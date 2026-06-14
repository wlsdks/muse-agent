import { describe, expect, it } from "vitest";

import { parseBoundedInt } from "./parse-bounded-int.js";

describe("parseBoundedInt", () => {
  it("returns the fallback for undefined / blank input", () => {
    expect(parseBoundedInt(undefined, "--top", 1, 20, 3)).toBe(3);
    expect(parseBoundedInt("", "--top", 1, 20, 3)).toBe(3);
    expect(parseBoundedInt("   ", "--top", 1, 20, 3)).toBe(3);
  });

  it("parses a valid integer within range", () => {
    expect(parseBoundedInt("5", "--top", 1, 20, 3)).toBe(5);
    expect(parseBoundedInt(" 12 ", "--top", 1, 20, 3)).toBe(12);
  });

  it("truncates a fractional value and clamps to max", () => {
    expect(parseBoundedInt("4.9", "--top", 1, 20, 3)).toBe(4);
    expect(parseBoundedInt("999", "--top", 1, 20, 3)).toBe(20); // clamp high
  });

  it("rejects a non-numeric / unit-slip / below-min value with a flag-named error", () => {
    expect(() => parseBoundedInt("5m", "--top", 1, 20, 3)).toThrow(/--top must be an integer in \[1, 20\]/u);
    expect(() => parseBoundedInt("abc", "--top", 1, 20, 3)).toThrow(/got 'abc'/u);
    expect(() => parseBoundedInt("0", "--top", 1, 20, 3)).toThrow(/\[1, 20\]/u);
    expect(() => parseBoundedInt("-5", "--best-of", 1, 5, 1)).toThrow(/--best-of/u);
  });
});
