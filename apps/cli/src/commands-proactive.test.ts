import { describe, expect, it } from "vitest";

import { parseBoundedFlag } from "./commands-proactive.js";

describe("parseBoundedFlag (proactive daemon cadence flags)", () => {
  it("returns the fallback when the flag is absent or blank", () => {
    expect(parseBoundedFlag(undefined, "--interval", 5, 86_400, 60)).toBe(60);
    expect(parseBoundedFlag("", "--interval", 5, 86_400, 60)).toBe(60);
    expect(parseBoundedFlag("   ", "--lead-minutes", 1, 1_440, 10)).toBe(10);
  });

  it("accepts a genuine number, truncating and clamping to max", () => {
    expect(parseBoundedFlag("30", "--interval", 5, 86_400, 60)).toBe(30);
    expect(parseBoundedFlag(" 45 ", "--interval", 5, 86_400, 60)).toBe(45);
    expect(parseBoundedFlag("90.7", "--interval", 5, 86_400, 60)).toBe(90);
    expect(parseBoundedFlag("999999999", "--interval", 5, 86_400, 60)).toBe(86_400); // clamp high
    expect(parseBoundedFlag("1440", "--lead-minutes", 1, 1_440, 10)).toBe(1_440);
  });

  it("rejects a unit slip / non-numeric / below-min instead of silently defaulting", () => {
    expect(() => parseBoundedFlag("30abc", "--interval", 5, 86_400, 60))
      .toThrow(/--interval must be an integer in \[5, 86400\]/u);
    expect(() => parseBoundedFlag("abc", "--interval", 5, 86_400, 60)).toThrow(/got 'abc'/u);
    expect(() => parseBoundedFlag("3", "--interval", 5, 86_400, 60)).toThrow(/\[5, 86400\]/u); // below min
    expect(() => parseBoundedFlag("0", "--lead-minutes", 1, 1_440, 10)).toThrow(/\[1, 1440\]/u);
    expect(() => parseBoundedFlag("-5", "--lead-minutes", 1, 1_440, 10)).toThrow(/got '-5'/u);
    expect(() => parseBoundedFlag("1O", "--lead-minutes", 1, 1_440, 10)).toThrow(/got '1O'/u);
  });

  it("enforces the history `--limit` [1, 500] bounds", () => {
    expect(parseBoundedFlag(undefined, "--limit", 1, 500, 20)).toBe(20);
    expect(parseBoundedFlag("50", "--limit", 1, 500, 20)).toBe(50);
    expect(parseBoundedFlag("99999", "--limit", 1, 500, 20)).toBe(500); // clamp high
    expect(() => parseBoundedFlag("50abc", "--limit", 1, 500, 20))
      .toThrow(/--limit must be an integer in \[1, 500\]/u);
    expect(() => parseBoundedFlag("0", "--limit", 1, 500, 20)).toThrow(/\[1, 500\]/u);
  });
});
