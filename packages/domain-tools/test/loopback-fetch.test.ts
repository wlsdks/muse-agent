import { describe, expect, it } from "vitest";

import { normalizeFetchBodyBytes, normalizeFetchTimeoutMs } from "../src/loopback-fetch.js";

describe("loopback fetch option normalization", () => {
  it("keeps only safe positive body caps", () => {
    expect(normalizeFetchBodyBytes(128)).toBe(128);
    expect(normalizeFetchBodyBytes(0)).toBe(65_536);
    expect(normalizeFetchBodyBytes(0.5)).toBe(65_536);
    expect(normalizeFetchBodyBytes(Number.POSITIVE_INFINITY)).toBe(65_536);
  });

  it("preserves an explicit disabled timeout while rejecting fractional and overflow timer values", () => {
    expect(normalizeFetchTimeoutMs(0)).toBe(0);
    expect(normalizeFetchTimeoutMs(25)).toBe(25);
    expect(normalizeFetchTimeoutMs(0.5)).toBe(5_000);
    expect(normalizeFetchTimeoutMs(Number.MAX_SAFE_INTEGER)).toBe(2_147_483_647);
  });
});
