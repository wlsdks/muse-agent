import { describe, expect, it } from "vitest";

import { finiteOr } from "../src/index.js";

describe("finiteOr", () => {
  it("returns the value when it is a finite number", () => {
    expect(finiteOr(5, 0)).toBe(5);
    expect(finiteOr(0, 99)).toBe(0);
    expect(finiteOr(-3.5, 0)).toBe(-3.5);
  });

  it("returns the fallback for undefined / NaN / Infinity", () => {
    expect(finiteOr(undefined, 7)).toBe(7);
    expect(finiteOr(Number.NaN, 7)).toBe(7);
    expect(finiteOr(Number.POSITIVE_INFINITY, 7)).toBe(7);
    expect(finiteOr(Number.NEGATIVE_INFINITY, 7)).toBe(7);
  });
});
