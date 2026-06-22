import { describe, expect, it } from "vitest";

import { clampLimit } from "../src/loopback-history.js";

describe("clampLimit — a sub-1 fractional limit takes the fallback, never slices to empty", () => {
  it("a fractional limit in (0,1) returns the fallback, not 0", () => {
    // The bug: 0.5 passed the `<= 0` guard, then Math.trunc(0.5) === 0 sliced the
    // feed to empty — the agent silently reports 'nothing happened'.
    expect(clampLimit(0.5, 20, 200)).toBe(20);
    expect(clampLimit(0.999, 20, 200)).toBe(20);
  });

  it("0 and negatives still take the fallback (unchanged)", () => {
    expect(clampLimit(0, 20, 200)).toBe(20);
    expect(clampLimit(-5, 20, 200)).toBe(20);
  });

  it("a fractional limit ≥ 1 truncates toward zero", () => {
    expect(clampLimit(2.9, 20, 200)).toBe(2);
    expect(clampLimit(1.5, 20, 200)).toBe(1);
  });

  it("an in-range integer passes through; over-cap is capped", () => {
    expect(clampLimit(50, 20, 200)).toBe(50);
    expect(clampLimit(500, 20, 200)).toBe(200);
  });

  it("non-numbers and non-finite values take the fallback", () => {
    expect(clampLimit("10", 20, 200)).toBe(20);
    expect(clampLimit(undefined, 20, 200)).toBe(20);
    expect(clampLimit(Number.NaN, 20, 200)).toBe(20);
    expect(clampLimit(Number.POSITIVE_INFINITY, 20, 200)).toBe(20);
  });
});
