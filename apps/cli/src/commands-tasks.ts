/**
 * `muse tasks` command group.
 *
 * Wraps `/api/tasks/*` for remote mode and the shared
 * `@muse/mcp/personal-tasks-store` helpers for `--local` mode so the
 * CLI works without an API server. Both surfaces speak the same
 * on-disk format, so a `--local` write is visible to the API on the
 * next request and vice versa.
 */

import { randomUUID } from "node:crypto";

import { resolveTasksFile } from "@muse/autoconfigure";
import {
  parseTaskDueAt,
  readTasks,
  readTaskStatusFilter,
  serializeTask,
  writeTasks,
  type PersistedTask
} from "@muse/mcp";
import type { Command } from "commander";

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

interface LocalOption {
  readonly local?: boolean;
}

function localTasksFile(): string {
  return resolveTasksFile(process.env as Record<string, string | undefined>);
}

export function registerTasksCommands(program: Command, io: ProgramIO, helpers: TasksCommandHelpers): void {
  const tasks = program.command("tasks").description("Personal todo list");

  tasks
    .command("providers")
    .description("GET /api/tasks/providers — list configured tasks backends")
    .action(async (_options, command) => {
      helpers.writeOutput(io, await helpers.apiRequest(io, command, "/api/tasks/providers"));
    });

  tasks
    .command("list")
    .description("List tasks newest-first, filter by status (--local skips the API)")
    .option("--status <status>", "Status filter: open (default), done, or all", "open")
    .option("--local", "Read directly from the local tasks file instead of the API")
    .action(async (options: { readonly status: string } & LocalOption, command) => {
      if (options.local) {
        const file = localTasksFile();
        const status = readTaskStatusFilter(options.status);
        const all = await readTasks(file);
        const filtered = all
          .filter((task) => status === "all" || task.status === status)
          .sort((left, right) => (right.createdAt ?? "").localeCompare(left.createdAt ?? ""));
        helpers.writeOutput(io, { status, tasks: filtered.map(serializeTask), total: filtered.length });
        return;
      }
      const path = `/api/tasks?status=${encodeURIComponent(options.status)}`;
      helpers.writeOutput(io, await helpers.apiRequest(io, command, path));
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
    .action(async (
      titleParts: readonly string[],
      options: { readonly notes?: string; readonly tags?: string; readonly due?: string } & LocalOption,
      command
    ) => {
      const title = titleParts.join(" ").trim();
      if (title.length === 0) {
        throw new Error("title is required");
      }
      const tags = options.tags
        ? options.tags.split(",").map((tag) => tag.trim()).filter((tag) => tag.length > 0)
        : undefined;

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
        const created: PersistedTask = {
          createdAt: new Date().toISOString(),
          id: `task_${randomUUID()}`,
          status: "open",
          title,
          ...(options.notes && options.notes.length > 0 ? { notes: options.notes } : {}),
          ...(tags && tags.length > 0 ? { tags } : {}),
          ...(dueAt ? { dueAt } : {})
        };
        const existing = await readTasks(file);
        await writeTasks(file, [...existing, created]);
        helpers.writeOutput(io, serializeTask(created));
        return;
      }

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
      helpers.writeOutput(io, await helpers.apiRequest(io, command, "/api/tasks", body, "POST"));
    });

  tasks
    .command("complete")
    .description("Mark a task done (--local skips the API)")
    .argument("<id>", "Task id")
    .option("--local", "Update the local tasks file instead of calling the API")
    .action(async (id: string, options: LocalOption, command) => {
      if (options.local) {
        const file = localTasksFile();
        const all = await readTasks(file);
        const index = all.findIndex((task) => task.id === id);
        if (index < 0) {
          throw new Error(`task not found: ${id}`);
        }
        const completed: PersistedTask = { ...all[index]!, completedAt: new Date().toISOString(), status: "done" };
        const next = [...all];
        next[index] = completed;
        await writeTasks(file, next);
        helpers.writeOutput(io, serializeTask(completed));
        return;
      }
      helpers.writeOutput(
        io,
        await helpers.apiRequest(io, command, `/api/tasks/${encodeURIComponent(id)}/complete`, {}, "POST")
      );
    });

  tasks
    .command("delete")
    .description("Remove a task (--local skips the API)")
    .argument("<id>", "Task id")
    .option("--local", "Delete from the local tasks file instead of calling the API")
    .action(async (id: string, options: LocalOption, command) => {
      if (options.local) {
        const file = localTasksFile();
        const all = await readTasks(file);
        const next = all.filter((task) => task.id !== id);
        if (next.length === all.length) {
          throw new Error(`task not found: ${id}`);
        }
        await writeTasks(file, next);
        io.stdout(`Deleted task ${id}\n`);
        return;
      }
      await helpers.apiRequest(io, command, `/api/tasks/${encodeURIComponent(id)}`, undefined, "DELETE");
      io.stdout(`Deleted task ${id}\n`);
    });
}
