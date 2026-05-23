import { randomUUID } from "node:crypto";

import type { JsonObject, JsonValue } from "@muse/shared";

import type { LoopbackMcpServer } from "./loopback.js";
import { readString, readStringArray, errorMessage } from "./loopback-helpers.js";
import {
  compareTasksByDueDate,
  parseTaskDueAt,
  readTasks,
  readTaskStatusFilter,
  selectTasksDueWithin,
  serializeTask,
  writeTasks,
  type PersistedTask
} from "./personal-tasks-store.js";

/**
 * `muse.tasks` loopback MCP server — personal todo list backed by a
 * single JSON file (default `~/.muse/tasks.json` via autoconfigure).
 *
 * Lifted out of `loopback.ts` (which had grown past 1,800 LOC)
 * to keep the on-disk task storage helpers
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

/**
 * Personal todo list. Persists tasks as a single JSON file. Reads
 * are idempotent — a missing or unparseable file is treated as
 * empty so a fresh install never throws. Writes are atomic
 * (`tmp` → rename).
 *
 * Tools:
 *   - `muse.tasks.add({ title, notes?, tags? })` — append a new task
 *     with status="open" and a generated id.
 *   - `muse.tasks.list({ status?: "open"|"done"|"all" })` —
 *     due-soonest first (undated last), default status="open".
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
          "Append a new task. Required: `title`. Optional: `notes` (free-form text), `tags` (string array), `dueAt`, `urgent`. " +
          "Set `urgent: true` for a high-priority task the proactive watcher fires even during the user's quiet hours (e.g. 'pay rent today'). " +
          "`dueAt` accepts either an ISO-8601 timestamp OR a relative phrase. " +
          "English: 'tomorrow', 'tomorrow 6pm', 'today at 14:30', 'in 3 hours', 'in 2 days', 'next Monday', 'next Monday at 9am'. " +
          "Korean: '내일', '내일 오후 3시', '오늘 오전 9시 30분', '30분 후', '3일 뒤', '다음 주 월요일', '다음 주 월요일 오후 3시 반'. " +
          "Pass the user's natural-language phrase directly (in their own language) — the server resolves it against the current local time. " +
          "Returns the created task with its generated id.",
        execute: async (args): Promise<JsonObject> => {
          const title = readString(args, "title")?.trim();
          if (!title) {
            return { error: "title is required" };
          }
          const notes = readString(args, "notes") ?? undefined;
          const tags = readStringArray(args, "tags") ?? undefined;
          const urgent = args["urgent"] === true;
          const dueAtRaw = readString(args, "dueAt")?.trim();
          let dueAt: string | undefined;
          if (dueAtRaw && dueAtRaw.length > 0) {
            const parsed = parseTaskDueAt(dueAtRaw, now);
            if (parsed instanceof Error) {
              return { error: parsed.message };
            }
            dueAt = parsed;
          }
          const tasks = await readTasks(file);
          const created: PersistedTask = {
            createdAt: now().toISOString(),
            id: idFactory(),
            status: "open",
            title,
            ...(notes ? { notes } : {}),
            ...(dueAt ? { dueAt } : {}),
            ...(tags && tags.length > 0 ? { tags } : {}),
            ...(urgent ? { urgent: true } : {})
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
            notes: { description: "Optional free-text details for the task.", type: "string" },
            tags: { description: "Optional labels for the task.", items: { type: "string" }, type: "array" },
            title: { description: "What the task is, e.g. 'Buy milk' or 'Email the Q3 deck'.", type: "string" },
            urgent: { description: "Set true for a high-priority task fired even during the user's quiet hours, e.g. 'pay rent today'. Omit for a normal task.", type: "boolean" }
          },
          required: ["title"],
          type: "object"
        },
        domain: "tasks",
        name: "add",
        risk: "write"
      },
      {
        description:
          "List tasks due-soonest first (undated last). `status`: \"open\" (default), \"done\", or \"all\". " +
          "Pass `dueWithinDays` to answer 'what's due today / this week?' — it returns ONLY open tasks due within that many days, OVERDUE included, soonest first (0 = today + overdue, 7 = this week). " +
          `Returns up to ${maxListEntries} entries.`,
        execute: async (args): Promise<JsonObject> => {
          const tasks = await readTasks(file);
          const dueRaw = (args as Record<string, unknown>)["dueWithinDays"];
          if (typeof dueRaw === "number" && Number.isFinite(dueRaw)) {
            const due = selectTasksDueWithin(tasks, { now: now(), withinDays: dueRaw })
              .map((entry) => entry.task)
              .slice(0, maxListEntries);
            return {
              dueWithinDays: Math.max(0, Math.trunc(dueRaw)),
              tasks: due.map(serializeTask) as JsonValue,
              total: due.length
            };
          }
          const status = readTaskStatusFilter(readString(args, "status"));
          const filtered = tasks
            .filter((task) => status === "all" || task.status === status)
            .sort(compareTasksByDueDate)
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
            dueWithinDays: { description: "Only OPEN tasks due within this many days (overdue included), e.g. 0 = today + overdue, 7 = this week. Omit to list by status.", type: "number" },
            status: { description: "Which tasks to list: 'open' (default), 'done', or 'all'. Ignored when dueWithinDays is set.", enum: ["open", "done", "all"], type: "string" }
          },
          type: "object"
        },
        domain: "tasks",
        keywords: ["due", "overdue", "deadline", "마감"],
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
            id: { description: "The task's id, from `list` or `search`.", type: "string" }
          },
          required: ["id"],
          type: "object"
        },
        domain: "tasks",
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
          const status = readTaskStatusFilter(readString(args, "status"));
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
            query: { description: "Text to find in task titles/notes, e.g. 'milk' or 'Q3'.", type: "string" },
            status: { description: "Which tasks to search: 'open' (default), 'done', or 'all'.", enum: ["open", "done", "all"], type: "string" }
          },
          required: ["query"],
          type: "object"
        },
        domain: "tasks",
        name: "search",
        risk: "read"
      }
    ]
  };
}

