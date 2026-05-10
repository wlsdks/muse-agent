import { randomUUID } from "node:crypto";
import { promises as nodeFs } from "node:fs";
import { dirname as nodePathDirname } from "node:path";

import type { JsonObject, JsonValue } from "@muse/shared";

import type { LoopbackMcpServer } from "./loopback.js";
import { readString, readStringArray, errorMessage } from "./loopback-helpers.js";
import { resolveRelativeTimePhrase } from "./loopback-relative-time.js";

/**
 * `muse.tasks` loopback MCP server — personal todo list backed by a
 * single JSON file (default `~/.muse/tasks.json` via autoconfigure).
 *
 * Lifted out of `loopback.ts` (which had grown past 1,800 LOC even
 * after rounds 82-83) to keep the on-disk task storage helpers
 * (`readTasks` / `writeTasks` / atomic-rename / shape guards) in
 * one cohesive module. Same public surface as before:
 * `TasksMcpServerOptions` + `createTasksMcpServer`. Both symbols
 * are re-exported from `loopback.ts` so the `@muse/mcp` barrel,
 * autoconfigure, and the existing tests stay byte-identical.
 */

export interface TasksMcpServerOptions {
  readonly file: string;
  readonly idFactory?: () => string;
  readonly maxListEntries?: number;
  readonly maxQueryLength?: number;
  readonly now?: () => Date;
}

interface PersistedTask {
  readonly id: string;
  readonly title: string;
  readonly status: "open" | "done";
  readonly createdAt: string;
  readonly completedAt?: string;
  readonly dueAt?: string;
  readonly notes?: string;
  readonly tags?: readonly string[];
}

/**
 * Personal todo list. Persists tasks as a single JSON file. Reads
 * are idempotent — a missing or unparseable file is treated as
 * empty so a fresh install never throws. Writes are atomic
 * (`tmp` → rename).
 *
 * Tools:
 *   - `muse.tasks.add({ title, notes?, tags? })` — append a new task
 *     with status="open" and a generated id.
 *   - `muse.tasks.list({ status?: "open"|"done"|"all" })` — newest
 *     first, default status="open".
 *   - `muse.tasks.complete({ id })` — mark a task done with
 *     completedAt timestamp.
 *   - `muse.tasks.search({ query, status? })` — substring match on
 *     title and notes (case-insensitive).
 */
export function createTasksMcpServer(options: TasksMcpServerOptions): LoopbackMcpServer {
  const file = options.file;
  const idFactory = options.idFactory ?? (() => `task_${randomUUID()}`);
  const now = options.now ?? (() => new Date());
  const maxListEntries = Math.max(1, Math.trunc(options.maxListEntries ?? 200));
  const maxQueryLength = Math.max(1, Math.trunc(options.maxQueryLength ?? 200));

  return {
    description: "Personal todo list (single JSON file, loopback MCP).",
    name: "muse.tasks",
    tools: [
      {
        description:
          "Append a new task. Required: `title`. Optional: `notes` (free-form text), `tags` (string array), `dueAt`. " +
          "`dueAt` accepts either an ISO-8601 timestamp OR a simple relative phrase: 'tomorrow', 'tomorrow at 6pm', 'today at 14:30', 'in 3 hours', 'in 2 days', 'next Monday', 'next Monday at 9am'. " +
          "Pass the user's natural-language phrase directly — the server resolves it against the current local time. " +
          "Returns the created task with its generated id.",
        execute: async (args): Promise<JsonObject> => {
          const title = readString(args, "title")?.trim();
          if (!title) {
            return { error: "title is required" };
          }
          const notes = readString(args, "notes") ?? undefined;
          const tags = readStringArray(args, "tags") ?? undefined;
          const dueAtRaw = readString(args, "dueAt")?.trim();
          let dueAt: string | undefined;
          if (dueAtRaw && dueAtRaw.length > 0) {
            const isoParsed = new Date(dueAtRaw);
            if (!Number.isNaN(isoParsed.getTime()) && /^\d{4}-\d{2}-\d{2}/u.test(dueAtRaw)) {
              dueAt = isoParsed.toISOString();
            } else {
              const relative = resolveRelativeTimePhrase(dueAtRaw, now);
              if (!relative) {
                return { error: `dueAt must be an ISO-8601 timestamp or a supported relative phrase (got ${JSON.stringify(dueAtRaw)})` };
              }
              dueAt = relative.toISOString();
            }
          }
          const tasks = await readTasks(file);
          const created: PersistedTask = {
            createdAt: now().toISOString(),
            id: idFactory(),
            status: "open",
            title,
            ...(notes ? { notes } : {}),
            ...(dueAt ? { dueAt } : {}),
            ...(tags && tags.length > 0 ? { tags } : {})
          };
          try {
            await writeTasks(file, [...tasks, created]);
          } catch (error) {
            return { error: errorMessage(error) };
          }
          return { task: serializeTask(created) as JsonValue };
        },
        inputSchema: {
          additionalProperties: false,
          properties: {
            dueAt: { description: "Optional ISO-8601 due timestamp (e.g. 2026-05-15T18:00:00Z).", type: "string" },
            notes: { type: "string" },
            tags: { items: { type: "string" }, type: "array" },
            title: { type: "string" }
          },
          required: ["title"],
          type: "object"
        },
        name: "add",
        risk: "write"
      },
      {
        description:
          "List tasks newest-first. `status`: \"open\" (default), \"done\", or \"all\". " +
          `Returns up to ${maxListEntries} entries.`,
        execute: async (args): Promise<JsonObject> => {
          const status = readStatusFilter(readString(args, "status"));
          const tasks = await readTasks(file);
          const filtered = tasks
            .filter((task) => status === "all" || task.status === status)
            .sort((left, right) => (right.createdAt ?? "").localeCompare(left.createdAt ?? ""))
            .slice(0, maxListEntries);
          return {
            status,
            tasks: filtered.map(serializeTask) as JsonValue,
            total: filtered.length
          };
        },
        inputSchema: {
          additionalProperties: false,
          properties: {
            status: { enum: ["open", "done", "all"], type: "string" }
          },
          type: "object"
        },
        name: "list",
        risk: "read"
      },
      {
        description: "Mark a task done by id. Sets status=\"done\" and completedAt to now.",
        execute: async (args): Promise<JsonObject> => {
          const id = readString(args, "id");
          if (!id) {
            return { error: "id is required" };
          }
          const tasks = await readTasks(file);
          const index = tasks.findIndex((task) => task.id === id);
          if (index < 0) {
            return { error: `task not found: ${id}` };
          }
          const completed: PersistedTask = {
            ...tasks[index]!,
            completedAt: now().toISOString(),
            status: "done"
          };
          const next = [...tasks];
          next[index] = completed;
          try {
            await writeTasks(file, next);
          } catch (error) {
            return { error: errorMessage(error) };
          }
          return { task: serializeTask(completed) as JsonValue };
        },
        inputSchema: {
          additionalProperties: false,
          properties: {
            id: { type: "string" }
          },
          required: ["id"],
          type: "object"
        },
        name: "complete",
        risk: "write"
      },
      {
        description:
          "Substring search across title + notes (case-insensitive). `status` filter optional. " +
          "Returns up to 50 matches newest-first.",
        execute: async (args): Promise<JsonObject> => {
          const query = readString(args, "query")?.trim() ?? "";
          if (query.length === 0) {
            return { error: "query is required" };
          }
          if (query.length > maxQueryLength) {
            return { error: `query too long (max ${maxQueryLength} chars)` };
          }
          const status = readStatusFilter(readString(args, "status"));
          const tasks = await readTasks(file);
          const needle = query.toLowerCase();
          const matches = tasks
            .filter((task) => status === "all" || task.status === status)
            .filter((task) =>
              task.title.toLowerCase().includes(needle)
              || (task.notes?.toLowerCase().includes(needle) ?? false)
            )
            .sort((left, right) => (right.createdAt ?? "").localeCompare(left.createdAt ?? ""))
            .slice(0, 50);
          return {
            query,
            status,
            tasks: matches.map(serializeTask) as JsonValue,
            total: matches.length
          };
        },
        inputSchema: {
          additionalProperties: false,
          properties: {
            query: { type: "string" },
            status: { enum: ["open", "done", "all"], type: "string" }
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

async function readTasks(file: string): Promise<readonly PersistedTask[]> {
  let raw: string;
  try {
    raw = await nodeFs.readFile(file, "utf8");
  } catch (error) {
    if (isFileNotFound(error)) {
      return [];
    }
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { tasks?: unknown }).tasks)) {
    return [];
  }
  return (parsed as { tasks: unknown[] }).tasks.flatMap((entry): readonly PersistedTask[] =>
    isPersistedTask(entry) ? [entry] : []
  );
}

async function writeTasks(file: string, tasks: readonly PersistedTask[]): Promise<void> {
  const payload = `${JSON.stringify({ tasks }, null, 2)}\n`;
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await nodeFs.mkdir(nodePathDirname(file), { recursive: true });
  await nodeFs.writeFile(tmp, payload, "utf8");
  await nodeFs.rename(tmp, file);
}

function serializeTask(task: PersistedTask): JsonObject {
  return {
    createdAt: task.createdAt,
    id: task.id,
    status: task.status,
    title: task.title,
    ...(task.completedAt ? { completedAt: task.completedAt } : {}),
    ...(task.dueAt ? { dueAt: task.dueAt } : {}),
    ...(task.notes ? { notes: task.notes } : {}),
    ...(task.tags && task.tags.length > 0 ? { tags: [...task.tags] as JsonValue } : {})
  };
}

function isPersistedTask(value: unknown): value is PersistedTask {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as PersistedTask;
  if (typeof candidate.id !== "string"
    || typeof candidate.title !== "string"
    || typeof candidate.createdAt !== "string"
    || (candidate.status !== "open" && candidate.status !== "done")) {
    return false;
  }
  if (candidate.dueAt !== undefined && typeof candidate.dueAt !== "string") {
    return false;
  }
  return true;
}

function readStatusFilter(value: string | undefined): "open" | "done" | "all" {
  if (value === "done" || value === "all") {
    return value;
  }
  return "open";
}

function isFileNotFound(error: unknown): boolean {
  return Boolean(error) && typeof error === "object" && (error as { code?: string }).code === "ENOENT";
}
