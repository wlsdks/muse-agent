import { describe, expect, it } from "vitest";

import { levenshteinDistance } from "../src/index.js";

describe("levenshteinDistance", () => {
  it("is 0 for identical strings", () => {
    expect(levenshteinDistance("status", "status")).toBe(0);
  });
  it("equals the other length when one string is empty", () => {
    expect(levenshteinDistance("", "abc")).toBe(3);
    expect(levenshteinDistance("abc", "")).toBe(3);
  });
  it("counts single edits (insert/delete/substitute)", () => {
    expect(levenshteinDistance("statu", "status")).toBe(1);
    expect(levenshteinDistance("histoy", "history")).toBe(1);
    expect(levenshteinDistance("kitten", "sitting")).toBe(3);
  });
});
