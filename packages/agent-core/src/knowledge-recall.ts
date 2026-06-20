/**
 * Multi-document knowledge recall (RAG) with source attribution.
 *
 * Episodic recall ranks ONE corpus (past conversation summaries).
 * This ranks a MULTI-source personal corpus — notes + ingested docs —
 * and keeps each passage's `source` so the agent can CITE which
 * document an answer came from. Source-agnostic by design: the caller
 * assembles `KnowledgeChunk`s from whatever stores it has (local
 * notes, an ingested PDF, …); the ranker only needs `{ source, text }`.
 *
 * Embedding-backed (cosine), local + zero-cost (Ollama in production,
 * a deterministic fake in tests). Reuses `cosineSimilarity` so the
 * scoring matches episodic recall.
 */

import type { MuseTool } from "@muse/tools";

import { cosineSimilarity } from "./episodic-recall.js";
import { buildNoteLinkGraph, personalizedPageRank } from "./associative-recall.js";
import { comparableScript } from "./script-family.js";

export interface KnowledgeChunk {
  readonly source: string;
  readonly text: string;
  /**
   * Optional contextualized text for EMBEDDING ONLY (Anthropic contextual
   * retrieval): "[source · heading] chunk" so a bare list/pronoun chunk keeps
   * its referent in embedding space. Evidence/gate always use the raw `text`.
   */
  readonly embedText?: string;
}

export interface KnowledgeMatch {
  readonly source: string;
  readonly text: string;
  /** Ranking score. In hybrid mode this is the RRF-fused (rank-based) value, NOT an absolute relevance. */
  readonly score: number;
  /** Absolute cosine similarity to the query — the signal for retrieval-confidence grading (CRAG). */
  readonly cosine?: number;
  /**
   * Provenance trust. `false` = an UNTRUSTED source (e.g. an allowlisted-but-hostile
   * MCP tool-output, per architecture.md). Absent/`true` = the user's own data. The
   * grounding gate verifies faithfulness, not source veracity (grounded≠true); this
   * bit lets a caller flag a grounded answer that rests only on data not the user's.
   */
  readonly trusted?: boolean;
}

export interface RankKnowledgeOptions {
  readonly embed: (text: string) => Promise<readonly number[]>;
  readonly topK?: number;
  readonly minScore?: number;
  /**
   * Fuse the cosine ranking with a lexical (keyword-overlap) ranking
   * via Reciprocal Rank Fusion so an exact rare token (a name, an
   * error code, an ID) the embedding misses is still recalled. Default
   * off — the cosine-only behaviour is unchanged.
   */
  readonly hybrid?: boolean;
  /**
   * Use Okapi BM25 (IDF-weighted, length-normalised) for the lexical ranking in
   * the RRF fusion instead of raw token-overlap, so a query's rare
   * discriminative term outranks a corpus-common one. Only applies with
   * `hybrid: true`; the overlap-based citation fence is unchanged. Default off.
   */
  readonly bm25?: boolean;
  /** RRF constant; larger = flatter rank weighting. Default 60. */
  readonly rrfK?: number;
  /**
   * Diversify the top-K with Maximal Marginal Relevance so near-
   * duplicate passages don't crowd out a distinct relevant one — the
   * agent's limited context sees varied grounding. Default off.
   */
  readonly diversify?: boolean;
  /**
   * MMR relevance/diversity trade-off in [0,1]; higher = more
   * relevance. Default 0.5 — a balanced split: at 0.7 real near-
   * duplicate notes (cosine ~0.95) still both surface (live-measured
   * on nomic-embed), so 0.5 is needed for the diversity penalty to
   * actually drop a paraphrase.
   */
  readonly mmrLambda?: number;
}

function finiteOr(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

// Drop high-frequency function words so lexical overlap (and the RRF
// lexical rank) keys on CONTENT terms — otherwise a decoy sharing only
// "my"/"is" with the query would be falsely recalled.
const LEXICAL_STOPWORDS = new Set([
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

/**
 * Maximal Marginal Relevance (Carbonell & Goldstein, SIGIR 1998: "The
 * Use of MMR, Diversity-Based Reranking for Reordering Documents and
 * Producing Summaries"). Greedily picks the candidate maximising
 * `λ·relevance − (1−λ)·max cosine-similarity to the already-picked`, so
 * a near-duplicate of an already-selected passage is penalised and a
 * distinct relevant one surfaces. Deterministic, no deps.
 */
export function selectByMmr(
  candidates: ReadonlyArray<{ readonly key: string; readonly relevance: number; readonly embedding: readonly number[] }>,
  lambda: number,
  topK: number
): string[] {
  const pool = [...candidates];
  const selected: typeof pool = [];
  while (selected.length < topK && pool.length > 0) {
    let bestIndex = 0;
    let bestScore = -Infinity;
    pool.forEach((candidate, index) => {
      const maxSim = selected.length === 0
        ? 0
        : Math.max(...selected.map((picked) => cosineSimilarity(candidate.embedding, picked.embedding)));
      const mmr = lambda * candidate.relevance - (1 - lambda) * maxSim;
      if (mmr > bestScore) {
        bestScore = mmr;
        bestIndex = index;
      }
    });
    selected.push(pool[bestIndex]!);
    pool.splice(bestIndex, 1);
  }
  return selected.map((candidate) => candidate.key);
}

/**
 * Charnov's Marginal Value Theorem (Optimal foraging, the marginal value theorem,
 * Theoretical Population Biology 9(2):129-136, 1976): an optimal forager abandons
 * a depleting patch the moment its marginal intake rate falls to the habitat's
 * long-run average rate R*. Applied to a RANKED set of grounding sources, each
 * source's relevance score is its marginal value and R* is the average score of
 * the whole candidate habitat (the mean). We keep the LEADING sources whose value
 * is at or above R* and stop at the first that drops below it — so the cited
 * count adapts to the score distribution: a sharp relevance cliff (one source far
 * above the mean) yields FEW, a rich field (many comparably-relevant) yields
 * MORE, a flat field yields all — instead of a fixed top-N, shrinking the
 * cited-source noise/fabrication surface. Scale-robust (the threshold is the
 * distribution's own mean, so it works on the compressed cosine space nomic
 * produces). `scoresDescending` MUST be sorted high→low. Clamped to [min, max];
 * an empty input returns 0. Deterministic, no tuning constant.
 */
export function selectByMarginalValue(
  scoresDescending: readonly number[],
  options: { readonly min?: number; readonly max?: number } = {}
): number {
  const n = scoresDescending.length;
  if (n === 0) return 0;
  const min = Math.max(1, Math.trunc(finiteOr(options.min, 1)));
  const max = Math.max(min, Math.trunc(finiteOr(options.max, n)));
  const giveUpRate = scoresDescending.reduce((sum, score) => sum + score, 0) / n;
  let k = 0;
  for (const score of scoresDescending) {
    if (score < giveUpRate) break; // descending — once below R*, the rest are too
    k += 1;
  }
  return Math.min(max, Math.max(min, k));
}

/**
 * Adaptive-k passage selection by largest consecutive score gap (arXiv:2506.08479,
 * Taguchi/Maekawa/Bhutani, EMNLP 2025). The largest drop between adjacent ranked
 * scores marks the "natural knee" — everything above the knee is genuinely relevant,
 * everything below is near-miss padding that widens the fabrication surface for the
 * local 12B. `scoresDescending` MUST be sorted high→low (caller's contract —
 * not re-sorted here). Returns k = (index of largest gap) + 1, clamped to [min, max].
 * Ties → earliest index (smaller k, more conservative). Deterministic, no tuning
 * constant, never throws.
 */
export function selectByScoreGap(
  scoresDescending: readonly number[],
  options?: { readonly min?: number; readonly max?: number }
): number {
  const n = scoresDescending.length;
  if (n === 0) return 0;
  const min = Math.max(1, Math.trunc(finiteOr(options?.min, 1)));
  const rawMax = Math.trunc(finiteOr(options?.max, n));
  const max = Math.max(min, Math.min(n, rawMax));
  if (n <= min) return n;
  // Compute consecutive gaps and find the largest.
  let largestGap = -Infinity;
  let gapIndex = 0; // index i where gap g_i = scores[i] - scores[i+1] is largest
  for (let i = 0; i < n - 1; i++) {
    const g = scoresDescending[i]! - scoresDescending[i + 1]!;
    if (g > largestGap) {
      largestGap = g;
      gapIndex = i;
    }
  }
  const k = gapIndex + 1;
  return Math.min(max, Math.max(min, k));
}

/**
 * Rank `chunks` from multiple sources by cosine similarity to `query`.
 * Returns the top-K matches (each carrying its `source`), highest
 * score first. Empty query / corpus → no matches; sub-threshold
 * passages are dropped so an irrelevant corpus doesn't fabricate a
 * citation.
 */
export async function rankKnowledgeChunks(
  query: string,
  chunks: readonly KnowledgeChunk[],
  options: RankKnowledgeOptions
): Promise<KnowledgeMatch[]> {
  const topK = Math.max(1, Math.trunc(finiteOr(options.topK, 3)));
  const minScore = Math.max(0, finiteOr(options.minScore, 0.1));
  if (query.trim().length === 0 || chunks.length === 0) {
    return [];
  }
  const queryVec = await options.embed(query);

  if (options.hybrid === true) {
    const rrfK = Math.max(1, Math.trunc(finiteOr(options.rrfK, 60)));
    const queryTokens = lexicalTokens(query);
    const key = (chunk: KnowledgeChunk): string => `${chunk.source}\u0000${chunk.text}`;
    const cosByKey = new Map<string, number>();
    const lexByKey = new Map<string, number>();
    const embByKey = new Map<string, readonly number[]>();
    const byKey = new Map<string, KnowledgeChunk>();
    for (const chunk of chunks) {
      const k = key(chunk);
      byKey.set(k, chunk);
      const embedding = await options.embed(chunk.embedText ?? chunk.text);
      embByKey.set(k, embedding);
      cosByKey.set(k, cosineSimilarity(queryVec, embedding));
      lexByKey.set(k, lexicalOverlap(queryTokens, chunk.text));
    }
    const cosRanked = [...cosByKey.entries()].filter(([, s]) => s > 0).sort((a, b) => b[1] - a[1]).map(([k]) => k);
    const lexRanked = [...lexByKey.entries()].filter(([, s]) => s > 0).sort((a, b) => b[1] - a[1]).map(([k]) => k);
    // BM25 (IDF-weighted) is a sharper lexical signal than raw overlap; use it
    // as the fusion's lexical ranking when opted in, keeping the overlap-based
    // citation fence below unchanged (BM25 > 0 iff overlap > 0).
    const lexicalRanking = options.bm25 === true
      ? [...bm25Scores(queryTokens, chunks, key).entries()].filter(([, s]) => s > 0).sort((a, b) => b[1] - a[1]).map(([k]) => k)
      : lexRanked;
    const fused = fuseByReciprocalRank([cosRanked, lexicalRanking], rrfK);
    // A passage earns a citation only with a real signal: cosine above
    // threshold OR any lexical overlap — so an irrelevant corpus still
    // fabricates nothing.
    const eligible = [...byKey.keys()].filter((k) => (cosByKey.get(k) ?? 0) >= minScore || (lexByKey.get(k) ?? 0) > 0);
    eligible.sort((a, b) => (fused.get(b) ?? 0) - (fused.get(a) ?? 0));
    const toMatch = (k: string): KnowledgeMatch => {
      const chunk = byKey.get(k)!;
      return { cosine: cosByKey.get(k) ?? 0, score: fused.get(k) ?? 0, source: chunk.source, text: chunk.text };
    };
    if (options.diversify === true && eligible.length > topK) {
      const lambda = Math.min(1, Math.max(0, finiteOr(options.mmrLambda, 0.5)));
      // MMR relevance must share the diversity penalty's scale: the penalty is
      // a raw cosine in [0,1], while an RRF score tops out near 2/(k+1)≈0.03 —
      // feeding RRF here let the similarity term dominate ~30×, so after the
      // first pick MMR maximized DISSIMILARITY and a near-noise chunk displaced
      // the second-most-relevant one (audit finding). Rank by fused order, but
      // diversify on cosine relevance like the non-hybrid path.
      const order = selectByMmr(
        eligible.map((k) => ({ embedding: embByKey.get(k) ?? [], key: k, relevance: cosByKey.get(k) ?? 0 })),
        lambda,
        topK
      );
      return order.map(toMatch);
    }
    return eligible.slice(0, topK).map(toMatch);
  }

  const scored: Array<{ readonly match: KnowledgeMatch; readonly embedding: readonly number[] }> = [];
  for (const chunk of chunks) {
    const embedding = await options.embed(chunk.embedText ?? chunk.text);
    const score = cosineSimilarity(queryVec, embedding);
    if (score < minScore) {
      continue;
    }
    scored.push({ embedding, match: { cosine: score, score, source: chunk.source, text: chunk.text } });
  }
  if (options.diversify === true && scored.length > topK) {
    const lambda = Math.min(1, Math.max(0, finiteOr(options.mmrLambda, 0.7)));
    const order = selectByMmr(
      scored.map((entry, index) => ({ embedding: entry.embedding, key: String(index), relevance: entry.match.score })),
      lambda,
      topK
    );
    return order.map((key) => scored[Number(key)]!.match);
  }
  scored.sort((a, b) => b.match.score - a.match.score);
  return scored.slice(0, topK).map((entry) => entry.match);
}

/**
 * Render matches for the agent as a passage list, each labelled with
 * its `[source]` and instructed to cite it. The labelling is what
 * lets a grounded answer attribute its claim to the right document.
 */
/**
 * Reorder relevance-ranked items so the MOST relevant sit at the
 * edges of the list (first + last) and the least relevant in the
 * middle, because language models attend best to the start and end of
 * their context and worst to the middle (Liu et al. 2023, "Lost in the
 * Middle: How Language Models Use Long Contexts", arXiv 2307.03172).
 * Input must be sorted best-first. Deterministic, no deps.
 */
export function edgeLoadByRelevance<T>(ranked: readonly T[]): T[] {
  const out = new Array<T>(ranked.length);
  let front = 0;
  let back = ranked.length - 1;
  ranked.forEach((item, index) => {
    if (index % 2 === 0) {
      out[front] = item;
      front += 1;
    } else {
      out[back] = item;
      back -= 1;
    }
  });
  return out;
}

export type RetrievalConfidence = "confident" | "ambiguous" | "none";

// Default top-cosine bar for "confident". Calibrated live on nomic-embed-text:
// a clearly-relevant personal note scored ~0.61 while personal distractors
// scored ~0.44–0.51, so 0.55 splits them. BEST-EFFORT only — nomic's cosine
// space is compressed (even unrelated encyclopedic text can score ~0.54), so
// this flags weak personal grounding, it is NOT a hard relevant/irrelevant cut.
export const DEFAULT_CONFIDENT_AT = 0.55;

/**
 * Resolve the recall confidence bar from `MUSE_GROUNDING_MIN_COSINE` — the
 * conformal-calibrated threshold `muse doctor --calibration` emits (KnowNo /
 * conformal prediction, arXiv:2307.01928). Mirrors the chat gate's parse
 * (`resolveGroundingMinScore`) EXACTLY so chat and the RGV recall path agree on
 * one number: finite, `> 0 && <= 1`, else the hardcoded `DEFAULT_CONFIDENT_AT`.
 * STRICTLY opt-in and fail-safe: a missing or out-of-range env changes nothing,
 * so the fabrication=0 floor is preserved; a valid override may only RAISE the
 * abstention bar.
 */
export function resolveRecallConfidentAt(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.MUSE_GROUNDING_MIN_COSINE);
  return Number.isFinite(raw) && raw > 0 && raw <= 1 ? raw : DEFAULT_CONFIDENT_AT;
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
  options?: { readonly confidentAt?: number }
): RetrievalConfidence {
  if (matches.length === 0) {
    return "none";
  }
  const confidentAt = finiteOr(options?.confidentAt, DEFAULT_CONFIDENT_AT);
  const scores = matches.map((match) => match.cosine ?? match.score).sort((a, b) => b - a);
  const top = scores[0]!;
  if (top < confidentAt) {
    return "ambiguous";
  }
  const runnerUp = scores[1] ?? 0;
  const borderlineTop = top < confidentAt + CONFIDENCE_SOFT_BAND;
  const flatDistribution = top - runnerUp < CONFIDENCE_MIN_MARGIN;
  return borderlineTop && flatDistribution ? "ambiguous" : "confident";
}

/**
 * SET-LEVEL semantic sufficiency: a multi-part query is only covered when EVERY
 * sub-query has at least one passage above the coverage bar. A single strong
 * passage on sub-query A does not cover sub-query B — the top-cosine signal
 * misses this gap and the model fabricates the uncovered half.
 *
 * Sufficient Context (arXiv:2411.06037, Joren/Zhang/Ferng/Juan/Taly/Rashtchian,
 * ICLR 2025): sufficiency is a SET-LEVEL property orthogonal to per-passage
 * relevance; when context is insufficient, models fabricate instead of
 * abstaining.
 *
 * ADVISORY-ONLY: the result is never used to block an answer or relax the
 * citation gate. It powers one honest caveat naming the uncovered parts.
 * MULTI-PART-GATED: returns sufficient:true for single-intent queries — those
 * are the confidence gate's job.
 * FAIL-OPEN: degenerate/empty vecs → cosineSimilarity returns 0 → insufficient
 * → but empty subQueries or length<2 → sufficient:true.
 */
export interface SufficiencyVerdict {
  readonly sufficient: boolean;
  readonly coveredFraction: number;
  readonly uncovered: readonly string[];
}

export function assessContextSufficiency(
  subQueries: ReadonlyArray<{ readonly text: string; readonly vec: readonly number[] }>,
  evidenceVecs: readonly (readonly number[])[],
  options?: { readonly coverAt?: number; readonly sufficientAt?: number }
): SufficiencyVerdict {
  // Single-intent no-op: per-passage confidence gate already handles this.
  if (subQueries.length < 2) {
    return { sufficient: true, coveredFraction: 1, uncovered: [] };
  }
  // coverAt reuses DEFAULT_CONFIDENT_AT (0.55): calibrated on nomic-embed-text
  // against real personal notes — same bar used by classifyRetrievalConfidence.
  const coverAt = finiteOr(options?.coverAt, DEFAULT_CONFIDENT_AT);
  const sufficientAt = finiteOr(options?.sufficientAt, 1.0);

  const uncovered: string[] = [];
  for (const sq of subQueries) {
    let maxSim = 0;
    for (const ev of evidenceVecs) {
      const sim = cosineSimilarity(sq.vec as number[], ev as number[]);
      if (sim > maxSim) maxSim = sim;
    }
    if (maxSim < coverAt) {
      uncovered.push(sq.text);
    }
  }

  const covered = subQueries.length - uncovered.length;
  const coveredFraction = covered / subQueries.length;
  return {
    sufficient: coveredFraction >= sufficientAt,
    coveredFraction,
    uncovered
  };
}

// Near-tie band (cosine units) for the clarify gate. Two DISTINCT sources whose
// top cosines sit within this band are "equally relevant" — the open question is
// WHICH the user meant, not whether the corpus covers it. Tight (vs
// CONFIDENCE_MIN_MARGIN's 0.08) so only a genuine tie fires, never a clear lead;
// calibrated against nomic's compressed cosine space.
const DEFAULT_CLARIFY_TIE_MARGIN = 0.03;

export interface RecallClarification {
  /** True when distinct sources are equally-strong enough that asking beats guessing. */
  readonly clarify: boolean;
  /** The distinct divergent sources to offer, strongest first (empty unless `clarify`). */
  readonly sources: readonly string[];
  /** Why it did or didn't fire — for logging / tests. */
  readonly reason: string;
}

/**
 * Expected-information-gain gate (Lindley 1956, "On a Measure of the Information
 * Provided by an Experiment"; Howard 1966, value of perfect information): when
 * several retrieved sources are each independently strong, come from DISTINCT
 * sources, and are nearly TIED, the residual uncertainty is over WHICH reading
 * the user meant — so a single clarifying question carries the highest expected
 * information gain, more than silently answering the top one (it may be the wrong
 * reading) or abstaining (the corpus DOES cover it). One dominant source ⇒ low
 * entropy ⇒ just answer; nothing strong ⇒ abstain. Pure + deterministic so the
 * small model can't flake the decision — the THIRD arm of the recall wedge
 * (answer / clarify / abstain), alongside `classifyRetrievalConfidence`.
 */
export function decideRecallClarification(
  matches: readonly KnowledgeMatch[],
  options?: { readonly confidentAt?: number; readonly tieMargin?: number; readonly maxSources?: number }
): RecallClarification {
  const confidentAt = finiteOr(options?.confidentAt, DEFAULT_CONFIDENT_AT);
  const tieMargin = Math.max(0, finiteOr(options?.tieMargin, DEFAULT_CLARIFY_TIE_MARGIN));
  const maxSources = Math.max(2, Math.trunc(finiteOr(options?.maxSources, 3)));
  // Best score per DISTINCT source: several chunks of the SAME note are one
  // candidate, not a tie — there is no ambiguity within a single source.
  const bestBySource = new Map<string, number>();
  for (const match of matches) {
    const value = match.cosine ?? match.score;
    const prev = bestBySource.get(match.source);
    if (prev === undefined || value > prev) bestBySource.set(match.source, value);
  }
  const strong = [...bestBySource.entries()]
    .filter(([, value]) => value >= confidentAt)
    .sort((left, right) => right[1] - left[1]);
  if (strong.length < 2) {
    return { clarify: false, reason: strong.length === 1 ? "one dominant source — answer it" : "no strong source — abstain", sources: [] };
  }
  const top = strong[0]![1];
  const tied = strong.filter(([, value]) => top - value <= tieMargin);
  if (tied.length < 2) {
    return { clarify: false, reason: "top source clearly leads — answer it", sources: [] };
  }
  return {
    clarify: true,
    reason: `${tied.length.toString()} distinct sources within ${tieMargin.toString()} of the top — high expected information gain from clarifying`,
    sources: tied.slice(0, maxSources).map(([source]) => source)
  };
}

export function renderKnowledgeMatches(matches: readonly KnowledgeMatch[], options?: { readonly confidentAt?: number }): string {
  if (matches.length === 0) {
    return "No matching passages found in the personal corpus.";
  }
  const verdict = classifyRetrievalConfidence(matches, options);
  const header = verdict === "ambiguous"
    ? "Possibly-related passages (LOW confidence — verify before relying; do not cite as established fact):"
    : "Relevant passages — cite the [source] you use:";
  const lines = [header];
  // Edge-place the passages (strongest at the head + tail, weakest in the
  // middle) so the local model attends to the best grounding — same
  // "Lost in the Middle" reorder `muse ask` applies to its notes block.
  for (const match of reorderForLongContext(matches)) {
    lines.push(`— [${match.source}] ${match.text}`);
  }
  return lines.join("\n");
}

const CITATION_RE = /\[from\s+([^\]]+?)\s*\]/giu;

/** Every source the text cites via a `[from <source>]` token, trimmed, in order. */
export function citedSourcesIn(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(CITATION_RE)) {
    const src = match[1]?.trim();
    if (src) out.push(src);
  }
  return out;
}

/**
 * grounded≠true MITIGATION (source-trust segregation). A grounded answer can be
 * perfectly faithful to its source yet the source itself be UNTRUSTED. Source
 * VERACITY is unknowable on a fixed local model; source TRUST is a known
 * provenance bit (`KnowledgeMatch.trusted`). Returns `true` when EVERY citation in
 * the answer that resolves to a retrieved match resolves ONLY to untrusted ones —
 * i.e. the user is being handed a grounded claim resting entirely on data that is
 * not their own (e.g. MCP tool-output). A single trusted backing source makes it
 * `false`. The caller surfaces a distinct marker so the user applies extra scrutiny.
 * Unresolved citations are NOT this function's concern — verifyGrounding already
 * rejects a fabricated citation as ungrounded.
 */
export function groundedOnUntrustedOnly(answer: string, matches: readonly KnowledgeMatch[]): boolean {
  const cited = citedSourcesIn(answer);
  if (cited.length === 0) {
    return false;
  }
  const trustBySource = new Map(matches.map((m) => [m.source.trim().toLowerCase(), m.trusted !== false]));
  let anyResolved = false;
  for (const src of cited) {
    const trusted = trustBySource.get(src.trim().toLowerCase());
    if (trusted === undefined) {
      continue;
    }
    anyResolved = true;
    if (trusted) {
      return false;
    }
  }
  return anyResolved;
}

export interface CitationEnforcement {
  /** The answer with every invented `[from <source>]` citation removed. */
  readonly text: string;
  /** The invented sources that were stripped — cited but not among the real ones shown. */
  readonly stripped: readonly string[];
}

export interface AllowedCitations {
  /** `[from <source>]` — note files; exact match (filenames are identifiers). */
  readonly notes?: readonly string[];
  /** `[feed: <name>]` — subscribed feeds; exact match. */
  readonly feeds?: readonly string[];
  /** `[task: <title>]` — open tasks; content-token overlap (the model may reword the title). */
  readonly tasks?: readonly string[];
  /** `[event: <title>]` — upcoming events; content-token overlap. */
  readonly events?: readonly string[];
  /** `[reminder: <text>]` — pending reminders; content-token overlap. */
  readonly reminders?: readonly string[];
  /** `[session: <summary>]` — retrieved past-session summaries; content-token overlap (the model rewrites the recap). */
  readonly sessions?: readonly string[];
  /** `[contact: <name>]` — known contacts; content-token overlap (the model may cite a first name / partial). */
  readonly contacts?: readonly string[];
  /** `[command: <cmd>]` — shell-history commands shown this turn; content-token overlap. */
  readonly commands?: readonly string[];
  /** `[commit: <subject>]` — git commit subjects shown this turn; content-token overlap. */
  readonly commits?: readonly string[];
  /** `[memory: <topic>]` — facts the user told Muse to remember; content-token overlap. */
  readonly memories?: readonly string[];
  /** `[action: <what>]` — actions Muse logged taking on the user's behalf; content-token overlap. */
  readonly actions?: readonly string[];
}

function resolvesExact(value: string, allowed: readonly string[]): boolean {
  const v = value.trim().toLowerCase();
  return allowed.some((item) => item.trim().toLowerCase() === v);
}

// Free-text citations (task/event/reminder titles): the model may PARAPHRASE
// the title, so an exact match would false-strip a real one. A citation
// resolves when it shares any CONTENT token with a real item of that type; a
// wholly-invented title (no overlap with anything the user has) is stripped.
function resolvesByOverlap(value: string, allowed: readonly string[]): boolean {
  const tokens = lexicalTokens(value);
  if (tokens.size === 0) {
    return false;
  }
  return allowed.some((item) => {
    const itemTokens = lexicalTokens(item);
    for (const token of tokens) {
      if (itemTokens.has(token)) {
        return true;
      }
    }
    return false;
  });
}

/**
 * Rewrite the local model's natural-but-wrong contact citations to the
 * canonical `[contact: <name>]` form the gate accepts — BEFORE
 * `enforceAnswerCitations` runs. A `<<contact N — id>>` wrapper is a structural
 * sibling of the `<<note N — file>>` wrapper the model cites as `[from file]`,
 * so qwen3:8b tends to cite a contact with the note verb or by slot/id —
 * `[from contact 1]`, `[from contact: mina]`, `[contact 1]` — which the
 * exact-match note gate then false-strips, firing a spurious "treat as
 * unverified" warning on a correctly-grounded answer about the user's OWN
 * address book. This maps every "contact"-anchored mis-form to
 * `[contact: <name>]` by code: an in-range slot number, or an id / name that
 * token-overlaps a real matched contact, resolves to that contact's name; an
 * unresolvable reference (`[from contact 9]`) is left untouched for the gate to
 * strip. Pure + deterministic; only touches a citation whose first token is
 * literally `contact`, so a real `[from contacts.md]` note citation is never
 * rewritten.
 */
export function normalizeContactCitations(
  answer: string,
  contacts: ReadonlyArray<{ readonly id: string; readonly name: string }>
): string {
  if (contacts.length === 0) {
    return answer;
  }
  const resolveName = (ref: string): string | undefined => {
    const trimmed = ref.trim();
    if (/^\d+$/u.test(trimmed)) {
      const slot = Number(trimmed);
      return slot >= 1 && slot <= contacts.length ? contacts[slot - 1]?.name : undefined;
    }
    const low = trimmed.toLowerCase();
    const exact = contacts.find((c) => c.id.toLowerCase() === low || c.name.toLowerCase() === low);
    if (exact) {
      return exact.name;
    }
    const refTokens = lexicalTokens(trimmed);
    if (refTokens.size === 0) {
      return undefined;
    }
    const overlap = contacts.find((c) => {
      const nameTokens = lexicalTokens(c.name);
      for (const token of refTokens) {
        if (nameTokens.has(token)) {
          return true;
        }
      }
      return false;
    });
    return overlap?.name;
  };
  const withContactVerb = answer.replace(
    /\[\s*(?:from\s+)?contact\s*(?:[:#-]\s*|\s+)([^\]]+?)\s*\]/giu,
    (match: string, ref: string) => {
      const name = resolveName(ref);
      return name ? `[contact: ${name}]` : match;
    }
  );
  // Also catch the bare NOTE-verb form `[from <X>]` where <X> is the raw
  // `contact_<uuid>` id (or the full contact name) the model echoed — the
  // `contact`-anchored pass above misses it because the id is `contact_<uuid>`
  // (no "contact" + separator). Only an EXACT id / name match is rewritten
  // (separator- and case-insensitive, never a fuzzy token overlap), so a real
  // `[from note.md]` is never mistaken for a contact.
  const normRef = (value: string): string => value.trim().toLowerCase().replace(/[\s_-]+/gu, " ");
  const exactContactName = (ref: string): string | undefined => {
    const low = ref.trim().toLowerCase();
    const n = normRef(ref);
    const hit = contacts.find((c) => c.id.toLowerCase() === low || normRef(c.id) === n || normRef(c.name) === n);
    return hit?.name;
  };
  return withContactVerb.replace(
    /\[from\s+([^\]]+?)\s*\]/giu,
    (match: string, ref: string) => {
      const name = exactContactName(ref);
      return name ? `[contact: ${name}]` : match;
    }
  );
}

/**
 * Rewrite a remembered-fact cited with the NOTE verb to the canonical
 * `[memory: <key>]` form — the local model (especially in Korean, where the
 * `[memory: …]` hint block isn't injected because the query doesn't lexically
 * match the English fact key) tends to cite a fact it knows from the persona as
 * `[from car_license_plate]`, which the exact-match note gate then false-strips.
 * Only a `[from <X>]` whose `<X>` EXACTLY matches a known memory key (separator /
 * case-insensitive) is rewritten; a real `[from note.md]` is left untouched, so a
 * note citation is never mistaken for a memory.
 */
export function normalizeMemoryCitations(answer: string, memoryKeys: readonly string[]): string {
  if (memoryKeys.length === 0) {
    return answer;
  }
  const norm = (value: string): string => value.trim().toLowerCase().replace(/[\s_-]+/gu, " ");
  const keys = new Set(memoryKeys.map(norm));
  return answer.replace(
    /\[from\s+([^\]]+?)\s*\]/giu,
    (match: string, ref: string) => (keys.has(norm(ref)) ? `[memory: ${ref.trim()}]` : match)
  );
}

/**
 * Strip the redundant note-verb "from " the model sometimes prepends to a
 * STRUCTURED citation — `[from commit: …]`, `[from task: …]`, `[from event: …]` —
 * so it reads as the canonical `[commit: …]` / `[task: …]` the gate validates by
 * class. Without this, the note regex (`[from <X>]`) mis-catches it first and
 * false-strips a TRUE structured citation as a non-existent note. Only a KNOWN
 * class keyword + ":" is rewritten, so a real `[from note.md]` is never touched.
 */
export function normalizeFromPrefixedCitations(answer: string): string {
  return answer.replace(
    /\[from\s+(task|event|reminder|session|feed|contact|command|commit|memory|action)\s*:/giu,
    "[$1:"
  );
}

/**
 * Rewrite a STRUCTURED citation the model wrote by SLOT NUMBER — `[from session 1]`,
 * `[from event 2]` — into the canonical `[<class>: <that slot's content>]` the gate
 * validates by class. The grounding markers are slot-numbered (`<<session N — id>>`),
 * so a reasoning-off model often cites the slot rather than the title; without this
 * the note regex mis-catches `[from session 1]` and false-strips a TRUE recall.
 * `slotsByClass` maps each class to the ORDERED list shown to the model (slot N →
 * index N-1); an out-of-range slot is left untouched for the gate to judge.
 */
export function normalizeSlotCitations(
  answer: string,
  slotsByClass: Readonly<Record<string, readonly string[]>>
): string {
  return answer.replace(
    // `[from session 1]`, the bare `[feed 1]` (the model often drops "from" for the
    // slot-numbered markers `<<feed N — name>>`), or `[from session 1 — ep_001]`
    // when it echoes the marker whole — the optional "from " and trailing "— <id>"
    // are both ignored.
    /\[(?:from\s+)?(task|event|reminder|session|feed|contact|command|commit|memory|action)\s+(\d+)(?:\s*[—–-]\s*[^\]]*)?\s*\]/giu,
    (match: string, cls: string, num: string) => {
      const list = slotsByClass[cls.toLowerCase()];
      const content = list?.[Number.parseInt(num, 10) - 1];
      return content ? `[${cls.toLowerCase()}: ${content}]` : match;
    }
  );
}

/**
 * Output-side grounding gate for the recall WEDGE — the code-not-model half of
 * "shows its work". Strips ANY citation the answer makes — `[from <note>]`,
 * `[feed: <name>]`, `[task|event|reminder: <title>]` — whose target is NOT
 * among the real sources Muse actually showed the model, so a fabricated
 * citation to something the user doesn't have can never reach them BY CODE
 * (mirrors `parseReflections` / `parseCouncilAnswer`). Notes + feeds match
 * exactly (they are identifiers); the free-text title forms match on
 * content-token overlap so a paraphrased-but-real citation survives — including
 * `[session: …]`, matched against the retrieved past-session summaries.
 */
export function enforceAnswerCitations(answer: string, allowed: AllowedCitations): CitationEnforcement {
  let text = answer;
  const stripped: string[] = [];
  const strip = (re: RegExp, resolves: (value: string) => boolean): void => {
    text = text.replace(re, (match: string, raw: string) => {
      const value = raw.trim();
      if (resolves(value)) {
        return match;
      }
      stripped.push(value);
      return "";
    });
  };
  strip(CITATION_RE, (value) => resolvesExact(value, allowed.notes ?? []));
  strip(/\[feed:\s*([^\]]+?)\s*\]/giu, (value) => resolvesExact(value, allowed.feeds ?? []));
  strip(/\[task:\s*([^\]]+?)\s*\]/giu, (value) => resolvesByOverlap(value, allowed.tasks ?? []));
  strip(/\[event:\s*([^\]]+?)\s*\]/giu, (value) => resolvesByOverlap(value, allowed.events ?? []));
  strip(/\[reminder:\s*([^\]]+?)\s*\]/giu, (value) => resolvesByOverlap(value, allowed.reminders ?? []));
  strip(/\[session:\s*([^\]]+?)\s*\]/giu, (value) => resolvesByOverlap(value, allowed.sessions ?? []));
  strip(/\[contact:\s*([^\]]+?)\s*\]/giu, (value) => resolvesByOverlap(value, allowed.contacts ?? []));
  strip(/\[command:\s*([^\]]+?)\s*\]/giu, (value) => resolvesByOverlap(value, allowed.commands ?? []));
  strip(/\[commit:\s*([^\]]+?)\s*\]/giu, (value) => resolvesByOverlap(value, allowed.commits ?? []));
  strip(/\[memory:\s*([^\]]+?)\s*\]/giu, (value) => resolvesByOverlap(value, allowed.memories ?? []));
  strip(/\[action:\s*([^\]]+?)\s*\]/giu, (value) => resolvesByOverlap(value, allowed.actions ?? []));
  // Only tidy whitespace when a citation marker was actually removed (the cleanup
  // exists to close the seam a stripped `[...]` leaves). Running it on a CLEAN
  // answer collapses multi-space runs and mangles code-block indentation / aligned
  // columns — so leave an un-stripped answer byte-for-byte verbatim.
  if (stripped.length > 0) {
    text = text
      .replace(/[ \t]{2,}/gu, " ")
      .replace(/[ \t]+([.,;!?])/gu, "$1")
      .replace(/[ \t]+\n/gu, "\n");
  }
  return { stripped, text };
}

export type GroundingVerdict = "grounded" | "weak" | "ungrounded";

export interface GroundingRubric {
  /** Retrieval confidence (CRAG): confident → 1, ambiguous → 0.5, none → 0. */
  readonly confidence: number;
  /** Fraction of the answer's content tokens supported by the retrieved evidence. */
  readonly coverage: number;
  /** Fraction of the query's content tokens addressed by the retrieved evidence. */
  readonly answerability: number;
  /** Fraction of the answer's `[from <source>]` citations that resolve to a retrieved source. */
  readonly citationValidity: number;
}

export interface GroundingVerification {
  readonly verdict: GroundingVerdict;
  readonly rubric: GroundingRubric;
  readonly reason: string;
  /** Cited sources that resolve to NO retrieved match — fabricated citations. */
  readonly invalidCitations: readonly string[];
}

export interface VerifyGroundingOptions {
  /** Absolute-cosine threshold for the confidence criterion (default `DEFAULT_CONFIDENT_AT`). */
  readonly confidentAt?: number;
  /** Min answer-token support for a non-ungrounded verdict (default 0.5). */
  readonly coverageFloor?: number;
  /** Min query-token coverage by the evidence for a grounded verdict (default 0.34). */
  readonly answerabilityFloor?: number;
  /**
   * Number of judge samples to draw for each reverify call (1–5, default 1).
   * Unanimous agreement required to PASS (self-consistency, arXiv:2203.11171).
   * Default 1 preserves byte-identical behaviour for all existing callers.
   */
  readonly reverifySamples?: number;
}

const DEFAULT_COVERAGE_FLOOR = 0.5;
const DEFAULT_ANSWERABILITY_FLOOR = 0.34;

function unionContentTokens(matches: readonly KnowledgeMatch[]): Set<string> {
  const out = new Set<string>();
  for (const m of matches) {
    for (const token of lexicalTokens(m.text)) out.add(token);
  }
  return out;
}

function coveredFraction(tokens: Set<string>, evidence: Set<string>): number {
  if (tokens.size === 0) return 0;
  let hit = 0;
  for (const token of tokens) {
    if (evidence.has(token)) hit += 1;
  }
  return hit / tokens.size;
}

/**
 * Independent, deterministic test-time verifier for the recall wedge — the
 * "shows its work" gate scaled from a single cosine threshold to a multi-
 * criterion rubric (test-time rubric-guided verification, arXiv:2601.15808 +
 * ReasoningBank MaTTS, adapted to a local model with NO weight updates). Where
 * `enforceAnswerCitations` edits the text, this JUDGES the whole answer against
 * the evidence it was grounded on and returns one verdict — separating the
 * answer-maker from the verifier (the harness "maker ≠ judge" gate).
 *
 * - `grounded`  — confident retrieval, the answer's claims are backed by the
 *   evidence, the query is addressed, and every citation resolves. Surface it.
 * - `weak`      — only weakly relevant evidence (ambiguous cosine) but otherwise
 *   consistent. The caller falls back to "I'm not sure" (slice 1) or a 1-shot
 *   LLM re-verification (slice 2).
 * - `ungrounded`— nothing retrieved, a fabricated citation, or claims the
 *   evidence does not support. Dropped by CODE — fabrication can't reach the user.
 *
 * Citations are the `[from <source>]` form, resolved case/space-insensitively
 * against the retrieved sources (notes are identifiers — exact match, mirroring
 * `enforceAnswerCitations`).
 */
export function verifyGrounding(
  answer: string,
  matches: readonly KnowledgeMatch[],
  query: string,
  options?: VerifyGroundingOptions
): GroundingVerification {
  const confidentAt = finiteOr(options?.confidentAt, DEFAULT_CONFIDENT_AT);
  const coverageFloor = finiteOr(options?.coverageFloor, DEFAULT_COVERAGE_FLOOR);
  const answerabilityFloor = finiteOr(options?.answerabilityFloor, DEFAULT_ANSWERABILITY_FLOOR);

  const retrieval = classifyRetrievalConfidence(matches, { confidentAt });
  const confidence = retrieval === "confident" ? 1 : retrieval === "ambiguous" ? 0.5 : 0;

  const evidence = unionContentTokens(matches);
  const answerTokens = lexicalTokens(answer.replace(/\[[^\]]*\]/gu, " "));
  const coverage = coveredFraction(answerTokens, evidence);
  const answerability = query.trim().length === 0 ? 1 : coveredFraction(lexicalTokens(query), evidence);

  const sourceSet = new Set(matches.map((m) => m.source.trim().toLowerCase()));
  const cited = citedSourcesIn(answer);
  const invalidCitations = cited.filter((src) => !sourceSet.has(src.trim().toLowerCase()));
  const citationValidity = cited.length === 0 ? 1 : (cited.length - invalidCitations.length) / cited.length;

  const rubric: GroundingRubric = { answerability, citationValidity, confidence, coverage };

  if (retrieval === "none") {
    return { invalidCitations, reason: "no evidence retrieved", rubric, verdict: "ungrounded" };
  }
  if (invalidCitations.length > 0) {
    return { invalidCitations, reason: "answer cites a source that was not retrieved", rubric, verdict: "ungrounded" };
  }
  if (coverage < coverageFloor) {
    return { invalidCitations, reason: "answer makes claims the evidence does not support", rubric, verdict: "ungrounded" };
  }
  if (confidence === 1 && answerability >= answerabilityFloor) {
    return { invalidCitations, reason: "confident, covered, and fully cited", rubric, verdict: "grounded" };
  }
  return { invalidCitations, reason: "evidence only weakly supports the answer", rubric, verdict: "weak" };
}

export interface BestGroundedDraft {
  readonly index: number;
  readonly draft: string;
  readonly verification: GroundingVerification;
}

/**
 * Best-of-N selection over recall drafts: verify every draft with the same
 * deterministic rubric and keep the best GROUNDED survivor — "weak" is never
 * accepted, so re-sampling can only raise the answered rate, not admit a
 * fabrication (small models can't self-verify; the owned verifier selects).
 */
export function selectBestGroundedDraft(
  drafts: readonly string[],
  matches: readonly KnowledgeMatch[],
  query: string,
  options?: VerifyGroundingOptions
): BestGroundedDraft | undefined {
  let best: BestGroundedDraft | undefined;
  let bestScore = -1;
  for (let index = 0; index < drafts.length; index += 1) {
    const draft = drafts[index]!;
    const verification = verifyGrounding(draft, matches, query, options);
    if (verification.verdict !== "grounded") {
      continue;
    }
    const { answerability, citationValidity, confidence, coverage } = verification.rubric;
    const score = answerability + citationValidity + confidence + coverage;
    if (score > bestScore) {
      best = { draft, index, verification };
      bestScore = score;
    }
  }
  return best;
}

/**
 * Embed a match's text for dedup comparison, preferring the input chunk's
 * `embedText` (the same embedding space used during ranking — a cache hit).
 * Returns null on any embed failure so the dedup stays fail-open.
 */
async function embedChunkVec(
  inputChunk: KnowledgeChunk | undefined,
  match: KnowledgeMatch,
  embed: (text: string) => Promise<readonly number[]>
): Promise<readonly number[] | null> {
  try {
    return await embed(inputChunk?.embedText ?? match.text);
  } catch {
    return null;
  }
}

/**
 * Drop a candidate bridge/addition that is a near-duplicate of a chunk already
 * kept (a primary hit OR an earlier-kept addition). Mirrors the ask-window
 * `dedupNearDuplicateChunks` (@muse/recall) on the ENGINE path: a hop/PPR
 * bridge can surface a chunk near-identical to a primary (same fact across two
 * notes, or a bridge adjacent to a seed) and pad the small model's grounding
 * window with redundancy. Greedy first-wins so the higher-ranked chunk survives.
 *
 * AUGMENT-never-displace + FAIL-OPEN: only candidate ADDITIONS are filtered —
 * the primary ranking is never touched. Each chunk's embedding is fetched via
 * the (caching) embedder; a degenerate/length-mismatched vec yields cosine 0
 * (< threshold) so it never registers as a duplicate, and an embed FAILURE
 * keeps the candidate. Redundancy is dropped only on a confident match.
 */
async function dropNearDuplicateAdditions(
  kept: readonly KnowledgeMatch[],
  additions: readonly KnowledgeMatch[],
  embedFor: (match: KnowledgeMatch) => Promise<readonly number[] | null>,
  threshold = 0.985
): Promise<KnowledgeMatch[]> {
  if (additions.length === 0) return [];
  const keptVecs: (readonly number[])[] = [];
  for (const match of kept) {
    const vec = await embedFor(match);
    if (vec !== null) keptVecs.push(vec);
  }
  const survivors: KnowledgeMatch[] = [];
  for (const candidate of additions) {
    const vec = await embedFor(candidate);
    const isNearDup =
      vec !== null && keptVecs.some((kv) => cosineSimilarity(vec, kv) >= threshold);
    if (!isNearDup) {
      survivors.push(candidate);
      if (vec !== null) keptVecs.push(vec);
    }
  }
  return survivors;
}

/**
 * Append up to 2 associative bridges to `primary` using PPR over the
 * note-link graph (HippoRAG 2, arXiv:2502.14802). Seed weights = primary
 * match scores; appended bridges carry a query-relative cosine (or 0 on
 * embed failure). Primary list is never mutated.
 */
async function appendAssociativeBridges(
  query: string,
  primary: readonly KnowledgeMatch[],
  notes: readonly KnowledgeChunk[],
  options: RankKnowledgeOptions
): Promise<KnowledgeMatch[]> {
  if (primary.length === 0) {
    return [...primary];
  }
  const keyOf = (chunk: KnowledgeChunk | KnowledgeMatch): string =>
    `${chunk.source}|${chunk.text}`;

  const graph = buildNoteLinkGraph(notes);
  const seeds = new Map<string, number>();
  for (const match of primary) {
    seeds.set(keyOf(match), Math.max(match.cosine ?? match.score, 0));
  }

  const pprScores = personalizedPageRank(graph, seeds);
  const primaryKeys = new Set(primary.map((m) => keyOf(m)));

  // arXiv:2502.14802 §3.2: only nodes genuinely reached by the PPR walk
  // (score > 0) qualify as bridges; zero-score nodes were never traversed.
  const bridgeCandidates = [...pprScores.entries()]
    .filter(([key, score]) => !primaryKeys.has(key) && score > 1e-9)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([key]) => key);

  const inputByKey = new Map<string, KnowledgeChunk>();
  for (const chunk of notes) {
    inputByKey.set(keyOf(chunk), chunk);
  }

  let queryVec: readonly number[] | null = null;
  try {
    queryVec = await options.embed(query);
  } catch {
    // fail-safe: bridges get cosine=0
  }

  const additions: KnowledgeMatch[] = [];
  for (const key of bridgeCandidates) {
    const chunk = inputByKey.get(key);
    if (!chunk) continue;
    let queryCosine = 0;
    if (queryVec !== null) {
      try {
        const chunkVec = await options.embed(chunk.embedText ?? chunk.text);
        queryCosine = cosineSimilarity(queryVec, chunkVec);
      } catch {
        queryCosine = 0;
      }
    }
    additions.push({ cosine: queryCosine, score: queryCosine, source: chunk.source, text: chunk.text });
  }

  const deduped = await dropNearDuplicateAdditions(primary, additions, (match) =>
    embedChunkVec(inputByKey.get(keyOf(match)), match, options.embed)
  );
  return [...primary, ...deduped];
}

/**
 * Deterministic second-hop retrieval (pseudo-relevance feedback, Rocchio
 * lineage): a two-hop question ("the team of the person who recommended the
 * book") names only hop 1 — the bridging note shares no tokens with the
 * query, so single-shot recall measured 2/6 joint@4 on the multi-hop battery.
 * Re-query with the TOP primary hits' own text (the bridge entity lives
 * there), then RRF-merge primary + hop lists. Zero model calls — two extra
 * embeds; `secondHop` is opt-in so the base path is byte-identical without it.
 */
export async function rankKnowledgeChunksWithHop(
  query: string,
  notes: readonly KnowledgeChunk[],
  options: RankKnowledgeOptions & { readonly secondHop?: boolean; readonly associative?: boolean }
): Promise<KnowledgeMatch[]> {
  const primary = await rankKnowledgeChunks(query, notes, options);
  if (options.secondHop !== true && options.associative !== true) {
    return primary;
  }
  if (options.secondHop !== true && options.associative === true) {
    return appendAssociativeBridges(query, primary, notes, options);
  }
  if (primary.length === 0) {
    return primary;
  }
  const keyOf = (match: KnowledgeMatch): string => `${match.source}|${match.text}`;
  const byKey = new Map<string, KnowledgeMatch>();
  const lists: string[][] = [primary.map((match) => { byKey.set(keyOf(match), match); return keyOf(match); })];
  for (const seed of primary.slice(0, 2)) {
    try {
      const hop = await rankKnowledgeChunks(seed.text, notes, options);
      lists.push(hop.map((match) => {
        const key = keyOf(match);
        const known = byKey.get(key);
        if (!known || (match.cosine ?? 0) > (known.cosine ?? 0)) byKey.set(key, match);
        return key;
      }));
    } catch {
      // hop retrieval is best-effort — a failed hop keeps the primary list
    }
  }
  // AUGMENT, never displace: the primary ranking is the measured single-hop
  // optimum (hit@1 15/15), so it keeps its exact order; hop-only bridges are
  // APPENDED (best-fused first, max 2) — multi-hop gains joint coverage while
  // single-hop behavior stays byte-identical.
  const fused = fuseByReciprocalRank(lists);
  const primaryKeys = new Set(primary.map((match) => keyOf(match)));

  // Recompute cosine for appended bridges against the ORIGINAL QUERY so
  // additions carry query-relative confidence, not seed-relative (inflated) cosine.
  // The caching embedder makes these cache hits — the same texts were already
  // embedded during the primary and hop ranking passes above.
  let queryVec: readonly number[] | null = null;
  try {
    queryVec = await options.embed(query);
  } catch {
    // If the query embed fails, fall back: all additions get cosine=0 (fail-safe below).
  }

  const inputByKey = new Map<string, KnowledgeChunk>();
  for (const chunk of notes) {
    inputByKey.set(`${chunk.source}|${chunk.text}`, chunk);
  }

  const additionKeys = [...byKey.keys()]
    .filter((key) => !primaryKeys.has(key))
    .sort((a, b) => (fused.get(b) ?? 0) - (fused.get(a) ?? 0))
    .slice(0, 2);

  const additions: KnowledgeMatch[] = [];
  for (const key of additionKeys) {
    const match = byKey.get(key)!;
    let queryCosine = 0;
    if (queryVec !== null) {
      try {
        // Prefer the input chunk's embedText (same embedding space used during ranking);
        // fall back to the match's display text.
        const inputChunk = inputByKey.get(key);
        const chunkVec = await options.embed(inputChunk?.embedText ?? match.text);
        queryCosine = cosineSimilarity(queryVec, chunkVec);
      } catch {
        // Fail-safe: an appended bridge must NEVER inflate retrieval confidence.
        queryCosine = 0;
      }
    }
    additions.push({ ...match, cosine: queryCosine });
  }

  const deduped = await dropNearDuplicateAdditions(primary, additions, (match) =>
    embedChunkVec(inputByKey.get(keyOf(match)), match, options.embed)
  );
  return [...primary, ...deduped];
}

export interface GroundingExplanationOptions {
  /** The top match's ABSOLUTE cosine — the rubric stores the categorical confidence, not the raw value. */
  readonly topCosine?: number;
  readonly confidentAt?: number;
  readonly coverageFloor?: number;
  readonly answerabilityFloor?: number;
}

/**
 * Plain-language WHY behind a non-`grounded` verdict — the "shows its work" edge
 * applied to the REFUSAL itself (`muse ask --why`). Names each rubric criterion
 * that fell short and the measured value vs its threshold, turning an opaque
 * "I'm not sure" into an inspectable, actionable judgement (rephrase, reindex,
 * add a note). Returns `[]` for a `grounded` verdict — silent on the happy path
 * (a targeted trust affordance, not a debug firehose). Pure: the caller passes
 * the top match's cosine, since the rubric carries the categorical confidence
 * (1/0.5/0), not the raw cosine the user wants to see.
 */
export function explainGroundingVerdict(
  verification: GroundingVerification,
  options?: GroundingExplanationOptions
): string[] {
  if (verification.verdict === "grounded") {
    return [];
  }
  const confidentAt = finiteOr(options?.confidentAt, DEFAULT_CONFIDENT_AT);
  const coverageFloor = finiteOr(options?.coverageFloor, DEFAULT_COVERAGE_FLOOR);
  const answerabilityFloor = finiteOr(options?.answerabilityFloor, DEFAULT_ANSWERABILITY_FLOOR);
  const { answerability, confidence, coverage } = verification.rubric;
  const cosineNote = typeof options?.topCosine === "number"
    ? ` (best match ${options.topCosine.toFixed(2)}, I need ${confidentAt.toFixed(2)})`
    : "";
  const lines: string[] = [];
  if (confidence === 0) {
    lines.push(`no notes came close enough to the question${cosineNote} — confidence criterion`);
  } else if (confidence < 1) {
    lines.push(`the closest notes are only loosely related${cosineNote} — confidence criterion (low)`);
  }
  if (verification.invalidCitations.length > 0) {
    lines.push(`the answer cited ${verification.invalidCitations.length.toString()} source(s) you don't have (${verification.invalidCitations.join(", ")}) — citation criterion`);
  }
  if (coverage < coverageFloor) {
    lines.push(`the evidence covers only ${(coverage * 100).toFixed(0)}% of the answer's wording (I need ${(coverageFloor * 100).toFixed(0)}%) — coverage criterion`);
  }
  if (answerability < answerabilityFloor) {
    lines.push(`your notes address only ${(answerability * 100).toFixed(0)}% of the question (I need ${(answerabilityFloor * 100).toFixed(0)}%) — answerability criterion`);
  }
  if (lines.length === 0) {
    lines.push(verification.reason);
  }
  return lines;
}

export interface GroundingReverifyInput {
  readonly answer: string;
  /** The grounded passages, joined — the evidence the judge checks against. */
  readonly evidence: string;
  readonly query: string;
}

/**
 * Injected one-shot judge: returns `true` iff the answer is supported by the
 * evidence. Kept as a plain function so this package stays model-agnostic — the
 * caller wires a local-Qwen `generate` + `parseGroundingReverifyVerdict`.
 */
export type GroundingReverify = (input: GroundingReverifyInput) => Promise<boolean>;

/**
 * How k judge verdicts are collapsed into one decision.
 * - "unanimous-pass"  — upgrade to `grounded` ONLY if every sample agrees (YES).
 * - "unanimous-keep"  — keep `grounded` ONLY if every sample agrees (YES).
 * Both are the SAME reducer; the two names document call-site intent and leave
 * room for future divergence (arXiv:2203.11171 self-consistency; arXiv:2510.27106
 * "Rating Roulette" — single-judge verdicts have near-arbitrary intra-rater variance).
 */
export type JudgeConsensusMode = "unanimous-pass" | "unanimous-keep";

/**
 * Aggregate k boolean judge verdicts by a fail-close unanimous rule.
 * Returns true ONLY when every sample is true (empty → false).
 */
export function judgeConsensus(verdicts: readonly boolean[], _mode: JudgeConsensusMode): boolean {
  return verdicts.length > 0 && verdicts.every((v) => v);
}

export const REVERIFY_SYSTEM_PROMPT =
  "You are a strict grounding judge. Given a user QUESTION, an ANSWER, and the EVIDENCE the answer was drawn from, decide whether the EVIDENCE actually supports the ANSWER's factual claims. The QUESTION, ANSWER, and EVIDENCE may be in DIFFERENT languages — judge whether the underlying FACTS match (a value, number, name, or term that appears in the EVIDENCE supports the same fact in the ANSWER even when the surrounding words are translated), NOT whether the wording matches. A value the EVIDENCE does NOT contain is still unsupported, in any language. Reply with a single word: YES if the evidence supports it, NO if it does not or you are unsure. Do not explain.";

export function buildGroundingReverifyPrompt(input: GroundingReverifyInput): string {
  return [
    `QUESTION: ${input.query}`,
    `ANSWER: ${input.answer}`,
    "EVIDENCE:",
    input.evidence,
    "",
    "Does the EVIDENCE support the ANSWER's claims? Reply YES or NO."
  ].join("\n");
}

/**
 * Deterministic, fail-close parse of the judge's reply: supported ONLY on a
 * clear leading YES. Anything else — NO, hedging, empty — is unsupported, so a
 * confused small model can never UPGRADE a weak answer by accident.
 */
export function parseGroundingReverifyVerdict(output: string): boolean {
  return /^\s*(yes|y|true|supported)\b/iu.test(output.trim());
}

/**
 * Schema for Ollama's `format` constrained decoding on the reverify judge —
 * the verdict can no longer be lost to parse drift (a hedge, an explanation,
 * an empty completion). Safe here because the judge call carries NO tools
 * (Ollama can't compose format+tools — #6002; tool calls stay unconstrained).
 */
export const REVERIFY_RESPONSE_FORMAT = {
  properties: { supported: { type: "boolean" } },
  required: ["supported"],
  type: "object"
};

/**
 * Parse the format-constrained verdict; a non-JSON reply (older runtime, env
 * without format support) degrades to the legacy YES-word parse. Both layers
 * fail-close — anything unclear is unsupported.
 */
export function parseGroundingReverifyJson(output: string): boolean {
  try {
    const parsed: unknown = JSON.parse(output.trim());
    if (parsed && typeof parsed === "object" && "supported" in parsed) {
      return (parsed as { supported: unknown }).supported === true;
    }
    return false;
  } catch {
    return parseGroundingReverifyVerdict(output);
  }
}

/**
 * Build the canonical one-shot grounding judge ({@link GroundingReverify}) from a
 * minimal text-generation provider — the SAME reverify the reflection + proactive-
 * notice faithfulness gates inject, so every "free LLM prose over a known source"
 * surface verifies identically. Relies on the free-text YES/NO fallback in
 * {@link parseGroundingReverifyJson}, so it works even with a narrow provider that
 * has no structured-output capability. Pure over the provider.
 */
export function buildGroundingReverify(
  provider: {
    generate(request: {
      readonly model: string;
      readonly messages: readonly { readonly role: "system" | "user" | "assistant"; readonly content: string }[];
      readonly maxOutputTokens?: number;
      readonly temperature?: number;
    }): Promise<{ readonly output?: string }>;
  },
  model: string
): GroundingReverify {
  return async ({ answer, evidence, query }) => {
    const judged = await provider.generate({
      maxOutputTokens: 24,
      messages: [
        { content: REVERIFY_SYSTEM_PROMPT, role: "system" },
        { content: buildGroundingReverifyPrompt({ answer, evidence, query }), role: "user" }
      ],
      model,
      temperature: 0
    });
    return parseGroundingReverifyJson(judged.output ?? "");
  };
}

// Month / day names: a correct date answer renders "September" for an evidence
// "09" token, so they are excluded from the named-entity check below to avoid a
// needless escalation on a faithful date.
const VALUE_WORD_STOPLIST = new Set([
  "january", "february", "march", "april", "may", "june", "july",
  "august", "september", "october", "november", "december",
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"
]);

// Sentence-opener / connective words a chatty model capitalizes only because
// they start a sentence — NOT named entities. Excluded so "However, …" /
// "Based on your notes, …" don't trigger a needless value-escalation judge pass.
const SENTENCE_OPENER_STOPLIST = new Set([
  "however", "based", "according", "additionally", "moreover", "furthermore",
  "therefore", "thus", "hence", "consequently", "meanwhile", "instead",
  "otherwise", "nonetheless", "nevertheless", "although", "though", "because",
  "since", "while", "when", "where", "whereas", "also", "finally", "firstly",
  "secondly", "next", "then", "overall", "generally", "specifically", "note",
  "here", "there", "currently", "recently", "unfortunately", "fortunately",
  "importantly", "notably", "similarly", "conversely", "regarding", "given",
  "considering", "despite", "besides", "alternatively", "basically",
  "essentially", "ultimately", "first", "second", "third",
  "yes", "sure", "okay", "well"
]);

/**
 * The VALUE tokens the answer asserts that the evidence does NOT contain — a
 * pure-digit NUMBER ("MTU 9000" vs the note's "1380"), a whole EMAIL ADDRESS
 * ("jane@acme.com" vs the note's "jane@globex.com"), OR a capitalized NAMED
 * ENTITY ("Dr. Kim" vs "Dr. Patel"). The rubric's `coverage` is whole-answer
 * token overlap, so a single wrong value barely dents coverage and the answer
 * still reads `grounded` — the documented wrong-value hole. This flags exactly
 * that case so re-verification can escalate it to the judge (claim-level
 * grounding — Self-RAG ISSUP arXiv:2310.11511; Chain-of-Note arXiv:2311.09210).
 * Citations are stripped first (a `[from 2026-…]` source is never an asserted
 * value); month/day names are excluded. The call site is FAIL-OPEN, so a false
 * flag only costs one judge pass that upholds a correct answer, never a refusal.
 */
const ISO_DATE_RE = /\b\d{4}-\d{2}-\d{2}\b/gu;
const DATE_MONTH_NUMBER: Readonly<Record<string, number>> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12
};
// Case-sensitive (initial-cap) so the modal verb "may" in prose isn't a false May date.
const EN_PROSE_DATE_RE = /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+(\d{1,2})\b/gu;
const KO_DATE_RE = /(\d{1,2})\s*월\s*(\d{1,2})\s*일/gu;

/**
 * Script-neutral `month-day` keys ("9-14") from every date form in `text` — ISO
 * ("2026-09-14"), English prose ("September 14"), Korean ("9월 14일"). Binds month+day
 * as ONE key so a drifted calendar/deadline DAY can't be waved through by an unrelated
 * same-digit elsewhere in the evidence (the bare-number guard's blind spot). Year is
 * dropped (the number guard owns it). The chat date gate (fire 31) shares this one copy.
 */
export function monthDayKeys(text: string): Set<string> {
  const out = new Set<string>();
  for (const d of text.match(ISO_DATE_RE) ?? []) {
    const [, m, day] = d.split("-");
    out.add(`${Number(m).toString()}-${Number(day).toString()}`);
  }
  for (const m of text.matchAll(EN_PROSE_DATE_RE)) {
    const month = DATE_MONTH_NUMBER[m[1]!.toLowerCase()];
    if (month) out.add(`${month.toString()}-${Number(m[2]).toString()}`);
  }
  for (const m of text.matchAll(KO_DATE_RE)) {
    out.add(`${Number(m[1]).toString()}-${Number(m[2]).toString()}`);
  }
  return out;
}

function answerAssertsUnsupportedValue(answer: string, matches: readonly KnowledgeMatch[]): boolean {
  const stripped = answer.replace(/\[[^\]]*\]/gu, " ");
  const evidence = unionContentTokens(matches);
  // DATE drift (ask-path counterpart of the chat date gate, fire 31): bind month+day so
  // a calendar/renewal date that drifts by a day (Sep 14 vs the note's Sep 13) flags even
  // when the day "14" appears elsewhere in evidence. Month names are stoplisted from the
  // bare-number path, so this is the only place a drifted prose/KO date can be caught.
  const answerDates = monthDayKeys(stripped);
  if (answerDates.size > 0) {
    const evidenceDates = monthDayKeys(matches.map((m) => m.text).join(" "));
    if (evidenceDates.size > 0 && [...answerDates].some((d) => !evidenceDates.has(d))) {
      return true;
    }
  }
  // Strip date expressions before the bare-number check so a date's DAY digit isn't
  // re-judged as a loose number (which would false-fire when the evidence carries the
  // same day only inside an ISO date — "September 13" vs "2026-09-13").
  const numStripped = stripped.replace(ISO_DATE_RE, " ").replace(EN_PROSE_DATE_RE, " ").replace(KO_DATE_RE, " ");
  const numbers = [...lexicalTokens(numStripped)].filter((token) => /^\d+$/u.test(token));
  if (numbers.some((number) => !evidence.has(number))) {
    return true;
  }
  // Structured identifiers — an EMAIL ADDRESS the answer asserts must appear
  // VERBATIM in the evidence. The token rules above are blind to these: an email
  // tokenises to lowercase parts (jane@acme.com → jane/acme/com), so a drifted
  // DOMAIN ("acme" for the note's "globex") is neither a pure digit nor a
  // capitalised entity and a WRONG contact email passes as "grounded" — the most
  // dangerous drift for a contact / outbound surface. Compare whole addresses
  // against the raw evidence text, case-insensitively (local part + domain are
  // both copied verbatim from a note, never reformatted).
  const evidenceText = matches.map((m) => m.text).join(" ").toLowerCase();
  const emails = stripped.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/giu) ?? [];
  if (emails.some((address) => !evidenceText.includes(address.toLowerCase()))) {
    return true;
  }
  const namedEntities = (stripped.match(/\b[A-Z][a-zA-Z]{2,}\b/gu) ?? [])
    .map((word) => word.toLowerCase())
    .filter((word) => !LEXICAL_STOPWORDS.has(word) && !VALUE_WORD_STOPLIST.has(word) && !SENTENCE_OPENER_STOPLIST.has(word));
  return namedEntities.some((entity) => !evidence.has(entity));
}

/**
 * Test-time verification scaling for the WEAK verdict (Memory-aware Test-Time
 * Scaling — ReasoningBank MaTTS, arXiv:2509.25140; rubric-guided verification,
 * arXiv:2601.15808). The deterministic `verifyGrounding` core decides
 * `grounded` / `ungrounded` outright — only the ambiguous `weak` band spends a
 * second inference: one injected judge re-checks the answer against the
 * evidence. Fail-close — the weak answer is UPGRADED to `grounded` ONLY on an
 * explicit supported verdict; an unsupported verdict OR any re-verifier error
 * DEMOTES it to `ungrounded` (a weak answer never silently survives on a failed
 * check).
 *
 * Claim-level value escalation: a `grounded` answer that still asserts a NUMBER
 * or a NAMED ENTITY absent from the evidence (the wrong-value hole the lexical
 * rubric is blind to) also spends ONE judge pass — but FAIL-OPEN, since `base`
 * already cleared every deterministic criterion: a judge ERROR must not demote a
 * passing answer, only an explicit unsupported verdict does. A `grounded` answer
 * whose values all check out, and any `ungrounded` verdict, never call the judge.
 */
export async function verifyGroundingWithReverify(
  answer: string,
  matches: readonly KnowledgeMatch[],
  query: string,
  reverify: GroundingReverify,
  options?: VerifyGroundingOptions
): Promise<GroundingVerification> {
  const base = verifyGrounding(answer, matches, query, options);
  const evidence = matches.map((m) => m.text).join("\n");
  // Empty evidence is unverifiable BY DEFINITION — a high-cosine match with empty
  // text gives confidence>0 yet evidence="". No band may escalate UP to grounded
  // by asking the judge about nothing (a YES on "" would be a fabrication-floor
  // leak — the exact hole fail-closed for council/reflection). Fail-close WITHOUT
  // consulting the judge; a `grounded` base is left to the value band below (which
  // can only tighten), so a grounded refusal is never demoted here.
  if (evidence.trim().length === 0 && base.verdict !== "grounded") {
    return { ...base, reason: "empty evidence — unverifiable, fail-closed", verdict: "ungrounded" };
  }
  const samples = Math.min(5, Math.max(1, options?.reverifySamples ?? 1));

  /** Collect up to `samples` verdicts, short-circuiting on the first false (unanimous). */
  async function collectVerdicts(input: GroundingReverifyInput): Promise<boolean[]> {
    const verdicts: boolean[] = [];
    for (let i = 0; i < samples; i++) {
      const v = await reverify(input);
      verdicts.push(v);
      if (!v) break;
    }
    return verdicts;
  }

  if (base.verdict === "weak") {
    let verdicts: boolean[];
    try {
      verdicts = await collectVerdicts({ answer, evidence, query });
    } catch {
      return { ...base, reason: "weak retrieval + re-verification failed — fail-closed to ungrounded", verdict: "ungrounded" };
    }
    return judgeConsensus(verdicts, "unanimous-pass")
      ? { ...base, reason: "weak retrieval upheld by re-verification", verdict: "grounded" }
      : { ...base, reason: "weak retrieval rejected by re-verification", verdict: "ungrounded" };
  }
  // Coverage-ONLY failure: retrieval succeeded (confidence > 0) and every citation
  // is valid (no invalid source), but the answer's lexical token-coverage is below
  // the floor. That is exactly the band the token proxy gets WRONG — a CROSS-LINGUAL
  // answer (Korean prose over English evidence) or a terse structured fact scores low
  // coverage yet states a value the evidence DOES contain. Defer to the SAME judge as
  // the weak band rather than hard-failing; a real drift / wrong value is still
  // rejected (it stays "NO" in any language). Fail-closed to the original ungrounded
  // verdict if there is no judge or it errors.
  if (base.verdict === "ungrounded" && base.rubric.confidence > 0 && base.invalidCitations.length === 0) {
    let verdicts: boolean[];
    try {
      verdicts = await collectVerdicts({ answer, evidence, query });
    } catch {
      return base;
    }
    return judgeConsensus(verdicts, "unanimous-pass")
      ? { ...base, reason: "low coverage upheld by re-verification", verdict: "grounded" }
      : { ...base, reason: "low coverage rejected by re-verification", verdict: "ungrounded" };
  }
  if (base.verdict === "grounded" && answerAssertsUnsupportedValue(answer, matches)) {
    let verdicts: boolean[];
    try {
      verdicts = await collectVerdicts({ answer, evidence, query });
    } catch {
      return base;
    }
    return judgeConsensus(verdicts, "unanimous-keep")
      ? base
      : { ...base, reason: "answer asserts a value the evidence does not support", verdict: "ungrounded" };
  }
  return base;
}

/** A right-hand fragment is a CLAUSE (worth judging on its own) only if it
 *  carries a value (a digit) or is long enough to be a predicate — NOT a short
 *  noun continuation ("Sarah and Bob"), which would shred a list into garbage
 *  claims and risk false drops. Conservative on purpose. */
function isClauseFragment(text: string): boolean {
  const trimmed = text.trim();
  if (/\d/u.test(trimmed)) {
    return true;
  }
  return trimmed.split(/\s+/u).filter(Boolean).length >= 5;
}

function splitClausalConjunctions(text: string): string[] {
  const raw = text.split(/\s*,?\s+(?:and|but)\s+/iu);
  if (raw.length <= 1) {
    return [text];
  }
  const merged: string[] = [raw[0]!];
  for (let i = 1; i < raw.length; i += 1) {
    if (isClauseFragment(raw[i]!)) {
      merged.push(raw[i]!);
    } else {
      // A noun continuation, not a new clause — re-join so a list never splits.
      merged[merged.length - 1] = `${merged[merged.length - 1]} and ${raw[i]!}`;
    }
  }
  return merged;
}

/**
 * Segment a grounded answer into atomic CLAIMS for per-claim verification
 * (Self-RAG ISSUP, arXiv:2310.11511): split on sentence terminators and
 * semicolons, then on `and`/`but` ONLY when the right side is a real clause
 * (carries a value or ≥5 words), so "Mina owns pricing and the budget was
 * 2,000,000 KRW" yields TWO claims while "Sarah and Bob report to Mina" stays
 * ONE. Citation markers ride along with their clause. Empty fragments dropped.
 * Conservative by design — under-segmenting only degrades to whole-answer
 * checking; over-segmenting risks dropping a true clause. Pure.
 */
export function segmentClaims(answer: string): readonly string[] {
  const trimmed = answer.trim();
  if (trimmed.length === 0) {
    return [];
  }
  const out: string[] = [];
  for (const sentence of trimmed.split(/(?<=[.!?])\s+/u)) {
    for (const bySemicolon of sentence.split(/\s*;\s*/u)) {
      out.push(...splitClausalConjunctions(bySemicolon));
    }
  }
  return out.map((claim) => claim.trim()).filter((claim) => claim.length > 0);
}

export interface PerClaimVerdict {
  readonly claim: string;
  readonly supported: boolean;
}

export interface PerClaimRefinement {
  /** The answer with unsupported claims removed + an honest "I'm not sure" note. Equals the input when nothing was dropped. */
  readonly answer: string;
  readonly verdicts: readonly PerClaimVerdict[];
  readonly dropped: number;
}

/**
 * Per-claim grounding refinement (Self-RAG ISSUP). Runs the SAME one-shot judge
 * on EACH atomic claim of an answer the whole-answer gate already passed as
 * `grounded`, and SURGICALLY drops only the unsupported claims — keeping the
 * cited true clauses and appending an honest "I'm not sure about …" note —
 * instead of the all-or-nothing whole-answer verdict (which either lets one
 * fabricated clause ride through or refuses the entire answer).
 *
 * Safety (the reason this strictly tightens, never over-refuses a passing
 * answer): it is meant to run ONLY on an already-`grounded` answer, it FAILS
 * OPEN per claim (a judge error KEEPS the claim, matching the value-escalation
 * fail-open), a 0/1-claim answer is returned untouched, and claims beyond
 * `maxClaims` are kept verbatim (never dropped unchecked). So the worst case is
 * an occasional false-drop on an opt-in surface, never a new refusal.
 */
export async function verifyGroundingPerClaim(
  answer: string,
  matches: readonly KnowledgeMatch[],
  query: string,
  reverify: GroundingReverify,
  options?: { readonly maxClaims?: number; readonly suspectClaims?: ReadonlySet<string> }
): Promise<PerClaimRefinement> {
  const claims = segmentClaims(answer);
  if (claims.length <= 1) {
    return { answer, dropped: 0, verdicts: claims.map((claim) => ({ claim, supported: true })) };
  }
  const evidence = matches.map((m) => m.text).join("\n");
  const cap = Math.max(1, options?.maxClaims ?? 6);
  const checked = claims.slice(0, cap);
  const overflow = claims.slice(cap);
  const verdicts: PerClaimVerdict[] = [];
  for (const claim of checked) {
    // When a pre-filter screen has already classified non-suspect claims,
    // skip the judge for them (only embed cost, not a model call).
    if (options?.suspectClaims !== undefined && !options.suspectClaims.has(claim)) {
      verdicts.push({ claim, supported: true });
      continue;
    }
    let supported: boolean;
    try {
      supported = await reverify({ answer: claim, evidence, query });
    } catch {
      supported = true; // judge error → keep the claim (fail-open)
    }
    verdicts.push({ claim, supported });
  }
  const droppedVerdicts = verdicts.filter((v) => !v.supported);
  if (droppedVerdicts.length === 0) {
    return { answer, dropped: 0, verdicts };
  }
  const kept = verdicts.filter((v) => v.supported).map((v) => v.claim);
  const subjects = droppedVerdicts.map((v) => v.claim.replace(/\[[^\]]*\]/gu, "").trim()).filter((s) => s.length > 0);
  const body = [...kept, ...overflow].join(" ").trim();
  const note = subjects.length > 0 ? `${body ? "\n\n" : ""}I'm not sure about: ${subjects.join("; ")}.` : "";
  return { answer: `${body}${note}`.trim(), dropped: droppedVerdicts.length, verdicts };
}

/**
 * Reorder passages so the most relevant sit at the START and END and the
 * weakest land in the MIDDLE — "Lost in the Middle" (Liu et al. 2023,
 * arXiv:2307.03172): decoder LLMs attend most to a context's head and
 * tail and under-use the middle, which bites hardest on a small local
 * model. Pure: ranks by score desc, then places ranks 1,3,5… from the
 * front and 2,4,6… from the back. Shared by `muse ask` and
 * `renderKnowledgeMatches` so both surfaces reorder identically.
 */
export function reorderForLongContext<T extends { readonly score: number }>(items: readonly T[]): T[] {
  const sorted = [...items].sort((a, b) => b.score - a.score);
  const front: T[] = [];
  const back: T[] = [];
  sorted.forEach((item, i) => {
    if (i % 2 === 0) {
      front.push(item);
    } else {
      back.push(item);
    }
  });
  return [...front, ...back.reverse()];
}

/**
 * Split `text` into passages of at most `maxChars`, preferring
 * paragraph boundaries (blank lines) so a chunk stays coherent. A
 * single paragraph longer than `maxChars` is hard-split. Returns []
 * for empty input; a short text returns one chunk. This is what lets
 * a long note / ingested document be retrieved + cited PASSAGE-by-
 * passage instead of truncated to its first `maxChars`.
 *
 * `overlapChars` (optional, default 0 = no overlap, back-compat) adds
 * an OVERLAPPING WINDOW between consecutive chunks: the tail of chunk
 * i-1 is prepended to chunk i, so a fact straddling a boundary appears
 * WHOLE in at least one chunk and stays retrievable. Standard RAG /
 * dense-retrieval chunking practice (Karpukhin et al. 2020, "Dense
 * Passage Retrieval", arXiv:2004.04906, uses overlapping 100-word
 * passages). The overlap is added to chunks i ≥ 1, so they may
 * slightly exceed `maxChars` — embedding models tolerate this; the
 * limit is a soft target.
 */

/** The closest markdown heading PRECEDING the chunk's position in its note. */
export function nearestHeading(noteText: string, chunkText: string): string | undefined {
  const at = noteText.indexOf(chunkText.slice(0, 80).trim());
  if (at < 0) return undefined;
  const before = noteText.slice(0, at);
  const headings = [...before.matchAll(/^#{1,6}[ \t]+(.+)$/gmu)];
  const last = headings[headings.length - 1]?.[1]?.trim();
  // The note TITLE (# h1) is carried by the source name already; prefer a
  // section heading, fall back to the title only when it is not the sole match.
  if (!last) return undefined;
  return last;
}

/**
 * Contextual chunk annotation (Anthropic contextual retrieval, deterministic
 * slice): the EMBEDDED text gets "[<source> · <nearest heading>]" prepended so
 * a context-free chunk (a bare list under "## 준비물") keeps its referent in
 * embedding space; the stored/evidence text stays raw, so the grounding gate
 * and citations are unchanged.
 */
export function annotateNoteChunks(
  source: string,
  noteText: string,
  pieces: readonly string[]
): KnowledgeChunk[] {
  return pieces.map((piece) => {
    const heading = nearestHeading(noteText, piece);
    const context = heading ? `[${source} · ${heading}]` : `[${source}]`;
    return { embedText: `${context} ${piece}`, source, text: piece };
  });
}

export function chunkText(text: string, maxChars: number, overlapChars: number = 0): string[] {
  const trimmed = text.trim();
  const limit = Number.isFinite(maxChars) ? Math.max(1, Math.trunc(maxChars)) : 4_000;
  if (trimmed.length === 0) {
    return [];
  }
  if (trimmed.length <= limit) {
    return [trimmed];
  }
  const paragraphs = trimmed.split(/\n{2,}/u).map((p) => p.trim()).filter((p) => p.length > 0);
  const chunks: string[] = [];
  let current = "";
  for (const paragraph of paragraphs) {
    if (paragraph.length > limit) {
      if (current.length > 0) {
        chunks.push(current);
        current = "";
      }
      for (let i = 0; i < paragraph.length; i += limit) {
        chunks.push(paragraph.slice(i, i + limit));
      }
      continue;
    }
    const candidate = current.length > 0 ? `${current}\n\n${paragraph}` : paragraph;
    if (candidate.length > limit) {
      chunks.push(current);
      current = paragraph;
    } else {
      current = candidate;
    }
  }
  if (current.length > 0) {
    chunks.push(current);
  }
  return applyOverlap(chunks, overlapChars);
}

/**
 * Post-process: prepend each chunk (after the first) with the tail of
 * the previous one, so a fact spanning a chunk boundary appears whole
 * in chunk i. Prefers to start the tail at a word boundary so it
 * doesn't begin mid-token. A 0/negative/no-op `overlap` returns the
 * input unchanged. Exported so other chunkers (the CLI notes-index
 * builder) apply the SAME overlapping window without reimplementing it.
 */
export function applyOverlap(chunks: readonly string[], overlap: number): string[] {
  const n = Number.isFinite(overlap) ? Math.max(0, Math.trunc(overlap)) : 0;
  if (n === 0 || chunks.length <= 1) {
    return [...chunks];
  }
  const out: string[] = [chunks[0] ?? ""];
  for (let i = 1; i < chunks.length; i += 1) {
    const tail = overlapTail(chunks[i - 1] ?? "", n);
    out.push(tail.length > 0 ? `${tail}\n\n${chunks[i] ?? ""}` : chunks[i] ?? "");
  }
  return out;
}

function overlapTail(chunk: string, overlap: number): string {
  if (chunk.length === 0) {
    return "";
  }
  const effective = Math.min(overlap, chunk.length);
  const tail = chunk.slice(-effective);
  // Start the tail at the first whitespace inside it so we don't begin
  // mid-token; if none lies in the front of the tail, return it raw
  // (better to keep the boundary context than to drop it entirely).
  const m = /\s+/u.exec(tail);
  if (m && m.index < Math.floor(effective * 0.3)) {
    return tail.slice(m.index + m[0].length);
  }
  return tail;
}

/**
 * Memoize an embedder by input text so repeated chunks (a corpus is
 * mostly stable across queries) are embedded ONCE, not on every
 * `knowledge_search` call — the responsiveness fix for embedding the
 * whole personal corpus per query. The cached value is the Promise
 * (so concurrent calls dedupe); a rejected embed is evicted so a
 * transient Ollama failure isn't cached forever. Bounded FIFO.
 */
export function createCachingEmbedder(
  embed: (text: string) => Promise<readonly number[]>,
  options: { readonly maxEntries?: number } = {}
): (text: string) => Promise<readonly number[]> {
  const maxEntries = Math.max(1, Math.trunc(finiteOr(options.maxEntries, 4_096)));
  const cache = new Map<string, Promise<readonly number[]>>();
  return (text: string) => {
    const hit = cache.get(text);
    if (hit) {
      return hit;
    }
    const pending = Promise.resolve().then(() => embed(text));
    pending.catch(() => cache.delete(text));
    cache.set(text, pending);
    if (cache.size > maxEntries) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) {
        cache.delete(oldest);
      }
    }
    return pending;
  };
}

export interface KnowledgeSearchToolOptions {
  readonly corpus: readonly KnowledgeChunk[];
  readonly embed: (text: string) => Promise<readonly number[]>;
  readonly topK?: number;
}

/**
 * A read-only `knowledge_search` tool the agent can call to ground an
 * answer in the user's multi-document personal corpus. Returns the
 * matching passages with their `[source]` labels.
 */
export function createKnowledgeSearchTool(options: KnowledgeSearchToolOptions): MuseTool {
  return {
    definition: {
      description: "Search the user's personal knowledge corpus (notes + ingested documents). Returns matching passages, each labelled with its [source] — cite the source you use. Use when the user asks about something they may have written down or saved; do not use for general knowledge or live web data.",
      inputSchema: {
        additionalProperties: false,
        properties: {
          query: {
            description: "What to look up, in natural language — e.g. 'my health insurance policy number' or 'notes from the Q3 launch'.",
            type: "string"
          }
        },
        required: ["query"],
        type: "object"
      },
      name: "knowledge_search",
      risk: "read"
    },
    execute: async (args) => {
      const query = typeof (args as { query?: unknown }).query === "string" ? (args as { query: string }).query : "";
      const matches = await rankKnowledgeChunks(query, options.corpus, {
        diversify: true,
        embed: options.embed,
        hybrid: true,
        ...(options.topK !== undefined ? { topK: options.topK } : {})
      });
      return renderKnowledgeMatches(edgeLoadByRelevance(matches));
    }
  };
}

/**
 * A flagged pair of evidence notes that state the SAME THING but with a
 * DIFFERENT VALUE (e.g. "flight at 3pm" vs "flight at 6pm").
 * `aIndex` and `bIndex` are the two conflicting notes' positions in the
 * original array — no recency ordering implied (score ≠ recency).
 *
 * Detection method from Mem0 (arXiv:2504.19413, Chhikara et al. 2025):
 * detect when a retrieved fact contradicts a stored one, applied here
 * at READ-TIME to annotate conflicting evidence pairs BEFORE the model
 * sees them — moving reconciliation from a fragile prompt instruction
 * into deterministic DATA.
 */
export interface ContradictionPair {
  readonly aIndex: number;
  readonly bIndex: number;
  readonly topicSim: number;
}

const CONTRADICTION_TOPIC_SIM_MIN = 0.86;
const CONTRADICTION_STATEMENT_OVERLAP_MIN = 0.5;

/**
 * Detect evidence notes that make the SAME STATEMENT about the SAME TOPIC but
 * assert a DIFFERENT VALUE — genuine value-conflicts, not paraphrases or
 * elaborations.
 *
 * The signal (precision-first — when unsure, returns nothing):
 * 1. Same-script guard: skip cross-script pairs. Lexical value-comparison is
 *    unreliable cross-lingual (the recurring fire-28/36/39 lesson). Fail-open:
 *    a missed cross-lingual conflict = today's behaviour (safe).
 * 2. Topic gate: cosine(embed(A), embed(B)) ≥ TOPIC_SIM_MIN → same topic.
 * 3. HIGH token overlap + neither-subset = value-conflict skeleton.
 *    HIGH overlap (tokenOverlapRatio ≥ STATEMENT_OVERLAP_MIN) means the notes
 *    share the STATEMENT SKELETON. The neither-subset gate (|A\B|≥1 AND |B\A|≥1)
 *    kills elaboration false-positives: "meeting at 2pm" ⊂ "meeting at 2pm in
 *    room 4" → A is a subset of B → NOT a conflict. Mutual difference at the
 *    value level (each note has ≥1 token absent from the other) is required.
 *
 * Fail-open: any embed error → no pairs → today's behaviour.
 * Never throws, never mutates, never calls an LLM.
 */
/**
 * The pairwise contradiction-detection CORE (shared policy): given a list of texts,
 * return index pairs that are SAME-TOPIC (cosine ≥ topicSimMin) but VALUE-DISAGREEING
 * (high token overlap = same statement skeleton, AND neither-subset = a mutual value
 * difference, not an elaboration). Same-script guard + fail-open on embed error.
 * One detector so the evidence layer ({@link detectEvidenceContradictions}) and the
 * fan-in layer (`detectSubtaskConflicts`) can never drift on the contradiction policy.
 * Pure over the injected embed; never throws.
 */
export async function detectPairwiseContradictions(
  texts: readonly string[],
  embed: (text: string) => Promise<readonly number[]>,
  opts?: { readonly topicSimMin?: number; readonly statementOverlapMin?: number }
): Promise<readonly ContradictionPair[]> {
  const topicSimMin = opts?.topicSimMin ?? CONTRADICTION_TOPIC_SIM_MIN;
  const statementOverlapMin = opts?.statementOverlapMin ?? CONTRADICTION_STATEMENT_OVERLAP_MIN;

  if (texts.length < 2) return [];

  let embeddings: Array<readonly number[] | null>;
  try {
    embeddings = await Promise.all(texts.map((t) => embed(t).catch(() => null)));
  } catch {
    return [];
  }

  const pairs: ContradictionPair[] = [];

  for (let i = 0; i < texts.length; i++) {
    for (let j = i + 1; j < texts.length; j++) {
      const a = texts[i]!;
      const b = texts[j]!;

      // Same-script guard: cross-script pairs are always skipped (fail-open).
      if (!comparableScript(a, b)) continue;

      const embA = embeddings[i];
      const embB = embeddings[j];
      if (!embA || !embB) continue;

      const topicSim = cosineSimilarity(embA, embB);
      if (topicSim < topicSimMin) continue;

      const tokA = lexicalTokens(a);
      const tokB = lexicalTokens(b);
      const unionSize = new Set([...tokA, ...tokB]).size;
      if (unionSize === 0) continue;
      let intersect = 0;
      for (const t of tokA) {
        if (tokB.has(t)) intersect++;
      }
      const overlapRatio = intersect / unionSize;
      if (overlapRatio < statementOverlapMin) continue;

      // Neither-subset gate: both must each have ≥1 content token absent from the
      // other. Kills elaboration false-positives — an elaboration (one is a superset
      // of the other) has |A\B|=0 or |B\A|=0.
      if (tokA.size - intersect === 0 || tokB.size - intersect === 0) continue;

      // aIndex = i (the earlier index in the array); no score-based ordering
      // because score reflects query relevance, not recency.
      pairs.push({ aIndex: i, bIndex: j, topicSim });
    }
  }

  return pairs;
}

export async function detectEvidenceContradictions(
  matches: readonly KnowledgeMatch[],
  embed: (text: string) => Promise<readonly number[]>,
  opts?: { readonly topicSimMin?: number; readonly statementOverlapMin?: number }
): Promise<readonly ContradictionPair[]> {
  return detectPairwiseContradictions(matches.map((m) => m.text), embed, opts);
}
