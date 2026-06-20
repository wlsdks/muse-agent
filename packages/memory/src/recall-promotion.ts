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
  /** Epoch-ms of recent accesses (chronological), for ACT-R activation ranking. Optional — legacy records have only lastHitMs. */
  readonly recentAccessMs?: readonly number[];
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
  /**
   * When true, rank by ACT-R base-level activation (frequency×spacing) instead
   * of the plain recency-weighted score. The eligibility FILTER is unchanged —
   * only sort order.
   */
  readonly useActrRanking?: boolean;
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
  const nowMs = options.nowMs;
  const useActr = options.useActrRanking === true;
  type WithActr = PromotedMemory & { readonly activation: number };
  const mapped = records
    .filter((record) => Number.isFinite(record.hits) && record.hits >= minHits)
    .map((record): WithActr => ({
      hits: record.hits,
      key: record.key,
      score: scoreRecallHit(record, nowMs, options.halfLifeDays),
      activation: useActr ? recallActivation(record, nowMs) : 0
    }))
    .filter((promoted) => promoted.score >= minScore);
  if (useActr) {
    mapped.sort((left, right) => right.activation - left.activation || right.score - left.score);
  } else {
    mapped.sort((left, right) => right.score - left.score);
  }
  return mapped.slice(0, maxPromoted).map(({ key, hits, score }) => ({ key, hits, score }));
}

const DAY_MS_FADE = 24 * 60 * 60_000;
const DEFAULT_FADE_MAX_SCORE = 0.25;
const DEFAULT_FADE_MIN_AGE_DAYS = 30;
const DEFAULT_MAX_FADING = 10;
/**
 * Lifetime recall hits at/above which a memory RESISTS fading even when idle and
 * decayed (MemoryBank, arXiv:2305.10250 — frequency consolidates a memory's
 * strength so it survives the Ebbinghaus curve). Well above the promote floor
 * (DEFAULT_MIN_HITS = 3): only a genuinely well-established memory is protected.
 * Reasoning-set; tune on a real recall-hit distribution (see backlog ◦).
 */
const DEFAULT_FADE_IMPORTANCE_HITS = 8;

export interface SelectForgettableOptions {
  readonly nowMs: number;
  readonly halfLifeDays?: number;
  /** A memory fades only when its recency-weighted score is at/below this (well under the promote floor). Default 0.25. */
  readonly maxScore?: number;
  /** …AND its last hit was at least this many days ago — never fade something recalled recently, however low its tally. Default 30. */
  readonly minAgeDays?: number;
  /** Cap the fading list. Default 10. */
  readonly maxFading?: number;
  /**
   * A memory with at least this many LIFETIME recall hits resists fading even
   * when idle and decayed — its frequency has consolidated it (MemoryBank
   * importance term, arXiv:2305.10250). Distinct from the recency-weighted score
   * (which decays hits by age): a long-idle but heavily-recalled memory has a low
   * score yet high lifetime frequency, and should not be down-ranked. Default 8.
   */
  readonly importanceHitsFloor?: number;
  /**
   * When true, rank by ACT-R base-level activation (frequency×spacing) instead
   * of the plain recency-weighted score. The eligibility FILTER is unchanged —
   * only sort order.
   */
  readonly useActrRanking?: boolean;
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
  const importanceHitsFloor = Number.isFinite(options.importanceHitsFloor) ? Math.max(1, Math.trunc(options.importanceHitsFloor!)) : DEFAULT_FADE_IMPORTANCE_HITS;
  const nowMs = options.nowMs;
  const useActr = options.useActrRanking === true;
  type WithActr = ForgettingMemory & { readonly activation: number };
  const mapped = records
    .map((record): WithActr => ({
      ageDays: Math.max(0, (nowMs - record.lastHitMs) / DAY_MS_FADE),
      hits: Number.isFinite(record.hits) ? Math.max(0, record.hits) : 0,
      key: record.key,
      score: scoreRecallHit(record, nowMs, options.halfLifeDays),
      activation: useActr ? recallActivation(record, nowMs) : 0
    }))
    .filter((memory) => memory.score <= maxScore && memory.ageDays >= minAgeDays && memory.hits < importanceHitsFloor);
  if (useActr) {
    mapped.sort((left, right) => left.activation - right.activation || left.score - right.score);
  } else {
    mapped.sort((left, right) => left.score - right.score);
  }
  return mapped.slice(0, maxFading).map(({ key, hits, score, ageDays }) => ({ key, hits, score, ageDays }));
}

/**
 * ACT-R base-level activation (Anderson & Schooler 1991): B = ln(Σ_j tⱼ^(-d))
 * over the age of EACH past access tⱼ (days), decay d (default 0.5). Unlike a
 * single last-hit half-life, summing over every access captures BOTH frequency
 * (more terms ⇒ higher B) AND spacing (each access decays on its own clock, so a
 * memory practised in a distributed way retains activation a massed one loses).
 * Ages are clamped to `minAgeDays` (default 1/24 ≈ 1h) so a just-now access can't
 * blow the power term to Infinity; a future-dated access (negative age) clamps too.
 * Empty access list ⇒ -Infinity (no activation; the caller floors/filters it).
 */
export function actrActivation(
  accessAgesDays: readonly number[],
  options: { readonly decay?: number; readonly minAgeDays?: number } = {}
): number {
  const decay = Number.isFinite(options.decay) && options.decay! > 0 ? options.decay! : 0.5;
  const minAgeDays = Number.isFinite(options.minAgeDays) && options.minAgeDays! > 0 ? options.minAgeDays! : 1 / 24;
  let sum = 0;
  for (const age of accessAgesDays) {
    if (!Number.isFinite(age)) continue;
    sum += Math.pow(Math.max(age, minAgeDays), -decay);
  }
  return sum <= 0 ? -Infinity : Math.log(sum);
}

/**
 * ACT-R activation of a recall record for RANKING: over its recentAccessMs if
 * present, else over a single access at lastHitMs (recency-only activation — a
 * graceful fallback that keeps legacy records on the SAME log scale as full
 * ones, so a mixed set sorts coherently). Uses actrActivation under the hood.
 */
export function recallActivation(record: RecallHitLike, nowMs: number, decay?: number): number {
  const toAgeDays = (ms: number): number => (nowMs - ms) / DAY_MS;
  const ages = record.recentAccessMs && record.recentAccessMs.length > 0
    ? record.recentAccessMs.map(toAgeDays)
    : [toAgeDays(record.lastHitMs)];
  return actrActivation(ages, decay !== undefined ? { decay } : {});
}

export const DEFAULT_CONSOLIDATION_MIN_INTERVAL_MS = 6 * 60 * 60_000;
export const DEFAULT_CONSOLIDATION_MIN_NEW_HITS = 3;

export interface ConsolidationScheduleInput {
  readonly nowMs: number;
  /** Epoch-ms of the last consolidation run, or undefined if it has never run. */
  readonly lastRunMs: number | undefined;
  /** Recall hits accrued since the last run (the new material to consolidate). */
  readonly newHitsSinceLastRun: number;
  /** Brake: don't re-run within this window (default 6h). */
  readonly minIntervalMs?: number;
  /** Don't run with fewer than this many new hits (default 3). */
  readonly minNewHits?: number;
}

/**
 * Brake-first gate for a BACKGROUND memory-consolidation tick: run only when
 * BOTH enough new recall material has accrued (≥ minNewHits) AND enough time has
 * passed since the last run (≥ minIntervalMs) — so the daemon never churns
 * consolidation on idle ticks or on near-zero new material (non-straining
 * background self-learning). A never-run state (lastRunMs undefined) only needs
 * the material threshold. Pure; non-finite/negative inputs fail safe to false.
 */
export function shouldConsolidateMemory(input: ConsolidationScheduleInput): boolean {
  const minInterval = Number.isFinite(input.minIntervalMs) && (input.minIntervalMs as number) > 0 ? (input.minIntervalMs as number) : DEFAULT_CONSOLIDATION_MIN_INTERVAL_MS;
  const minNewHits = Number.isFinite(input.minNewHits) && (input.minNewHits as number) > 0 ? Math.trunc(input.minNewHits as number) : DEFAULT_CONSOLIDATION_MIN_NEW_HITS;
  const newHits = Number.isFinite(input.newHitsSinceLastRun) ? input.newHitsSinceLastRun : 0;
  if (newHits < minNewHits) return false;
  if (!Number.isFinite(input.nowMs)) return false;
  if (input.lastRunMs === undefined) return true;
  if (!Number.isFinite(input.lastRunMs)) return true;
  return input.nowMs - input.lastRunMs >= minInterval;
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

export interface MemoryConsolidationTickState {
  /** Epoch-ms of the last consolidation run, or undefined if never run. */
  readonly lastRunMs: number | undefined;
}

export interface MemoryConsolidationTickResult {
  /** Did the brake pass (consolidation actually computed this tick)? */
  readonly ran: boolean;
  /** The promote/fade plan — present only when `ran`. */
  readonly plan?: ConsolidationPlan;
  /** The scheduling state to persist for the next tick (advanced only when it ran). */
  readonly nextState: MemoryConsolidationTickState;
}

/**
 * One background memory-consolidation tick, decided + computed in one pure step:
 * count the recall records re-engaged since the last run (lastHitMs newer than
 * lastRunMs — that's the NEW material), gate on shouldConsolidateMemory (the
 * brake), and only when it passes compute consolidationPlan. Returns the plan +
 * the next state (lastRunMs advanced ONLY when it ran). The daemon supplies the
 * records (readRecallHits) and persists nextState; this stays pure + testable.
 */
export function planMemoryConsolidationTick(
  records: readonly RecallHitLike[],
  state: MemoryConsolidationTickState,
  options: SelectPromotableOptions & SelectForgettableOptions & { readonly minIntervalMs?: number; readonly minNewHits?: number }
): MemoryConsolidationTickResult {
  const sinceMs = state.lastRunMs ?? Number.NEGATIVE_INFINITY;
  const newHitsSinceLastRun = records.reduce(
    (n, r) => (Number.isFinite(r.lastHitMs) && r.lastHitMs > sinceMs ? n + 1 : n),
    0
  );
  const go = shouldConsolidateMemory({
    nowMs: options.nowMs,
    lastRunMs: state.lastRunMs,
    newHitsSinceLastRun,
    ...(options.minIntervalMs !== undefined ? { minIntervalMs: options.minIntervalMs } : {}),
    ...(options.minNewHits !== undefined ? { minNewHits: options.minNewHits } : {})
  });
  if (!go) return { ran: false, nextState: state };
  return { ran: true, plan: consolidationPlan(records, options), nextState: { lastRunMs: options.nowMs } };
}
