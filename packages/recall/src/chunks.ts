import { classifyRetrievalConfidence, cosineSimilarity, fuseByReciprocalRank, lexicalOverlap, lexicalTokens, resolveRecallConfidentAt, selectByMmr, selectByScoreGap, type RetrievalConfidence } from "@muse/agent-core";

interface RetrievalIndexChunk {
  readonly file: string;
  readonly chunkIndex: number;
  readonly text: string;
  readonly embedding: number[] | Float32Array;
}

export interface ScoredChunk {
  readonly chunk: RetrievalIndexChunk;
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
  // Adaptive-k: trim to the natural score-distribution knee before MMR so a cliff-
  // shaped distribution (one strong hit + low-scoring decoys) doesn't pad the
  // grounding block with near-miss fabrication surface (arXiv:2506.08479).
  // Trim-only (Math.min keeps it ≤ topK); min:1 always retains the top match.
  const effectiveK = Math.min(topK, selectByScoreGap(sorted.map((c) => c.score), { min: 1, max: topK }));
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
      effectiveK
    );
    return order.map((k) => sorted[Number(k)]!);
  }
  const order = selectByMmr(
    sorted.map((c, i) => ({ key: String(i), relevance: c.score, embedding: c.chunk.embedding })),
    lambda,
    effectiveK
  );
  return order.map((k) => sorted[Number(k)]!);
}

/**
 * Second-hop AUGMENT for `muse ask`'s inline notes recall. A two-hop question
 * ("내 매니저의 상사 누구야") names only the hop-1 entity; the answer note shares
 * no token with the query, so single-shot recall measured hit@4 2/5 on the
 * two-hop battery. From the top single-hop seed(s) we re-rank the SAME in-memory
 * chunks by cosine to the seed CHUNK's embedding (the bridge entity lives in the
 * seed's text — pseudo-relevance feedback, Rocchio lineage), take the best
 * chunk(s) not already present, recompute their cosine against the ORIGINAL
 * query vector (query-relative confidence, never seed-relative inflation), and
 * APPEND up to `cap` of them.
 *
 * SAFETY (mirrors rankKnowledgeChunksWithHop):
 * - AUGMENT, never displace: returns only the NEW chunks to append; the caller's
 *   `scored` array is untouched, so single-hop ranking stays byte-identical.
 * - Zero model calls — all embeddings are the ones already loaded in memory; no
 *   re-embed, so latency is a handful of cosine dot-products.
 * - Fabrication-safe: every appended chunk is a real retrieved note; the
 *   downstream citation gate still runs.
 * Pure + exported for direct unit coverage.
 */
export function secondHopAugmentChunks(
  queryVec: ArrayLike<number>,
  cosine: (a: ArrayLike<number>, b: ArrayLike<number>) => number,
  allScored: readonly ScoredChunk[],
  seeds: readonly ScoredChunk[],
  present: readonly ScoredChunk[],
  cap = 2
): ScoredChunk[] {
  if (cap <= 0 || seeds.length === 0 || allScored.length === 0) {
    return [];
  }
  const keyOf = (s: ScoredChunk): string => `${s.file}|${s.chunk.chunkIndex}|${s.chunk.text}`;
  const presentKeys = new Set(present.map(keyOf));
  // Reciprocal-rank fuse the per-seed hop rankings so a chunk surfaced by
  // multiple seeds (the shared bridge target) ranks first.
  const lists: Array<readonly string[]> = [];
  const byKey = new Map<string, ScoredChunk>();
  for (const seed of seeds.slice(0, 2)) {
    const ranked = allScored
      .map((c) => ({ c, hop: cosine(seed.chunk.embedding, c.chunk.embedding) }))
      .filter((x) => x.hop > 0)
      .sort((a, b) => b.hop - a.hop)
      .map((x) => {
        const key = keyOf(x.c);
        if (!byKey.has(key)) byKey.set(key, x.c);
        return key;
      });
    lists.push(ranked);
  }
  if (lists.length === 0) return [];
  const fused = fuseByReciprocalRank(lists);
  const additionKeys = [...byKey.keys()]
    .filter((key) => !presentKeys.has(key))
    .sort((a, b) => (fused.get(b) ?? 0) - (fused.get(a) ?? 0))
    .slice(0, cap);
  // Recompute each addition's score against the ORIGINAL query (query-relative),
  // never the seed-relative hop cosine that surfaced it.
  return additionKeys.map((key) => {
    const c = byKey.get(key)!;
    return { chunk: c.chunk, file: c.file, score: cosine(queryVec, c.chunk.embedding) };
  });
}

/**
 * Drop near-duplicate chunks from a ranked grounding window. The initial
 * top-K is MMR-diversified, but graph-link + second-hop AUGMENT chunks are
 * APPENDED afterwards and bypass MMR — so a chunk near-identical to one
 * already kept (the same fact phrased almost the same across two notes, or a
 * bridge chunk near a seed) can pad the small model's context with redundancy.
 * Greedy first-wins in INPUT ORDER (the caller hands them score/MMR-ordered),
 * so the highest-ranked of a near-dup pair survives. A chunk is kept unless
 * its cosine to an ALREADY-KEPT chunk is >= `threshold`.
 *
 * Fail-open by construction: a missing / empty / zero-norm embedding (e.g. an
 * `--file` ad-hoc chunk carries `embedding: []`) is NEVER treated as a
 * near-dup — it is always kept, so the filter can only remove provable
 * redundancy and never silently drops a chunk it cannot compare. Pure +
 * exported for direct unit coverage.
 */
export function dedupNearDuplicateChunks(
  chunks: readonly ScoredChunk[],
  cosine: (a: ArrayLike<number>, b: ArrayLike<number>) => number,
  threshold = 0.985
): ScoredChunk[] {
  if (chunks.length <= 1) return [...chunks];
  const isZeroOrEmpty = (v: number[] | Float32Array): boolean =>
    v.length === 0 || v.every((x: number) => x === 0);
  const comparable = (a: number[] | Float32Array, b: number[] | Float32Array): boolean =>
    a.length > 0 && a.length === b.length && !isZeroOrEmpty(a) && !isZeroOrEmpty(b);
  const kept: ScoredChunk[] = [];
  for (const candidate of chunks) {
    const emb = candidate.chunk.embedding;
    const isNearDup = kept.some((k) => {
      const ke = k.chunk.embedding;
      return comparable(emb, ke) && cosine(emb, ke) >= threshold;
    });
    if (!isNearDup) kept.push(candidate);
  }
  return kept;
}

/**
 * Promotion gate for the second-hop AUGMENT (slice-1c). Live measurement
 * (`scripts/measure-second-hop-cost.mjs`) showed the hop's wall-clock cost is
 * ~0 (in-memory cosine, zero re-embed) but UNGATED it fires on every single-hop
 * query and appends only-irrelevant chunks — the wedge risk. The honest finding
 * is that on a personal-scale corpus no in-memory score signal cleanly
 * separates "single-hop answer already present" from "two-hop bridge needed"
 * (verdicts are mostly ambiguous for both; append-score ranges overlap). So the
 * implementable protection is the CRAG verdict: a CONFIDENT single-hop match is
 * settled — appending bridges only muddies a context that already answers the
 * question — so the hop is SKIPPED. When the verdict is NOT confident the
 * answer is uncertain anyway, AUGMENT-never-displace keeps the single-hop order
 * byte-identical, and the citation gate is the hard backstop, so the hop may
 * fire to surface a possible bridge. Pure + exported for direct unit coverage.
 */
export function shouldSecondHop(verdict: RetrievalConfidence): boolean {
  return verdict !== "confident";
}

/**
 * The chunk backing a cited note reference, matched by exact file path OR by
 * basename — a citation may name a relative path while the chunk stores an
 * absolute one (or vice versa). Shared by every source-receipt / disk-verify
 * path that resolves a citation back to its indexed chunk.
 */
/** Last path segment, separator-agnostic (chunk files are native paths, note ids are "/"). */
function lastPathSegment(p: string): string | undefined {
  return p.split(/[\\/]/u).pop();
}

export function findChunkByNote<T extends { readonly file: string }>(
  note: string,
  chunks: ReadonlyArray<T>
): T | undefined {
  const base = lastPathSegment(note);
  return chunks.find((c) => c.file === note || lastPathSegment(c.file) === base);
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
export function notesGroundingFraming(
  scored: readonly ScoredChunk[],
  query?: string,
  // Verdict is derived from this when supplied — the pre-gap-cut top-K so a
  // gap-cut that trims the prompt window to k=1 doesn't make runnerUp=0 and
  // flip "ambiguous"→"confident" (floor violation). Prompt window stays trimmed.
  verdictInput?: readonly ScoredChunk[],
  // The index's embed model, so the confidence bar matches the embedder's cosine
  // scale (v2-moe sits lower than nomic; a nomic-tuned bar over-abstains on it).
  // Omitted ⇒ the conservative default bar (unchanged behavior).
  embedModel?: string
): { readonly verdict: RetrievalConfidence; readonly header: string; readonly guidance?: string } {
  const verdictSet = verdictInput ?? scored;
  const cosineVerdict = verdictSet.length === 0
    ? "none"
    : classifyRetrievalConfidence(verdictSet.map((s) => ({ cosine: s.score, source: s.file, score: s.score, text: s.chunk.text })), { confidentAt: resolveRecallConfidentAt(process.env, embedModel) });
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
    && verdictSet.some((s) => lexicalOverlap(queryTokens, s.chunk.text) >= 2);
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
