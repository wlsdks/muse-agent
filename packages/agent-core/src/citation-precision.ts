import { lexicalTokens, type KnowledgeMatch } from "./knowledge-recall.js";
import { splitPreservingSentencePunctuation } from "./internals.js";

/**
 * ALCE citation PRECISION (arXiv:2305.14627) — the "right source, wrong claim"
 * check Muse lacked. `enforceAnswerCitations` strips a citation only when its
 * target is NOT a retrieved source (citation EXISTENCE); `reportSentenceGroundedness`
 * scores a sentence against the UNION of all evidence. Neither asks the ALCE
 * question: does the SPECIFIC source a sentence cites actually support THAT
 * sentence? A citation can resolve to a real retrieved note yet that note say
 * nothing about the sentence's claim ("Your flight is 9am [from notes/vpn.md]").
 *
 * This is the per-(sentence, cited-source) token-support diagnostic, scoring each
 * sentence ONLY against the text of the source it cites. Diagnostic — it changes
 * no gate verdict (mirrors sentence-groundedness). Pure.
 */
export interface CitationPrecisionPair {
  readonly sentence: string;
  /** The cited source string, as written in the `[from <source>]` marker. */
  readonly source: string;
  /** Did the cited source resolve to one of the retrieved matches? */
  readonly resolved: boolean;
  /** Does that cited source's text support the sentence (coverage ≥ floor)? */
  readonly supported: boolean;
  readonly coverage: number;
}

export interface CitationPrecisionReport {
  readonly pairs: readonly CitationPrecisionPair[];
  /** Fraction of cited (sentence, source) pairs whose cited source supports the sentence. 1 when there are no citations. */
  readonly precision: number;
  /** Sentences carrying at least one citation whose cited source does NOT support them. */
  readonly unsupported: readonly string[];
}

/** A sentence needs ≥ this fraction of its content tokens in the CITED source to count supported. */
export const DEFAULT_CITATION_PRECISION_FLOOR = 0.5;

const CITATION_FROM_RE = /\[from\s+([^\]]+?)\s*\]/giu;
// Private-use sentinel so a `[from x.md]` marker's internal "." can't split a
// sentence; the index between sentinels is stripped before tokenizing.
const SENTINEL = "\u{E000}";
const SENTINEL_RE = /\u{E000}(\d+)\u{E000}/gu;

/**
 * Per-(sentence, cited-source) support. Citations are masked to sentinels BEFORE
 * sentence-splitting (so a `vpn.md` source's "." doesn't break a sentence), then
 * each sentence is scored against ONLY the text of the source(s) it cites. A
 * sentence with no citation contributes no pair. `precision` is 1 when there are
 * no cited pairs (nothing to get wrong).
 */
export function reportCitationPrecision(
  answer: string,
  matches: readonly KnowledgeMatch[],
  floor?: number
): CitationPrecisionReport {
  const effectiveFloor =
    typeof floor === "number" && Number.isFinite(floor) && floor > 0 ? floor : DEFAULT_CITATION_PRECISION_FLOOR;

  const sourceText = new Map<string, string>();
  for (const match of matches) {
    sourceText.set(match.source.trim().toLowerCase(), match.text);
  }

  const citedSources: string[] = [];
  const masked = answer.replace(CITATION_FROM_RE, (_m, src: string) => {
    citedSources.push(src.trim());
    return ` ${SENTINEL}${(citedSources.length - 1).toString()}${SENTINEL} `;
  });

  const pairs: CitationPrecisionPair[] = [];
  const unsupported: string[] = [];

  for (const sentenceMasked of splitPreservingSentencePunctuation(masked)) {
    const indices = [...sentenceMasked.matchAll(SENTINEL_RE)].map((m) => Number(m[1]));
    if (indices.length === 0) continue;
    const sentence = sentenceMasked.replace(SENTINEL_RE, " ").replace(/\s+/gu, " ").trim();
    const sentenceTokens = lexicalTokens(sentence);
    let sentenceHasUnsupported = false;
    for (const index of indices) {
      const source = citedSources[index]!;
      const text = sourceText.get(source.trim().toLowerCase());
      const resolved = text !== undefined;
      let coverage = 0;
      if (resolved && sentenceTokens.size > 0) {
        const evidenceTokens = lexicalTokens(text);
        let covered = 0;
        for (const token of sentenceTokens) {
          if (evidenceTokens.has(token)) covered += 1;
        }
        coverage = covered / sentenceTokens.size;
      }
      const supported = resolved && coverage >= effectiveFloor;
      pairs.push({ sentence, source, resolved, supported, coverage });
      if (!supported) sentenceHasUnsupported = true;
    }
    if (sentenceHasUnsupported) unsupported.push(sentence);
  }

  const supportedCount = pairs.filter((p) => p.supported).length;
  const precision = pairs.length === 0 ? 1 : supportedCount / pairs.length;
  return { pairs, precision, unsupported };
}
