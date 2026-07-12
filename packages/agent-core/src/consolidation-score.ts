/**
 * Deterministic sleep-consolidation promotion score: which episodic memories
 * are worth promoting to durable storage. Re-recall COUNT, RECENCY, and (when
 * available) DISTINCT-QUERY breadth are cheap, LLM-free signals that track
 * "this keeps proving useful" — no model call, no judgment, no write.
 *
 * This is a SELECTION score only. It never promotes or persists anything —
 * that is a separate, draft-first step (a memory promoted without user
 * confirmation would defeat the correction-forgetting guarantee: durable
 * storage must only ever grow through a reviewable path).
 *
 * Recency here is a plain half-life decay `2^(-ageDays/halfLifeDays)`, NOT
 * the ACT-R power-law in `actr-activation.ts` — that model needs the full
 * access-time history, which the recall-hits ledger does not keep (it stores
 * `hits` + `lastHitMs` only). Half-life decay needs just the last hit.
 */

export interface ConsolidationCandidateSignals {
  readonly hits: number;
  readonly createdMs: number;
  readonly lastHitMs: number;
  /**
   * Distinct queries that recalled this memory. Optional: the recall-hits
   * ledger does not track this yet. When absent, the diversity term is
   * neutral (1) rather than penalizing — a future ledger slice can supply it
   * without changing today's scores.
   */
  readonly distinctQueries?: number;
}

export const DEFAULT_CONSOLIDATION_HALF_LIFE_DAYS = 14;
export const DEFAULT_CONSOLIDATION_THRESHOLD = 1.0;

const DAY_MS = 86_400_000;

/**
 * Higher = better durable-promotion candidate. Pure and side-effect-free:
 * no I/O, no mutation of `signals`, never writes or promotes anything.
 */
export function scoreConsolidationCandidate(
  signals: ConsolidationCandidateSignals,
  nowMs: number,
  opts?: { readonly halfLifeDays?: number }
): number {
  const { hits, lastHitMs, distinctQueries } = signals;
  if (!Number.isFinite(hits) || hits <= 0 || !Number.isFinite(lastHitMs) || !Number.isFinite(nowMs)) {
    return 0;
  }
  const halfLifeDays = opts?.halfLifeDays ?? DEFAULT_CONSOLIDATION_HALF_LIFE_DAYS;
  const ageDays = Math.max(0, (nowMs - lastHitMs) / DAY_MS);
  const recency = Math.pow(2, -ageDays / halfLifeDays);
  const frequency = Math.log2(1 + hits);
  const diversity =
    distinctQueries !== undefined && Number.isFinite(distinctQueries) && hits > 0
      ? 1 + Math.max(0, Math.min(1, (distinctQueries - 1) / hits))
      : 1;
  return frequency * recency * diversity;
}

/** True when a candidate's score clears the promotion-consideration bar. Selection only — never a write. */
export function isConsolidationCandidate(
  score: number,
  threshold: number = DEFAULT_CONSOLIDATION_THRESHOLD
): boolean {
  return Number.isFinite(score) && score >= threshold;
}
