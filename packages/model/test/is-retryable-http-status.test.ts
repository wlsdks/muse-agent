import { describe, expect, it } from "vitest";

import { isRetryableHttpStatus } from "../src/index.js";

// The retry-classification source of truth (architecture.md): a 4xx MUST fail fast
// (it is a permanent client error — retrying just hammers a doomed request), while
// 5xx and the two transient 4xx (408 request-timeout, 429 rate-limit) MAY retry.
describe("isRetryableHttpStatus", () => {
  it("retries the transient 4xx codes 408 and 429", () => {
    expect(isRetryableHttpStatus(408)).toBe(true);
    expect(isRetryableHttpStatus(429)).toBe(true);
  });

  it("retries the whole 5xx range (inclusive bounds 500..599)", () => {
    expect(isRetryableHttpStatus(500)).toBe(true);
    expect(isRetryableHttpStatus(503)).toBe(true);
    expect(isRetryableHttpStatus(599)).toBe(true);
    expect(isRetryableHttpStatus(499)).toBe(false); // just below the range
    expect(isRetryableHttpStatus(600)).toBe(false); // just above the range
  });

  it("does NOT retry ordinary 4xx (fail fast) or 2xx/3xx", () => {
    for (const status of [400, 401, 403, 404, 422]) {
      expect(isRetryableHttpStatus(status), `${status.toString()} is a permanent client error`).toBe(false);
    }
    expect(isRetryableHttpStatus(200)).toBe(false);
    expect(isRetryableHttpStatus(301)).toBe(false);
  });

  it("returns false for a non-finite status (NaN / Infinity from a malformed response)", () => {
    expect(isRetryableHttpStatus(Number.NaN)).toBe(false);
    expect(isRetryableHttpStatus(Number.POSITIVE_INFINITY)).toBe(false);
  });
});
