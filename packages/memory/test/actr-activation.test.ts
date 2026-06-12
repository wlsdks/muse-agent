import { describe, expect, it } from "vitest";

import { actrActivation } from "../src/index.js";

const actr = actrActivation;

describe("actrActivation — ACT-R base-level activation", () => {
  it("frequency: more accesses yield higher activation", () => {
    expect(actr([5, 5, 5])).toBeGreaterThan(actr([5]));
  });

  it("recency: a recent access set scores higher than an older one", () => {
    expect(actr([1, 2, 3])).toBeGreaterThan(actr([30, 31, 32]));
  });

  it("spacing vs massed: distributed practice (includes a recent access) beats massed access of equal count", () => {
    expect(actr([1, 40, 41])).toBeGreaterThan(actr([38, 39, 40]));
  });

  it("a just-now access (age 0) is clamped, not Infinity", () => {
    expect(Number.isFinite(actr([0]))).toBe(true);
  });

  it("empty access list returns -Infinity", () => {
    expect(actr([])).toBe(-Infinity);
  });

  it("future-dated access (negative age) is clamped to minAgeDays, not NaN/Infinity", () => {
    expect(Number.isFinite(actr([-5]))).toBe(true);
  });

  it("non-finite ages (NaN) are skipped — result equals the finite-only subset", () => {
    expect(actr([NaN, 2])).toBeCloseTo(actr([2]), 10);
  });

  it("decay <= 0 falls back to default 0.5 — result is finite, no throw", () => {
    expect(Number.isFinite(actr([2, 3], { decay: 0 }))).toBe(true);
    expect(Number.isFinite(actr([2, 3], { decay: -1 }))).toBe(true);
  });

  it("single-access closed form: actr([2]) === Math.log(2^-0.5)", () => {
    expect(actr([2])).toBeCloseTo(Math.log(Math.pow(2, -0.5)), 10);
  });
});
