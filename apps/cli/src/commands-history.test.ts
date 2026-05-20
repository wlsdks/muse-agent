import { describe, expect, it } from "vitest";

import { parseLimit } from "./commands-history.js";

describe("commands-history parseLimit — strict-parse convention", () => {
  it("returns the fallback when the flag is absent or blank", () => {
    expect(parseLimit(undefined, 20, 200)).toBe(20);
    expect(parseLimit("", 20, 200)).toBe(20);
    expect(parseLimit("   ", 20, 200)).toBe(20);
  });

  it("parses a valid value and caps it", () => {
    expect(parseLimit("5", 20, 200)).toBe(5);
    expect(parseLimit(" 7 ", 20, 200)).toBe(7);
    expect(parseLimit("999", 20, 200)).toBe(200);
    expect(parseLimit("3.9", 20, 200)).toBe(3);
  });

  it("throws on an explicitly invalid value instead of silently using the default", () => {
    expect(() => parseLimit("abc", 20, 200)).toThrow(/--limit must be a positive number/u);
    expect(() => parseLimit("0", 20, 200)).toThrow(/positive number/u);
    expect(() => parseLimit("-4", 20, 200)).toThrow(/positive number/u);
    expect(() => parseLimit("20x", 20, 200), "unit-slip must not silently degrade to the 20 default — that's the exact silent-fallback bug").toThrow(/got '20x'/u);
    expect(() => parseLimit("5min", 20, 200)).toThrow(/got '5min'/u);
  });
});
