import { describe, expect, it } from "vitest";

import { parseLimit } from "./commands-episode.js";

describe("commands-episode parseLimit — strict-parse convention", () => {
  it("returns the fallback when the flag is absent or blank", () => {
    expect(parseLimit(undefined, 10, 200)).toBe(10);
    expect(parseLimit("", 10, 200)).toBe(10);
    expect(parseLimit("   ", 10, 200)).toBe(10);
  });

  it("parses a valid value and caps it", () => {
    expect(parseLimit("5", 10, 200)).toBe(5);
    expect(parseLimit(" 7 ", 10, 200)).toBe(7);
    expect(parseLimit("999", 10, 200)).toBe(200);
    expect(parseLimit("3.9", 10, 200)).toBe(3);
  });

  it("throws on an explicitly invalid value instead of silently using the default", () => {
    expect(() => parseLimit("abc", 10, 200)).toThrow(/--limit must be a positive number/u);
    expect(() => parseLimit("0", 10, 200)).toThrow(/positive number/u);
    expect(() => parseLimit("-2", 10, 200)).toThrow(/positive number/u);
    expect(() => parseLimit("10x", 10, 200), "unit-slip must not silently degrade to the 10 default — that's the exact silent-fallback bug").toThrow(/got '10x'/u);
    expect(() => parseLimit("5 entries", 10, 200)).toThrow(/got '5 entries'/u);
  });
});
