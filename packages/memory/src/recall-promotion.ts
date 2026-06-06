/**
 * Weighted memory promotion — the "promote" half of dreaming (after OpenClaw's
 * promote-by-usefulness). Given how often each memory has been surfaced by
 * recall (its hit record) and how recently, score its recall-usefulness and
 * select the few that have earned a place in the ALWAYS-ON persona — beyond the
 * episode themes/consolidate path, which promotes by narrative content rather
 * than by demonstrated usefulness.
 *
 * Pure + I/O-free: the caller resolves the hit records from disk
 * (`@muse/mcp`'s `readRecallHits`) and passes them in.
 *
 * Pattern adapted from OpenClaw's dreaming / weighted-promotion (MIT) —
 * reimplemented for Muse, no code copied. See THIRD_PARTY_NOTICES.md.
 */

export interface RecallHitLike {
  readonly key: string;
  readonly hits: number;
  readonly lastHitMs: number;
}

const DAY_MS = 24 * 60 * 60_000;
const DEFAULT_HALF_LIFE_DAYS = 21;
const DEFAULT_MIN_HITS = 3;
const DEFAULT_MAX_PROMOTED = 3;

/**
 * Recall-usefulness score: hit count damped by how long ago the LAST hit was,
 * `hits · 2^(-ageDays / halfLifeDays)`. A memory recalled 10× but not in two
 * months scores below one recalled 4× this week — promotion tracks *current*
 * usefulness, not a lifetime tally. Future timestamps clamp to age 0.
 */
export function scoreRecallHit(
  record: RecallHitLike,
  nowMs: number,
  halfLifeDays: number = DEFAULT_HALF_LIFE_DAYS
): number {
  const hits = Number.isFinite(record.hits) ? Math.max(0, record.hits) : 0;
  if (hits === 0) return 0;
  const half = Number.isFinite(halfLifeDays) && halfLifeDays > 0 ? halfLifeDays : DEFAULT_HALF_LIFE_DAYS;
  const ageDays = Math.max(0, (nowMs - record.lastHitMs) / DAY_MS);
  return hits * Math.pow(2, -ageDays / half);
}

export interface SelectPromotableOptions {
  readonly nowMs: number;
  /** Only memories with at least this many hits are eligible. Default 3. */
  readonly minHits?: number;
  /**
   * Minimum recency-weighted score to promote. Default 0.5 — guards against a
   * memory that cleared the hit floor long ago but hasn't been recalled in
   * months (its decayed score is near-zero); without this an only-3-candidate
   * set would still promote a stale memory just to fill the cap.
   */
  readonly minScore?: number;
  /** Cap on promoted memories. Default 3. */
  readonly maxPromoted?: number;
  readonly halfLifeDays?: number;
}

const DEFAULT_MIN_SCORE = 0.5;

export interface PromotedMemory {
  readonly key: string;
  readonly hits: number;
  readonly score: number;
}

/**
 * The memories that have earned promotion into the always-on persona: those
 * with ≥ `minHits` recall hits, ranked by recency-weighted score, capped at
 * `maxPromoted`. Returns the keys + score so the caller can fetch each memory's
 * summary and render it. A memory below the hit floor is never promoted — one
 * coincidental recall shouldn't graduate it.
 */
export function selectPromotableMemories(
  records: readonly RecallHitLike[],
  options: SelectPromotableOptions
): readonly PromotedMemory[] {
  const minHits = Number.isFinite(options.minHits) ? Math.max(1, Math.trunc(options.minHits!)) : DEFAULT_MIN_HITS;
  const maxPromoted = Number.isFinite(options.maxPromoted) ? Math.max(1, Math.trunc(options.maxPromoted!)) : DEFAULT_MAX_PROMOTED;
  const minScore = Number.isFinite(options.minScore) ? Math.max(0, options.minScore!) : DEFAULT_MIN_SCORE;
  return records
    .filter((record) => Number.isFinite(record.hits) && record.hits >= minHits)
    .map((record) => ({ hits: record.hits, key: record.key, score: scoreRecallHit(record, options.nowMs, options.halfLifeDays) }))
    .filter((promoted) => promoted.score >= minScore)
    .sort((left, right) => right.score - left.score)
    .slice(0, maxPromoted);
}

const DAY_MS_FADE = 24 * 60 * 60_000;
const DEFAULT_FADE_MAX_SCORE = 0.25;
const DEFAULT_FADE_MIN_AGE_DAYS = 30;
const DEFAULT_MAX_FADING = 10;

export interface SelectForgettableOptions {
  readonly nowMs: number;
  readonly halfLifeDays?: number;
  /** A memory fades only when its recency-weighted score is at/below this (well under the promote floor). Default 0.25. */
  readonly maxScore?: number;
  /** …AND its last hit was at least this many days ago — never fade something recalled recently, however low its tally. Default 30. */
  readonly minAgeDays?: number;
  /** Cap the fading list. Default 10. */
  readonly maxFading?: number;
}

export interface ForgettingMemory {
  readonly key: string;
  readonly hits: number;
  readonly score: number;
  readonly ageDays: number;
}

/**
 * The "forget" half of sleep consolidation (synaptic tagging & capture; Tetzlaff
 * 2021): a memory that was NOT re-engaged within its window fades, while the
 * salient ones are captured/promoted. A fade candidate is one whose recency-
 * weighted recall score has decayed at/below `maxScore` AND whose last hit was
 * ≥ `minAgeDays` ago — so a recently-useful memory is never a candidate however
 * small its tally. Ranked least-useful first. PURE + non-destructive: it only
 * NAMES what is fading; the caller decides whether to down-rank/archive (Muse
 * never silently deletes the user's data).
 */
export function selectForgettable(
  records: readonly RecallHitLike[],
  options: SelectForgettableOptions
): readonly ForgettingMemory[] {
  const maxScore = Number.isFinite(options.maxScore) ? Math.max(0, options.maxScore!) : DEFAULT_FADE_MAX_SCORE;
  const minAgeDays = Number.isFinite(options.minAgeDays) ? Math.max(0, options.minAgeDays!) : DEFAULT_FADE_MIN_AGE_DAYS;
  const maxFading = Number.isFinite(options.maxFading) ? Math.max(1, Math.trunc(options.maxFading!)) : DEFAULT_MAX_FADING;
  return records
    .map((record) => ({
      ageDays: Math.max(0, (options.nowMs - record.lastHitMs) / DAY_MS_FADE),
      hits: Number.isFinite(record.hits) ? Math.max(0, record.hits) : 0,
      key: record.key,
      score: scoreRecallHit(record, options.nowMs, options.halfLifeDays)
    }))
    .filter((memory) => memory.score <= maxScore && memory.ageDays >= minAgeDays)
    .sort((left, right) => left.score - right.score)
    .slice(0, maxFading);
}

export interface ConsolidationPlan {
  readonly promote: readonly PromotedMemory[];
  readonly fade: readonly ForgettingMemory[];
}

/**
 * One sleep-consolidation pass: which memories to PROMOTE (re-engaged, salient)
 * and which are FADING (decayed + idle). Pure — a background daemon resolves the
 * hit records from disk and runs this when the machine is idle. Non-destructive:
 * the fade list is a report, not a delete.
 */
export function consolidationPlan(
  records: readonly RecallHitLike[],
  options: SelectPromotableOptions & SelectForgettableOptions
): ConsolidationPlan {
  return {
    fade: selectForgettable(records, options),
    promote: selectPromotableMemories(records, options)
  };
}
