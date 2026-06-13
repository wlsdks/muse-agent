import { describe, expect, it } from "vitest";

import { isRecord, levenshteinDistance } from "../src/index.js";

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

describe("isRecord", () => {
  it("accepts a plain object, rejects null/array/primitive", () => {
    expect(isRecord({ a: 1 })).toBe(true);
    expect(isRecord(null)).toBe(false);
    expect(isRecord([1, 2])).toBe(false);
    expect(isRecord("x")).toBe(false);
    expect(isRecord(undefined)).toBe(false);
  });
});
