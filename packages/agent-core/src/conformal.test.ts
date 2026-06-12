import { describe, expect, it } from "vitest";
import { calibrateAbstentionByGroup, empiricalCoverage } from "./conformal.js";

describe("calibrateAbstentionByGroup", () => {
  // arXiv:2407.21057 headline: a pooled threshold can have aggregate coverage ≥ 1−α
  // yet fall below that guarantee on a subgroup (here: hangul scores are systematically lower).
  it("multivalid headline — pooled tau under-covers the low-scoring subgroup", () => {
    const latinScores = Array.from({ length: 15 }, (_, i) => 0.7 + i * 0.01); // 0.70 … 0.84 (high)
    const hangulScores = Array.from({ length: 15 }, (_, i) => 0.3 + i * 0.01); // 0.30 … 0.44 (low)
    const items = [
      ...latinScores.map((score) => ({ group: "latin", score })),
      ...hangulScores.map((score) => ({ group: "hangul", score }))
    ];
    const { pooled, groups } = calibrateAbstentionByGroup(items, 0.1, 10);

    // Pooled tau comes from the combined distribution — likely sits around the low end of Latin.
    // hangul coverage under the pooled tau should be < 0.9.
    const hangulGroup = groups.find((g) => g.group === "hangul")!;
    const hangulCoverage = empiricalCoverage(hangulScores, pooled.threshold);
    expect(hangulCoverage).toBeLessThan(0.9);

    // But each group's OWN threshold gives it ≥ 0.9 coverage.
    expect(hangulGroup.calibrationCoverage).toBeGreaterThanOrEqual(0.9);
    const latinGroup = groups.find((g) => g.group === "latin")!;
    expect(latinGroup.calibrationCoverage).toBeGreaterThanOrEqual(0.9);
    expect(hangulGroup.pooledFallback).toBe(false);
  });

  it("overall guarantee retained — when all groups ≥ minGroupN, overall coverage ≥ 1−α", () => {
    const scores = Array.from({ length: 20 }, (_, i) => 0.5 + i * 0.02);
    const items = [
      ...scores.slice(0, 10).map((score) => ({ group: "latin", score })),
      ...scores.slice(10).map((score) => ({ group: "hangul", score }))
    ];
    const { pooled, groups } = calibrateAbstentionByGroup(items, 0.1, 10);
    expect(pooled.calibrationCoverage).toBeGreaterThanOrEqual(0.9);
    for (const g of groups) {
      expect(g.calibrationCoverage).toBeGreaterThanOrEqual(0.9);
      expect(g.pooledFallback).toBe(false);
    }
  });

  it("thin group (n < minGroupN) falls back to pooled threshold with pooledFallback: true", () => {
    const latinScores = Array.from({ length: 15 }, (_, i) => 0.5 + i * 0.01);
    const thinScores = [0.6, 0.7, 0.8]; // only 3 — below default minGroupN=10
    const items = [
      ...latinScores.map((score) => ({ group: "latin", score })),
      ...thinScores.map((score) => ({ group: "hangul", score }))
    ];
    const { pooled, groups } = calibrateAbstentionByGroup(items, 0.1, 10);
    const thin = groups.find((g) => g.group === "hangul")!;
    expect(thin.pooledFallback).toBe(true);
    expect(thin.threshold).toBe(pooled.threshold);
    expect(thin.n).toBe(3);
  });

  it("degenerate empty input — pooled threshold is −Infinity, no groups, never invents refusals", () => {
    const { pooled, groups } = calibrateAbstentionByGroup([]);
    expect(pooled.threshold).toBe(Number.NEGATIVE_INFINITY);
    expect(groups).toHaveLength(0);
    // A score of 0 still passes the gate (−Infinity ≤ 0) — no fabricated refusals.
    expect(0 >= pooled.threshold).toBe(true);
  });
});
