/**
 * `muse tasks` command group.
 *
 * Wraps `/api/tasks/*` for remote mode and the shared
 * `@muse/mcp/personal-tasks-store` helpers for `--local` mode so the
 * CLI works without an API server. Both surfaces speak the same
 * on-disk format, so a `--local` write is visible to the API on the
 * next request and vice versa.
 *
 * Output: human-readable by default; `--json` opts back into the raw
 * API response for scripting.
 */

import { randomUUID } from "node:crypto";

import { resolveTasksFile } from "@muse/autoconfigure";
import {
  compareTasksByDueDate,
  parseTaskDueAt,
  readTasks,
  readTaskStatusFilter,
  serializeTask,
  writeTasks,
  type PersistedTask
} from "@muse/mcp";
import type { Command } from "commander";

import { isApiUnreachable } from "./program-helpers.js";

import { closestCommandName } from "./closest-command.js";
import {
  formatProvidersList,
  formatTaskAdded,
  formatTaskCompleted,
  formatTaskList
} from "./human-formatters.js";
import type { ProgramIO } from "./program.js";

/**
 * CLI-side strict validation for `muse tasks list
 * --status <value>`. The shared `readTaskStatusFilter` is
 * deliberately lenient (it silently falls back to `"open"` so
 * the MCP tool tolerates an LLM that omits / mistypes the
 * field). On the CLI a typo is a real user error — surface it
 * with the same closest-match hint used elsewhere instead of
 * pretending the filter worked.
 */
const TASK_STATUS_VALUES = ["open", "done", "all"] as const;

function assertTaskStatusInput(raw: string): void {
  const trimmed = raw.trim().toLowerCase();
  if (TASK_STATUS_VALUES.includes(trimmed as (typeof TASK_STATUS_VALUES)[number])) {
    return;
  }
  const suggestion = closestCommandName(trimmed, TASK_STATUS_VALUES);
  const hint = suggestion ? ` — did you mean '${suggestion}'?` : "";
  throw new Error(`--status must be one of: ${TASK_STATUS_VALUES.join(", ")} (got '${raw}')${hint}`);
}

export interface TasksCommandHelpers {
  readonly apiRequest: (
    io: ProgramIO,
    command: Command,
    path: string,
    body?: Record<string, unknown>,
    method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"
  ) => Promise<unknown>;
  readonly writeOutput: (io: ProgramIO, value: unknown, textField?: string) => void;
}

interface SharedOptions {
  readonly local?: boolean;
  readonly json?: boolean;
}

function localTasksFile(): string {
  return resolveTasksFile(process.env as Record<string, string | undefined>);
}

export function registerTasksCommands(program: Command, io: ProgramIO, helpers: TasksCommandHelpers): void {
  const tasks = program.command("tasks").description("Personal todo list");

  tasks
    .command("providers")
    .description("List configured tasks backends")
    .option("--json", "Print the raw API response instead of the formatted list")
    .action(async (options: { readonly json?: boolean }, command) => {
      const result = await helpers.apiRequest(io, command, "/api/tasks/providers");
      if (options.json) {
        helpers.writeOutput(io, result);
        return;
      }
      const providers = (result as { providers?: Parameters<typeof formatProvidersList>[1] })?.providers ?? [];
      io.stdout(formatProvidersList("Tasks providers", providers));
    });

  tasks
    .command("list")
    .description("List tasks newest-first, filter by status (--local skips the API)")
    .option("--status <status>", "Status filter: open (default), done, or all", "open")
    .option("--search <text>", "Only tasks whose title or notes contains this text (case-insensitive)")
    .option("--local", "Read directly from the local tasks file instead of the API")
    .option("--json", "Print the raw API response instead of the formatted list")
    .action(async (options: { readonly status: string; readonly search?: string } & SharedOptions, command) => {
      // Throws before dispatch so a typo'd --status doesn't return
      // a silently-wrong "open" list.
      assertTaskStatusInput(options.status);
      type TaskListPayload = { status: string; tasks: readonly Record<string, unknown>[]; total: number };
      const readLocalTasks = async (): Promise<TaskListPayload> => {
        const file = localTasksFile();
        const status = readTaskStatusFilter(options.status);
        const all = await readTasks(file);
        const filtered = all
          .filter((task) => status === "all" || task.status === status)
          .sort(compareTasksByDueDate);
        return { status, tasks: filtered.map(serializeTask), total: filtered.length };
      };
      let payload: TaskListPayload;
      if (options.local) {
        payload = await readLocalTasks();
      } else {
        const path = `/api/tasks?status=${encodeURIComponent(options.status)}`;
        try {
          payload = (await helpers.apiRequest(io, command, path)) as TaskListPayload;
        } catch (cause) {
          if (!isApiUnreachable(cause)) {
            throw cause;
          }
          io.stderr("muse: API not reachable — reading tasks from the local store.\n");
          payload = await readLocalTasks();
        }
      }
      const query = options.search?.trim();
      if (query) {
        const matched = filterTasksBySearch(payload.tasks, query);
        payload = { ...payload, tasks: matched, total: matched.length };
      }
      if (options.json) {
        helpers.writeOutput(io, payload);
        return;
      }
      io.stdout(formatTaskList({
        status: payload.status,
        tasks: payload.tasks as unknown as Parameters<typeof formatTaskList>[0]["tasks"],
        total: payload.total
      }));
    });

  tasks
    .command("add")
    .description("Append a new task (--local skips the API)")
    .argument("<title...>", "Task title (one or more words)")
    .option("--notes <text>", "Free-form notes")
    .option("--tags <list>", "Comma-separated tag list (e.g. work,muse)")
    .option(
      "--due <when>",
      "Due date: ISO-8601 (2026-05-15T18:00Z) or relative phrase ('tomorrow at 6pm', 'in 3 hours', 'next Monday')"
    )
    .option("--local", "Write directly to the local tasks file instead of the API")
    .option(
      "--urgent",
      "Mark as urgent: proactive watcher fires this task even during routine_active_hours-derived quiet hours"
    )
    .option("--json", "Print the raw response instead of a short confirmation")
    .action(async (
      titleParts: readonly string[],
      options: { readonly notes?: string; readonly tags?: string; readonly due?: string; readonly urgent?: boolean } & SharedOptions,
      command
    ) => {
      const title = titleParts.join(" ").trim();
      if (title.length === 0) {
        throw new Error("title is required");
      }
      const tags = options.tags
        ? options.tags.split(",").map((tag) => tag.trim()).filter((tag) => tag.length > 0)
        : undefined;

      // Validate `--due` before dispatch in BOTH modes: the
      // `/api/tasks` route uses the same `parseTaskDueAt` grammar,
      // so a bad `--due` gets the identical actionable error
      // whether or not `--local` is set — no degraded API error,
      // no wasted round-trip on input the server would only reject.
      let resolvedDueAt: string | undefined;
      if (options.due && options.due.trim().length > 0) {
        const parsed = parseTaskDueAt(options.due, () => new Date());
        if (parsed instanceof Error) {
          throw parsed;
        }
        resolvedDueAt = parsed;
      }

      let created: Record<string, unknown>;
      if (options.local) {
        const file = localTasksFile();
        const persisted: PersistedTask = {
          createdAt: new Date().toISOString(),
          id: `task_${randomUUID()}`,
          status: "open",
          title,
          ...(options.notes && options.notes.length > 0 ? { notes: options.notes } : {}),
          ...(tags && tags.length > 0 ? { tags } : {}),
          ...(resolvedDueAt ? { dueAt: resolvedDueAt } : {}),
          ...(options.urgent === true ? { urgent: true } : {})
        };
        const existing = await readTasks(file);
        await writeTasks(file, [...existing, persisted]);
        created = serializeTask(persisted);
      } else {
        const body: Record<string, unknown> = { title };
        if (options.notes && options.notes.length > 0) {
          body.notes = options.notes;
        }
        if (tags && tags.length > 0) {
          body.tags = tags;
        }
        if (options.due && options.due.trim().length > 0) {
          body.dueAt = options.due.trim();
        }
        created = (await helpers.apiRequest(io, command, "/api/tasks", body, "POST")) as Record<string, unknown>;
      }
      if (options.json) {
        helpers.writeOutput(io, created);
        return;
      }
      io.stdout(formatTaskAdded(created as unknown as Parameters<typeof formatTaskAdded>[0]));
    });

  tasks
    .command("complete")
    .description("Mark a task done (--local skips the API)")
    .argument("<id>", "Task id")
    .option("--local", "Update the local tasks file instead of calling the API")
    .option("--json", "Print the raw response instead of a short confirmation")
    .action(async (id: string, options: SharedOptions, command) => {
      let completed: Record<string, unknown>;
      if (options.local) {
        const file = localTasksFile();
        const all = await readTasks(file);
        const resolved = resolveLocalTaskId(id, all);
        const index = all.findIndex((task) => task.id === resolved);
        const persisted: PersistedTask = { ...all[index]!, completedAt: new Date().toISOString(), status: "done" };
        const next = [...all];
        next[index] = persisted;
        await writeTasks(file, next);
        completed = serializeTask(persisted);
      } else {
        completed = (await helpers.apiRequest(
          io,
          command,
          `/api/tasks/${encodeURIComponent(id)}/complete`,
          {},
          "POST"
        )) as Record<string, unknown>;
      }
      if (options.json) {
        helpers.writeOutput(io, completed);
        return;
      }
      io.stdout(formatTaskCompleted(completed as unknown as Parameters<typeof formatTaskCompleted>[0]));
    });

  tasks
    .command("edit")
    .description("Update an existing task in place (--local skips the API)")
    .argument("<id>", "Task id (full or short prefix)")
    .option("--title <text...>", "New title")
    .option("--notes <text>", "New free-form notes (pass an empty string to clear)")
    .option("--tags <list>", "New comma-separated tag list (pass an empty string to clear)")
    .option(
      "--due <when>",
      "New due date: ISO-8601 or relative phrase ('tomorrow at 6pm'). Pass 'none' to clear."
    )
    .option("--urgent", "Mark as urgent")
    .option("--no-urgent", "Clear the urgent flag")
    .option("--local", "Update the local tasks file instead of calling the API")
    .option("--json", "Print the raw task instead of a short confirmation")
    .action(async (
      id: string,
      options: {
        readonly title?: string | readonly string[];
        readonly notes?: string;
        readonly tags?: string;
        readonly due?: string;
        readonly urgent?: boolean;
      } & SharedOptions,
      command
    ) => {
      const nextTitle = Array.isArray(options.title)
        ? options.title.join(" ").trim()
        : typeof options.title === "string"
          ? options.title.trim()
          : undefined;
      const updates: Record<string, unknown> = {};
      if (nextTitle && nextTitle.length > 0) {
        updates.title = nextTitle;
      }
      if (options.notes !== undefined) {
        updates.notes = options.notes;
      }
      if (options.tags !== undefined) {
        const split = options.tags.split(",").map((t) => t.trim()).filter((t) => t.length > 0);
        updates.tags = split;
      }
      if (options.due !== undefined) {
        if (options.due.trim().toLowerCase() === "none" || options.due.trim().length === 0) {
          updates.dueAt = null;
        } else {
          const parsed = parseTaskDueAt(options.due, () => new Date());
          if (parsed instanceof Error) {
            throw parsed;
          }
          updates.dueAt = parsed;
        }
      }
      if (typeof options.urgent === "boolean") {
        updates.urgent = options.urgent;
      }
      if (Object.keys(updates).length === 0) {
        io.stderr("muse tasks edit needs at least one of --title/--notes/--tags/--due/--urgent/--no-urgent\n");
        process.exitCode = 1;
        return;
      }

      let updated: Record<string, unknown>;
      if (options.local) {
        const file = localTasksFile();
        const all = await readTasks(file);
        const resolved = resolveLocalTaskId(id, all);
        const index = all.findIndex((task) => task.id === resolved);
        if (index === -1) {
          io.stderr(`Task ${id} not found\n`);
          process.exitCode = 1;
          return;
        }
        const existing = all[index]!;
        const patched: PersistedTask = {
          ...existing,
          ...(typeof updates.title === "string" ? { title: updates.title } : {}),
          ...(typeof updates.notes === "string"
            ? updates.notes.length > 0 ? { notes: updates.notes } : { }
            : { }),
          ...(Array.isArray(updates.tags)
            ? (updates.tags as readonly string[]).length > 0 ? { tags: updates.tags as readonly string[] } : { }
            : { }),
          ...(typeof updates.dueAt === "string" ? { dueAt: updates.dueAt } : { }),
          ...(typeof updates.urgent === "boolean" ? { urgent: updates.urgent } : { })
        };
        // Clear-out semantics: --notes "" / --tags "" / --due none drop the field.
        const cleared: PersistedTask = {
          ...patched,
          ...(typeof updates.notes === "string" && updates.notes.length === 0 ? { notes: undefined as unknown as string } : {}),
          ...(Array.isArray(updates.tags) && (updates.tags as readonly string[]).length === 0 ? { tags: undefined as unknown as readonly string[] } : {}),
          ...(updates.dueAt === null ? { dueAt: undefined as unknown as string } : {})
        };
        const next = [...all];
        next[index] = cleared;
        await writeTasks(file, next);
        updated = serializeTask(cleared);
      } else {
        updated = (await helpers.apiRequest(
          io,
          command,
          `/api/tasks/${encodeURIComponent(id)}`,
          updates,
          "PATCH"
        )) as Record<string, unknown>;
      }
      if (options.json) {
        helpers.writeOutput(io, updated);
        return;
      }
      io.stdout(`Updated [${String(updated.id).slice(0, 12)}] ${String(updated.title)}\n`);
    });

  tasks
    .command("delete")
    .description("Remove a task (--local skips the API)")
    .argument("<id>", "Task id")
    .option("--local", "Delete from the local tasks file instead of calling the API")
    .action(async (id: string, options: { readonly local?: boolean }, command) => {
      if (options.local) {
        const file = localTasksFile();
        const all = await readTasks(file);
        const resolved = resolveLocalTaskId(id, all);
        const next = all.filter((task) => task.id !== resolved);
        await writeTasks(file, next);
        io.stdout(`Deleted task ${resolved}\n`);
        return;
      }
      await helpers.apiRequest(io, command, `/api/tasks/${encodeURIComponent(id)}`, undefined, "DELETE");
      io.stdout(`Deleted task ${id}\n`);
    });
}

/**
 * Resolve a task id that the user typed against the local store.
 * Accepts both the full uuid and the 12-char prefix the list/add
 * renderers print (e.g. `task_0810976`). When the input is shorter
 * than a full id and not unique, refuse to guess.
 */
/**
 * Filter listed tasks to those whose title or notes contains `query`
 * (case-insensitive) — `muse tasks list --search`. Operates on the
 * serialized task records (title / notes are the searchable text), so
 * it works the same for the local file and the API payload.
 */
export function filterTasksBySearch<T extends { readonly title?: unknown; readonly notes?: unknown }>(
  tasks: readonly T[],
  query: string
): T[] {
  const q = query.trim().toLowerCase();
  if (q.length === 0) {
    return [...tasks];
  }
  return tasks.filter((task) => {
    const title = typeof task.title === "string" ? task.title.toLowerCase() : "";
    const notes = typeof task.notes === "string" ? task.notes.toLowerCase() : "";
    return title.includes(q) || notes.includes(q);
  });
}

export function resolveLocalTaskId(input: string, all: readonly PersistedTask[]): string {
  const exact = all.find((task) => task.id === input);
  if (exact) return exact.id;
  const matches = all.filter((task) => task.id.startsWith(input));
  if (matches.length === 1) {
    return matches[0]!.id;
  }
  if (matches.length === 0) {
    const suggestion = closestCommandName(input.trim(), all.map((t) => t.id));
    const hint = suggestion ? ` — did you mean '${suggestion}'?` : "";
    throw new Error(`task not found: ${input}${hint}`);
  }
  throw new Error(`ambiguous task prefix '${input}' matched ${matches.length.toString()} tasks; use a longer id (full uuid is in the on-disk file or --json output)`);
}
