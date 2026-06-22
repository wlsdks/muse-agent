import { bm25Scores, lexicalTokens } from "@muse/agent-core";

/**
 * One searchable item from the user's own past — a chat session/episode, a note,
 * or a remembered fact. `text` is the full searchable body; `timestampMs` (when
 * known) breaks score ties toward the more recent item. Source-agnostic so the
 * same deterministic search serves every history surface.
 */
export interface HistoryRecord {
  readonly ref: string;
  readonly source: "notes" | "episodes" | "memory";
  readonly text: string;
  readonly timestampMs?: number;
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

/**
 * A snippet centered on the FIRST occurrence of any query content token, so the
 * user sees the matched context, not the record's opening filler. Falls back to
 * the head of the text when no token offset is found (defensive — BM25 already
 * guaranteed an overlap).
 */
function buildSnippet(text: string, queryTokens: ReadonlySet<string>, snippetChars: number): string {
  const matchIndex = firstMatchIndex(text, queryTokens);
  if (matchIndex < 0 || text.length <= snippetChars) {
    return text.slice(0, snippetChars).trim();
  }
  const half = Math.floor(snippetChars / 2);
  const start = Math.max(0, matchIndex - half);
  const end = Math.min(text.length, start + snippetChars);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  return `${prefix}${text.slice(start, end).trim()}${suffix}`;
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
