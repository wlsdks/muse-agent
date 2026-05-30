import { describe, expect, it } from "vitest";

import {
  clampInboundLimit,
  clampOutboundText,
  fetchReadWithRetry,
  fetchWithTimeout,
  tryParseJson
} from "../src/provider-helpers.js";

// Direct coverage for the shared messaging-provider reliability primitives
// (untested module): outbound clamp, inbound-limit clamp, JSON parse, the
// timed fetch, and the idempotent-read retry. These are the daily-reliability
// seams — a stalled socket must not hang the polling daemon, a transient
// 429/5xx must retry with backoff, and a send() must NEVER be retried (double
// delivery). All deterministic via injected fetch + sleep — no real network.

describe("clampOutboundText", () => {
  it("returns text unchanged when within the cap", () => {
    expect(clampOutboundText("hello", 4096)).toBe("hello");
  });

  it("truncates over-cap text with a marker that fits INSIDE max", () => {
    const clamped = clampOutboundText("a".repeat(5000), 100);
    expect(clamped.length).toBe(100);
    expect(clamped.endsWith("… [truncated]")).toBe(true);
  });

  it("drops a trailing lone high surrogate so the cut never emits invalid UTF-8", () => {
    // 11 'x' + emoji repeats; max=25 → head=slice(0,12) lands on the emoji's
    // high surrogate, which must be dropped before the marker is appended.
    const text = `${"x".repeat(11)}${"\u{1F600}".repeat(10)}`;
    expect(clampOutboundText(text, 25)).toBe("xxxxxxxxxxx… [truncated]");
  });

  it("when max ≤ the marker length, returns a bare slice (still surrogate-safe), and max 0 → ''", () => {
    expect(clampOutboundText("hello world", 5)).toBe("hello");
    expect(clampOutboundText("hello", 0)).toBe("");
  });
});

describe("clampInboundLimit", () => {
  it("falls back to the default (20) for undefined / NaN / non-finite", () => {
    expect(clampInboundLimit(undefined)).toBe(20);
    expect(clampInboundLimit(Number.NaN)).toBe(20);
    expect(clampInboundLimit(Number.POSITIVE_INFINITY)).toBe(20);
  });

  it("truncates floats and clamps to [1, max]", () => {
    expect(clampInboundLimit(5.9)).toBe(5);
    expect(clampInboundLimit(0)).toBe(1);
    expect(clampInboundLimit(500)).toBe(100); // default max
    expect(clampInboundLimit(50, 10)).toBe(10); // custom max
  });
});

describe("tryParseJson", () => {
  it("parses valid JSON, and returns undefined for empty / malformed bodies", () => {
    expect(tryParseJson<{ a: number }>('{"a":1}')).toEqual({ a: 1 });
    expect(tryParseJson("")).toBeUndefined();
    expect(tryParseJson("{bad")).toBeUndefined();
  });
});

describe("fetchWithTimeout", () => {
  it("aborts a stalled request and throws a timed-out error carrying the cause", async () => {
    const hang: typeof fetch = ((_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as unknown as typeof fetch;
    await expect(fetchWithTimeout(hang, "http://x", {}, 20)).rejects.toThrow(/timed out after 20ms/u);
  });

  it("returns the response on success and falls back to the default timeout for a non-finite value", async () => {
    const ok: typeof fetch = (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch;
    const res = await fetchWithTimeout(ok, "http://x", {}, Number.NaN);
    expect(res.status).toBe(200);
  });
});

describe("fetchReadWithRetry", () => {
  it("retries a transient 5xx with LINEAR backoff and returns the eventual success", async () => {
    let calls = 0;
    const slept: number[] = [];
    const flaky: typeof fetch = (async () => {
      calls += 1;
      return calls < 3 ? new Response("e", { status: 500 }) : new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;
    const res = await fetchReadWithRetry(flaky, "http://x", {}, { baseDelayMs: 200, sleep: async (ms) => { slept.push(ms); } });
    expect(res.status).toBe(200);
    expect(calls).toBe(3);
    expect(slept).toEqual([200, 400]); // base * attempt
  });

  it("honors a Retry-After header over the backoff base", async () => {
    let calls = 0;
    const slept: number[] = [];
    const flaky: typeof fetch = (async () => {
      calls += 1;
      return calls < 2
        ? new Response("e", { headers: { "retry-after": "2" }, status: 429 })
        : new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;
    await fetchReadWithRetry(flaky, "http://x", {}, { sleep: async (ms) => { slept.push(ms); } });
    expect(slept).toEqual([2000]); // 2 seconds, not the 200ms base
  });

  it("falls back to linear backoff when Retry-After is INVALID (negative / non-numeric / missing)", async () => {
    // A buggy or hostile server can send `Retry-After: -5` or `abc`; the parser
    // must yield undefined (secs >= 0 + isFinite) so the retry uses baseDelayMs *
    // attempt instead of a negative / NaN delay — never trusting the bad header.
    const probe = async (retryAfter: string | null): Promise<readonly number[]> => {
      let calls = 0;
      const slept: number[] = [];
      const flaky: typeof fetch = (async () => {
        calls += 1;
        const headers = retryAfter !== null ? { "retry-after": retryAfter } : {};
        return calls < 2 ? new Response("e", { headers, status: 429 }) : new Response("ok", { status: 200 });
      }) as unknown as typeof fetch;
      await fetchReadWithRetry(flaky, "http://x", {}, { baseDelayMs: 50, sleep: async (ms) => { slept.push(ms); } });
      return slept;
    };
    expect(await probe("-5")).toEqual([50]);   // negative → ignored, linear backoff
    expect(await probe("abc")).toEqual([50]);  // non-numeric → ignored
    expect(await probe(null)).toEqual([50]);   // header absent → linear backoff
  });

  it("returns a non-retryable 4xx immediately without retrying", async () => {
    let calls = 0;
    const notFound: typeof fetch = (async () => { calls += 1; return new Response("nf", { status: 404 }); }) as unknown as typeof fetch;
    const res = await fetchReadWithRetry(notFound, "http://x", {}, { sleep: async () => {} });
    expect(res.status).toBe(404);
    expect(calls).toBe(1);
  });

  it("re-throws the network error after exhausting maxAttempts", async () => {
    let calls = 0;
    const netErr: typeof fetch = (async () => { calls += 1; throw new Error("ECONNRESET"); }) as unknown as typeof fetch;
    await expect(fetchReadWithRetry(netErr, "http://x", {}, { maxAttempts: 2, sleep: async () => {} }))
      .rejects.toThrow("ECONNRESET");
    expect(calls).toBe(2);
  });
});
