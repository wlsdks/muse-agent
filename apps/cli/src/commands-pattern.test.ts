import { describe, expect, it } from "vitest";

import { parseConfidence, parseLimit } from "./commands-pattern.js";

describe("parseLimit (goal 177)", () => {
  it("returns the fallback when the flag is absent or blank", () => {
    expect(parseLimit(undefined, 20, 200)).toBe(20);
    expect(parseLimit("", 20, 200)).toBe(20);
    expect(parseLimit("   ", 20, 200)).toBe(20);
  });

  it("parses a valid value and caps it", () => {
    expect(parseLimit("5", 20, 200)).toBe(5);
    expect(parseLimit(" 7 ", 20, 200)).toBe(7);
    expect(parseLimit("999", 20, 200)).toBe(200);
    expect(parseLimit("3.9", 20, 200)).toBe(3); // trunc
  });

  it("throws on an explicitly invalid value instead of silently using the default", () => {
    expect(() => parseLimit("abc", 20, 200)).toThrow(/--limit must be a positive number/u);
    expect(() => parseLimit("0", 20, 200)).toThrow(/positive number/u);
    expect(() => parseLimit("-4", 20, 200)).toThrow(/positive number/u);
    expect(() => parseLimit("20x", 20, 200)).toThrow(/got '20x'/u);
  });
});

describe("parseConfidence (goal 177)", () => {
  it("returns the fallback when absent or blank", () => {
    expect(parseConfidence(undefined, 0)).toBe(0);
    expect(parseConfidence("  ", 0.5)).toBe(0.5);
  });

  it("accepts any value in [0, 1]", () => {
    expect(parseConfidence("0", 0.3)).toBe(0);
    expect(parseConfidence("1", 0.3)).toBe(1);
    expect(parseConfidence("0.75", 0.3)).toBe(0.75);
  });

  it("throws on out-of-range or non-numeric instead of silently falling back", () => {
    expect(() => parseConfidence("1.5", 0)).toThrow(/\[0, 1\]/u);
    expect(() => parseConfidence("-0.1", 0)).toThrow(/\[0, 1\]/u);
    expect(() => parseConfidence("0.8x", 0)).toThrow(/got '0\.8x'/u);
  });
});
