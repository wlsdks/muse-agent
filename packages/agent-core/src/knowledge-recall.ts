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

export interface KnowledgeChunk {
  readonly source: string;
  readonly text: string;
}

export interface KnowledgeMatch {
  readonly source: string;
  readonly text: string;
  readonly score: number;
}

export interface RankKnowledgeOptions {
  readonly embed: (text: string) => Promise<readonly number[]>;
  readonly topK?: number;
  readonly minScore?: number;
}

function finiteOr(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
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
  const scored: KnowledgeMatch[] = [];
  for (const chunk of chunks) {
    const score = cosineSimilarity(queryVec, await options.embed(chunk.text));
    if (score < minScore) {
      continue;
    }
    scored.push({ score, source: chunk.source, text: chunk.text });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}

/**
 * Render matches for the agent as a passage list, each labelled with
 * its `[source]` and instructed to cite it. The labelling is what
 * lets a grounded answer attribute its claim to the right document.
 */
export function renderKnowledgeMatches(matches: readonly KnowledgeMatch[]): string {
  if (matches.length === 0) {
    return "No matching passages found in the personal corpus.";
  }
  const lines = ["Relevant passages — cite the [source] you use:"];
  for (const match of matches) {
    lines.push(`— [${match.source}] ${match.text}`);
  }
  return lines.join("\n");
}

/**
 * Split `text` into passages of at most `maxChars`, preferring
 * paragraph boundaries (blank lines) so a chunk stays coherent. A
 * single paragraph longer than `maxChars` is hard-split. Returns []
 * for empty input; a short text returns one chunk. This is what lets
 * a long note / ingested document be retrieved + cited PASSAGE-by-
 * passage instead of truncated to its first `maxChars`.
 */
export function chunkText(text: string, maxChars: number): string[] {
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
  return chunks;
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
      description: "Search the user's personal knowledge corpus (notes + ingested documents). Returns matching passages, each labelled with its [source] — cite the source you use.",
      inputSchema: {
        properties: { query: { type: "string" } },
        required: ["query"],
        type: "object"
      },
      name: "knowledge_search",
      risk: "read"
    },
    execute: async (args) => {
      const query = typeof (args as { query?: unknown }).query === "string" ? (args as { query: string }).query : "";
      const matches = await rankKnowledgeChunks(query, options.corpus, {
        embed: options.embed,
        ...(options.topK !== undefined ? { topK: options.topK } : {})
      });
      return renderKnowledgeMatches(matches);
    }
  };
}
