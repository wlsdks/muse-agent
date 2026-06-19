import { lexicalTokens } from "./knowledge-recall.js";
import { splitPreservingSentencePunctuation } from "./internals.js";
import { detectPolarityMismatch } from "./polarity-mismatch.js";
import { detectNumericMismatch } from "./numeric-mismatch.js";
import { detectHedgeOverclaim } from "./hedge-overclaim.js";

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
    // Polarity guard: token coverage strips "no"/"not", so a NEGATED contradiction
    // ("X is not effective" vs evidence "X is effective") scores fully supported.
    // A token-supported sentence that contradicts its overlapping evidence sentence
    // on negation polarity is fail-closed to unsupported (arXiv:2305.16819).
    const label: SentenceGroundedness =
      coverage >= effectiveFloor && !detectPolarityMismatch(sentence, evidence) && !detectNumericMismatch(sentence, evidence) && !detectHedgeOverclaim(sentence, evidence)
        ? "supported"
        : "unsupported";
    labelled.push({ sentence, label, coverage });
  }

  const unsupportedCount = labelled.filter((l) => l.label === "unsupported").length;
  const unsupportedFraction = labelled.length === 0 ? 0 : unsupportedCount / labelled.length;

  return { sentences: labelled, unsupportedCount, unsupportedFraction };
}

/**
 * The single most un-groundable sentence (lowest coverage among the
 * `unsupported` ones) — the actionable pointer for fuel/diagnostics: "this is
 * the sentence the evidence didn't support". undefined when nothing is
 * unsupported. Ties resolve to the earliest sentence.
 */
export function worstUnsupportedSentence(report: GroundednessReport): string | undefined {
  let worst: SentenceGroundednessLabel | undefined;
  for (const label of report.sentences) {
    if (label.label !== "unsupported") continue;
    if (worst === undefined || label.coverage < worst.coverage) worst = label;
  }
  return worst?.sentence;
}

/**
 * The unsupported fraction over ASSERTIVE sentences only — interrogative
 * sentences (a follow-up question / pleasantry the agent appends, e.g. "anything
 * else?") are not claims, so they cannot be misgrounded and must not inflate the
 * denominator. This is the misgrounding signal's input: a grounded answer whose
 * only unbacked sentence is a trailing question is NOT a misgrounding (an observed
 * false positive on the conversational local model). 0 when nothing assertive
 * remains. Pure.
 */
/**
 * The non-interrogative ("assertive") sentences — the ones a misgrounding probe
 * scores. A follow-up question / pleasantry ("anything else?") is not a claim
 * that can be misgrounded, so it is excluded from the denominator. Single source
 * of the interrogative filter, shared with the cross-lingual semantic probe.
 */
export function assertiveLabels(report: GroundednessReport): readonly SentenceGroundednessLabel[] {
  return report.sentences.filter((s) => {
    const trimmed = s.sentence.trim();
    return !trimmed.endsWith("?") && !trimmed.endsWith("？");
  });
}

export function assertiveUnsupportedFraction(report: GroundednessReport): number {
  const assertive = assertiveLabels(report);
  if (assertive.length === 0) return 0;
  const unsupported = assertive.filter((s) => s.label === "unsupported").length;
  return unsupported / assertive.length;
}
