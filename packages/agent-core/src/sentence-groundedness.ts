import { lexicalTokens } from "./knowledge-recall.js";
import { splitPreservingSentencePunctuation } from "./internals.js";

export type SentenceGroundedness = "supported" | "unsupported";

export interface SentenceGroundednessLabel {
  readonly sentence: string;
  readonly label: SentenceGroundedness;
  readonly coverage: number;
}

export interface GroundednessReport {
  readonly sentences: readonly SentenceGroundednessLabel[];
  readonly unsupportedCount: number;
  readonly unsupportedFraction: number;
}

// Per-sentence diagnosis is stricter than the lenient episode-ingest floor —
// a sentence needs ≥half its content tokens in evidence to count supported.
export const DEFAULT_SENTENCE_GROUNDING_FLOOR = 0.5;

/**
 * A per-sentence grounding DIAGNOSTIC (hallucinations_v1-style): split `answer`
 * into sentences and label each supported/unsupported by the SAME deterministic
 * token-coverage the recall gate uses — fraction of the sentence's content
 * tokens present in the union of `evidence` source texts, supported when ≥ floor.
 * Localises WHICH sentence is un-groundable so self-improvement can report it.
 * Diagnostic only — it changes no gate verdict. Pure. A sentence with no content
 * tokens (punctuation/stopwords only) asserts nothing and is omitted from the
 * report + the denominator. Empty evidence ⇒ every content sentence unsupported.
 */
export function reportSentenceGroundedness(
  answer: string,
  evidence: readonly string[],
  floor?: number
): GroundednessReport {
  const effectiveFloor =
    typeof floor === "number" && Number.isFinite(floor) && floor > 0
      ? floor
      : DEFAULT_SENTENCE_GROUNDING_FLOOR;

  const evidenceTokens = new Set<string>();
  for (const e of evidence) {
    for (const token of lexicalTokens(e)) {
      evidenceTokens.add(token);
    }
  }

  const raw = splitPreservingSentencePunctuation(answer);
  const labelled: SentenceGroundednessLabel[] = [];

  for (const sentence of raw) {
    const tokens = lexicalTokens(sentence);
    if (tokens.size === 0) {
      continue;
    }
    let covered = 0;
    for (const token of tokens) {
      if (evidenceTokens.has(token)) {
        covered += 1;
      }
    }
    const coverage = covered / tokens.size;
    const label: SentenceGroundedness = coverage >= effectiveFloor ? "supported" : "unsupported";
    labelled.push({ sentence, label, coverage });
  }

  const unsupportedCount = labelled.filter((l) => l.label === "unsupported").length;
  const unsupportedFraction = labelled.length === 0 ? 0 : unsupportedCount / labelled.length;

  return { sentences: labelled, unsupportedCount, unsupportedFraction };
}
