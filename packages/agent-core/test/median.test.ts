import { describe, expect, it } from "vitest";

import { median } from "../src/median.js";

describe("median (shared by the robust-statistics detectors)", () => {
  it("returns 0 for an empty array", () => {
    expect(median([])).toBe(0);
  });

  it("returns the single element / the middle of an odd-length array", () => {
    expect(median([5])).toBe(5);
    expect(median([1, 2, 3])).toBe(2);
    expect(median([1, 4, 9, 16, 25])).toBe(9);
  });

  it("averages the two middle elements of an even-length array", () => {
    expect(median([10, 20])).toBe(15);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([2, 4, 6, 100])).toBe(5);
  });

  it("assumes ascending-sorted input (it does NOT sort) — the caller's contract", () => {
    // Given an UNSORTED array, it picks positional middles, not the true median.
    expect(median([9, 1, 5])).toBe(1); // middle position, not the sorted median (5)
  });
});
