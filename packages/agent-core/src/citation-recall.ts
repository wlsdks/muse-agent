import { lexicalTokens, type KnowledgeMatch } from "./knowledge-recall.js";
import { splitPreservingSentencePunctuation } from "./internals.js";

/**
 * ALCE citation RECALL (arXiv:2305.14627) — the complement to citation precision.
 * Precision asks "is the cited source right?"; recall asks "does every groundable
 * claim actually CARRY a citation?" A sentence whose claim IS in the retrieved
 * evidence but that omits its `[from <source>]` marker is an UNCITED-but-citable
 * claim — it passes every existing gate silently (sentence-groundedness measures
 * union support but is citation-agnostic; precision only judges the citations that
 * ARE present). This localises the missing attributions. Diagnostic — changes no
 * gate verdict (mirrors sentence-groundedness / citation-precision). Pure.
 */
export interface CitationRecallReport {
  /** Sentences whose claim is supported by the union of evidence (≥ floor) — i.e. citable. */
  readonly citableCount: number;
  /** Of the citable sentences, how many actually carry a `[from <source>]` marker. */
  readonly citedCount: number;
  /** Fraction of citable sentences that carry a citation. 1 when nothing is citable. */
  readonly recall: number;
  /** Citable sentences that omit a citation (the missing attributions). */
  readonly uncited: readonly string[];
}

/** A sentence counts as citable when ≥ this fraction of its content tokens are in the evidence union. */
export const DEFAULT_CITATION_RECALL_FLOOR = 0.5;

const CITATION_FROM_RE = /\[from\s+([^\]]+?)\s*\]/giu;
// Private-use sentinel so a `[from x.md]` marker's internal "." can't split a
// sentence; its presence in a masked sentence marks "this sentence was cited".
const SENTINEL = "\u{E000}";
const SENTINEL_RE = /\u{E000}\d+\u{E000}/gu;

/**
 * Remove `[from <source>]` citation markers from an answer — they are Muse's own
 * attribution metadata, not claims, and their internal "." (e.g. `.md]`) would
 * otherwise split into a junk sentence that a per-sentence groundedness probe
 * scores unsupported (an observed misgrounding false positive). Pure.
 */
export function stripCitationMarkers(text: string): string {
  return text.replace(CITATION_FROM_RE, " ");
}

export function reportCitationRecall(
  answer: string,
  matches: readonly KnowledgeMatch[],
  floor?: number
): CitationRecallReport {
  const effectiveFloor =
    typeof floor === "number" && Number.isFinite(floor) && floor > 0 ? floor : DEFAULT_CITATION_RECALL_FLOOR;

  const evidenceTokens = new Set<string>();
  for (const match of matches) {
    for (const token of lexicalTokens(match.text)) evidenceTokens.add(token);
  }

  let counter = 0;
  const masked = answer.replace(CITATION_FROM_RE, () => ` ${SENTINEL}${(counter++).toString()}${SENTINEL} `);

  let citableCount = 0;
  let citedCount = 0;
  const uncited: string[] = [];

  for (const sentenceMasked of splitPreservingSentencePunctuation(masked)) {
    const hasCitation = sentenceMasked.includes(SENTINEL);
    const sentence = sentenceMasked.replace(SENTINEL_RE, " ").replace(/\s+/gu, " ").trim();
    const tokens = lexicalTokens(sentence);
    if (tokens.size === 0) continue;
    let covered = 0;
    for (const token of tokens) {
      if (evidenceTokens.has(token)) covered += 1;
    }
    const citable = covered / tokens.size >= effectiveFloor;
    if (!citable) continue;
    citableCount += 1;
    if (hasCitation) citedCount += 1;
    else uncited.push(sentence);
  }

  const recall = citableCount === 0 ? 1 : citedCount / citableCount;
  return { citableCount, citedCount, recall, uncited };
}
