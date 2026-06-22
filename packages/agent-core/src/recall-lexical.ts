/**
 * Shared lexical scoring primitives for the knowledge-recall family — the
 * tokeniser, stopword set, BM25 / overlap scorers, and rank fusion used by BOTH
 * the retrieval rankers and the grounding verifier. Extracted first so neither
 * importer creates a cycle through the other.
 */

export { finiteOr } from "@muse/shared";

// Drop high-frequency function words so lexical overlap (and the RRF
// lexical rank) keys on CONTENT terms — otherwise a decoy sharing only
// "my"/"is" with the query would be falsely recalled.
export const LEXICAL_STOPWORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "am", "to", "of",
  "in", "on", "for", "and", "or", "my", "your", "our", "what", "who", "how",
  "do", "does", "did", "you", "it", "this", "that", "with", "at", "by", "as",
  "me", "we", "i", "if", "so", "no", "not", "from", "about", "into", "than"
]);

// Filtered CONTENT tokens WITH duplicates — `lexicalTokens` is the de-duped
// view; BM25 needs the multiset (term frequency + document length). Split on any
// non-(Unicode letter / number) so NON-ASCII scripts tokenise too — the old
// `[^a-z0-9]` dropped EVERY Korean/CJK/Cyrillic word to nothing, which made
// `resolvesByOverlap` false-strip a `[task: 분기 보고서]` citation (its tokens were
// empty) and zeroed cross-lingual coverage. ASCII English is unchanged
// (`\p{L}`/`\p{N}` cover a–z and 0–9). A single CJK syllable IS a meaningful word
// (unlike a lone Latin letter), so CJK tokens are kept at length ≥ 1; Latin/digit
// tokens still need length ≥ 2 to drop stray letters.
function lexicalTokenList(text: string): string[] {
  return text.toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => {
      if (token.length === 0 || LEXICAL_STOPWORDS.has(token)) {
        return false;
      }
      return token.length >= 2 || /\p{Script=Han}|\p{Script=Hangul}|\p{Script=Hiragana}|\p{Script=Katakana}/u.test(token);
    });
}

export function lexicalTokens(text: string): Set<string> {
  return new Set(lexicalTokenList(text));
}

// Okapi BM25 (Robertson / Spärck Jones): IDF-weighted term frequency with
// length normalisation + TF saturation — a sharper lexical signal than raw
// token-overlap (which weights every shared token equally and ignores chunk
// length), so a query's RARE discriminative term (a name, an ID, an error code)
// outranks a chunk that merely shares a corpus-common term. k1 = TF-saturation,
// b = length-norm strength (the standard defaults).
const BM25_K1 = 1.5;
const BM25_B = 0.75;

/**
 * BM25 score per chunk for `queryTokens`, with IDF + document length computed
 * over `chunks` as the corpus (`key` identifies a chunk). A chunk scores > 0 iff
 * it shares at least one query token, so it preserves the same "any-overlap"
 * eligibility the raw-overlap scorer had — only the RANKING among matches changes.
 */
export function bm25Scores<T extends { readonly text: string }>(
  queryTokens: ReadonlySet<string>,
  chunks: readonly T[],
  key: (chunk: T) => string
): Map<string, number> {
  const tokensByKey = new Map<string, string[]>();
  const df = new Map<string, number>();
  let totalLen = 0;
  for (const chunk of chunks) {
    const k = key(chunk);
    if (tokensByKey.has(k)) {
      continue;
    }
    const tokens = lexicalTokenList(chunk.text);
    tokensByKey.set(k, tokens);
    totalLen += tokens.length;
    for (const term of new Set(tokens)) {
      if (queryTokens.has(term)) {
        df.set(term, (df.get(term) ?? 0) + 1);
      }
    }
  }
  const n = tokensByKey.size;
  const avgdl = n === 0 ? 0 : totalLen / n;
  const idf = new Map<string, number>();
  for (const [term, count] of df) {
    // BM25 IDF; the `1 +` keeps it non-negative even for a term in every doc.
    idf.set(term, Math.log(1 + (n - count + 0.5) / (count + 0.5)));
  }
  const scores = new Map<string, number>();
  for (const [k, tokens] of tokensByKey) {
    const tf = new Map<string, number>();
    for (const token of tokens) {
      if (queryTokens.has(token)) {
        tf.set(token, (tf.get(token) ?? 0) + 1);
      }
    }
    let score = 0;
    for (const [term, freq] of tf) {
      const denom = freq + BM25_K1 * (1 - BM25_B + (avgdl === 0 ? 0 : BM25_B * tokens.length / avgdl));
      score += (idf.get(term) ?? 0) * (freq * (BM25_K1 + 1)) / (denom === 0 ? 1 : denom);
    }
    scores.set(k, score);
  }
  return scores;
}

export function lexicalOverlap(queryTokens: Set<string>, text: string): number {
  if (queryTokens.size === 0) return 0;
  const textTokens = lexicalTokens(text);
  let shared = 0;
  for (const token of queryTokens) {
    if (textTokens.has(token)) shared += 1;
  }
  return shared;
}

/**
 * Reciprocal Rank Fusion (Cormack, Clarke & Büttcher, SIGIR 2009:
 * "Reciprocal Rank Fusion outperforms Condorcet and individual Rank
 * Learning Methods"). Each key's fused score is the sum over the input
 * rankings of `1 / (k + rank)` (rank 1-based), so a key ranked highly
 * by EITHER list surfaces. Deterministic, no training, no extra deps.
 */
export function fuseByReciprocalRank(rankings: ReadonlyArray<readonly string[]>, k = 60): Map<string, number> {
  const fused = new Map<string, number>();
  for (const ranking of rankings) {
    ranking.forEach((key, index) => {
      fused.set(key, (fused.get(key) ?? 0) + 1 / (k + index + 1));
    });
  }
  return fused;
}
