import { lexicalTokens } from "./knowledge-recall.js";
import { splitPreservingSentencePunctuation } from "./internals.js";

/**
 * Epistemic-overclaim / hedge-strip (FActScore atomic-fact certainty, arXiv:2305.14251;
 * faithfulness survey arXiv:2501.00269). Token coverage keeps modal words but never
 * compares their CERTAINTY direction, so an answer that asserts categorically
 * ("the migration breaks the build") fully covers HEDGED evidence ("the migration
 * MAY break the build") — a confidence escalation read as supported. This flags the
 * one-directional case: a high content-overlap answer sentence that DROPS the
 * hedge its evidence sentence carries (evidence hedged ∧ answer categorical). The
 * reverse (answer hedges a categorical evidence) is under-claiming, not a
 * fabrication, and is NOT flagged. Sentence-granular. Pure.
 */
const HEDGE_RE = /\b(?:may|might|could|possibly|perhaps|likely|probably|seems?|appears?|reportedly|allegedly|presumably|apparently)\b/iu;

export const HEDGE_OVERLAP_FLOOR = 0.6;

function isHedged(text: string): boolean {
  return HEDGE_RE.test(text);
}

export function detectHedgeOverclaim(
  sentence: string,
  evidence: readonly string[],
  floor?: number
): boolean {
  const overlapFloor =
    typeof floor === "number" && Number.isFinite(floor) && floor > 0 ? floor : HEDGE_OVERLAP_FLOOR;
  if (isHedged(sentence)) return false; // the answer itself hedges — no overclaim
  const sentenceTokens = lexicalTokens(sentence);
  if (sentenceTokens.size === 0) return false;
  for (const block of evidence) {
    for (const evidenceSentence of splitPreservingSentencePunctuation(block)) {
      if (!isHedged(evidenceSentence)) continue;
      const evidenceTokens = lexicalTokens(evidenceSentence);
      if (evidenceTokens.size === 0) continue;
      let overlap = 0;
      for (const token of sentenceTokens) {
        if (evidenceTokens.has(token)) overlap += 1;
      }
      if (overlap / sentenceTokens.size >= overlapFloor) return true;
    }
  }
  return false;
}
