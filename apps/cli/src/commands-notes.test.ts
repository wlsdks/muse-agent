import { describe, expect, it } from "vitest";

import { parseNotesSearchLimit } from "./commands-notes.js";

describe("parseNotesSearchLimit (goal 188)", () => {
  it("returns undefined when absent or blank (server/tool default)", () => {
    expect(parseNotesSearchLimit(undefined)).toBeUndefined();
    expect(parseNotesSearchLimit("")).toBeUndefined();
    expect(parseNotesSearchLimit("   ")).toBeUndefined();
  });

  it("accepts a genuine positive number, truncating", () => {
    expect(parseNotesSearchLimit("10")).toBe(10);
    expect(parseNotesSearchLimit(" 5 ")).toBe(5);
    expect(parseNotesSearchLimit("3.9")).toBe(3);
  });

  it("rejects a unit slip / non-numeric instead of silently dropping it", () => {
    expect(() => parseNotesSearchLimit("20x")).toThrow(/--limit must be a positive number \(got '20x'\)/u);
    expect(() => parseNotesSearchLimit("abc")).toThrow(/positive number/u);
  });

  it("rejects 0 / negative instead of passing them through to the tool", () => {
    expect(() => parseNotesSearchLimit("0")).toThrow(/positive number/u);
    expect(() => parseNotesSearchLimit("-3")).toThrow(/positive number/u);
  });
});
