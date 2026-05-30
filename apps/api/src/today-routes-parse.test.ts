import { describe, expect, it } from "vitest";

import { parseLookaheadHours } from "./today-routes.js";

// Direct coverage for parseLookaheadHours (untested) — the strict lookahead
// parser for the /today briefing. It returns the 24h default for a missing or
// non-plain-integer value (a decimal / unit-slip / blank must NOT be leniently
// truncated), else the parsed integer. (The positivity + MAX clamp live in the
// route handler, so this function passes through 0 and large values.)

describe("parseLookaheadHours", () => {
  it("returns the 24h default for undefined, a decimal, a unit-slip, or a blank string", () => {
    expect(parseLookaheadHours(undefined)).toBe(24);
    expect(parseLookaheadHours("3.5")).toBe(24); // not 3
    expect(parseLookaheadHours("7d")).toBe(24); // not 7
    expect(parseLookaheadHours(" ")).toBe(24);
    expect(parseLookaheadHours("abc")).toBe(24);
  });

  it("parses a plain non-negative integer through (clamp/positivity handled downstream)", () => {
    expect(parseLookaheadHours("12")).toBe(12);
    expect(parseLookaheadHours("0")).toBe(0);
    expect(parseLookaheadHours("100000")).toBe(100_000);
  });
});
