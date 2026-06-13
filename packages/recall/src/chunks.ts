import { classifyRetrievalConfidence, cosineSimilarity, fuseByReciprocalRank, lexicalOverlap, lexicalTokens, selectByMmr, type RetrievalConfidence } from "@muse/agent-core";

export interface IndexChunk {
  readonly file: string;
  readonly chunkIndex: number;
  readonly text: string;
  readonly embedding: number[];
}

export interface FileEntry {
  readonly path: string;
  readonly chunks: readonly IndexChunk[];
}

export interface ScoredChunk {
  readonly chunk: IndexChunk;
  readonly file: string;
  readonly score: number;
}

const ASK_MMR_LAMBDA = 0.7;

/**
 * Pick the top-K note chunks to ground on. When a `query` is supplied,
 * selection is HYBRID — the embedding-cosine rank is fused with a lexical
 * keyword-overlap rank via Reciprocal Rank Fusion (Cormack et al., SIGIR
 * 2009), the same hybrid the `knowledge_search` path already uses (P23).
 * The headline `muse ask` path was embedding-ONLY, so a query with strong
 * distinctive terms ("WireGuard", "MTU") could rank the one answer-bearing
 * note below near-misses on nomic's compressed cosine and fall out of the
 * default top-K — a FALSE REFUSAL on a question the corpus answers. The
 * fused relevance is normalised to [0,1] before MMR so the diversity term
 * (cosine-similarity scale) stays comparable; each returned chunk keeps its
 * ABSOLUTE cosine `score`, so the CRAG confidence framing is unchanged.
 * Without a query (or with no content tokens) it is the prior cosine MMR.
 */
export function diversifyAskChunks(candidates: readonly ScoredChunk[], topK: number, lambda = ASK_MMR_LAMBDA, query?: string, subqueryEmbeddings?: ReadonlyArray<readonly number[]>): ScoredChunk[] {
  const sorted = [...candidates].sort((a, b) => b.score - a.score);
  if (topK <= 0 || sorted.length <= topK) {
    return sorted.slice(0, Math.max(0, topK));
  }
  const queryTokens = query ? lexicalTokens(query) : new Set<string>();
  if (queryTokens.size > 0) {
    const keyOf = (i: number): string => String(i);
    // Full-query cosine ranking (list #0) + lexical ranking (list #1) are
    // always present. Sub-query cosine rankings (one per clause) are appended
    // when supplied — RAG-Fusion (arXiv:2402.03367): each variant produces an
    // independent ranking, all fused via RRF so a chunk top-ranked by ANY
    // clause surfaces into the selection window.
    const cosRanked = sorted
      .map((c, i) => ({ i, s: c.score }))
      .filter((x) => x.s > 0).sort((a, b) => b.s - a.s).map((x) => keyOf(x.i));
    const lexRanked = sorted
      .map((c, i) => ({ i, s: lexicalOverlap(queryTokens, c.chunk.text) }))
      .filter((x) => x.s > 0).sort((a, b) => b.s - a.s).map((x) => keyOf(x.i));
    const rankingLists: Array<readonly string[]> = [cosRanked, lexRanked];
    if (subqueryEmbeddings && subqueryEmbeddings.length > 0) {
      for (const subVec of subqueryEmbeddings) {
        const subRanked = sorted
          .map((c, i) => ({ i, s: cosineSimilarity(subVec, c.chunk.embedding) }))
          .filter((x) => x.s > 0).sort((a, b) => b.s - a.s).map((x) => keyOf(x.i));
        rankingLists.push(subRanked);
      }
    }
    const fused = fuseByReciprocalRank(rankingLists);
    const maxFused = Math.max(1e-9, ...fused.values());
    const order = selectByMmr(
      sorted.map((c, i) => ({ key: keyOf(i), relevance: (fused.get(keyOf(i)) ?? 0) / maxFused, embedding: c.chunk.embedding })),
      lambda,
      topK
    );
    return order.map((k) => sorted[Number(k)]!);
  }
  const order = selectByMmr(
    sorted.map((c, i) => ({ key: String(i), relevance: c.score, embedding: c.chunk.embedding })),
    lambda,
    topK
  );
  return order.map((k) => sorted[Number(k)]!);
}

/**
 * CRAG confidence gate for `muse ask`'s notes grounding — the headline-surface
 * embodiment of Muse's identity ("says I'm not sure instead of making things
 * up"). The chunk score IS the absolute cosine, so we grade the top match: a
 * CONFIDENT hit is framed for citation; a merely AMBIGUOUS (weak near-miss) set
 * is flagged LOW-confidence so the small model is told NOT to cite it as fact;
 * `none` keeps the plain header (the "no relevant notes" block already shows).
 * Pure + exported for direct unit coverage.
 */
export function notesGroundingFraming(scored: readonly ScoredChunk[], query?: string): { readonly verdict: RetrievalConfidence; readonly header: string; readonly guidance?: string } {
  const cosineVerdict = scored.length === 0
    ? "none"
    : classifyRetrievalConfidence(scored.map((s) => ({ cosine: s.score, source: s.file, score: s.score, text: s.chunk.text })));
  // nomic's cosine space is compressed, so a genuinely-relevant note can sit
  // just below the confident cosine threshold and get falsely flagged LOW —
  // a soft false-refusal ("verify, may not be in your notes") on a correctly
  // cited answer, which erodes the trust edge. A STRONG lexical match (≥2
  // distinct query content tokens present in a grounded chunk) is a
  // high-precision signal that the corpus really does cover the question, so
  // it upgrades an ambiguous cosine verdict to confident. A must-refuse
  // question shares no content tokens, so it stays LOW/none — fabrication=0
  // is preserved (and the citation gate is the hard backstop regardless).
  const queryTokens = query ? lexicalTokens(query) : new Set<string>();
  const strongLexical = queryTokens.size >= 2
    && scored.some((s) => lexicalOverlap(queryTokens, s.chunk.text) >= 2);
  const verdict: RetrievalConfidence = cosineVerdict === "ambiguous" && strongLexical ? "confident" : cosineVerdict;
  if (verdict === "ambiguous") {
    return {
      guidance: "The USER NOTES below are only WEAK matches (low retrieval confidence). Do NOT present them as established fact; if they do not clearly answer the question, say you are not sure rather than cite a weak match.",
      header: "=== USER NOTES (LOW confidence — weak matches; verify, do not cite as fact) ===",
      verdict
    };
  }
  return { header: "=== USER NOTES (top relevant chunks) ===", verdict };
}
