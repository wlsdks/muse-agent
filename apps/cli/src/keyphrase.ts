/**
 * Keyphrase extraction — RAKE (Rose, Engel, Cramer, Cowley, "Automatic Keyword
 * Extraction from Individual Documents", in Text Mining: Applications and Theory,
 * 2010). Stopwords and punctuation split the text into CANDIDATE phrases (runs of
 * content words); within each phrase every word co-occurs with the others, and a
 * word scores deg(w)/freq(w) — its co-occurrence degree over its frequency, which
 * rewards a word that appears inside longer phrases. A phrase scores the sum of
 * its words' scores. So the top phrases are the document's key topics — as PHRASES
 * (multi-word topics), the complement to `muse summarize`'s key SENTENCES.
 * Deterministic, no model — works on a single document with no corpus or training.
 */

const KEYPHRASE_STOPWORDS = new Set([
  "a", "about", "above", "after", "again", "against", "all", "am", "an", "and",
  "any", "are", "as", "at", "be", "because", "been", "before", "being", "below",
  "between", "both", "but", "by", "can", "cannot", "could", "did", "do", "does",
  "doing", "down", "during", "each", "few", "for", "from", "further", "had", "has",
  "have", "having", "he", "her", "here", "hers", "him", "his", "how", "i", "if",
  "in", "into", "is", "it", "its", "just", "let", "me", "more", "most", "my", "no",
  "nor", "not", "now", "of", "off", "on", "once", "only", "or", "other", "our",
  "out", "over", "own", "same", "she", "should", "so", "some", "such", "than",
  "that", "the", "their", "them", "then", "there", "these", "they", "this", "those",
  "through", "to", "too", "under", "until", "up", "very", "was", "we", "were",
  "what", "when", "where", "which", "while", "who", "whom", "why", "will", "with",
  "would", "you", "your", "also", "may", "might", "must", "shall", "us", "via"
]);

/** A content token kept in a candidate phrase: lowercased letters/numbers, length >= 2, not a pure number, not a stopword. */
function isContentToken(token: string): boolean {
  return token.length >= 2 && !KEYPHRASE_STOPWORDS.has(token) && !/^\d+$/u.test(token);
}

/**
 * Split text into candidate phrases (arrays of content words). Stopwords, numbers,
 * short tokens, and PUNCTUATION break a phrase; SPACES separate words WITHIN one.
 * A content run longer than `maxPhraseWords` is chunked (keyphrases stay short and
 * useful, not whole clauses). The tokenizer matches word-runs and punctuation-runs
 * separately — whitespace matches neither, so a space never breaks a phrase.
 */
export function candidatePhrases(text: string, maxPhraseWords = 4): string[][] {
  const cap = Math.max(1, Math.trunc(maxPhraseWords));
  const phrases: string[][] = [];
  let current: string[] = [];
  const flush = (): void => { if (current.length > 0) { phrases.push(current); current = []; } };
  for (const token of text.toLowerCase().match(/[\p{L}\p{N}]+|[^\p{L}\p{N}\s]+/gu) ?? []) {
    if (/^[\p{L}\p{N}]+$/u.test(token)) {
      if (isContentToken(token)) {
        current.push(token);
        if (current.length >= cap) flush();
      } else {
        flush(); // stopword / number / single char
      }
    } else {
      flush(); // punctuation
    }
  }
  flush();
  return phrases;
}

export interface RankedKeyphrase {
  readonly phrase: string;
  readonly score: number;
}

/**
 * RAKE word scores: deg(w)/freq(w). For each candidate phrase of length n, every
 * member word gains `n` degree (it co-occurs with all n words, itself included)
 * and 1 frequency. A word recurring only as a single-word phrase scores 1; a word
 * that lives inside longer phrases scores higher.
 */
function wordScores(phrases: readonly string[][]): Map<string, number> {
  const freq = new Map<string, number>();
  const degree = new Map<string, number>();
  for (const phrase of phrases) {
    const n = phrase.length;
    for (const word of phrase) {
      freq.set(word, (freq.get(word) ?? 0) + 1);
      degree.set(word, (degree.get(word) ?? 0) + n);
    }
  }
  const score = new Map<string, number>();
  for (const [word, f] of freq) score.set(word, (degree.get(word) ?? 0) / f);
  return score;
}

/**
 * Extract the top `limit` keyphrases from a document by RAKE. Distinct phrases are
 * scored once (sum of their word scores); ties break toward the phrase that occurs
 * earlier. Returns [] for text with no content words.
 */
export function rakeKeyphrases(text: string, options: { readonly limit?: number } = {}): RankedKeyphrase[] {
  const limit = Math.max(1, Math.trunc(typeof options.limit === "number" && Number.isFinite(options.limit) ? options.limit : 8));
  const phrases = candidatePhrases(text);
  if (phrases.length === 0) return [];
  const scores = wordScores(phrases);
  const seen = new Map<string, { phrase: string; score: number; order: number }>();
  let order = 0;
  for (const words of phrases) {
    const phrase = words.join(" ");
    if (seen.has(phrase)) continue;
    const score = words.reduce((sum, word) => sum + (scores.get(word) ?? 0), 0);
    seen.set(phrase, { order: order++, phrase, score });
  }
  return [...seen.values()]
    .sort((a, b) => (b.score - a.score) || (a.order - b.order))
    .slice(0, limit)
    .map(({ phrase, score }) => ({ phrase, score: Math.round(score * 1000) / 1000 }));
}
