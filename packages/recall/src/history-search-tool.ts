import type { MuseTool } from "@muse/tools";
import { isRecord } from "@muse/shared";

import { searchHistoryHybrid, type HistoryRecord, type HistorySearchHit } from "./history-search.js";

export interface HistorySearchToolOptions {
  /**
   * The user's own searchable past — chat episodes, notes, remembered facts —
   * as flat {@link HistoryRecord}s. Resolved per call so newly written history
   * is searchable without a restart. May be sync or async; a thrown provider
   * degrades to the no-match message (fail-soft, never breaks the agent loop).
   */
  readonly records: () => Promise<readonly HistoryRecord[]> | readonly HistoryRecord[];
  /** Default cap on returned hits when the model omits `topK`. Default 5. */
  readonly defaultTopK?: number;
  /**
   * OPT-IN query embedder (same model/space as the records' `embedding`). When
   * present, the query is embedded and the search fuses lexical BM25 with cosine
   * similarity (RRF) so a PARAPHRASE sharing no term with the matching record is
   * still found. Absent — or a thrown embed, or records carrying no embedding —
   * degrades to the deterministic CJK-aware lexical search, byte-identical to the
   * default. Embeddings cost a local Ollama call, so the runtime injects this
   * only when hybrid history search is opted in.
   */
  readonly embed?: (text: string) => Promise<readonly number[]>;
}

const NO_MATCH = "No earlier conversation, note, or remembered fact matched that. Nothing was found — do not invent a past discussion.";
const MAX_TOP_K = 20;

/**
 * A read-only `history_search` tool: the agent-callable "find where we talked
 * about X" over the user's OWN past — chat episodes, notes, and remembered
 * facts — ranked by CJK-aware lexical relevance, OR (when an `embed` is injected
 * and the records carry embeddings) by lexical BM25 fused with embedding-cosine
 * so a paraphrase is found too. Each hit is labelled `[source:ref]` so an answer
 * built on it can cite the real item; a no-overlap, far-in-embedding-space query
 * returns an explicit no-match notice rather than a fabricated memory.
 *
 * Distinct from `knowledge_search` (the user's NOTES + ingested DOCUMENTS) and
 * from the chronological recent-activity feed: this one searches PAST
 * CONVERSATIONS / discussions by topic.
 */
export function createHistorySearchTool(options: HistorySearchToolOptions): MuseTool {
  const defaultTopK = clampTopK(options.defaultTopK ?? 5);
  return {
    definition: {
      description:
        "Search the user's OWN past — earlier chat conversations/episodes, notes, and remembered facts — to find where a topic was discussed before. Returns matching excerpts, each labelled with its [source:ref]; cite the source you use. Use when the user refers to a PRIOR discussion ('what did we decide about X', 'when did I mention Y', 'find that conversation about Z'). Do NOT use for general knowledge, live web data, or the current conversation.",
      domain: "core",
      inputSchema: {
        additionalProperties: false,
        properties: {
          query: {
            description:
              "The topic to find in the user's history, in their own words — e.g. 'the VPN MTU fix we discussed' or '분기 보고서 마감 얘기'.",
            type: "string"
          },
          topK: {
            description: "Max number of past items to return (1-20). Defaults to 5.",
            maximum: MAX_TOP_K,
            minimum: 1,
            type: "integer"
          }
        },
        required: ["query"],
        type: "object"
      },
      name: "history_search",
      risk: "read"
    },
    execute: async (args) => {
      const raw = isRecord(args) ? args : {};
      const query = typeof raw.query === "string" ? raw.query : "";
      const topK = typeof raw.topK === "number" && Number.isFinite(raw.topK) ? clampTopK(raw.topK) : defaultTopK;
      let records: readonly HistoryRecord[];
      try {
        records = await options.records();
      } catch {
        return NO_MATCH;
      }
      // Embed the query for hybrid fusion only when an embedder is injected; a
      // thrown embed leaves queryVector undefined so searchHistoryHybrid degrades
      // to pure lexical (never fails the search over an Ollama hiccup).
      let queryVector: readonly number[] | undefined;
      if (options.embed && query.trim().length > 0) {
        try {
          queryVector = await options.embed(query);
        } catch {
          queryVector = undefined;
        }
      }
      const hits = searchHistoryHybrid(query, records, { topK, ...(queryVector ? { queryVector } : {}) });
      if (hits.length === 0) {
        return NO_MATCH;
      }
      return hits.map(renderHit).join("\n\n");
    }
  };
}

function renderHit(hit: HistorySearchHit): string {
  // A conversation hit's ref is a real `muse chats resume` id — point that out so
  // the citation is actionable, not just a label (unlike the other three sources,
  // which have no equivalent "reopen this" command).
  if (hit.source === "conversations") {
    return `[conversations:${hit.ref}] (resume with \`muse chats resume ${hit.ref}\`) ${hit.snippet}`;
  }
  return `[${hit.source}:${hit.ref}] ${hit.snippet}`;
}

function clampTopK(value: number): number {
  return Math.min(MAX_TOP_K, Math.max(1, Math.trunc(value)));
}
