/**
 * `muse.history` loopback MCP server — agent-facing unified
 * activity feed mirroring the `muse history` CLI. Reads the five
 * personal-JARVIS audit stores (reminder firings, proactive
 * notices, fired followups, fired patterns, episodes) and returns
 * them merged + sorted newest-first.
 *
 * Pure wrapper around `readActivityFeed` — see that helper for
 * the merge rules + which followup/pattern/episode rows count.
 *
 * Letting the agent call this itself closes the introspection gap
 * the CLI command also covers: a chat-REPL or Claude-
 * Desktop session can now ask "what did you do for me last night?"
 * without bouncing through a shell.
 */

import type { JsonObject } from "@muse/shared";

import type { LoopbackMcpServer, LoopbackMcpToolDefinition } from "@muse/mcp";
import {
  ACTIVITY_KINDS,
  readActivityFeed,
  type ActivityKind
} from "./personal-activity-feed.js";

export interface HistoryMcpServerOptions {
  readonly reminderHistoryFile?: string;
  readonly proactiveHistoryFile?: string;
  readonly followupsFile?: string;
  readonly patternsFiredFile?: string;
  readonly episodesFile?: string;
}

export function clampLimit(raw: unknown, fallback: number, cap: number): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return fallback;
  }
  // Truncate BEFORE the positivity check: a sub-1 fractional limit
  // (Math.trunc(0.5) === 0) means "no meaningful count" exactly like 0 or a
  // negative, so it must take the fallback — not slice the feed to empty.
  const truncated = Math.trunc(raw);
  if (truncated <= 0) {
    return fallback;
  }
  return Math.min(cap, truncated);
}

export function createHistoryMcpServer(options: HistoryMcpServerOptions): LoopbackMcpServer {
  const recentTool: LoopbackMcpToolDefinition = {
    description:
      "Unified activity feed across the five personal-JARVIS audit stores " +
      "(reminder firings, proactive notices, fired followups, fired pattern detections, " +
      "and prior conversation episodes). Returns entries newest-first as " +
      "{kind, whenIso, summary, status?, providerId?, destination?, id?}. " +
      "Optional filters: `kind` restricts to one of " +
      "'reminder' | 'proactive' | 'followup' | 'pattern' | 'episode'; " +
      "`sinceIso` drops anything older than the given ISO timestamp; " +
      "`limit` caps the response (default 20, cap 200). " +
      "Use this to answer 'what did you do for me last night?' / " +
      "'has the 9am reminder fired yet?' without the user opening a shell.",
    execute: async (args: Record<string, unknown>): Promise<JsonObject> => {
      const kindRaw = args["kind"];
      let kind: ActivityKind | undefined;
      if (typeof kindRaw === "string" && kindRaw.length > 0) {
        const normalized = kindRaw.trim().toLowerCase();
        if (!ACTIVITY_KINDS.has(normalized as ActivityKind)) {
          return {
            error: `kind must be one of: ${[...ACTIVITY_KINDS].join(", ")} (got '${normalized}')`
          };
        }
        kind = normalized as ActivityKind;
      }

      let sinceMs: number | undefined;
      const sinceRaw = args["sinceIso"];
      if (typeof sinceRaw === "string" && sinceRaw.length > 0) {
        const parsed = Date.parse(sinceRaw);
        if (!Number.isFinite(parsed)) {
          return { error: `sinceIso must be a parseable ISO timestamp (got '${sinceRaw}')` };
        }
        sinceMs = parsed;
      }

      const limit = clampLimit(args["limit"], 20, 200);

      try {
        const entries = await readActivityFeed({
          episodesFile: options.episodesFile,
          followupsFile: options.followupsFile,
          ...(kind ? { kind } : {}),
          limit,
          patternsFiredFile: options.patternsFiredFile,
          proactiveHistoryFile: options.proactiveHistoryFile,
          reminderHistoryFile: options.reminderHistoryFile,
          ...(sinceMs !== undefined ? { sinceMs } : {})
        });
        return {
          entries: [...entries],
          total: entries.length
        };
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
      }
    },
    inputSchema: {
      additionalProperties: false,
      properties: {
        kind: {
          description: "Optional filter: 'reminder' | 'proactive' | 'followup' | 'pattern' | 'episode'.",
          enum: [...ACTIVITY_KINDS],
          type: "string"
        },
        limit: {
          description: "Max entries returned (newest first). Default 20, cap 200.",
          type: "number"
        },
        sinceIso: {
          description: "Drop entries older than this ISO-8601 timestamp.",
          type: "string"
        }
      },
      type: "object"
    },
    domain: "tasks",
    name: "recent",
    risk: "read"
  };

  return {
    description:
      "Unified personal-JARVIS activity feed (reminder + proactive + followup + pattern + episode). " +
      "Loopback MCP — readonly merge over the five audit stores.",
    name: "muse.history",
    tools: [recentTool]
  };
}
