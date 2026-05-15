import { describe, expect, it } from "vitest";

import { parseBoundedInt } from "./commands-ask.js";

describe("parseBoundedInt (goal 178)", () => {
  it("returns the fallback when the flag is absent or blank", () => {
    expect(parseBoundedInt(undefined, "--top", 1, 20, 3)).toBe(3);
    expect(parseBoundedInt("", "--top", 1, 20, 3)).toBe(3);
    expect(parseBoundedInt("   ", "--top", 1, 20, 3)).toBe(3);
  });

  it("accepts a genuine number, truncating and clamping to max", () => {
    expect(parseBoundedInt("5", "--top", 1, 20, 3)).toBe(5);
    expect(parseBoundedInt(" 7 ", "--top", 1, 20, 3)).toBe(7);
    expect(parseBoundedInt("4.9", "--top", 1, 20, 3)).toBe(4);
    expect(parseBoundedInt("999", "--top", 1, 20, 3)).toBe(20); // clamp high
  });

  it("rejects a unit slip / non-numeric / below-min instead of silently defaulting", () => {
    expect(() => parseBoundedInt("5x", "--top", 1, 20, 3)).toThrow(/--top must be an integer in \[1, 20\]/u);
    expect(() => parseBoundedInt("abc", "--top", 1, 20, 3)).toThrow(/got 'abc'/u);
    expect(() => parseBoundedInt("0", "--top", 1, 20, 3)).toThrow(/\[1, 20\]/u);
    expect(() => parseBoundedInt("-2", "--top", 1, 20, 3)).toThrow(/\[1, 20\]/u);
  });

  it("works for the --calendar-days bounds too", () => {
    expect(parseBoundedInt("14", "--calendar-days", 1, 30, 7)).toBe(14);
    expect(parseBoundedInt("60", "--calendar-days", 1, 30, 7)).toBe(30);
    expect(() => parseBoundedInt("14d", "--calendar-days", 1, 30, 7))
      .toThrow(/--calendar-days must be an integer in \[1, 30\]/u);
  });
});
