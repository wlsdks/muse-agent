import { describe, expect, it } from "vitest";

import { maxOfNumbers, minOfNumbers } from "./commands-calendar.js";

describe("minOfNumbers / maxOfNumbers — reduce-based min/max so a large `.ics` import range computation can't RangeError on `Math.min(...arr)` spread", () => {
  it("returns the min / max of a small array", () => {
    expect(minOfNumbers([3, 1, 2])).toBe(1);
    expect(maxOfNumbers([3, 1, 2])).toBe(3);
    expect(minOfNumbers([-5, 0, 5])).toBe(-5);
    expect(maxOfNumbers([-5, 0, 5])).toBe(5);
  });

  it("handles a single element", () => {
    expect(minOfNumbers([42])).toBe(42);
    expect(maxOfNumbers([42])).toBe(42);
  });

  it("returns the Infinity seeds for an empty array (the documented empty-input fallback; callers guard against empty)", () => {
    expect(minOfNumbers([])).toBe(Infinity);
    expect(maxOfNumbers([])).toBe(-Infinity);
  });

  it("does NOT RangeError on a very large array — `Math.min(...arr)` / `Math.max(...arr)` spread every element as a call argument and overflow the engine's argument-count limit; the reduce never spreads", () => {
    // 200k elements is comfortably past V8's spread argument-count
    // ceiling, where `Math.min(...arr)` throws RangeError.
    const big = Array.from({ length: 200_000 }, (_, i) => i);
    expect(maxOfNumbers(big)).toBe(199_999);
    expect(minOfNumbers(big)).toBe(0);
  });
});
