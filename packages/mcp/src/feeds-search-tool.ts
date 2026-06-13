/**
 * `feeds_search` agent tool — search the user's watched RSS/Atom feed archive
 * by keyword so a conversation can answer "any news about X in the feeds I
 * follow?". Feeds otherwise reach the model ONLY passively (a bounded slice of
 * recent entries injected as knowledge); without this tool the only on-demand
 * feed search is the opt-in `knowledge_search` (off by default), so in the
 * default posture the model has no way to query the feed archive. Read-only,
 * deterministic substring match — no model call, no egress.
 */

import type { JsonObject } from "@muse/shared";
import type { MuseTool } from "@muse/tools";

/**
 * The shape the tool reads. Structurally compatible with autoconfigure's
 * `FeedEntryLike` (the runtime wires `readFeedKnowledgeEntries`), declared here
 * so @muse/mcp owns the tool without depending on @muse/autoconfigure.
 */
export interface FeedEntryLike {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly publishedAt?: string;
  readonly feedName?: string;
}

export interface FeedsSearchToolDeps {
  /** Recent watched feed entries, newest first (the runtime caps how many are read). */
  readonly feedEntries: () => Promise<readonly FeedEntryLike[]> | readonly FeedEntryLike[];
}

export function createFeedsSearchTool(deps: FeedsSearchToolDeps): MuseTool {
  return {
    definition: {
      description:
        "Search the user's watched RSS/Atom feed archive (the blogs/news sources they subscribe to) by keyword and return matching entries, newest first. Use when the user asks about news / updates / posts FROM THEIR FEEDS or subscriptions ('any news about X in the feeds I follow?' / '내가 구독한 피드에 X 소식 있어?'). Do NOT use for a fresh public web search (use the web search tool) or for their email inbox (use the email search tool). Read-only.",
      domain: "knowledge",
      inputSchema: {
        additionalProperties: false,
        properties: {
          limit: { description: "Max entries to return, e.g. 5. Defaults to 10.", maximum: 50, minimum: 1, type: "integer" },
          query: { description: "Keyword(s) to match against feed entry titles and summaries, e.g. 'Mars mission'.", type: "string" }
        },
        required: ["query"],
        type: "object"
      },
      keywords: ["feed", "feeds", "rss", "subscription", "news", "구독", "피드", "소식"],
      name: "feeds_search",
      risk: "read"
    },
    execute: async (args): Promise<JsonObject> => {
      const query = typeof args["query"] === "string" ? args["query"].trim() : "";
      const rawLimit = args["limit"];
      const limit = typeof rawLimit === "number" && Number.isFinite(rawLimit) && rawLimit >= 1 ? Math.min(50, Math.trunc(rawLimit)) : 10;
      if (query.length === 0) {
        return { count: 0, found: false, hits: [], reason: "query is required (e.g. 'Mars mission')" };
      }
      const needle = query.toLowerCase();
      const entries = await Promise.resolve(deps.feedEntries());
      const hits = entries
        .filter((e) => `${e.title} ${e.summary}`.toLowerCase().includes(needle))
        .slice(0, limit)
        .map((e) => ({
          id: e.id,
          summary: e.summary,
          title: e.title,
          ...(e.feedName ? { feedName: e.feedName } : {}),
          ...(e.publishedAt ? { publishedAt: e.publishedAt } : {})
        }));
      return { count: hits.length, hits, limit, query };
    }
  };
}
