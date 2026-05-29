import { describe, expect, it } from "vitest";

import { clampScanLimit } from "./commands-commitments.js";

describe("commands-commitments clampScanLimit — strict-parse convention", () => {
  it("returns the fallback when absent or blank", () => {
    expect(clampScanLimit(undefined, 10, 50)).toBe(10);
    expect(clampScanLimit("   ", 10, 50)).toBe(10);
  });

  it("parses and caps a valid value", () => {
    expect(clampScanLimit("5", 10, 50)).toBe(5);
    expect(clampScanLimit("999", 10, 50)).toBe(50);
    expect(clampScanLimit("3.9", 10, 50)).toBe(3);
  });

  it("throws on an invalid value rather than silently defaulting", () => {
    expect(() => clampScanLimit("abc", 10, 50)).toThrow(/positive number/u);
    expect(() => clampScanLimit("0", 10, 50)).toThrow(/positive number/u);
    expect(() => clampScanLimit("5 items", 10, 50)).toThrow(/got '5 items'/u);
  });
});
