import { describe, expect, it } from "vitest";

import { classifyError, retry } from "../src/index.js";

describe("classifyError", () => {
  it("classifies 429 as rate_limit — retryable with backoff", () => {
    const c = classifyError({ status: 429, message: "Rate limited" });
    expect(c.reason).toBe("rate_limit");
    expect(c.recovery).toMatchObject({ retryable: true, shouldBackoff: true });
  });

  it("classifies 401/403 as auth — fail fast", () => {
    expect(classifyError({ status: 401, message: "no" }).reason).toBe("auth");
    const c = classifyError({ statusCode: 403, message: "forbidden" });
    expect(c.reason).toBe("auth");
    expect(c.recovery.retryable).toBe(false);
  });

  it("classifies 404 as model_not_found — fail fast, suggests fallback", () => {
    const c = classifyError({ status: 404, message: "model gone" });
    expect(c.reason).toBe("model_not_found");
    expect(c.recovery.retryable).toBe(false);
    expect(c.recovery.shouldFallbackModel).toBe(true);
  });

  it("classifies 503/529 as overloaded — retryable, backoff, fallback", () => {
    expect(classifyError({ status: 503, message: "busy" }).reason).toBe("overloaded");
    const c = classifyError({ status: 529, message: "overloaded" });
    expect(c.reason).toBe("overloaded");
    expect(c.recovery).toMatchObject({ retryable: true, shouldBackoff: true, shouldFallbackModel: true });
  });

  it("classifies 5xx as server_error — retryable", () => {
    expect(classifyError({ status: 500, message: "boom" }).reason).toBe("server_error");
    expect(classifyError({ status: 502, message: "bad gateway" }).recovery.retryable).toBe(true);
  });

  it("classifies 413 / context messages as context_overflow — compress, not retry", () => {
    expect(classifyError({ status: 413, message: "too large" }).reason).toBe("context_overflow");
    const c = classifyError(new Error("maximum context length exceeded"));
    expect(c.reason).toBe("context_overflow");
    expect(c.recovery).toMatchObject({ retryable: false, shouldCompressContext: true });
  });

  it("classifies content-policy messages — fail fast", () => {
    const c = classifyError(new Error("Your request was flagged by the content policy"));
    expect(c.reason).toBe("content_policy");
    expect(c.recovery.retryable).toBe(false);
  });

  it("classifies network/timeout by name and message", () => {
    const t = new Error("operation timed out");
    t.name = "TimeoutError";
    expect(classifyError(t).reason).toBe("timeout");
    expect(classifyError(new Error("ECONNRESET while reading")).reason).toBe("network");
    const fetchErr = new TypeError("fetch failed");
    expect(classifyError(fetchErr).reason).toBe("network");
  });

  it("honors a wrapped provider error's own retryable flag when text is opaque", () => {
    expect(classifyError({ message: "weird", retryable: false }).reason).toBe("bad_request");
    expect(classifyError({ message: "weird", retryable: true }).reason).toBe("server_error");
  });

  it("falls back to unknown (retryable) so the loop never gives up on an unexplained error", () => {
    const c = classifyError(new Error("something inexplicable"));
    expect(c.reason).toBe("unknown");
    expect(c.recovery.retryable).toBe(true);
  });
});

describe("classifyError retry-after extraction", () => {
  it("reads a numeric retryAfter (seconds) and retry_after and retryAfterMs", () => {
    expect(classifyError({ status: 429, retryAfter: 30 }).retryAfterMs).toBe(30_000);
    expect(classifyError({ status: 429, retry_after: 5 }).retryAfterMs).toBe(5_000);
    expect(classifyError({ status: 429, retryAfterMs: 500 }).retryAfterMs).toBe(500);
  });

  it("reads a retry-after header from an object bag or a get()-style bag", () => {
    expect(classifyError({ status: 429, headers: { "retry-after": "12" } }).retryAfterMs).toBe(12_000);
    const withGet = { status: 429, response: { headers: new Map([["retry-after", "7"]]) } };
    expect(classifyError(withGet).retryAfterMs).toBe(7_000);
  });

  it("parses retry-after from message text with units", () => {
    expect(classifyError(new Error("Rate limited, try again in 2 seconds")).retryAfterMs).toBe(2_000);
    expect(classifyError(new Error("retry after 30s")).retryAfterMs).toBe(30_000);
    expect(classifyError(new Error("quota resets in 3m")).retryAfterMs).toBe(180_000);
    expect(classifyError(new Error("please wait 500ms")).retryAfterMs).toBe(500);
  });

  it("is null when no retry-after is present", () => {
    expect(classifyError(new Error("boom")).retryAfterMs).toBeNull();
  });
});

describe("retry honors server-advised retry-after", () => {
  it("waits the retry-after instead of the default backoff", async () => {
    const waits: number[] = [];
    const op = () => Promise.reject({ status: 429, retryAfter: 2, message: "rate limited" });
    await expect(
      retry(op, { maxAttempts: 2, sleep: async (ms) => { waits.push(ms); } })
    ).rejects.toBeDefined();
    expect(waits).toEqual([2_000]); // not the ~100ms default
  });

  it("caps an absurd retry-after at 60s when no maxDelayMs is set", async () => {
    const waits: number[] = [];
    const op = () => Promise.reject({ status: 429, retryAfter: 3_600, message: "rate limited" });
    await expect(
      retry(op, { maxAttempts: 2, sleep: async (ms) => { waits.push(ms); } })
    ).rejects.toBeDefined();
    expect(waits).toEqual([60_000]);
  });
});

describe("retry default policy uses the classifier", () => {
  it("fails fast on a clearly-permanent error with NO explicit retryable fn", async () => {
    let attempts = 0;
    const op = () => {
      attempts++;
      return Promise.reject({ status: 401, message: "bad key" });
    };
    await expect(retry(op, { maxAttempts: 5, sleep: async () => {} })).rejects.toMatchObject({ status: 401 });
    expect(attempts).toBe(1); // stopped immediately, not 5
  });

  it("still retries an unknown error to exhaustion by default (old behavior preserved)", async () => {
    let attempts = 0;
    const op = () => {
      attempts++;
      return Promise.reject(new Error("transient blip"));
    };
    await expect(retry(op, { maxAttempts: 3, sleep: async () => {} })).rejects.toBeDefined();
    expect(attempts).toBe(3);
  });
});
