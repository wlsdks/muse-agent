import { describe, expect, it } from "vitest";

import { parseLimit } from "./commands-search.js";

describe("parseLimit (muse search --limit)", () => {
  it("absent or blank → the fallback", () => {
    expect(parseLimit(undefined, 10, 50)).toBe(10);
    expect(parseLimit("", 10, 50)).toBe(10);
    expect(parseLimit("   ", 10, 50)).toBe(10);
  });

  it("accepts a genuine number, truncating and clamping to cap", () => {
    expect(parseLimit("5", 10, 50)).toBe(5);
    expect(parseLimit(" 25 ", 10, 50)).toBe(25);
    expect(parseLimit("25.9", 10, 50)).toBe(25);
    expect(parseLimit("999", 10, 50)).toBe(50); // clamp high
    expect(parseLimit("1", 10, 50)).toBe(1);
  });

  it("rejects a unit slip / non-numeric / below-1 instead of silently defaulting", () => {
    expect(() => parseLimit("5abc", 10, 50)).toThrow(/--limit must be an integer in \[1, 50\]/u);
    expect(() => parseLimit("abc", 10, 50)).toThrow(/got 'abc'/u);
    expect(() => parseLimit("0", 10, 50)).toThrow(/\[1, 50\]/u);
    expect(() => parseLimit("-5", 10, 50)).toThrow(/got '-5'/u);
    expect(() => parseLimit("0.5", 10, 50)).toThrow(/\[1, 50\]/u);
    expect(() => parseLimit("1O", 10, 50)).toThrow(/got '1O'/u);
  });
});
