import { describe, expect, it } from "vitest";

import { clamp } from "../src/index.js";

describe("clamp", () => {
  it("returns the value unchanged when already within [min, max]", () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(0, 0, 10)).toBe(0);
    expect(clamp(10, 0, 10)).toBe(10);
  });

  it("floors at min and caps at max", () => {
    expect(clamp(-3, 0, 10)).toBe(0);
    expect(clamp(42, 0, 10)).toBe(10);
  });

  it("handles negative ranges and fractional values", () => {
    expect(clamp(-7, -10, -5)).toBe(-7);
    expect(clamp(-2, -10, -5)).toBe(-5);
    expect(clamp(0.5, 0, 1)).toBe(0.5);
  });
});
