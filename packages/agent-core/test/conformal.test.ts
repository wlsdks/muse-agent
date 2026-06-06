import { describe, expect, it } from "vitest";

import { calibrateAbstention, conformalThreshold, empiricalCoverage } from "../src/conformal.js";

// A deterministic, RNG-free score sample: an evenly-spaced grid on (0,1]. Using a
// fixed grid keeps the statistical assertions reproducible while still exercising
// the order-statistic math the conformal guarantee rests on.
const grid = (n: number): number[] => Array.from({ length: n }, (_, i) => (i + 1) / n);

describe("conformalThreshold — the construction coverage guarantee (deterministic)", () => {
  it("on the calibration set, coverage ≥ 1 - alpha for every alpha and n", () => {
    for (const n of [10, 23, 50, 100, 1000]) {
      const scores = grid(n);
      for (const alpha of [0.01, 0.05, 0.1, 0.2, 0.5]) {
        const tau = conformalThreshold(scores, alpha);
        const coverage = empiricalCoverage(scores, tau);
        expect(coverage).toBeGreaterThanOrEqual(1 - alpha);
      }
    }
  });

  it("is monotonic: a larger alpha yields a higher (or equal) threshold and lower (or equal) coverage", () => {
    const scores = grid(200);
    let prevTau = Number.NEGATIVE_INFINITY;
    let prevCov = Infinity;
    for (const alpha of [0.01, 0.05, 0.1, 0.2, 0.3, 0.5]) {
      const tau = conformalThreshold(scores, alpha);
      const cov = empiricalCoverage(scores, tau);
      expect(tau).toBeGreaterThanOrEqual(prevTau);
      expect(cov).toBeLessThanOrEqual(prevCov + 1e-9);
      prevTau = tau;
      prevCov = cov;
    }
  });
});

describe("conformalThreshold — the held-out (real) conformal guarantee", () => {
  it("a threshold calibrated on one split holds coverage ≥ ~1-alpha on a disjoint split from the same distribution", () => {
    // Two disjoint, identically-distributed grids (calibration vs test). The
    // distribution-free bound says test coverage ≥ 1 - alpha in expectation; with
    // these dense, exchangeable grids it holds within a small finite-sample slack.
    const calib = grid(500);
    const test = Array.from({ length: 500 }, (_, i) => (i + 0.5) / 500); // interleaved, same support
    for (const alpha of [0.05, 0.1, 0.2]) {
      const tau = conformalThreshold(calib, alpha);
      const coverage = empiricalCoverage(test, tau);
      expect(coverage).toBeGreaterThanOrEqual(1 - alpha - 0.02);
    }
  });
});

describe("conformalThreshold — fail-safe edge cases (never invent a refusal)", () => {
  it("empty calibration set → -Infinity (answer everything; calibrating a fresh corpus can't regress the floor)", () => {
    expect(conformalThreshold([], 0.1)).toBe(Number.NEGATIVE_INFINITY);
    expect(empiricalCoverage([0.1, 0.9], Number.NEGATIVE_INFINITY)).toBe(1);
  });

  it("alpha = 0 → -Infinity (a 100% coverage target abstains on nothing)", () => {
    expect(conformalThreshold(grid(50), 0)).toBe(Number.NEGATIVE_INFINITY);
  });

  it("alpha = 1 → +Infinity (a 0% coverage target abstains on everything)", () => {
    expect(conformalThreshold(grid(50), 1)).toBe(Number.POSITIVE_INFINITY);
    expect(empiricalCoverage(grid(50), Number.POSITIVE_INFINITY)).toBe(0);
  });

  it("clamps an out-of-range alpha instead of producing garbage", () => {
    expect(conformalThreshold(grid(50), -5)).toBe(Number.NEGATIVE_INFINITY);
    expect(conformalThreshold(grid(50), 5)).toBe(Number.POSITIVE_INFINITY);
  });

  it("is order-independent (sorts internally)", () => {
    const a = conformalThreshold([0.9, 0.1, 0.5, 0.3, 0.7], 0.2);
    const b = conformalThreshold([0.1, 0.3, 0.5, 0.7, 0.9], 0.2);
    expect(a).toBe(b);
  });
});

describe("calibrateAbstention — one-call convenience", () => {
  it("returns threshold + the (guaranteed ≥ target) calibration coverage + n", () => {
    const result = calibrateAbstention(grid(100), 0.1);
    expect(result.n).toBe(100);
    expect(result.targetCoverage).toBeCloseTo(0.9, 10);
    expect(result.calibrationCoverage).toBeGreaterThanOrEqual(result.targetCoverage);
    expect(Number.isFinite(result.threshold)).toBe(true);
  });

  it("defaults to alpha = 0.1 (a 90% coverage target)", () => {
    expect(calibrateAbstention(grid(100)).targetCoverage).toBeCloseTo(0.9, 10);
  });
});
