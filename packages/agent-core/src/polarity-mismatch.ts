import { lexicalTokens } from "./knowledge-recall.js";
import { splitPreservingSentencePunctuation } from "./internals.js";

/**
 * Polarity-mismatch contradiction (arXiv:2305.16819; hallucination survey
 * arXiv:2510.06265 "switching negation"). Token-coverage grounding strips "no"/
 * "not" as stopwords (knowledge-recall LEXICAL_STOPWORDS), so "X is NOT effective"
 * scores IDENTICAL coverage to "X is effective" — a negated CONTRADICTION read as
 * supported. This is the one class the lexical/coverage gate is structurally blind
 * to. Flags an answer sentence with high content-token overlap to an evidence
 * sentence but OPPOSITE negation polarity. Compared at SENTENCE granularity so a
 * stray negation elsewhere in the evidence block doesn't false-fire. Pure.
 */
const NEGATION_RE = /\b(?:not|no|never|without|cannot|none|neither|nor)\b|\b\w*n't\b|\bfails?\s+to\b/iu;

/** Default content-token overlap above which two sentences are "the same claim". */
export const POLARITY_OVERLAP_FLOOR = 0.6;

function hasNegation(text: string): boolean {
  return NEGATION_RE.test(text);
}

export function detectPolarityMismatch(
  sentence: string,
  evidence: readonly string[],
  floor?: number
): boolean {
  const overlapFloor =
    typeof floor === "number" && Number.isFinite(floor) && floor > 0 ? floor : POLARITY_OVERLAP_FLOOR;
  const sentenceTokens = lexicalTokens(sentence);
  if (sentenceTokens.size === 0) return false;
  const sentenceNegated = hasNegation(sentence);
  for (const block of evidence) {
    for (const evidenceSentence of splitPreservingSentencePunctuation(block)) {
      const evidenceTokens = lexicalTokens(evidenceSentence);
      if (evidenceTokens.size === 0) continue;
      let overlap = 0;
      for (const token of sentenceTokens) {
        if (evidenceTokens.has(token)) overlap += 1;
      }
      if (overlap / sentenceTokens.size >= overlapFloor && hasNegation(evidenceSentence) !== sentenceNegated) {
        return true;
      }
    }
  }
  return false;
}
