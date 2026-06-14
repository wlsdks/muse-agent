import { describe, expect, it } from "vitest";

import { formatFiredList, formatShift, parseConfidence, parseLimit } from "./commands-pattern.js";

describe("parseLimit", () => {
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

describe("parseConfidence", () => {
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

describe("formatFiredList — a corrupt firedAtMs can't crash the whole listing", () => {
  const rec = (patternId: string, firedAtMs: number) =>
    ({ firedAtMs, patternId } as unknown as Parameters<typeof formatFiredList>[0][number]);

  it("renders a placeholder for a non-finite / out-of-range firedAtMs and still lists the rest", () => {
    const out = formatFiredList([
      rec("good-1", Date.UTC(2026, 4, 20, 9, 0, 0)),
      rec("nan", Number.NaN),
      rec("huge", 9e15), // beyond the ±8.64e15 Date range
      rec("good-2", Date.UTC(2026, 4, 21, 10, 30, 0))
    ]);
    expect(out).toContain("[good-1]");
    expect(out).toContain("[good-2]");
    expect(out.match(/\(unknown time\)/gu)).toHaveLength(2); // nan + huge
    expect(out).not.toMatch(/\[nan\][^\n]*\d{4}/u); // no real date for the bad one
  });

  it("empty list is unchanged", () => {
    expect(formatFiredList([])).toBe("No patterns have fired yet.\n");
  });
});

describe("formatShift — routine change-point readout (C5)", () => {
  const days = Array.from({ length: 20 }, (_, i) => ({ count: i < 10 ? 3 : 12, date: `2026-05-${String(i + 1).padStart(2, "0")}` }));
  it("needs enough history", () => {
    expect(formatShift(null, days.slice(0, 5))).toContain("Not enough history");
  });
  it("all-clear when no shift", () => {
    expect(formatShift(null, days)).toContain("No clear routine shift");
  });
  it("reports the shift date, direction, and before/after levels", () => {
    const out = formatShift({ index: 10, beforeMean: 3, afterMean: 12, magnitude: 1.3, direction: "up" }, days);
    expect(out).toContain("picked up around 2026-05-11");
    expect(out).toContain("3.0/day to 12.0/day");
  });
});
