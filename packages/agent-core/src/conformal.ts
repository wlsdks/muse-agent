/**
 * Split-conformal calibration for a "should I answer, or abstain?" gate.
 *
 * Muse's grounding floor decides when to say "I'm not sure" from a confidence
 * SCORE (top retrieval cosine, a rubric score, …). Today that cutoff is a
 * hand-tuned magic number. Conformal prediction (Vovk et al.; Angelopoulos &
 * Bates 2022, arXiv:2107.07511; Mohri & Hashimoto, ICML 2024) replaces it with a
 * threshold CALIBRATED on a held-out set so the gate carries a distribution-free,
 * finite-sample GUARANTEE: of the items that truly SHOULD be answered, at least
 * (1 - alpha) get answered (coverage ≥ 1 - alpha) — no assumption on the score
 * distribution, only exchangeability.
 *
 * This is the deterministic core (no model, no I/O) and the calibration brake the
 * Whetstone axis calls for. It NEVER fabricates: it only chooses when to abstain,
 * and a too-low calibration set can only make the gate MORE permissive (it can't
 * invent confidence).
 *
 * The mechanism, plainly: collect the confidence scores of the ANSWERABLE
 * calibration items, sort them, and take the `floor(alpha * (n + 1))`-th smallest
 * as the threshold tau. Answer when score ≥ tau, abstain below. The `+1` is the
 * finite-sample conformal correction that makes the coverage bound exact.
 */

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return value > 0 ? 1 : 0;
  }
  return Math.min(1, Math.max(0, value));
}

/**
 * The conformal abstention threshold tau. `positiveScores` are the confidence
 * scores of calibration items that SHOULD be answered (higher = more confident);
 * `alpha` is the tolerated miss rate (0.1 → answer ≥ 90% of answerable items).
 * Answer when an item's score ≥ tau, else abstain.
 *
 * Guarantees (deterministic, finite-sample):
 *  - Empty calibration set → -Infinity: with no evidence to calibrate on, the
 *    gate must NOT invent refusals — it stays fully permissive (answer all), so
 *    enabling calibration on a fresh corpus can never REGRESS the floor.
 *  - alpha so small that `floor(alpha*(n+1)) == 0` → -Infinity (answer all).
 *  - alpha so large that the rank exceeds n → +Infinity (abstain on everything).
 *  - Otherwise tau is the k-th smallest score, k = floor(alpha*(n+1)); on the
 *    calibration set this yields coverage = (n - k + 1)/n ≥ 1 - alpha exactly.
 */
export function conformalThreshold(positiveScores: readonly number[], alpha: number): number {
  const n = positiveScores.length;
  if (n === 0) {
    return Number.NEGATIVE_INFINITY;
  }
  const a = clamp01(alpha);
  const rank = Math.floor(a * (n + 1));
  if (rank <= 0) {
    return Number.NEGATIVE_INFINITY;
  }
  if (rank > n) {
    return Number.POSITIVE_INFINITY;
  }
  const sorted = [...positiveScores].sort((x, y) => x - y);
  return sorted[rank - 1]!;
}

/**
 * The fraction of `scores` at or above `threshold` — the empirical coverage of
 * the gate (how many answerable items it would still answer). Empty set → 1
 * (nothing to miss).
 */
export function empiricalCoverage(scores: readonly number[], threshold: number): number {
  if (scores.length === 0) {
    return 1;
  }
  const kept = scores.reduce((count, score) => (score >= threshold ? count + 1 : count), 0);
  return kept / scores.length;
}

export interface CalibrationResult {
  /** The abstention threshold: answer when score ≥ threshold. */
  readonly threshold: number;
  /** Target coverage 1 - alpha. */
  readonly targetCoverage: number;
  /** Coverage measured on the calibration set itself (always ≥ targetCoverage). */
  readonly calibrationCoverage: number;
  /** Calibration sample size. */
  readonly n: number;
}

/**
 * Calibrate the abstention gate in one call: returns the threshold plus the
 * coverage it achieves on the calibration set (a sanity readout — the held-out
 * guarantee is what matters, but this confirms the construction). `alpha`
 * defaults to 0.1 (a 90% coverage target).
 */
export function calibrateAbstention(positiveScores: readonly number[], alpha = 0.1): CalibrationResult {
  const a = clamp01(alpha);
  const threshold = conformalThreshold(positiveScores, a);
  return {
    calibrationCoverage: empiricalCoverage(positiveScores, threshold),
    n: positiveScores.length,
    targetCoverage: 1 - a,
    threshold
  };
}
