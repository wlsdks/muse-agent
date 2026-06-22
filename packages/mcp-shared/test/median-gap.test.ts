import { describe, expect, it } from "vitest";

import { medianGap } from "../src/median-gap.js";

describe("medianGap (shared by the cadence detectors)", () => {
  it("returns 0 for an empty array", () => {
    expect(medianGap([])).toBe(0);
  });

  it("sorts UNSORTED input internally, then picks the middle (odd length)", () => {
    expect(medianGap([9, 1, 5])).toBe(5); // sorted [1,5,9] → 5 (NOT the positional 1)
    expect(medianGap([5])).toBe(5);
  });

  it("averages the two middle values of an even-length array, regardless of input order", () => {
    expect(medianGap([4, 2, 1, 3])).toBe(2.5); // sorted [1,2,3,4] → (2+3)/2
    expect(medianGap([100, 2, 6, 4])).toBe(5); // sorted [2,4,6,100] → (4+6)/2
  });

  it("is robust to an outlier — the median ignores one long pause a mean would smear", () => {
    expect(medianGap([3, 3, 3, 300])).toBe(3); // sorted [3,3,3,300] → (3+3)/2 = 3
  });
});
