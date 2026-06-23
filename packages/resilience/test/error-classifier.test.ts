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
