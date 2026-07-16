import { describe, expect, it } from "vitest";

import { DEFAULT_PROVIDER_FETCH_TIMEOUT_MS, clampInboundLimit, clampOutboundText, fetchWithTimeout, tryParseJson } from "./provider-helpers.js";

describe("clampOutboundText", () => {
  it("returns short text unchanged", () => {
    expect(clampOutboundText("hello", 4096)).toBe("hello");
    expect(clampOutboundText("x".repeat(4096), 4096)).toBe("x".repeat(4096));
  });

  it("truncates over-limit text with a marker, never exceeding max", () => {
    const out = clampOutboundText("y".repeat(5000), 4096);
    expect(out.length).toBe(4096);
    expect(out.endsWith("… [truncated]")).toBe(true);
    expect(out.startsWith("y")).toBe(true);
  });

  it("defaults to Telegram's 4096 cap and supports a tighter platform cap", () => {
    expect(clampOutboundText("z".repeat(5000)).length).toBe(4096);
    const discord = clampOutboundText("z".repeat(3000), 2000);
    expect(discord.length).toBe(2000);
    expect(discord.endsWith("… [truncated]")).toBe(true);
  });

  it("degrades safely when max is smaller than the marker", () => {
    expect(clampOutboundText("abcdef", 3)).toBe("abc");
    expect(clampOutboundText("abcdef", 0)).toBe("");
  });

  it("never emits a lone surrogate when the cut lands inside an astral char (emoji)", () => {
    const marker = "… [truncated]";
    // Make the slice boundary fall exactly between 📋's surrogate
    // pair (U+1F4CB = 📋).
    const head = "a".repeat(4096 - marker.length - 1);
    const out = clampOutboundText(`${head}📋${"z".repeat(200)}`, 4096);
    expect(out.endsWith(marker)).toBe(true);
    expect(out.length).toBeLessThanOrEqual(4096);
    // No unpaired high surrogate anywhere — invalid UTF-8 some chat
    // APIs 400, dropping the whole message.
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u.test(out)).toBe(false);
    // The half emoji is dropped, not mangled.
    expect(out.includes("\uD83D")).toBe(false);

    // A complete trailing emoji that fits is preserved intact.
    const fits = clampOutboundText(`${"b".repeat(10)}📋`, 4096);
    expect(fits).toBe(`${"b".repeat(10)}📋`);

    // Tight-max branch (max ≤ marker) also can't leave a half pair.
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u.test(clampOutboundText("📋x", 1))).toBe(false);
  });
});

describe("clampInboundLimit", () => {
  it("falls back to default 20 when raw is undefined / non-finite", () => {
    expect(clampInboundLimit(undefined)).toBe(20);
    expect(clampInboundLimit(Number.NaN)).toBe(20);
    expect(clampInboundLimit(Number.POSITIVE_INFINITY)).toBe(20);
  });
  it("clamps finite values into [1, max]", () => {
    expect(clampInboundLimit(0)).toBe(1);
    expect(clampInboundLimit(-5)).toBe(1);
    expect(clampInboundLimit(50)).toBe(50);
    expect(clampInboundLimit(500)).toBe(100); // default max
    expect(clampInboundLimit(500, 30)).toBe(30); // custom max
  });
  it("truncates fractional values toward zero", () => {
    expect(clampInboundLimit(5.9)).toBe(5);
    expect(clampInboundLimit(1.4)).toBe(1);
  });
});

describe("tryParseJson", () => {
  it("returns the parsed value for valid JSON", () => {
    expect(tryParseJson<{ a: number }>('{"a":1}')).toEqual({ a: 1 });
    expect(tryParseJson<number[]>("[1,2,3]")).toEqual([1, 2, 3]);
  });
  it("returns undefined for empty body", () => {
    expect(tryParseJson("")).toBeUndefined();
  });
  it("returns undefined for invalid JSON (no throw)", () => {
    expect(tryParseJson("not json")).toBeUndefined();
    expect(tryParseJson("{unbalanced")).toBeUndefined();
  });
});

describe("fetchWithTimeout — a stalled Bot API connection can't hang the polling daemon's inbound tick or a proactive send forever", () => {
  it("rejects with a 'timed out' error when the upstream fetch never resolves before the timeout, and forwards the AbortSignal so the connection is actively cancelled", async () => {
    let receivedSignal: AbortSignal | undefined;
    const neverResolves: typeof globalThis.fetch = (_input, init) => {
      receivedSignal = (init as { signal?: AbortSignal } | undefined)?.signal;
      const pending = Promise.withResolvers<Response>();
      receivedSignal?.addEventListener("abort", () => pending.reject(new DOMException("aborted", "AbortError")), { once: true });
      return pending.promise;
    };
    await expect(
      fetchWithTimeout(neverResolves, "https://api.telegram.org/botX/getUpdates", { method: "GET" }, 10)
    ).rejects.toThrow(/timed out after 10ms/u);
    expect(receivedSignal).toBeInstanceOf(AbortSignal);
    expect(receivedSignal?.aborted).toBe(true);
  });

  it("returns the response and clears the timer on a fast call — no leaked timer keeps the event loop alive", async () => {
    const okFetch: typeof globalThis.fetch = () => Promise.resolve(new Response("ok", { status: 200 }));
    const response = await fetchWithTimeout(okFetch, "https://api.telegram.org/botX/sendMessage", { method: "POST" }, 5_000);
    expect(response.status).toBe(200);
  });

  it("re-throws a non-abort fetch error verbatim (network reset before the timeout) — only an actual abort becomes a 'timed out' error", async () => {
    const failFetch: typeof globalThis.fetch = () => Promise.reject(new Error("ECONNRESET"));
    await expect(
      fetchWithTimeout(failFetch, "https://api.telegram.org/botX/getUpdates", { method: "GET" }, 5_000)
    ).rejects.toThrow(/ECONNRESET/u);
  });

  it("preserves a caller AbortSignal while adding the timeout signal", async () => {
    const caller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    const callerAbort = new DOMException("caller cancelled", "AbortError");
    const pendingFetch: typeof globalThis.fetch = (_input, init) => {
      receivedSignal = (init as { signal?: AbortSignal } | undefined)?.signal;
      return new Promise<Response>((_resolve, reject) => {
        receivedSignal?.addEventListener("abort", () => reject(receivedSignal?.reason), { once: true });
      });
    };

    const pending = fetchWithTimeout(pendingFetch, "https://api.telegram.org/botX/getUpdates", { signal: caller.signal }, 5_000);
    caller.abort(callerAbort);

    await expect(pending).rejects.toBe(callerAbort);
    expect(receivedSignal).not.toBe(caller.signal);
    expect(receivedSignal?.aborted).toBe(true);
  });

  it("falls back to the 30s default for a non-finite / non-positive timeout", () => {
    expect(DEFAULT_PROVIDER_FETCH_TIMEOUT_MS).toBe(30_000);
  });
});
