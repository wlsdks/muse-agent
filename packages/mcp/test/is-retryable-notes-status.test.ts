import { describe, expect, it } from "vitest";

import { isRetryableNotesStatus } from "../src/notes-providers.js";

describe("isRetryableNotesStatus", () => {
  it("retries 429 (rate limit)", () => {
    expect(isRetryableNotesStatus(429)).toBe(true);
  });

  it("retries the whole 5xx server-error range at its bounds", () => {
    expect(isRetryableNotesStatus(500)).toBe(true);
    expect(isRetryableNotesStatus(503)).toBe(true);
    expect(isRetryableNotesStatus(599)).toBe(true);
  });

  it("does not retry 4xx (incl. 408) or 2xx — only 429 + 5xx", () => {
    for (const status of [200, 404, 408, 422, 499]) {
      expect(isRetryableNotesStatus(status)).toBe(false);
    }
  });

  it("does not retry out-of-range or non-positive statuses", () => {
    expect(isRetryableNotesStatus(600)).toBe(false);
    expect(isRetryableNotesStatus(0)).toBe(false);
    expect(isRetryableNotesStatus(-1)).toBe(false);
  });

  it("treats undefined / non-finite status as not retryable", () => {
    expect(isRetryableNotesStatus(undefined)).toBe(false);
    expect(isRetryableNotesStatus(Number.NaN)).toBe(false);
    expect(isRetryableNotesStatus(Number.POSITIVE_INFINITY)).toBe(false);
  });
});
