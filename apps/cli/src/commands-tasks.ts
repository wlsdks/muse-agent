/**
 * `muse tasks` command group.
 *
 * Wraps `/api/tasks/*`:
 *   - `muse tasks list [--status open|done|all]` — newest-first
 *   - `muse tasks add <title...> [--notes <text>] [--tags <a,b>]` — new task
 *   - `muse tasks complete <id>` — mark done
 *   - `muse tasks delete <id>` — remove
 *
 * Same DI injection pattern as the prior CLI groups (scheduler /
 * orchestrate / mcp / specs / config / auth / voice / memory /
 * calendar). Personal-domain trio CLI: calendar (round 109),
 * tasks (this iter), notes (still agent-only).
 */

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
    .description("GET /api/tasks — list tasks newest-first, filter by status")
    .option("--status <status>", "Status filter: open (default), done, or all", "open")
    .action(async (options: { readonly status: string }, command) => {
      const path = `/api/tasks?status=${encodeURIComponent(options.status)}`;
      helpers.writeOutput(io, await helpers.apiRequest(io, command, path));
    });

  tasks
    .command("add")
    .description("POST /api/tasks — append a new task")
    .argument("<title...>", "Task title (one or more words)")
    .option("--notes <text>", "Free-form notes")
    .option("--tags <list>", "Comma-separated tag list (e.g. work,muse)")
    .action(async (
      titleParts: readonly string[],
      options: { readonly notes?: string; readonly tags?: string },
      command
    ) => {
      const title = titleParts.join(" ").trim();
      if (title.length === 0) {
        throw new Error("title is required");
      }
      const body: Record<string, unknown> = { title };
      if (options.notes && options.notes.length > 0) {
        body.notes = options.notes;
      }
      if (options.tags && options.tags.length > 0) {
        body.tags = options.tags
          .split(",")
          .map((tag) => tag.trim())
          .filter((tag) => tag.length > 0);
      }
      helpers.writeOutput(io, await helpers.apiRequest(io, command, "/api/tasks", body, "POST"));
    });

  tasks
    .command("complete")
    .description("POST /api/tasks/:id/complete — mark a task done")
    .argument("<id>", "Task id")
    .action(async (id: string, _options, command) => {
      helpers.writeOutput(
        io,
        await helpers.apiRequest(io, command, `/api/tasks/${encodeURIComponent(id)}/complete`, {}, "POST")
      );
    });

  tasks
    .command("delete")
    .description("DELETE /api/tasks/:id — remove a task")
    .argument("<id>", "Task id")
    .action(async (id: string, _options, command) => {
      await helpers.apiRequest(io, command, `/api/tasks/${encodeURIComponent(id)}`, undefined, "DELETE");
      io.stdout(`Deleted task ${id}\n`);
    });
}
