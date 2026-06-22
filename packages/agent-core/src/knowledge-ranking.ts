/**
 * The retrieval ranker family: the multi-source corpus types and the
 * adaptive-k / MMR / cosine ranking that turns a query + chunks into the
 * cited matches the grounding gate then judges.
 */

import { cosineSimilarity } from "./episodic-recall.js";
import {
  bm25Scores,
  finiteOr,
  fuseByReciprocalRank,
  lexicalOverlap,
  lexicalTokens
} from "./recall-lexical.js";

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
    const key = (chunk: KnowledgeChunk): string => `${chunk.source} ${chunk.text}`;
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
    const lambda = Math.min(1, Math.max(0, finiteOr(options.mmrLambda, 0.5)));
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
