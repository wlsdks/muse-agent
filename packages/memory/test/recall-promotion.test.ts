import { describe, expect, it } from "vitest";

import { consolidationPlan, scoreRecallHit, selectForgettable, selectPromotableMemories, type RecallHitLike } from "../src/index.js";

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

  // Edge/branch deepening — the promotion-selection guards must not silently
  // mis-graduate a memory (a wrongly-promoted memory pollutes the always-on
  // persona; a wrongly-excluded one is lost from it).
  it("scoreRecallHit floors non-finite / negative hits to 0 and falls back to the 21-day half-life", () => {
    expect(scoreRecallHit({ hits: Number.NaN, key: "a", lastHitMs: NOW }, NOW)).toBe(0);
    expect(scoreRecallHit({ hits: Number.POSITIVE_INFINITY, key: "a", lastHitMs: NOW }, NOW)).toBe(0);
    expect(scoreRecallHit({ hits: -5, key: "a", lastHitMs: NOW }, NOW)).toBe(0);
    // a non-positive / non-finite half-life is ignored → the default 21 days
    // (a 21-day-old 4-hit memory decays to exactly 2 under the default).
    expect(scoreRecallHit({ hits: 4, key: "a", lastHitMs: daysAgo(21) }, NOW, 0)).toBeCloseTo(2, 5);
    expect(scoreRecallHit({ hits: 4, key: "a", lastHitMs: daysAgo(21) }, NOW, Number.NaN)).toBeCloseTo(2, 5);
  });

  it("the default minScore (0.5) excludes a memory that cleared the hit floor but decayed too far — minScore:0 re-includes it", () => {
    // 5 hits, last seen 90 days ago: score = 5·2^(-90/21) ≈ 0.26 < 0.5.
    const stale = [{ hits: 5, key: "stale", lastHitMs: daysAgo(90) }];
    expect(selectPromotableMemories(stale, { nowMs: NOW })).toEqual([]);
    expect(selectPromotableMemories(stale, { nowMs: NOW, minScore: 0 }).map((p) => p.key)).toEqual(["stale"]);
  });

  it("clamps a 0 / negative / fractional minHits and maxPromoted to sane bounds (>=1, truncated)", () => {
    const recs = [{ hits: 1, key: "one", lastHitMs: NOW }, { hits: 2, key: "two", lastHitMs: NOW }];
    // minHits 0 → clamped to >=1, so the 1-hit memory is eligible
    expect(selectPromotableMemories([{ hits: 1, key: "one", lastHitMs: NOW }], { minHits: 0, nowMs: NOW }).map((p) => p.key)).toEqual(["one"]);
    // maxPromoted 0 → clamped to >=1 (never returns an empty cap). Uses hits
    // that clear the DEFAULT minHits (3) so the cap, not the floor, is what bounds.
    const eligible = [{ hits: 9, key: "a", lastHitMs: NOW }, { hits: 8, key: "b", lastHitMs: NOW }];
    expect(selectPromotableMemories(eligible, { maxPromoted: 0, nowMs: NOW })).toHaveLength(1);
    // minHits 2.9 truncates to 2 — a 2-hit memory is eligible, a 1-hit one is not
    const trunc = selectPromotableMemories(recs, { minHits: 2.9, nowMs: NOW });
    expect(trunc.map((p) => p.key)).toEqual(["two"]);
  });

  it("filters out records with non-finite hits and returns [] for an empty set", () => {
    expect(selectPromotableMemories([{ hits: Number.POSITIVE_INFINITY, key: "bad", lastHitMs: NOW }], { minHits: 1, nowMs: NOW })).toEqual([]);
    expect(selectPromotableMemories([], { nowMs: NOW })).toEqual([]);
  });

  it("ranks strictly by recency-weighted score and respects the cap order (highest scores kept)", () => {
    const recs = [
      { hits: 3, key: "mid", lastHitMs: daysAgo(2) },
      { hits: 9, key: "top", lastHitMs: daysAgo(1) },
      { hits: 3, key: "low", lastHitMs: daysAgo(5) },
    ];
    const out = selectPromotableMemories(recs, { maxPromoted: 2, nowMs: NOW });
    expect(out.map((p) => p.key)).toEqual(["top", "mid"]); // "low" dropped by the cap, order by score
    expect(out[0]!.score).toBeGreaterThan(out[1]!.score);
  });
});

describe("selectForgettable — the FORGET half of sleep consolidation (non-destructive)", () => {
  it("flags a memory that is BOTH decayed (low score) AND idle (old last hit)", () => {
    const records: RecallHitLike[] = [
      { key: "fresh-useful", hits: 8, lastHitMs: daysAgo(2) },     // high score, recent → keep
      { key: "stale-unused", hits: 1, lastHitMs: daysAgo(120) },   // low score + old → FADE
      { key: "low-but-recent", hits: 1, lastHitMs: daysAgo(3) }    // low score but recent → keep
    ];
    const fading = selectForgettable(records, { nowMs: NOW });
    expect(fading.map((m) => m.key)).toEqual(["stale-unused"]);
    expect(fading[0]!.ageDays).toBeGreaterThanOrEqual(30);
  });

  it("never fades a recently-hit memory however small its tally (minAgeDays guard)", () => {
    const records: RecallHitLike[] = [{ key: "tiny-recent", hits: 1, lastHitMs: daysAgo(5) }];
    expect(selectForgettable(records, { nowMs: NOW })).toEqual([]);
  });

  it("ranks least-useful first and caps the list", () => {
    const records: RecallHitLike[] = Array.from({ length: 15 }, (_, i) => ({ key: `m${i}`, hits: 1, lastHitMs: daysAgo(60 + i) }));
    const fading = selectForgettable(records, { nowMs: NOW, maxFading: 5 });
    expect(fading).toHaveLength(5);
    for (let i = 1; i < fading.length; i++) expect(fading[i]!.score).toBeGreaterThanOrEqual(fading[i - 1]!.score);
  });
});

describe("consolidationPlan — one sleep pass: promote the salient, name the fading", () => {
  it("returns both halves over one record set", () => {
    const records: RecallHitLike[] = [
      { key: "star", hits: 9, lastHitMs: daysAgo(1) },        // promote
      { key: "ghost", hits: 1, lastHitMs: daysAgo(200) }      // fade
    ];
    const plan = consolidationPlan(records, { nowMs: NOW });
    expect(plan.promote.map((m) => m.key)).toContain("star");
    expect(plan.fade.map((m) => m.key)).toContain("ghost");
    // a promoted memory is never also a fade candidate
    const overlap = plan.promote.filter((p) => plan.fade.some((f) => f.key === p.key));
    expect(overlap).toEqual([]);
  });
});
