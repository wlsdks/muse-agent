import type { JsonObject, JsonValue } from "@muse/shared";

import { errorMessage, readString } from "./loopback-helpers.js";
import type { LoopbackMcpServer } from "./loopback.js";
import {
  clearEpisodes,
  readEpisodes,
  removeEpisode,
  serializeEpisode,
  type PersistedEpisode
} from "@muse/stores";
import type { ProactiveModelProviderLike } from "@muse/proactivity";

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
  /**
   * Optional model provider for the `search` tool's `mode: "llm-judge"`
   * path. When unset, the LLM-judge mode is rejected at request time
   * with a clear "not configured" error; the substring path still works.
   *
   * Personal-scale Muse skips a vector index entirely — at ≤ a few
   * hundred episodes, asking the LLM to pick relevant ids from the
   * full list (one round-trip per query) is cheaper than running
   * pgvector + embeddings, and the LLM does paraphrase recall
   * natively ("Notion thing" → matches "Q3 budget memo / Notion").
   */
  readonly modelProvider?: ProactiveModelProviderLike;
  readonly model?: string;
}

export function createEpisodesMcpServer(options: EpisodesMcpServerOptions): LoopbackMcpServer {
  const file = options.file;
  const maxListEntries = Math.max(1, Math.trunc(options.maxListEntries ?? 50));
  const llmJudgeReady = Boolean(options.modelProvider && options.model);

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
          const sorted = [...scoped].sort((left, right) => right.endedAt.localeCompare(left.endedAt));
          const shownList = sorted.slice(0, limit);
          return {
            episodes: shownList.map(serializeEpisode) as JsonValue,
            shown: shownList.length, // returned count
            total: scoped.length, // the REAL store size, NOT the post-limit slice (parity with reminders.list)
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
          const modeRaw = readString(args, "mode");
          const mode = modeRaw === "llm-judge" ? "llm-judge" : "substring";

          const all = await readEpisodes(file);
          const scoped = userId ? all.filter((e) => e.userId === userId) : all;

          if (mode === "llm-judge") {
            if (!llmJudgeReady) {
              return { error: "llm-judge mode requires modelProvider + model to be wired into createEpisodesMcpServer; falling back: re-run with mode: 'substring'" };
            }
            try {
              const matches = await runLlmJudge(scoped, query, limit, options);
              return {
                episodes: matches.map(serializeEpisode) as JsonValue,
                mode: "llm-judge",
                query,
                total: matches.length,
                ...(userId ? { userId } : {})
              };
            } catch (cause) {
              return { error: `llm-judge failed: ${errorMessage(cause)}` };
            }
          }

          const needle = query.toLowerCase();
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
            .sort((left, right) => right.endedAt.localeCompare(left.endedAt));
          const shownList = matches.slice(0, limit);
          return {
            episodes: shownList.map(serializeEpisode) as JsonValue,
            mode: "substring",
            query,
            shown: shownList.length, // returned count
            total: matches.length, // the full match count, NOT the post-limit slice
            ...(userId ? { userId } : {})
          };
        },
        inputSchema: {
          additionalProperties: false,
          properties: {
            limit: { type: "number" },
            mode: {
              description:
                "'substring' (default) for case-insensitive grep; 'llm-judge' asks the model to pick relevant ids from the full episode list (one extra round-trip; catches paraphrase recall — 'Notion thing' → matches an episode tagged 'Notion').",
              enum: ["substring", "llm-judge"],
              type: "string"
            },
            query: { description: "Substring (mode=substring) or natural-language query (mode=llm-judge).", type: "string" },
            userId: { type: "string" }
          },
          required: ["query"],
          type: "object"
        },
        domain: "memory",
        name: "search",
        keywords: ["session", "conversation", "대화", "세션", "지난번", "search", "찾아", "검색"],
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

const LLM_JUDGE_SYSTEM_PROMPT =
  `You are an episode selector. The user gives you a natural-language
query and a list of prior-session summaries. Return the ids of the
episodes that are MOST relevant to the query, in descending order of
relevance.

Output STRICT JSON: a single array of episode-id strings, e.g.
["ep_abc", "ep_def"]. NEVER invent ids that were not in the input.
NEVER include explanatory text. Return [] when nothing meaningfully
matches.`;

async function runLlmJudge(
  episodes: readonly PersistedEpisode[],
  query: string,
  limit: number,
  options: EpisodesMcpServerOptions
): Promise<readonly PersistedEpisode[]> {
  if (episodes.length === 0) return [];
  // Sort newest-first so the LLM has a chronological prior.
  const candidates = [...episodes].sort((left, right) => right.endedAt.localeCompare(left.endedAt));
  const lines: string[] = [];
  for (const ep of candidates) {
    const topicSuffix = ep.topics && ep.topics.length > 0 ? ` [${ep.topics.join(", ")}]` : "";
    lines.push(`[${ep.id}] ${ep.endedAt.slice(0, 10)}: ${ep.summary.replace(/\s+/gu, " ").trim()}${topicSuffix}`);
  }
  const userMessage = `Query: ${query}\n\nEpisodes:\n${lines.join("\n")}\n\nReturn at most ${limit.toString()} ids.`;

  const response = await options.modelProvider!.generate({
    maxOutputTokens: 320,
    messages: [
      { content: LLM_JUDGE_SYSTEM_PROMPT, role: "system" },
      { content: userMessage, role: "user" }
    ],
    model: options.model!,
    temperature: 0
  });
  const ids = parseLlmJudgeOutput((response.output ?? "").trim());
  // Resolve in the order the LLM returned (preserves its relevance ranking),
  // dedupe, cap at `limit`, drop hallucinated ids.
  const byId = new Map(candidates.map((ep) => [ep.id, ep] as const));
  const seen = new Set<string>();
  const out: PersistedEpisode[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    const ep = byId.get(id);
    if (!ep) continue;
    seen.add(id);
    out.push(ep);
    if (out.length >= limit) break;
  }
  return out;
}

function parseLlmJudgeOutput(raw: string): readonly string[] {
  const first = raw.indexOf("[");
  if (first < 0) return [];
  let depth = 0;
  let body = "";
  for (let i = first; i < raw.length; i += 1) {
    const ch = raw[i];
    if (ch === "[") depth += 1;
    else if (ch === "]") {
      depth -= 1;
      if (depth === 0) {
        body = raw.slice(first, i + 1);
        break;
      }
    }
  }
  if (!body) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(body) as unknown; } catch { return []; }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((id): id is string => typeof id === "string" && id.length > 0);
}
