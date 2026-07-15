import { bm25Scores, cosineSimilarity, fuseByReciprocalRank, lexicalTokens } from "@muse/agent-core";
import { sliceUtf16Safe, truncateUtf16Safe } from "@muse/shared";

/**
 * One searchable item from the user's own past — a chat session/episode, a note,
 * or a remembered fact. `text` is the full searchable body; `timestampMs` (when
 * known) breaks score ties toward the more recent item. `embedding` (when known)
 * lets the hybrid layer add a semantic-similarity rank. Source-agnostic so the
 * same deterministic search serves every history surface.
 */
export interface HistoryRecord {
  readonly ref: string;
  readonly source: "notes" | "episodes" | "memory" | "conversations";
  readonly text: string;
  readonly timestampMs?: number;
  /** Optional precomputed embedding for the record's text — enables hybrid fusion. */
  readonly embedding?: readonly number[];
}

export interface HistorySearchHit {
  readonly ref: string;
  readonly source: HistoryRecord["source"];
  readonly score: number;
  /** A short excerpt centered on the matched terms (not the record start). */
  readonly snippet: string;
}

export interface HistorySearchOptions {
  readonly topK?: number;
  /** Target snippet length in characters (the window is centered on the first match). */
  readonly snippetChars?: number;
}

const DEFAULT_TOP_K = 5;
const DEFAULT_SNIPPET_CHARS = 240;

/**
 * Deterministic lexical search over the user's own history — the agent-callable
 * "find where we talked about X" core. Ranks records by BM25 over CJK-aware
 * content tokens (so a Korean query matches Korean history and a rare term
 * outranks a corpus-common one), returns only records that share ≥1 query term
 * (precision: a no-overlap query yields nothing), and centers each snippet on the
 * match. Pure — no Ollama, no embeddings; the hybrid (cosine fusion) layer is a
 * later slice. Ties break toward the more recent record.
 */
export function searchHistory(
  query: string,
  records: readonly HistoryRecord[],
  options: HistorySearchOptions = {}
): HistorySearchHit[] {
  const topK = Math.max(1, options.topK ?? DEFAULT_TOP_K);
  const snippetChars = Math.max(20, options.snippetChars ?? DEFAULT_SNIPPET_CHARS);
  const queryTokens = lexicalTokens(query);
  if (queryTokens.size === 0 || records.length === 0) {
    return [];
  }

  const scores = bm25Scores(queryTokens, records, (r) => r.ref);
  const tsByRef = new Map<string, number>();
  for (const r of records) {
    if (r.timestampMs !== undefined && !tsByRef.has(r.ref)) {
      tsByRef.set(r.ref, r.timestampMs);
    }
  }

  const seen = new Set<string>();
  const hits: HistorySearchHit[] = [];
  for (const record of records) {
    if (seen.has(record.ref)) {
      continue;
    }
    seen.add(record.ref);
    const score = scores.get(record.ref) ?? 0;
    if (score <= 0) {
      continue;
    }
    hits.push({
      ref: record.ref,
      source: record.source,
      score,
      snippet: buildSnippet(record.text, queryTokens, snippetChars)
    });
  }

  hits.sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    return (tsByRef.get(b.ref) ?? 0) - (tsByRef.get(a.ref) ?? 0);
  });
  return hits.slice(0, topK);
}

export interface HybridHistorySearchOptions extends HistorySearchOptions {
  /**
   * Query embedding (same model/space as the records' `embedding`). When present
   * AND ≥1 record carries an embedding, the lexical BM25 rank is fused with a
   * cosine-similarity rank via Reciprocal Rank Fusion. Absent ⇒ pure lexical
   * (byte-identical to `searchHistory`).
   */
  readonly queryVector?: readonly number[];
  /**
   * Minimum cosine a record must reach to enter the semantic rank list — a floor
   * that keeps a far-off record from being promoted on weak similarity (grounding
   * precision). Default 0.2.
   */
  readonly minCosine?: number;
  /** RRF constant (Cormack et al.) — higher flattens the rank weighting. Default 60. */
  readonly rrfK?: number;
}

const DEFAULT_MIN_COSINE = 0.2;

/**
 * Hybrid history search: fuse the deterministic lexical (BM25) ranking with a
 * semantic (embedding-cosine) ranking via Reciprocal Rank Fusion (Cormack,
 * Clarke & Büttcher, SIGIR 2009), so a record the user phrased differently than
 * their query — a paraphrase the lexical pass misses or under-ranks — still
 * surfaces. Mirrors openclaw's hybrid BM25+vector recall as a deterministic
 * Muse reimplementation (no code copied; RRF is the published primitive).
 *
 * FALLBACK is the floor, not an afterthought: with no `queryVector`, or when no
 * record carries an `embedding`, this is byte-for-byte `searchHistory` (pure
 * lexical) — so the hybrid layer can never REGRESS the lexical path. The lexical
 * precision invariant is preserved: a record enters the fused result only if it
 * has a positive BM25 score OR a cosine ≥ `minCosine`; a record sharing no query
 * term and far in embedding space is never surfaced (no fabricated recall).
 */
export function searchHistoryHybrid(
  query: string,
  records: readonly HistoryRecord[],
  options: HybridHistorySearchOptions = {}
): HistorySearchHit[] {
  const topK = Math.max(1, options.topK ?? DEFAULT_TOP_K);
  const snippetChars = Math.max(20, options.snippetChars ?? DEFAULT_SNIPPET_CHARS);
  const queryVector = options.queryVector;
  const hasSemantic = queryVector !== undefined && queryVector.length > 0 && records.some((r) => r.embedding && r.embedding.length > 0);
  if (!hasSemantic) {
    return searchHistory(query, records, options);
  }

  const queryTokens = lexicalTokens(query);
  const minCosine = options.minCosine ?? DEFAULT_MIN_COSINE;
  const rrfK = options.rrfK ?? 60;

  // De-duplicate records by ref (first wins), then compute the two ranked lists.
  const byRef = new Map<string, HistoryRecord>();
  for (const r of records) {
    if (!byRef.has(r.ref)) byRef.set(r.ref, r);
  }
  const unique = [...byRef.values()];

  const lexScores = queryTokens.size > 0 ? bm25Scores(queryTokens, unique, (r) => r.ref) : new Map<string, number>();
  const cosByRef = new Map<string, number>();
  for (const r of unique) {
    if (r.embedding && r.embedding.length > 0) {
      const c = cosineSimilarity(queryVector!, r.embedding);
      if (c >= minCosine) cosByRef.set(r.ref, c);
    }
  }

  const lexRanking = [...unique]
    .filter((r) => (lexScores.get(r.ref) ?? 0) > 0)
    .sort((a, b) => (lexScores.get(b.ref) ?? 0) - (lexScores.get(a.ref) ?? 0))
    .map((r) => r.ref);
  const cosRanking = [...cosByRef.keys()].sort((a, b) => (cosByRef.get(b) ?? 0) - (cosByRef.get(a) ?? 0));

  if (lexRanking.length === 0 && cosRanking.length === 0) {
    return [];
  }

  const fused = fuseByReciprocalRank([lexRanking, cosRanking], rrfK);

  const tsByRef = new Map<string, number>();
  for (const r of unique) {
    if (r.timestampMs !== undefined) tsByRef.set(r.ref, r.timestampMs);
  }

  const hits: HistorySearchHit[] = [];
  for (const [ref, score] of fused) {
    const record = byRef.get(ref);
    if (!record || score <= 0) continue;
    hits.push({
      ref,
      source: record.source,
      score,
      snippet: buildSnippet(record.text, queryTokens.size > 0 ? queryTokens : lexicalTokens(record.text), snippetChars)
    });
  }

  hits.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return (tsByRef.get(b.ref) ?? 0) - (tsByRef.get(a.ref) ?? 0);
  });
  return hits.slice(0, topK);
}

/**
 * A snippet centered on the FIRST occurrence of any query content token, so the
 * user sees the matched context, not the record's opening filler. Falls back to
 * the head of the text when no token offset is found (defensive — BM25 already
 * guaranteed an overlap).
 */
function buildSnippet(text: string, queryTokens: ReadonlySet<string>, snippetChars: number): string {
  const matchIndex = firstMatchIndex(text, queryTokens);
  if (matchIndex < 0 || text.length <= snippetChars) {
    return truncateUtf16Safe(text, snippetChars).trim();
  }
  const half = Math.floor(snippetChars / 2);
  const start = Math.max(0, matchIndex - half);
  const end = Math.min(text.length, start + snippetChars);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  return `${prefix}${sliceUtf16Safe(text, start, end).trim()}${suffix}`;
}

function firstMatchIndex(text: string, queryTokens: ReadonlySet<string>): number {
  const lower = text.toLowerCase();
  let best = -1;
  for (const token of queryTokens) {
    const idx = lower.indexOf(token);
    if (idx >= 0 && (best < 0 || idx < best)) {
      best = idx;
    }
  }
  return best;
}
