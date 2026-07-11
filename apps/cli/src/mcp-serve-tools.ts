/**
 * The tools `muse mcp serve` exposes — three read-only (grounded recall,
 * knowledge search, user-model read) plus one write-proxy (`propose_action`,
 * which only PARKS a proposed action in the approval queue, never executes it)
 * — and the self-contained dependency bootstrap they run on (no API server, no
 * `createMuseRuntimeAssembly`
 * — mirrors how `commands-ask.ts` / `ask-routes.ts` wire the grounded-recall
 * seam directly against env-resolved paths + an injected model provider).
 *
 * `resolveMcpServeDependencies` does the REAL env-based wiring (production);
 * `buildMcpServeTools` is pure given a `McpServeDependencies` so tests can
 * inject fakes (a failing model provider, a fixed clock, a temp notes dir)
 * without touching `process.env` or a live Ollama.
 */

import { randomUUID } from "node:crypto";

import { effectiveConfidence, FileUserMemoryStore, type UserMemoryStore } from "@muse/memory";
import { LocalDirNotesProvider, type NotesProvider } from "@muse/domain-tools";
import {
  assembleKnowledgeCorpus,
  createModelProvider,
  mergeModelKeysFromFile,
  resolveAnswerTemperature,
  resolveDefaultModel,
  resolveNotesDir,
  resolveNotesIndexFile,
  resolvePendingApprovalsFile,
  type MuseEnvironment
} from "@muse/autoconfigure";
import { recordPendingApproval, type PendingApproval } from "@muse/messaging";
import {
  allUserMemoryFacts,
  isNotesIndexStale,
  reindexNotes,
  runGroundedRecall,
  type MemoryFact
} from "@muse/recall";
import {
  edgeLoadByRelevance,
  rankKnowledgeChunksWithHop,
  renderKnowledgeMatches
} from "@muse/agent-core";
import type { JsonObject, JsonValue } from "@muse/shared";
import type { ModelProvider } from "@muse/model";
import type { MuseTool } from "@muse/tools";

import { embed } from "./embed.js";
import { DEFAULT_EMBED_MODEL } from "./embed-model-default.js";
import { resolveOllamaUrl } from "./ollama-url.js";

export interface McpServeDependencies {
  readonly notesDir: string;
  readonly notesIndexFile: string;
  readonly notesProvider: NotesProvider;
  readonly embedModel: string;
  readonly embedFn: (text: string, model: string) => Promise<readonly number[]>;
  readonly userMemoryStore: UserMemoryStore;
  readonly userId: string;
  readonly modelProvider?: ModelProvider;
  readonly answerModel?: string;
  readonly answerTemperature: number;
  readonly now: () => Date;
  readonly stagePendingApproval: (entry: PendingApproval) => Promise<void>;
  readonly newId: () => string;
}

/**
 * `MUSE_USER_ID` / `USER` / `"default"` — the same base identity
 * `resolveMemoryUserId` (commands-memory.ts) computes without a persona
 * suffix, reimplemented against an injectable `env` instead of a direct
 * `process.env` read so tests never touch global state.
 */
function resolveMcpUserId(env: MuseEnvironment): string {
  return env.MUSE_USER_ID?.trim() || env.USER?.trim() || "default";
}

export function resolveMcpServeDependencies(rawEnv: MuseEnvironment = process.env): McpServeDependencies {
  const env = mergeModelKeysFromFile(rawEnv);
  const notesDir = resolveNotesDir(env);
  return {
    answerModel: resolveDefaultModel(env),
    answerTemperature: resolveAnswerTemperature(env),
    embedFn: (text, model) => embed(text, model),
    embedModel: DEFAULT_EMBED_MODEL,
    modelProvider: createModelProvider(env),
    newId: () => randomUUID(),
    notesDir,
    notesIndexFile: resolveNotesIndexFile(env),
    notesProvider: new LocalDirNotesProvider({ notesDir }),
    now: () => new Date(),
    stagePendingApproval: (entry) => recordPendingApproval(resolvePendingApprovalsFile(env), entry),
    userId: resolveMcpUserId(env),
    userMemoryStore: new FileUserMemoryStore(env.MUSE_USER_MEMORY_FILE ? { file: env.MUSE_USER_MEMORY_FILE } : {})
  };
}

const KNOWLEDGE_SEARCH_DEFAULT_LIMIT = 5;
const KNOWLEDGE_SEARCH_MAX_LIMIT = 20;

/**
 * Embeds for RANKING with a fail-open fallback: an unreachable embedder
 * returns `[]` (cosine 0 for every candidate) instead of throwing, so
 * `knowledge_search`'s hybrid ranking still surfaces LEXICAL matches with no
 * model running at all — only the semantic boost is lost, never the tool.
 */
function createRankingEmbedFn(deps: McpServeDependencies): (text: string) => Promise<readonly number[]> {
  return async (text: string) => {
    try {
      return await deps.embedFn(text, deps.embedModel);
    } catch {
      return [];
    }
  };
}

async function currentUserMemoryFacts(deps: McpServeDependencies): Promise<readonly MemoryFact[]> {
  const memory = await Promise.resolve(deps.userMemoryStore.findByUserId(deps.userId));
  return memory ? allUserMemoryFacts({ facts: memory.facts, preferences: memory.preferences }) : [];
}

function buildKnowledgeSearchTool(deps: McpServeDependencies): MuseTool {
  const embedForRanking = createRankingEmbedFn(deps);
  return {
    definition: {
      description:
        "Search the user's notes and the facts/preferences Muse has learned about them, returning ranked passages each tagged with its [source] (cite the source in your own answer). Use when a connected agent needs grounded context about the user (e.g. 'what does the user know about X', 'find their note on Y', 'what preferences has the user stated'). Do not use for general world knowledge unrelated to the user, and never use to write or change anything (read-only).",
      inputSchema: {
        additionalProperties: false,
        properties: {
          limit: {
            description: `Max snippets to return, 1-${KNOWLEDGE_SEARCH_MAX_LIMIT.toString()}. Example: 10. Omit for the default (${KNOWLEDGE_SEARCH_DEFAULT_LIMIT.toString()}).`,
            maximum: KNOWLEDGE_SEARCH_MAX_LIMIT,
            minimum: 1,
            type: "integer"
          },
          query: {
            description: "What to look up, in natural language — e.g. 'my health insurance policy number' or 'what embedder model did I decide to use'.",
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
      const query = typeof (args as { query?: unknown }).query === "string" ? (args as { query: string }).query : "";
      const rawLimit = (args as { limit?: unknown }).limit;
      const limit = typeof rawLimit === "number" && Number.isFinite(rawLimit)
        ? Math.min(KNOWLEDGE_SEARCH_MAX_LIMIT, Math.max(1, Math.trunc(rawLimit)))
        : KNOWLEDGE_SEARCH_DEFAULT_LIMIT;

      const corpus = await assembleKnowledgeCorpus({
        maxNotes: 200,
        notesProvider: deps.notesProvider,
        userMemorySource: { facts: () => currentUserMemoryFacts(deps) }
      });
      const matches = await rankKnowledgeChunksWithHop(query, corpus, {
        diversify: true,
        embed: embedForRanking,
        hybrid: true,
        topK: limit
      });
      return renderKnowledgeMatches(edgeLoadByRelevance(matches));
    }
  };
}

/** Best-effort refresh so a fresh/edited note is retrievable; never blocks the answer on failure. */
async function bestEffortReindex(deps: McpServeDependencies): Promise<void> {
  try {
    const stale = await isNotesIndexStale(deps.notesDir, deps.notesIndexFile);
    if (stale) {
      await reindexNotes({
        baseUrlResolver: resolveOllamaUrl,
        dir: deps.notesDir,
        indexPath: deps.notesIndexFile,
        model: deps.embedModel
      });
    }
  } catch {
    // Best-effort: muse_recall still runs against whatever index exists.
  }
}

function buildMuseRecallTool(deps: McpServeDependencies): MuseTool {
  return {
    definition: {
      description:
        "Answer a question by grounding it in the user's notes: retrieves the most relevant passages, generates through the local model, then passes the answer through Muse's citation gate — a weak or missing match returns an honest \"I'm not sure\" instead of a guess, and any fabricated citation is stripped by code before you ever see it. Use when a connected agent needs a SOURCED answer to a question about the user's own notes. Do not use for general knowledge unrelated to the user's notes; requires the local model (Ollama) to be running.",
      inputSchema: {
        additionalProperties: false,
        properties: {
          question: {
            description: "The question to answer from the user's notes, e.g. 'what embedder model did I decide to use?'",
            type: "string"
          }
        },
        required: ["question"],
        type: "object"
      },
      name: "muse_recall",
      risk: "read"
    },
    execute: async (args) => {
      const question = typeof (args as { question?: unknown }).question === "string" ? (args as { question: string }).question : "";
      if (!deps.modelProvider || !deps.answerModel) {
        throw new Error("muse_recall requires a configured local model (set MUSE_MODEL, or run `muse setup model`) — refusing to answer without one rather than return an uncited guess.");
      }
      const modelProvider = deps.modelProvider;
      const answerModel = deps.answerModel;

      await bestEffortReindex(deps);

      const generateAnswer = async (generateArgs: { readonly system: string; readonly user: string; readonly model: string; readonly temperature?: number }): Promise<string> => {
        const response = await modelProvider.generate({
          messages: [
            { content: generateArgs.system, role: "system" },
            { content: generateArgs.user, role: "user" }
          ],
          model: generateArgs.model,
          ...(generateArgs.temperature !== undefined ? { temperature: generateArgs.temperature } : {})
        });
        return response.output;
      };

      let result;
      try {
        result = await runGroundedRecall({
          options: { answerModel, embedModel: deps.embedModel, temperature: deps.answerTemperature },
          query: question,
          runtime: { embedFn: (text, model) => deps.embedFn(text, model) as Promise<number[]>, generateAnswer },
          sources: { notesDir: deps.notesDir, notesIndexFile: deps.notesIndexFile }
        });
      } catch (error) {
        // The local model / embed endpoint is unreachable — never fall back
        // to an uncited guess; the caller (serve.ts) turns this throw into a
        // structured MCP tool error.
        throw new Error(`muse_recall: local model unreachable — ${error instanceof Error ? error.message : String(error)}`, { cause: error });
      }

      const out: Record<string, JsonValue> = {
        answer: result.answer,
        citations: [...result.citations],
        groundedChunkCount: result.groundedChunkCount,
        notesUnavailable: result.notesUnavailable,
        refusal: result.refusal,
        verdict: result.verdict
      };
      if (result.receipts !== undefined) {
        out.receipts = result.receipts;
      }
      return out;
    }
  };
}

const USER_MODEL_READ_KINDS = ["facts", "preferences", "all"] as const;
type UserModelReadKind = (typeof USER_MODEL_READ_KINDS)[number];

function isUserModelReadKind(value: unknown): value is UserModelReadKind {
  return typeof value === "string" && (USER_MODEL_READ_KINDS as readonly string[]).includes(value);
}

function factEntry(key: string, value: string): JsonObject {
  return { asserted: true, confidence: 1, key, value };
}

function buildUserModelReadTool(deps: McpServeDependencies): MuseTool {
  return {
    definition: {
      description:
        "Read what Muse has learned about the user: their stable facts and their preferences/tastes/habits, each with a confidence score (1.0 = the user told Muse directly; lower = Muse inferred it, and it fades over time unless reconfirmed). Use when a connected agent is about to act on the user's behalf and needs to know an established fact or preference first. Do not use to look up something the user hasn't told Muse before (try knowledge_search instead), and never use to write or change anything — this never returns anything the user has vetoed or asked Muse to forget. Read-only.",
      inputSchema: {
        additionalProperties: false,
        properties: {
          kind: {
            description: "Which slice to read: 'facts', 'preferences', or 'all' (default 'all'). Example: 'preferences'.",
            enum: [...USER_MODEL_READ_KINDS],
            type: "string"
          }
        },
        type: "object"
      },
      name: "user_model_read",
      risk: "read"
    },
    execute: async (args) => {
      const rawKind = (args as { kind?: unknown }).kind;
      if (rawKind !== undefined && !isUserModelReadKind(rawKind)) {
        throw new Error(`user_model_read: 'kind' must be one of ${USER_MODEL_READ_KINDS.join(", ")}, got '${String(rawKind)}'`);
      }
      const kind: UserModelReadKind = isUserModelReadKind(rawKind) ? rawKind : "all";

      const memory = await Promise.resolve(deps.userMemoryStore.findByUserId(deps.userId));
      const out: Record<string, JsonValue> = {};

      if (kind === "facts" || kind === "all") {
        out.facts = memory ? Object.entries(memory.facts).map(([key, value]) => factEntry(key, value)) : [];
      }

      if (kind === "preferences" || kind === "all") {
        if (!memory) {
          out.preferences = [];
        } else {
          const now = deps.now();
          // Legacy `preferences:` entries are asserted (confidence 1, never
          // decay) but exclude the internal `veto:` / `goal:` namespaced keys —
          // those are persona machinery, never a preference to hand to a
          // third-party agent. Typed slots carry the auto-extractor's real
          // decayed confidence and OVERRIDE a same-key legacy entry (richer
          // provenance); `userModel.vetoes` is a separate array entirely and
          // is never read here at all, so a veto can never leave this tool.
          const byKey = new Map<string, JsonObject>();
          for (const [key, value] of Object.entries(memory.preferences)) {
            if (key.startsWith("veto:") || key.startsWith("goal:")) {
              continue;
            }
            byKey.set(key, factEntry(key, value));
          }
          for (const slot of memory.userModel?.preferences ?? []) {
            byKey.set(slot.id, {
              asserted: slot.confidence === undefined,
              confidence: effectiveConfidence(slot.confidence, slot.updatedAt, now),
              key: slot.id,
              value: slot.value
            });
          }
          out.preferences = [...byKey.values()];
        }
      }

      return out;
    }
  };
}

// Mirrors PENDING_APPROVAL_TTL_MS in actuator-tools.ts (buildCliPendingApprovalStager) —
// a proposed action parks for a week before it's stale, same as a refused CLI write.
const PROPOSE_ACTION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function buildProposeActionTool(deps: McpServeDependencies): MuseTool {
  return {
    definition: {
      description:
        "Propose an action for the user to review and approve — it is PARKED in the user's approval queue and NEVER executed automatically; the user must approve it via `muse approvals`. Use when a connected agent wants Muse to DO something on the user's behalf (write a note, add a reminder, draft a message). Do NOT use for reads (use knowledge_search / muse_recall) and do NOT expect the action to happen until the user confirms.",
      inputSchema: {
        additionalProperties: false,
        properties: {
          action: {
            description: "The proposed action or tool name, e.g. 'add_reminder' or 'send_message'.",
            type: "string"
          },
          arguments: {
            description: "Structured payload for the action, e.g. { \"at\": \"15:00\" }. Optional — omit if the draft alone is enough context.",
            type: "object"
          },
          draft: {
            description: "The exact human-readable content the user will review, e.g. 'Remind me to call the dentist at 3pm'.",
            type: "string"
          }
        },
        required: ["action", "draft"],
        type: "object"
      },
      name: "propose_action",
      risk: "write"
    },
    execute: async (args) => {
      const rawAction = (args as { action?: unknown }).action;
      const rawDraft = (args as { draft?: unknown }).draft;
      if (typeof rawAction !== "string" || rawAction.trim().length === 0) {
        throw new Error("propose_action: 'action' must be a non-empty string — refusing to park a blank action.");
      }
      if (typeof rawDraft !== "string" || rawDraft.trim().length === 0) {
        throw new Error("propose_action: 'draft' must be a non-empty string — refusing to park an action with no reviewable content.");
      }
      const rawArguments = (args as { arguments?: unknown }).arguments;
      const argumentsPayload = rawArguments && typeof rawArguments === "object" && !Array.isArray(rawArguments)
        ? rawArguments as Record<string, unknown>
        : {};

      const createdAt = deps.now();
      const entry: PendingApproval = {
        arguments: argumentsPayload,
        createdAt: createdAt.toISOString(),
        draft: rawDraft,
        expiresAt: new Date(createdAt.getTime() + PROPOSE_ACTION_TTL_MS).toISOString(),
        id: deps.newId(),
        providerId: "mcp",
        risk: "write",
        source: "mcp-serve",
        tool: rawAction,
        userId: deps.userId
      };

      await deps.stagePendingApproval(entry);

      return {
        id: entry.id,
        message: "Parked for your approval — nothing was executed. Run `muse approvals` to review and approve.",
        staged: true
      };
    }
  };
}

export function buildMcpServeTools(deps: McpServeDependencies): readonly MuseTool[] {
  return [buildMuseRecallTool(deps), buildKnowledgeSearchTool(deps), buildUserModelReadTool(deps), buildProposeActionTool(deps)];
}
