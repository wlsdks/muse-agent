/**
 * Retrieval-confidence graders (the answer / clarify / abstain wedge): a
 * deterministic local CRAG verdict over the ranked matches, plus the calibrated
 * cosine bar the chat and recall paths share.
 */

import type { KnowledgeMatch } from "./knowledge-ranking.js";
import { finiteOr } from "./recall-lexical.js";

export type RetrievalConfidence = "confident" | "ambiguous" | "none";

// Conservative top-cosine bar for "confident" when the active embedder is
// UNKNOWN. Calibrated live on nomic-embed-text: a clearly-relevant personal note
// scored ~0.61 while distractors scored ~0.44–0.51, so 0.55 splits them.
// BEST-EFFORT only — the cosine space is compressed, so this flags weak personal
// grounding, it is NOT a hard relevant/irrelevant cut.
export const DEFAULT_CONFIDENT_AT = 0.55;

// The bar is EMBEDDER-SPECIFIC: a different embedder produces a different cosine
// SCALE, so one constant can't serve both. nomic-embed-text-v2-moe (the shipped
// default) lives on a more compressed scale, so the nomic-tuned 0.55 over-abstains
// — it discards genuine matches for no fabrication-safety gain. The v2-moe bar is
// CONFORMAL-CALIBRATED, not guessed: over the 24-answerable / 12-refuse edge corpus
// (`muse doctor --calibration`) genuine matches separate from absents at a clean
// gap [0.415 max-absent, 0.460 first-clear-positive]; a 0.45 bar holds 12/12
// refuses with margin AND lifts answerable coverage 15/24 → 21/24 vs 0.55 (same
// fabrication-safety, far less over-abstention). nomic STAYS 0.55 — at 0.45 its
// 0.44–0.51 distractors would leak (an embedder-blind bump would regress it).
const RECALL_CONFIDENT_BAR_BY_EMBEDDER: Readonly<Record<string, number>> = {
  "nomic-embed-text": 0.55,
  "nomic-embed-text-v2-moe": 0.45
};

/** Strip a provider prefix (`ollama/`) and a `:tag` so `ollama/nomic-…:latest` keys cleanly. */
function normalizeEmbedModelKey(embedModel: string): string {
  return embedModel.trim().replace(/^.*\//u, "").replace(/:.*$/u, "");
}

/**
 * Resolve the recall confidence bar. Precedence:
 *  1. `MUSE_GROUNDING_MIN_COSINE` — an explicit conformal-calibrated override
 *     (`muse doctor --calibration` emits it; KnowNo / conformal, arXiv:2307.01928).
 *  2. The EMBEDDER-SPECIFIC calibrated bar when `embedModel` is a known embedder.
 *  3. The conservative `DEFAULT_CONFIDENT_AT` for an unknown embedder.
 * Fail-safe: a missing / out-of-range env and an unknown embedder both fall back
 * to the conservative 0.55, so the fabrication=0 floor is never weakened by accident.
 */
export function resolveRecallConfidentAt(env: NodeJS.ProcessEnv = process.env, embedModel?: string): number {
  const raw = Number(env.MUSE_GROUNDING_MIN_COSINE);
  if (Number.isFinite(raw) && raw > 0 && raw <= 1) {
    return raw;
  }
  if (embedModel) {
    const bar = RECALL_CONFIDENT_BAR_BY_EMBEDDER[normalizeEmbedModelKey(embedModel)];
    if (bar !== undefined) {
      return bar;
    }
  }
  return DEFAULT_CONFIDENT_AT;
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

// OPT-IN margin PROMOTION (the symmetric counterpart of the flat-demotion). A top
// BELOW the absolute bar but with a CLEAR lead over the runner-up is a confident
// single-entry match, not a weak cluster — so it is promoted to `confident`
// WITHOUT lowering the bar. Rescues short personal-memory entries whose absolute
// cosine sits under a notes-calibrated bar on a compressed-scale embedder
// (nomic-embed-text-v2-moe), measured on the recall-quality golden set: right
// entries lead by margin ≥0.15 while the absent/distractor set is flat (margins
// ≤0.11) AND every absent top is below PROMOTE_FLOOR — so no absent is ever
// promoted, preserving fabrication=0. OFF by default so the shared callers
// (proactive/council/notes) are unchanged; ONLY a path that opts in via
// `promoteOnMargin` gets it. (CRAG arXiv:2401.15884.)
const CONFIDENCE_PROMOTE_FLOOR = 0.45;
const CONFIDENCE_PROMOTE_MARGIN = 0.15;

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
  options?: { readonly confidentAt?: number; readonly promoteOnMargin?: boolean }
): RetrievalConfidence {
  if (matches.length === 0) {
    return "none";
  }
  const confidentAt = finiteOr(options?.confidentAt, DEFAULT_CONFIDENT_AT);
  const scores = matches.map((match) => match.cosine ?? match.score).sort((a, b) => b - a);
  const top = scores[0]!;
  const runnerUp = scores[1] ?? 0;
  const margin = top - runnerUp;
  if (top < confidentAt) {
    // OPT-IN only: a sub-bar top with a clear lead is promoted. Suppressed when a
    // caller RAISED the bar (deliberate stricter abstention — never undercut it).
    return options?.promoteOnMargin
      && confidentAt <= DEFAULT_CONFIDENT_AT
      && top >= CONFIDENCE_PROMOTE_FLOOR
      && margin >= CONFIDENCE_PROMOTE_MARGIN
      ? "confident"
      : "ambiguous";
  }
  const borderlineTop = top < confidentAt + CONFIDENCE_SOFT_BAND;
  const flatDistribution = margin < CONFIDENCE_MIN_MARGIN;
  return borderlineTop && flatDistribution ? "ambiguous" : "confident";
}
