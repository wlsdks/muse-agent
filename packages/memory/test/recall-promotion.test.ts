import { describe, expect, it } from "vitest";

import { consolidationPlan, recallActivation, scoreRecallHit, selectForgettable, selectPromotableMemories, type RecallHitLike } from "../src/index.js";

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

  it("an ESTABLISHED memory (lifetime hits ≥ importance floor) resists fading even when idle + decayed (MemoryBank importance term, arXiv:2305.10250)", () => {
    const records: RecallHitLike[] = [
      { key: "established", hits: 10, lastHitMs: daysAgo(120) }, // decayed score + idle, BUT high lifetime frequency → protected
      { key: "minor-stale", hits: 2, lastHitMs: daysAgo(120) }   // decayed + idle + low frequency → still fades
    ];
    const fading = selectForgettable(records, { nowMs: NOW }).map((m) => m.key);
    expect(fading).toContain("minor-stale");
    expect(fading).not.toContain("established");
  });

  it("the importance floor is tunable — a frequent memory fades under a higher floor, resists under a lower one", () => {
    const records: RecallHitLike[] = [{ key: "freq", hits: 5, lastHitMs: daysAgo(150) }];
    expect(selectForgettable(records, { nowMs: NOW, importanceHitsFloor: 6 }).map((m) => m.key)).toEqual(["freq"]);
    expect(selectForgettable(records, { nowMs: NOW, importanceHitsFloor: 4 })).toEqual([]);
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

describe("ACT-R ranking (useActrRanking)", () => {
  // Three records all eligible under the default gate (hits >= 3, score >= 0.5).
  // "spaced" has many distributed accesses so ACT-R activation > "recent" despite a lower plain score.
  // "recent" has a high plain score (many recent hits) but fewer spaced accesses.
  // "mid" is in between.
  const spacedAccessMs = [
    daysAgo(60), daysAgo(45), daysAgo(30), daysAgo(15), daysAgo(7), daysAgo(3), daysAgo(1)
  ];
  const spaced: RecallHitLike = { key: "spaced", hits: 7, lastHitMs: daysAgo(1), recentAccessMs: spacedAccessMs };
  const recent: RecallHitLike = { key: "recent", hits: 9, lastHitMs: daysAgo(1), recentAccessMs: [daysAgo(2), daysAgo(1)] };
  const mid: RecallHitLike = { key: "mid", hits: 4, lastHitMs: daysAgo(5), recentAccessMs: [daysAgo(10), daysAgo(5)] };

  it("same SET of keys as without the flag, but ACT-R winner leads", () => {
    const flagOff = selectPromotableMemories([spaced, recent, mid], { nowMs: NOW });
    const flagOn = selectPromotableMemories([spaced, recent, mid], { nowMs: NOW, useActrRanking: true });

    const keysOff = new Set(flagOff.map((p) => p.key));
    const keysOn = new Set(flagOn.map((p) => p.key));
    expect(keysOn).toEqual(keysOff);

    // "spaced" has the highest ACT-R activation (many distributed accesses) — must be first under ACT-R
    const actrSpaced = recallActivation(spaced, NOW);
    const actrRecent = recallActivation(recent, NOW);
    expect(actrSpaced).toBeGreaterThan(actrRecent);
    expect(flagOn[0]!.key).toBe("spaced");
  });

  it("gate invariant: high ACT-R does NOT rescue a below-minScore record", () => {
    // 2 hits < minHits(3) + lastHitMs old enough the score is near-zero, but recentAccessMs is long
    const lowScore: RecallHitLike = {
      key: "low-score",
      hits: 2,
      lastHitMs: daysAgo(90),
      recentAccessMs: Array.from({ length: 20 }, (_, i) => daysAgo(i + 1))
    };
    const out = selectPromotableMemories([lowScore, spaced], { nowMs: NOW, useActrRanking: true });
    const keys = out.map((p) => p.key);
    expect(keys).not.toContain("low-score");
    expect(keys).toContain("spaced");
  });

  it("legacy fallback: a record with no recentAccessMs ranks coherently alongside one with recentAccessMs", () => {
    const legacy: RecallHitLike = { key: "legacy", hits: 5, lastHitMs: daysAgo(2) };
    const withHistory: RecallHitLike = { key: "history", hits: 5, lastHitMs: daysAgo(2), recentAccessMs: [daysAgo(5), daysAgo(2)] };
    const out = selectPromotableMemories([legacy, withHistory], { nowMs: NOW, useActrRanking: true });
    const keys = out.map((p) => p.key);
    expect(keys).toContain("legacy");
    expect(keys).toContain("history");
    // both present and ordering is finite (no crash, no NaN)
    for (const p of out) {
      expect(Number.isFinite(p.score)).toBe(true);
    }
  });

  it("regression (flag off): output is identical to score-sorted order", () => {
    const recs: RecallHitLike[] = [
      { key: "a", hits: 9, lastHitMs: daysAgo(1) },
      { key: "b", hits: 6, lastHitMs: daysAgo(3) },
      { key: "c", hits: 4, lastHitMs: daysAgo(7) }
    ];
    const flagOff = selectPromotableMemories(recs, { nowMs: NOW });
    const explicit = selectPromotableMemories(recs, { nowMs: NOW, useActrRanking: false });
    // same order and same scores
    expect(flagOff.map((p) => p.key)).toEqual(explicit.map((p) => p.key));
    for (let i = 0; i < flagOff.length; i++) {
      expect(flagOff[i]!.score).toBeCloseTo(explicit[i]!.score, 10);
    }
    // scores are descending
    for (let i = 1; i < flagOff.length; i++) {
      expect(flagOff[i - 1]!.score).toBeGreaterThanOrEqual(flagOff[i]!.score);
    }
  });

  it("selectForgettable with useActrRanking: least-active-first, gate unchanged", () => {
    // All three are fading candidates: score <= 0.25 AND ageDays >= 30.
    const idle1: RecallHitLike = { key: "idle1", hits: 1, lastHitMs: daysAgo(120), recentAccessMs: [daysAgo(120)] };
    const idle2: RecallHitLike = { key: "idle2", hits: 1, lastHitMs: daysAgo(60), recentAccessMs: [daysAgo(60), daysAgo(45)] };
    const fresh: RecallHitLike = { key: "fresh", hits: 8, lastHitMs: daysAgo(2) }; // gate-excluded: score too high and too recent

    const fading = selectForgettable([idle1, idle2, fresh], { nowMs: NOW, useActrRanking: true });

    // "fresh" must not appear (gate: score > maxScore AND ageDays < minAgeDays)
    expect(fading.map((m) => m.key)).not.toContain("fresh");
    // idle1 has lower ACT-R activation (single old access) vs idle2 (two somewhat-older accesses) — idle1 comes first
    const actrIdle1 = recallActivation(idle1, NOW);
    const actrIdle2 = recallActivation(idle2, NOW);
    expect(actrIdle1).toBeLessThan(actrIdle2);
    expect(fading[0]!.key).toBe("idle1");
  });
});
