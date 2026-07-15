/**
 * Cross-encoder RERANKING — an optional second-pass relevance scorer over the
 * bi-encoder (cosine) top-K. The notes RAG ranks query·chunk by cosine of two
 * SEPARATELY-embedded vectors (fast, coarse); a reranker scores each (query, chunk)
 * PAIR jointly (slower, sharper), so the most relevant chunk rises to the top.
 *
 * This module is the model-agnostic SEAM: the pure reorder primitive + the provider
 * contract. A concrete provider (e.g. a local Qwen3-Reranker via Ollama) plugs in
 * behind it; until one is configured, retrieval is unchanged. Fail-open everywhere —
 * a reranker error or a malformed score set leaves the original cosine order intact
 * and never drops a match (so a flaky rerank can't weaken grounding).
 */

export interface RerankProvider {
  readonly id: string;
  /**
   * Relevance score for each document against the query (higher = more relevant).
   * MUST return one score per document, in the same order. Throwing is allowed —
   * callers fail open to the pre-rerank order.
   */
  rerank(query: string, documents: readonly string[]): Promise<readonly number[]>;
}

/**
 * Re-order `matches` by reranker `scores` (parallel arrays). Fail-open: a length
 * mismatch keeps the original order; a non-finite score falls back to that match's
 * own score. Pure; returns a new array annotated with `rerankScore`, never drops a
 * match.
 */
export function applyReranking<T extends { readonly score: number }>(
  matches: readonly T[],
  scores: readonly number[]
): readonly (T & { readonly rerankScore: number })[] {
  return rankedIndexes(matches, scores).map((index) => {
    const match = matches[index]!;
    const score = scores[index];
    return { ...match, rerankScore: typeof score === "number" && Number.isFinite(score) ? score : match.score };
  });
}

/**
 * Rerank only the top-K of `matches` (the reranker is the expensive pass; the tail
 * rarely changes the answer), leaving the remainder in place. Fail-open: any
 * provider error returns the matches unchanged.
 */
export async function rerankTopK<T extends { readonly score: number; readonly text: string }>(
  matches: readonly T[],
  query: string,
  reranker: RerankProvider,
  topK = 10
): Promise<readonly T[]> {
  const head = matches.slice(0, normalizeTopK(topK));
  if (head.length <= 1) return matches;
  let scores: readonly number[];
  try {
    scores = await reranker.rerank(query, head.map((m) => m.text));
  } catch {
    return matches;
  }
  return [...rankedIndexes(head, scores).map((index) => head[index]!), ...matches.slice(head.length)];
}

function rankedIndexes<T extends { readonly score: number }>(matches: readonly T[], scores: readonly number[]): readonly number[] {
  if (scores.length !== matches.length) {
    return matches.map((_, index) => index);
  }

  return matches
    .map((match, index) => ({ index, score: Number.isFinite(scores[index]) ? scores[index]! : match.score }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map(({ index }) => index);
}

function normalizeTopK(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}
