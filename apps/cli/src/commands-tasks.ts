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

import {
  formatProvidersList,
  formatTaskAdded,
  formatTaskCompleted,
  formatTaskList
} from "./human-formatters.js";
import type { ProgramIO } from "./program.js";

export interface TasksCommandHelpers {
  readonly apiRequest: (
    io: ProgramIO,
    command: Command,
    path: string,
    body?: Record<string, unknown>,
    method?: "GET" | "POST" | "PUT" | "DELETE"
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
    .option("--local", "Read directly from the local tasks file instead of the API")
    .option("--json", "Print the raw API response instead of the formatted list")
    .action(async (options: { readonly status: string } & SharedOptions, command) => {
      let payload: { status: string; tasks: readonly Record<string, unknown>[]; total: number };
      if (options.local) {
        const file = localTasksFile();
        const status = readTaskStatusFilter(options.status);
        const all = await readTasks(file);
        const filtered = all
          .filter((task) => status === "all" || task.status === status)
          .sort(compareTasksByDueDate);
        payload = { status, tasks: filtered.map(serializeTask), total: filtered.length };
      } else {
        const path = `/api/tasks?status=${encodeURIComponent(options.status)}`;
        payload = (await helpers.apiRequest(io, command, path)) as typeof payload;
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

      let created: Record<string, unknown>;
      if (options.local) {
        const file = localTasksFile();
        let dueAt: string | undefined;
        if (options.due && options.due.trim().length > 0) {
          const parsed = parseTaskDueAt(options.due, () => new Date());
          if (parsed instanceof Error) {
            throw parsed;
          }
          dueAt = parsed;
        }
        const persisted: PersistedTask = {
          createdAt: new Date().toISOString(),
          id: `task_${randomUUID()}`,
          status: "open",
          title,
          ...(options.notes && options.notes.length > 0 ? { notes: options.notes } : {}),
          ...(tags && tags.length > 0 ? { tags } : {}),
          ...(dueAt ? { dueAt } : {}),
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
function resolveLocalTaskId(input: string, all: readonly PersistedTask[]): string {
  const exact = all.find((task) => task.id === input);
  if (exact) return exact.id;
  const matches = all.filter((task) => task.id.startsWith(input));
  if (matches.length === 1) {
    return matches[0]!.id;
  }
  if (matches.length === 0) {
    throw new Error(`task not found: ${input}`);
  }
  throw new Error(`ambiguous task prefix '${input}' matched ${matches.length.toString()} tasks; use a longer id (full uuid is in the on-disk file or --json output)`);
}
