import { describe, expect, it } from "vitest";

import { detectChangePoint } from "../src/change-point.js";

describe("detectChangePoint — onset of a new regime", () => {
  it("finds a clear up-shift at the boundary", () => {
    const cp = detectChangePoint([3, 3, 4, 3, 3, 10, 11, 10, 12, 10]);
    expect(cp).not.toBeNull();
    expect(cp!.index).toBe(5);
    expect(cp!.direction).toBe("up");
    expect(cp!.beforeMean).toBeCloseTo(3.2, 1);
    expect(cp!.afterMean).toBeCloseTo(10.6, 1);
  });

  it("finds a down-shift (activity dropped)", () => {
    const cp = detectChangePoint([12, 11, 13, 12, 12, 4, 3, 4, 3, 4]);
    expect(cp!.direction).toBe("down");
    expect(cp!.index).toBe(5);
  });

  it("returns null for a steady series (no regime change)", () => {
    expect(detectChangePoint([5, 5, 6, 5, 4, 5, 5, 6])).toBeNull();
  });

  it("returns null when the series is perfectly flat (no scale)", () => {
    expect(detectChangePoint([4, 4, 4, 4, 4, 4])).toBeNull();
  });

  it("returns null when too short to have two regimes", () => {
    expect(detectChangePoint([1, 9])).toBeNull();
    expect(detectChangePoint([1, 1, 9])).toBeNull(); // < 2*minSegment(3)
  });
});
