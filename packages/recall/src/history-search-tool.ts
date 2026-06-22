import type { MuseTool } from "@muse/tools";

import { searchHistory, type HistoryRecord, type HistorySearchHit } from "./history-search.js";

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
}

const NO_MATCH = "No earlier conversation, note, or remembered fact matched that. Nothing was found — do not invent a past discussion.";
const MAX_TOP_K = 20;

/**
 * A read-only `history_search` tool: the agent-callable "find where we talked
 * about X" over the user's OWN past — chat episodes, notes, and remembered
 * facts — ranked deterministically by CJK-aware lexical relevance (no model,
 * no embeddings). Each hit is labelled `[source:ref]` so an answer built on it
 * can cite the real item; a no-overlap query returns an explicit no-match
 * notice rather than a fabricated memory.
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
      const raw = args as { query?: unknown; topK?: unknown };
      const query = typeof raw.query === "string" ? raw.query : "";
      const topK = typeof raw.topK === "number" && Number.isFinite(raw.topK) ? clampTopK(raw.topK) : defaultTopK;
      let records: readonly HistoryRecord[];
      try {
        records = await options.records();
      } catch {
        return NO_MATCH;
      }
      const hits = searchHistory(query, records, { topK });
      if (hits.length === 0) {
        return NO_MATCH;
      }
      return hits.map(renderHit).join("\n\n");
    }
  };
}

function renderHit(hit: HistorySearchHit): string {
  return `[${hit.source}:${hit.ref}] ${hit.snippet}`;
}

function clampTopK(value: number): number {
  return Math.min(MAX_TOP_K, Math.max(1, Math.trunc(value)));
}
