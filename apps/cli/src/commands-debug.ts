/**
 * `muse debug` command group. Currently wraps the replay-capture
 * surfaces under /api/admin/debug/replay; future debug-only commands
 * can pile on without expanding the top-level CLI namespace.
 */

import type { Command } from "commander";

import type { ProgramIO } from "./program.js";

export interface DebugCommandHelpers {
  readonly apiRequest: (
    io: ProgramIO,
    command: Command,
    path: string,
    body?: Record<string, unknown>,
    method?: "GET" | "POST" | "PUT" | "DELETE"
  ) => Promise<unknown>;
  readonly writeOutput: (io: ProgramIO, value: unknown, textField?: string) => void;
}

export function registerDebugCommands(program: Command, io: ProgramIO, helpers: DebugCommandHelpers): void {
  const debug = program.command("debug").description("Debugging surfaces (replay captures of failed runs)");

  debug
    .command("replay")
    .description("List recent failed-run replay captures")
    .option("--limit <n>", "Max captures to return (default 50)")
    .action(async (options: { readonly limit?: string }, command: Command) => {
      const path = options.limit
        ? `/api/admin/debug/replay?limit=${encodeURIComponent(options.limit)}`
        : "/api/admin/debug/replay";
      helpers.writeOutput(io, await helpers.apiRequest(io, command, path));
    });

  debug
    .command("replay-show")
    .description("Fetch a single replay capture by id")
    .argument("<id>", "Replay capture id (matches the failed run id)")
    .action(async (id: string, _options, command: Command) => {
      helpers.writeOutput(
        io,
        await helpers.apiRequest(io, command, `/api/admin/debug/replay/${encodeURIComponent(id)}`)
      );
    });
}
