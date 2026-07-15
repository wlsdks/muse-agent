/**
 * `muse.tasks-multi` — provider-neutral tasks MCP surface backed by
 * `TasksProviderRegistry`. Mirrors `createNotesRegistryMcpServer`
 * for the tasks domain so the agent can target any
 * registered backend (LocalFile, Apple Reminders, Notion DB) via
 * `providerId`.
 *
 * Coexists with the original `createTasksMcpServer` — server names
 * `muse.tasks` (filesystem-only) and `muse.tasks-multi` (registry)
 * don't collide. autoconfigure registers the multi-server only when
 * the user opts into ≥2 providers via `MUSE_TASKS_PROVIDERS`, so
 * default users keep the inline `muse.tasks` and skip the registry
 * overhead.
 */

import { assertNoSecretInPersistedFields, type JsonObject, type JsonValue } from "@muse/shared";

import { readString, readStringArray } from "@muse/mcp";
import type { LoopbackMcpServer } from "@muse/mcp";
import {
  TasksProviderError,
  TasksValidationError,
  type Task,
  type TaskInput,
  type TaskSearchHit,
  type TasksProviderRegistry
} from "./tasks-providers.js";

export interface TasksRegistryMcpServerOptions {
  readonly registry: TasksProviderRegistry;
}

export function createTasksRegistryMcpServer(options: TasksRegistryMcpServerOptions): LoopbackMcpServer {
  const { registry } = options;

  return {
    description: "Provider-neutral personal todo list (LocalFile / Apple Reminders / Notion) via TasksProviderRegistry.",
    name: "muse.tasks-multi",
    tools: [
      {
        description:
          "List configured tasks providers (id, displayName, local). " +
          "Use `providerId` from this list to target a specific provider in other muse.tasks-multi.* calls.",
        execute: async (): Promise<JsonObject> => ({
          providers: registry.describe().map((info) => ({
            description: info.description,
            displayName: info.displayName,
            id: info.id,
            local: info.local
          })) as JsonValue
        }),
        inputSchema: {
          additionalProperties: false,
          properties: {},
          type: "object"
        },
        name: "providers",
        risk: "read"
      },
      {
        description:
          "List tasks newest-first from one provider (or every provider when `providerId` is omitted). " +
          "Optional `status` filter: \"open\" (default), \"done\", or \"all\".",
        execute: async (args): Promise<JsonObject> => {
          const providerId = readString(args, "providerId");
          const status = readStatusFilter(readString(args, "status"));
          try {
            const tasks = providerId
              ? await registry.require(providerId).list(status)
              : (await Promise.all(
                  registry.list().map(async (provider) => {
                    try {
                      return await provider.list(status);
                    } catch {
                      return [] as readonly Task[];
                    }
                  })
                )).flat();
            return {
              status,
              tasks: tasks.map(serializeTask) as JsonValue,
              total: tasks.length
            };
          } catch (error) {
            return errorBody(error);
          }
        },
        inputSchema: {
          additionalProperties: false,
          properties: {
            providerId: { description: "Tasks provider id (default: all registered providers).", type: "string" },
            status: { description: "Which tasks to list: 'open' (default), 'done', or 'all'.", enum: ["open", "done", "all"], type: "string" }
          },
          type: "object"
        },
        name: "list",
        risk: "read"
      },
      {
        description:
          "Add a new task. Required: `title`. Optional: `notes`, `tags`, and `providerId` to " +
          "target a specific backend (from `providers`); omit `providerId` to use your primary list. " +
          "Returns the created task with its provider-scoped id.",
        execute: async (args): Promise<JsonObject> => {
          const providerId = readString(args, "providerId");
          const title = readString(args, "title")?.trim();
          if (!title) {
            return { error: "title is required" };
          }
          const notes = readString(args, "notes") ?? undefined;
          const guard = assertNoSecretInPersistedFields({ title, notes });
          if (!guard.safe) {
            return { blocked: true, error: guard.notice, kinds: guard.kinds as JsonValue };
          }
          const tags = readStringArray(args, "tags") ?? undefined;
          const input: TaskInput = {
            title,
            ...(notes ? { notes } : {}),
            ...(tags && tags.length > 0 ? { tags } : {})
          };
          try {
            const created = await registry.requireOrPrimary(providerId).add(input);
            return { task: serializeTask(created) as JsonValue };
          } catch (error) {
            return errorBody(error);
          }
        },
        inputSchema: {
          additionalProperties: false,
          properties: {
            notes: { description: "Optional free-text details for the task.", type: "string" },
            providerId: { description: "Tasks provider id to add into, from `providers` (default: your primary list).", type: "string" },
            tags: { description: "Optional labels for the task.", items: { type: "string" }, type: "array" },
            title: { description: "What the task is, e.g. 'Buy milk' or 'Email the Q3 deck'.", type: "string" }
          },
          required: ["title"],
          type: "object"
        },
        name: "add",
        risk: "write"
      },
      {
        description: "Mark a task done by `providerId` + `id`. Returns the updated task or `{ found: false }` when the id is unknown.",
        execute: async (args): Promise<JsonObject> => {
          const providerId = readString(args, "providerId");
          const id = readString(args, "id");
          if (!providerId || !id) {
            return { error: "providerId and id are required" };
          }
          try {
            const completed = await registry.require(providerId).complete(id);
            if (!completed) {
              return { error: `task not found: ${providerId}:${id}`, found: false };
            }
            return { task: serializeTask(completed) as JsonValue };
          } catch (error) {
            return errorBody(error);
          }
        },
        inputSchema: {
          additionalProperties: false,
          properties: {
            id: { description: "The task's id, from `list` or `search`.", type: "string" },
            providerId: { description: "Tasks provider id the task belongs to.", type: "string" }
          },
          required: ["providerId", "id"],
          type: "object"
        },
        name: "complete",
        risk: "write"
      },
      {
        description:
          "Search tasks by substring across one or all providers. Without `providerId`, the same query " +
          "runs in parallel against every registered provider.",
        execute: async (args): Promise<JsonObject> => {
          const query = readString(args, "query")?.trim();
          if (!query) {
            return { error: "query is required" };
          }
          const providerId = readString(args, "providerId");
          const limitArg = args["limit"];
          const limit = typeof limitArg === "number" && Number.isFinite(limitArg)
            ? Math.max(1, Math.min(200, Math.trunc(limitArg)))
            : 20;
          try {
            const hits = providerId
              ? await registry.require(providerId).search(query, limit)
              : (await Promise.all(
                  registry.list().map(async (provider) => {
                    try {
                      return await provider.search(query, limit);
                    } catch {
                      return [] as readonly TaskSearchHit[];
                    }
                  })
                )).flat();
            return {
              hits: hits.map(serializeHit) as JsonValue,
              total: hits.length
            };
          } catch (error) {
            return errorBody(error);
          }
        },
        inputSchema: {
          additionalProperties: false,
          properties: {
            limit: { description: "Max results to return (default 20).", type: "number" },
            providerId: { description: "Tasks provider id (default: search all providers).", type: "string" },
            query: { description: "Text to find in task titles/notes, e.g. 'milk' or 'Q3'.", type: "string" }
          },
          required: ["query"],
          type: "object"
        },
        name: "search",
        risk: "read"
      }
    ]
  };
}

function readStatusFilter(value: string | undefined): "open" | "done" | "all" {
  if (value === "done" || value === "all") {
    return value;
  }
  return "open";
}

function serializeTask(task: Task): JsonObject {
  return {
    createdAt: task.createdAt.toISOString(),
    id: task.id,
    providerId: task.providerId,
    status: task.status,
    title: task.title,
    ...(task.completedAt ? { completedAt: task.completedAt.toISOString() } : {}),
    ...(task.notes ? { notes: task.notes } : {}),
    ...(task.tags && task.tags.length > 0 ? { tags: [...task.tags] as JsonValue } : {})
  };
}

function serializeHit(hit: TaskSearchHit): JsonObject {
  return {
    id: hit.id,
    providerId: hit.providerId,
    status: hit.status,
    title: hit.title,
    ...(hit.snippet ? { snippet: hit.snippet } : {})
  };
}

function errorBody(error: unknown): JsonObject {
  if (error instanceof TasksProviderError || error instanceof TasksValidationError) {
    return { code: error.code, error: error.message };
  }
  return { error: error instanceof Error ? error.message : String(error) };
}
