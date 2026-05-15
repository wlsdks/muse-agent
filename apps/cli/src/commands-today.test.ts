import { describe, expect, it } from "vitest";

import { parseLookaheadHours } from "./commands-today.js";

describe("parseLookaheadHours", () => {
  it("absent or blank → the 24h default", () => {
    expect(parseLookaheadHours(undefined)).toBe(24);
    expect(parseLookaheadHours("")).toBe(24);
    expect(parseLookaheadHours("   ")).toBe(24);
  });

  it("accepts a genuine number, truncating and clamping to the 168h max", () => {
    expect(parseLookaheadHours("12")).toBe(12);
    expect(parseLookaheadHours(" 48 ")).toBe(48);
    expect(parseLookaheadHours("36.9")).toBe(36);
    expect(parseLookaheadHours("9999")).toBe(168); // clamp high
    expect(parseLookaheadHours("1")).toBe(1);
  });

  it("rejects a unit slip / non-numeric / below-1 instead of silently defaulting to 24", () => {
    expect(() => parseLookaheadHours("48abc")).toThrow(/--lookahead-hours must be an integer in \[1, 168\]/u);
    expect(() => parseLookaheadHours("abc")).toThrow(/got 'abc'/u);
    expect(() => parseLookaheadHours("0")).toThrow(/\[1, 168\]/u);
    expect(() => parseLookaheadHours("-5")).toThrow(/\[1, 168\]/u);
    expect(() => parseLookaheadHours("1O")).toThrow(/got '1O'/u);
  });
});
