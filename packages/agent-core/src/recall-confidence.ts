/**
 * Retrieval-confidence graders (the answer / clarify / abstain wedge): a
 * deterministic local CRAG verdict over the ranked matches, plus the calibrated
 * cosine bar the chat and recall paths share.
 */

import type { KnowledgeMatch } from "./knowledge-ranking.js";
import { finiteOr } from "./recall-lexical.js";

export type RetrievalConfidence = "confident" | "ambiguous" | "none";

// Default top-cosine bar for "confident". Calibrated live on nomic-embed-text:
// a clearly-relevant personal note scored ~0.61 while personal distractors
// scored ~0.44–0.51, so 0.55 splits them. BEST-EFFORT only — nomic's cosine
// space is compressed (even unrelated encyclopedic text can score ~0.54), so
// this flags weak personal grounding, it is NOT a hard relevant/irrelevant cut.
export const DEFAULT_CONFIDENT_AT = 0.55;

/**
 * Resolve the recall confidence bar from `MUSE_GROUNDING_MIN_COSINE` — the
 * conformal-calibrated threshold `muse doctor --calibration` emits (KnowNo /
 * conformal prediction, arXiv:2307.01928). Mirrors the chat gate's parse
 * (`resolveGroundingMinScore`) EXACTLY so chat and the RGV recall path agree on
 * one number: finite, `> 0 && <= 1`, else the hardcoded `DEFAULT_CONFIDENT_AT`.
 * STRICTLY opt-in and fail-safe: a missing or out-of-range env changes nothing,
 * so the fabrication=0 floor is preserved; a valid override may only RAISE the
 * abstention bar.
 */
export function resolveRecallConfidentAt(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.MUSE_GROUNDING_MIN_COSINE);
  return Number.isFinite(raw) && raw > 0 && raw <= 1 ? raw : DEFAULT_CONFIDENT_AT;
}

// Margin calibration (adaptive confidence). Near the compressed-cosine floor a
// single absolute threshold is fragile: an out-of-corpus query can clip a
// near-miss note just over the bar. So a `confident` top that is BOTH
// borderline (within `SOFT_BAND` of the floor) AND has no clear lead over the
// runner-up (`MIN_MARGIN`) is treated as a FLAT distribution — the query
// matches several notes weakly rather than one strongly (the off-corpus
// near-miss signature) — and demoted to `ambiguous`. A clearly-high top, or a
// clear top-to-runner-up gap, stays confident, so genuine single-note matches
// are untouched. Tuned so only the flat near-miss flips (CRAG arXiv:2401.15884).
const CONFIDENCE_SOFT_BAND = 0.05;
const CONFIDENCE_MIN_MARGIN = 0.08;

/**
 * CRAG (arXiv 2401.15884): a lightweight retrieval evaluator grades whether
 * the retrieved evidence is trustworthy. Deterministic local version — the
 * verdict comes from the TOP match's ABSOLUTE cosine (not the RRF score):
 * `confident` ≥ `confidentAt`, `ambiguous` when some match is present but
 * weak, `none` when nothing was retrieved. A borderline-confident top with a
 * flat distribution (no lead over the runner-up) is demoted to `ambiguous` —
 * the margin guard above. The caller frames/gates by it so a weak match isn't
 * presented to the small model as something to cite.
 */
export function classifyRetrievalConfidence(
  matches: readonly KnowledgeMatch[],
  options?: { readonly confidentAt?: number }
): RetrievalConfidence {
  if (matches.length === 0) {
    return "none";
  }
  const confidentAt = finiteOr(options?.confidentAt, DEFAULT_CONFIDENT_AT);
  const scores = matches.map((match) => match.cosine ?? match.score).sort((a, b) => b - a);
  const top = scores[0]!;
  if (top < confidentAt) {
    return "ambiguous";
  }
  const runnerUp = scores[1] ?? 0;
  const borderlineTop = top < confidentAt + CONFIDENCE_SOFT_BAND;
  const flatDistribution = top - runnerUp < CONFIDENCE_MIN_MARGIN;
  return borderlineTop && flatDistribution ? "ambiguous" : "confident";
}
