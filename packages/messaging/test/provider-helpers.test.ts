import { describe, expect, it } from "vitest";

import {
  clampInboundLimit,
  clampOutboundText,
  fetchReadWithRetry,
  fetchWithTimeout,
  parseRetryAfterMs,
  retryAfterMsFromResponse,
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

  it("at max EXACTLY the marker length, returns a bare slice (the boundary is `<=`, not `<`)", () => {
    // marker is 13 chars; max===13 must take the bare-slice path (13 real chars),
    // not the head+marker path (which would emit just the marker).
    expect(clampOutboundText("ABCDEFGHIJKLMNOP", 13)).toBe("ABCDEFGHIJKLM");
  });

  it("drops a lone high surrogate at EITHER surrogate boundary (0xD800 low, 0xDBFF high)", () => {
    // exact-boundary codepoints isolate the `>= 0xd800` and `<= 0xdbff` checks;
    // constructed via fromCharCode so the source file stays valid UTF-8.
    const tail = "y".repeat(20);
    const expected = `${"x".repeat(20)}… [truncated]`;
    for (const code of [0xd800, 0xdbff]) {
      const text = `${"x".repeat(20)}${String.fromCharCode(code)}${tail}`;
      expect(clampOutboundText(text, 34), `boundary 0x${code.toString(16)}`).toBe(expected);
    }
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
      (() => {
        const pending = Promise.withResolvers<Response>();
        init.signal?.addEventListener("abort", () => pending.reject(new Error("aborted")), { once: true });
        return pending.promise;
      })()) as unknown as typeof fetch;
    await expect(fetchWithTimeout(hang, "http://x", {}, 20)).rejects.toThrow(/timed out after 20ms/u);
  });

  it("returns the response on success and falls back to the default timeout for a non-finite value", async () => {
    const ok: typeof fetch = (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch;
    const res = await fetchWithTimeout(ok, "http://x", {}, Number.NaN);
    expect(res.status).toBe(200);
  });

  it("clamps an oversized finite timeout to Node's safe timer range instead of throwing before fetch", async () => {
    const ok: typeof fetch = (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch;
    await expect(fetchWithTimeout(ok, "http://x", {}, Number.MAX_SAFE_INTEGER)).resolves.toMatchObject({ status: 200 });
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

  it("retries a NETWORK ERROR with linear backoff (baseDelayMs * attempt) then returns the recovery", async () => {
    // The catch-path backoff (a transient ECONNRESET, distinct from the 5xx
    // path above) must wait baseDelayMs*attempt, not baseDelayMs+attempt.
    const delays: number[] = [];
    let calls = 0;
    const flaky: typeof fetch = (async () => {
      calls += 1;
      if (calls < 2) throw new Error("ECONNRESET");
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;
    const res = await fetchReadWithRetry(flaky, "http://x", {}, { baseDelayMs: 100, maxAttempts: 3, sleep: async (ms) => { delays.push(ms); } });
    expect(res.status).toBe(200);
    expect(delays).toEqual([100]); // base * attempt(1), not base + attempt
  });

  it("does not retry a caller-cancelled read", async () => {
    const caller = new AbortController();
    const callerAbort = new DOMException("caller cancelled", "AbortError");
    const delays: number[] = [];
    let calls = 0;
    const cancelled: typeof fetch = (async () => {
      calls += 1;
      caller.abort(callerAbort);
      throw callerAbort;
    }) as typeof fetch;

    await expect(
      fetchReadWithRetry(cancelled, "http://x", { signal: caller.signal }, { maxAttempts: 3, sleep: async (ms) => { delays.push(ms); } })
    ).rejects.toBe(callerAbort);
    expect(calls).toBe(1);
    expect(delays).toEqual([]);
  });

  it("normalizes non-finite retry controls to bounded defaults", async () => {
    const delays: number[] = [];
    let calls = 0;
    const impl: typeof fetch = (async () => {
      calls += 1;
      return new Response("retry", { status: 500 });
    }) as unknown as typeof fetch;
    const response = await fetchReadWithRetry(impl, "http://x", {}, {
      baseDelayMs: Number.NaN,
      maxAttempts: Number.POSITIVE_INFINITY,
      sleep: async (ms) => { delays.push(ms); }
    });
    expect(response.status).toBe(500);
    expect(calls).toBe(3);
    expect(delays).toEqual([200, 400]);
  });
});

describe("parseRetryAfterMs / retryAfterMsFromResponse — server-mandated 429 wait", () => {
  const resp = (retryAfter?: string) => ({ headers: { get: (n: string) => (n.toLowerCase() === "retry-after" && retryAfter !== undefined ? retryAfter : null) } });

  it("parses a numeric Retry-After header (seconds) into ms; ignores garbage / missing", () => {
    expect(parseRetryAfterMs("5")).toBe(5000);
    expect(parseRetryAfterMs("0")).toBe(0);
    expect(parseRetryAfterMs(null)).toBeUndefined();
    expect(parseRetryAfterMs("")).toBeUndefined();
    expect(parseRetryAfterMs("soon")).toBeUndefined();
    expect(parseRetryAfterMs("1e100")).toBe(2_147_483_647);
  });

  it("prefers a body retry_after (seconds) over the header, falls back to the header otherwise", () => {
    expect(retryAfterMsFromResponse(resp("3"), 12)).toBe(12000); // body wins
    expect(retryAfterMsFromResponse(resp("3"))).toBe(3000); // no body → header
    expect(retryAfterMsFromResponse(resp(undefined))).toBeUndefined(); // neither
  });
});
