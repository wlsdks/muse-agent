import { describe, expect, it } from "vitest";

import { scoreRecallHit, selectPromotableMemories, type RecallHitLike } from "../src/index.js";

const NOW = Date.UTC(2026, 4, 1, 0, 0, 0);
const daysAgo = (d: number): number => NOW - d * 24 * 60 * 60_000;

describe("scoreRecallHit", () => {
  it("is hits damped by recency of the LAST hit (21-day half-life), future clamps to age 0", () => {
    expect(scoreRecallHit({ hits: 4, key: "a", lastHitMs: NOW }, NOW, 21)).toBeCloseTo(4, 5);
    expect(scoreRecallHit({ hits: 4, key: "a", lastHitMs: daysAgo(21) }, NOW, 21)).toBeCloseTo(2, 5);
    expect(scoreRecallHit({ hits: 0, key: "a", lastHitMs: NOW }, NOW)).toBe(0);
    expect(scoreRecallHit({ hits: 3, key: "a", lastHitMs: NOW + 999_999 }, NOW, 21)).toBeCloseTo(3, 5);
  });

  it("a recent 4-hit memory outranks a stale 10-hit one (current usefulness, not lifetime tally)", () => {
    const recent = scoreRecallHit({ hits: 4, key: "r", lastHitMs: daysAgo(3) }, NOW, 21);
    const stale = scoreRecallHit({ hits: 10, key: "s", lastHitMs: daysAgo(90) }, NOW, 21);
    expect(recent).toBeGreaterThan(stale);
  });
});

describe("selectPromotableMemories", () => {
  const records: readonly RecallHitLike[] = [
    { hits: 6, key: "hot", lastHitMs: daysAgo(1) },
    { hits: 4, key: "warm", lastHitMs: daysAgo(10) },
    { hits: 2, key: "below-floor", lastHitMs: NOW }, // < minHits 3
    { hits: 5, key: "cold", lastHitMs: daysAgo(400) } // score decays ~to 0
  ];

  it("returns only ≥minHits memories with positive score, ranked by score desc, capped", () => {
    const out = selectPromotableMemories(records, { nowMs: NOW });
    expect(out.map((p) => p.key)).toEqual(["hot", "warm"]); // below-floor excluded by minHits, cold ~0 score
    expect(out[0]!.score).toBeGreaterThan(out[1]!.score);
  });

  it("honours minHits + maxPromoted", () => {
    expect(selectPromotableMemories(records, { nowMs: NOW, minHits: 2 }).map((p) => p.key)).toContain("below-floor");
    expect(selectPromotableMemories(records, { nowMs: NOW, maxPromoted: 1 })).toHaveLength(1);
  });
});
