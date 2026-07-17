import { lexicalTokens, type KnowledgeMatch } from "./knowledge-recall.js";
import { CITATION_MARKER_RE } from "./citation-recall.js";
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

const HANGUL_ONLY_RE = /^\p{Script=Hangul}+$/u;

/**
 * Korean is agglutinative: the SAME word carries different particles/endings per
 * sentence ("주문" in a note becomes "주문하고"/"주문하기로" in a faithful answer),
 * so exact-token coverage structurally under-counts Korean support — a correct
 * KO paraphrase of a KO note measured 0.267 exact-only coverage against the 0.5
 * floor (live false-flag, 2026-07-17). Count a Hangul sentence token as covered
 * when it shares a ≥2-syllable stem prefix with an evidence token (either
 * direction): the same pair then measures 0.733, while a fabricated KO claim
 * against the same note measures 0.125 — margin on both sides of the floor.
 * Two syllables, not one — single-syllable prefixes ("주문" vs "주민" share
 * only "주") collide across unrelated words.
 */
function hangulStemCovered(token: string, evidenceTokens: ReadonlySet<string>): boolean {
  if (token.length < 2 || !HANGUL_ONLY_RE.test(token)) {
    return false;
  }
  for (const evidence of evidenceTokens) {
    if (evidence.length < 2 || !HANGUL_ONLY_RE.test(evidence)) {
      continue;
    }
    if (token.startsWith(evidence) || evidence.startsWith(token)) {
      return true;
    }
  }
  return false;
}

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

  // Aggregate ALL chunks of a source, not last-wins — one note (file) is often
  // retrieved as several chunks sharing the same `source` but different `text`;
  // a sentence cited to that file must be checked against EVERY retrieved chunk,
  // else a faithful sentence supported by a different chunk is wrongly flagged.
  const sourceText = new Map<string, string>();
  for (const match of matches) {
    const key = match.source.trim().toLowerCase();
    const prior = sourceText.get(key);
    sourceText.set(key, prior === undefined ? match.text : `${prior}\n${match.text}`);
  }

  const citedSources: string[] = [];
  const fromMasked = answer.replace(CITATION_FROM_RE, (_m, src: string) => {
    citedSources.push(src.trim());
    return ` ${SENTINEL}${(citedSources.length - 1).toString()}${SENTINEL} `;
  });
  // The other marker kinds ([memory: …], [task: …], …) resolve by kind-specific
  // semantics the grounding verdict owns — precision judges only file citations,
  // but the markers are still masked out so their internal punctuation can't
  // split sentences and their content isn't scored as claim tokens.
  const masked = fromMasked.replace(CITATION_MARKER_RE, " ");

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
          if (evidenceTokens.has(token) || hangulStemCovered(token, evidenceTokens)) covered += 1;
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
