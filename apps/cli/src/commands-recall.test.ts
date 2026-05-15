import { describe, expect, it } from "vitest";

import { RECALL_SOURCE_VALUES, clampLimit, resolveSource } from "./commands-recall.js";

describe("clampLimit (goal 179)", () => {
  it("returns the default 5 when absent or blank", () => {
    expect(clampLimit(undefined)).toBe(5);
    expect(clampLimit("")).toBe(5);
    expect(clampLimit("   ")).toBe(5);
  });

  it("accepts a genuine number, truncating and clamping to the 50 cap", () => {
    expect(clampLimit("8")).toBe(8);
    expect(clampLimit(" 12 ")).toBe(12);
    expect(clampLimit("3.9")).toBe(3);
    expect(clampLimit("999")).toBe(50);
  });

  it("rejects a unit slip / non-numeric / non-positive instead of silently using 5", () => {
    expect(() => clampLimit("10x")).toThrow(/--limit must be a positive number \(got '10x'\)/u);
    expect(() => clampLimit("abc")).toThrow(/positive number/u);
    expect(() => clampLimit("0")).toThrow(/positive number/u);
    expect(() => clampLimit("-3")).toThrow(/positive number/u);
  });
});

describe("resolveSource (goal 157)", () => {
  it("returns the default 'all' when --source is omitted", () => {
    expect(resolveSource(undefined)).toEqual({ kind: "ok", source: "all" });
  });

  it("treats an empty or whitespace value as 'no flag' → 'all'", () => {
    expect(resolveSource("")).toEqual({ kind: "ok", source: "all" });
    expect(resolveSource("   ")).toEqual({ kind: "ok", source: "all" });
  });

  it("accepts each known value, case-insensitive", () => {
    for (const value of RECALL_SOURCE_VALUES) {
      expect(resolveSource(value)).toEqual({ kind: "ok", source: value });
      expect(resolveSource(value.toUpperCase())).toEqual({ kind: "ok", source: value });
    }
  });

  it("returns 'invalid' for unknown values so the caller can render a typo hint", () => {
    expect(resolveSource("note")).toEqual({ kind: "invalid", input: "note" });
    expect(resolveSource("episode")).toEqual({ kind: "invalid", input: "episode" });
    expect(resolveSource("everything")).toEqual({ kind: "invalid", input: "everything" });
  });

  it("preserves the original raw input on invalid so the caller renders the user's exact typo", () => {
    expect(resolveSource("  Note  ")).toEqual({ kind: "invalid", input: "  Note  " });
  });
});
