import { describe, expect, it } from "vitest";

import {
  DEFAULT_CONSOLIDATION_HALF_LIFE_DAYS,
  DEFAULT_CONSOLIDATION_THRESHOLD,
  isConsolidationCandidate,
  scoreConsolidationCandidate,
  type ConsolidationCandidateSignals
} from "./consolidation-score.js";

const DAY = 86_400_000;
const NOW = Date.parse("2026-07-12T12:00:00Z");
const daysAgo = (days: number): number => NOW - days * DAY;

describe("scoreConsolidationCandidate — monotone in hits", () => {
  it("more hits at the same recency scores strictly higher", () => {
    const base: Omit<ConsolidationCandidateSignals, "hits"> = {
      createdMs: daysAgo(30),
      lastHitMs: daysAgo(1)
    };
    const few = scoreConsolidationCandidate({ ...base, hits: 1 }, NOW);
    const many = scoreConsolidationCandidate({ ...base, hits: 5 }, NOW);
    expect(many).toBeGreaterThan(few);
  });
});

describe("scoreConsolidationCandidate — monotone in recency + half-life", () => {
  it("a more recent lastHitMs at the same hits scores strictly higher", () => {
    const signals = (lastHitMs: number): ConsolidationCandidateSignals => ({
      hits: 3,
      createdMs: daysAgo(60),
      lastHitMs
    });
    const recent = scoreConsolidationCandidate(signals(daysAgo(1)), NOW);
    const stale = scoreConsolidationCandidate(signals(daysAgo(20)), NOW);
    expect(recent).toBeGreaterThan(stale);
  });

  it("a hit exactly halfLifeDays ago scores ~half of a just-now hit", () => {
    const halfLifeDays = DEFAULT_CONSOLIDATION_HALF_LIFE_DAYS;
    const justNow = scoreConsolidationCandidate({ hits: 4, createdMs: daysAgo(60), lastHitMs: NOW }, NOW);
    const atHalfLife = scoreConsolidationCandidate(
      { hits: 4, createdMs: daysAgo(60), lastHitMs: NOW - halfLifeDays * DAY },
      NOW
    );
    expect(atHalfLife / justNow).toBeCloseTo(0.5, 5);
  });
});

describe("scoreConsolidationCandidate — diversity bonus", () => {
  const base: ConsolidationCandidateSignals = {
    hits: 4,
    createdMs: daysAgo(30),
    lastHitMs: daysAgo(1)
  };

  it("higher distinctQueries at the same hits scores higher", () => {
    const narrow = scoreConsolidationCandidate({ ...base, distinctQueries: 2 }, NOW);
    const broad = scoreConsolidationCandidate({ ...base, distinctQueries: 4 }, NOW);
    expect(broad).toBeGreaterThan(narrow);
  });

  it("absent distinctQueries is neutral — equals the score without the field", () => {
    const withoutField = scoreConsolidationCandidate(base, NOW);
    const { distinctQueries: _unused, ...rest } = { ...base, distinctQueries: undefined };
    const explicitlyUndefined = scoreConsolidationCandidate(rest as ConsolidationCandidateSignals, NOW);
    expect(explicitlyUndefined).toBe(withoutField);
  });

  it("distinctQueries=1 (all recalls share one query) applies no bonus", () => {
    const oneQuery = scoreConsolidationCandidate({ ...base, distinctQueries: 1 }, NOW);
    const noField = scoreConsolidationCandidate(base, NOW);
    expect(oneQuery).toBe(noField);
  });
});

describe("scoreConsolidationCandidate — boundary and guards", () => {
  it("hits <= 0 scores 0", () => {
    expect(scoreConsolidationCandidate({ hits: 0, createdMs: daysAgo(10), lastHitMs: daysAgo(1) }, NOW)).toBe(0);
    expect(scoreConsolidationCandidate({ hits: -3, createdMs: daysAgo(10), lastHitMs: daysAgo(1) }, NOW)).toBe(0);
  });

  it("non-finite hits, lastHitMs, or nowMs scores 0", () => {
    expect(
      scoreConsolidationCandidate({ hits: Number.NaN, createdMs: daysAgo(10), lastHitMs: daysAgo(1) }, NOW)
    ).toBe(0);
    expect(
      scoreConsolidationCandidate({ hits: 3, createdMs: daysAgo(10), lastHitMs: Number.POSITIVE_INFINITY }, NOW)
    ).toBe(0);
    expect(
      scoreConsolidationCandidate({ hits: 3, createdMs: daysAgo(10), lastHitMs: daysAgo(1) }, Number.NaN)
    ).toBe(0);
  });

  it("a lastHitMs in the future clamps ageDays at 0, not exceeding the just-now score", () => {
    const justNow = scoreConsolidationCandidate({ hits: 3, createdMs: daysAgo(10), lastHitMs: NOW }, NOW);
    const future = scoreConsolidationCandidate({ hits: 3, createdMs: daysAgo(10), lastHitMs: NOW + DAY }, NOW);
    expect(future).toBe(justNow);
  });
});

describe("isConsolidationCandidate", () => {
  it("passes at or above the threshold, fails below it", () => {
    expect(isConsolidationCandidate(DEFAULT_CONSOLIDATION_THRESHOLD)).toBe(true);
    expect(isConsolidationCandidate(DEFAULT_CONSOLIDATION_THRESHOLD + 0.01)).toBe(true);
    expect(isConsolidationCandidate(DEFAULT_CONSOLIDATION_THRESHOLD - 0.01)).toBe(false);
  });

  it("rejects NaN", () => {
    expect(isConsolidationCandidate(Number.NaN)).toBe(false);
  });
});

describe("scoreConsolidationCandidate — purity / no-write contract", () => {
  it("does not mutate a frozen input and performs no side effects", () => {
    const frozen: ConsolidationCandidateSignals = Object.freeze({
      hits: 5,
      createdMs: daysAgo(20),
      lastHitMs: daysAgo(2),
      distinctQueries: 3
    });
    const snapshot = { ...frozen };
    expect(() => scoreConsolidationCandidate(frozen, NOW)).not.toThrow();
    expect(frozen).toEqual(snapshot);
  });
});
