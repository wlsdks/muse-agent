/**
 * The `knowledge_search` tool the agent calls to ground an answer in the user's
 * multi-document personal corpus, plus the two supports it leans on: a
 * text-keyed caching embedder (embed each stable chunk ONCE per session, not per
 * query) and pairwise REDUNDANCY detection (the complement of the pairwise
 * contradiction screen — same-topic, near-identical restatements).
 */

import type { MuseTool } from "@muse/tools";
import { isRecord, withBestEffort } from "@muse/shared";

import { cosineSimilarity } from "./episodic-recall.js";
import { type KnowledgeChunk, rankKnowledgeChunks } from "./knowledge-ranking.js";
import { finiteOr, lexicalTokens } from "./recall-lexical.js";
import { edgeLoadByRelevance, renderKnowledgeMatches } from "./recall-scoring.js";
import { comparableScript } from "./script-family.js";

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
    const pending = (async () => embed(text))();
    pending.catch((error: unknown) => {
      cache.delete(text);
      throw error;
    });
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
      const querySource = isRecord(args) ? args : {};
      const query = typeof querySource.query === "string" ? querySource.query : "";
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

const REDUNDANCY_TOPIC_SIM_MIN = 0.86;
// Near-IDENTICAL token sets: union ≈ intersection. The INVERSE of the contradiction
// detector's neither-subset gate (which excludes identical sets). "Q1 sales 5억" vs
// "Q2 sales 7억" have Jaccard ≈ 0.2 (distinct value tokens) → not redundant; a verbatim
// / stopword-only-differing echo has Jaccard ≈ 1.0 → redundant. The high floor keeps an
// elaboration (one side adds real content, lowering Jaccard) from firing.
const REDUNDANCY_OVERLAP_MIN = 0.9;

export interface RedundantPair {
  readonly aIndex: number;
  readonly bIndex: number;
  readonly overlap: number;
}

/**
 * Pairwise REDUNDANCY (step-repetition) detection — the complement of
 * {@link detectPairwiseContradictions}. Returns index pairs that are SAME-TOPIC
 * (cosine ≥ topicSimMin) AND near-identical in content (lexical Jaccard ≥ overlapMin),
 * i.e. one text restates the other adding nothing new. Same-script guard + fail-open on
 * embed error. Catches MAST FM-1.3 Step Repetition (arXiv:2503.13657) at the OUTPUT
 * level — distinct sub-tasks whose workers converged to the same answer, or a sequenced
 * step that just echoes its upstream. Pure over the injected embed; never throws.
 */
export async function detectRedundantPairs(
  texts: readonly string[],
  embed: (text: string) => Promise<readonly number[]>,
  opts?: { readonly topicSimMin?: number; readonly overlapMin?: number }
): Promise<readonly RedundantPair[]> {
  const topicSimMin = opts?.topicSimMin ?? REDUNDANCY_TOPIC_SIM_MIN;
  const overlapMin = opts?.overlapMin ?? REDUNDANCY_OVERLAP_MIN;

  if (texts.length < 2) return [];

  let embeddings: Array<readonly number[] | null>;
  try {
    embeddings = await Promise.all(texts.map((t) => withBestEffort(embed(t), null)));
  } catch {
    return [];
  }

  const pairs: RedundantPair[] = [];

  for (let i = 0; i < texts.length; i++) {
    for (let j = i + 1; j < texts.length; j++) {
      const a = texts[i]!;
      const b = texts[j]!;

      if (!comparableScript(a, b)) continue;

      const embA = embeddings[i];
      const embB = embeddings[j];
      if (!embA || !embB) continue;

      if (cosineSimilarity(embA, embB) < topicSimMin) continue;

      const tokA = lexicalTokens(a);
      const tokB = lexicalTokens(b);
      const unionSize = new Set([...tokA, ...tokB]).size;
      if (unionSize === 0) continue;
      let intersect = 0;
      for (const t of tokA) {
        if (tokB.has(t)) intersect++;
      }
      const overlap = intersect / unionSize;
      if (overlap < overlapMin) continue;

      pairs.push({ aIndex: i, bIndex: j, overlap });
    }
  }

  return pairs;
}
