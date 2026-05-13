import type { JsonObject, JsonValue } from "@muse/shared";

import { errorMessage, readString } from "./loopback-helpers.js";
import type { LoopbackMcpServer } from "./loopback.js";
import {
  clearEpisodes,
  readEpisodes,
  removeEpisode,
  serializeEpisode,
  type PersistedEpisode
} from "./personal-episodes-store.js";

/**
 * `muse.episode` loopback MCP server — gives the agent
 * introspection over its own prior-session summaries
 * (`~/.muse/episodes.json`).
 *
 * Episodes are captured *automatically* by the REPL exit hook
 * (`apps/cli/src/chat-end-session.ts`); there is intentionally
 * NO `add` tool here. Letting the LLM manually create episodes
 * would let it lie about prior sessions or echo a fabricated
 * narrative into its own persona block. Read-shaped tools
 * (`list`, `search`, `show`) plus user-revocable write tools
 * (`remove`, `clear`) are the whole surface.
 *
 * Typical use cases:
 *   - "What were we working on yesterday?" → `list` newest-first.
 *   - "When did we last discuss the Q3 memo?" → `search` with
 *     query="Q3 memo".
 *   - "Forget that yesterday session, I don't want it in your
 *     memory anymore." → `remove` by id (after `show`-ing it).
 */
export interface EpisodesMcpServerOptions {
  readonly file: string;
  readonly maxListEntries?: number;
}

export function createEpisodesMcpServer(options: EpisodesMcpServerOptions): LoopbackMcpServer {
  const file = options.file;
  const maxListEntries = Math.max(1, Math.trunc(options.maxListEntries ?? 50));

  return {
    description:
      "Prior-session summaries (auto-captured at REPL exit). Read + remove + clear; the agent never creates episodes directly.",
    name: "muse.episode",
    tools: [
      {
        description:
          "List episodes (newest first by endedAt). `limit` defaults to 10, caps at `" + maxListEntries.toString() + "`. " +
          "`userId` (optional) scopes the list to a single user — leave it blank on single-user installs. " +
          "Use this to answer 'what were we working on yesterday?' / 'remind me what we decided last session'.",
        execute: async (args): Promise<JsonObject> => {
          const userId = readString(args, "userId")?.trim();
          const limitRaw = args["limit"];
          const limit = typeof limitRaw === "number" && Number.isFinite(limitRaw)
            ? Math.max(1, Math.min(maxListEntries, Math.trunc(limitRaw)))
            : Math.min(maxListEntries, 10);
          const all = await readEpisodes(file);
          const scoped = userId ? all.filter((e) => e.userId === userId) : all;
          const sorted = [...scoped]
            .sort((left, right) => right.endedAt.localeCompare(left.endedAt))
            .slice(0, limit);
          return {
            episodes: sorted.map(serializeEpisode) as JsonValue,
            total: sorted.length,
            ...(userId ? { userId } : {})
          };
        },
        inputSchema: {
          additionalProperties: false,
          properties: {
            limit: { description: "Max entries to return (newest first).", type: "number" },
            userId: { description: "Optional userId filter.", type: "string" }
          },
          type: "object"
        },
        domain: "memory",
        name: "list",
        risk: "read"
      },
      {
        description:
          "Substring search across episode summaries + topics (case-insensitive). `query` is required. " +
          "`limit` defaults to 10, caps at `" + maxListEntries.toString() + "`. Use this when the user says " +
          "'what did we say about X?' / 'find that session where we discussed Y'.",
        execute: async (args): Promise<JsonObject> => {
          const query = readString(args, "query")?.trim();
          if (!query) {
            return { error: "query is required" };
          }
          const userId = readString(args, "userId")?.trim();
          const limitRaw = args["limit"];
          const limit = typeof limitRaw === "number" && Number.isFinite(limitRaw)
            ? Math.max(1, Math.min(maxListEntries, Math.trunc(limitRaw)))
            : Math.min(maxListEntries, 10);
          const needle = query.toLowerCase();
          const all = await readEpisodes(file);
          const scoped = userId ? all.filter((e) => e.userId === userId) : all;
          const matches = scoped
            .filter((episode) => {
              if (episode.summary.toLowerCase().includes(needle)) return true;
              if (episode.topics) {
                for (const topic of episode.topics) {
                  if (topic.toLowerCase().includes(needle)) return true;
                }
              }
              return false;
            })
            .sort((left, right) => right.endedAt.localeCompare(left.endedAt))
            .slice(0, limit);
          return {
            episodes: matches.map(serializeEpisode) as JsonValue,
            query,
            total: matches.length,
            ...(userId ? { userId } : {})
          };
        },
        inputSchema: {
          additionalProperties: false,
          properties: {
            limit: { type: "number" },
            query: { description: "Substring to grep for (case-insensitive).", type: "string" },
            userId: { type: "string" }
          },
          required: ["query"],
          type: "object"
        },
        domain: "memory",
        name: "search",
        risk: "read"
      },
      {
        description:
          "Fetch a single episode by id. Use after `list` or `search` to read the full summary + topics + " +
          "originating timestamps. Returns `{ error }` when the id is unknown.",
        execute: async (args): Promise<JsonObject> => {
          const id = readString(args, "id");
          if (!id) {
            return { error: "id is required" };
          }
          const all = await readEpisodes(file);
          const found = all.find((entry) => entry.id === id);
          if (!found) {
            return { error: `episode not found: ${id}` };
          }
          return { episode: serializeEpisode(found) as JsonValue };
        },
        inputSchema: {
          additionalProperties: false,
          properties: {
            id: { type: "string" }
          },
          required: ["id"],
          type: "object"
        },
        domain: "memory",
        name: "show",
        risk: "read"
      },
      {
        description:
          "Drop a single episode by id. Use when the user says 'forget that session' / 'don't remember our " +
          "chat from yesterday'. Returns `{ removed: true, id }` on success, an error when the id is unknown.",
        execute: async (args): Promise<JsonObject> => {
          const id = readString(args, "id");
          if (!id) {
            return { error: "id is required" };
          }
          try {
            const ok = await removeEpisode(file, id);
            if (!ok) {
              return { error: `episode not found: ${id}` };
            }
            return { id, removed: true };
          } catch (cause) {
            return { error: errorMessage(cause) };
          }
        },
        inputSchema: {
          additionalProperties: false,
          properties: {
            id: { type: "string" }
          },
          required: ["id"],
          type: "object"
        },
        domain: "memory",
        name: "remove",
        risk: "write"
      },
      {
        description:
          "Drop EVERY episode from the store. Destructive — refuses unless `confirm: true` is passed " +
          "(the LLM-side equivalent of the CLI's `--yes` flag). Returns `{ cleared, removed }` on success.",
        execute: async (args): Promise<JsonObject> => {
          const confirm = args["confirm"];
          if (confirm !== true) {
            return { error: "Refusing to clear without confirm:true (this is irreversible — pass confirm:true to proceed)" };
          }
          try {
            const before = (await readEpisodes(file)) as readonly PersistedEpisode[];
            await clearEpisodes(file);
            return { cleared: true, removed: before.length };
          } catch (cause) {
            return { error: errorMessage(cause) };
          }
        },
        inputSchema: {
          additionalProperties: false,
          properties: {
            confirm: { description: "Must be true to actually clear.", type: "boolean" }
          },
          required: ["confirm"],
          type: "object"
        },
        domain: "memory",
        name: "clear",
        risk: "write"
      }
    ]
  };
}
