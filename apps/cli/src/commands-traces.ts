/**
 * `muse traces` command group. Wraps `/api/admin/traces` (list of
 * trace events) and `/api/admin/traces/:traceId/spans` (per-trace
 * span filter) so trace inspection is reachable from the terminal.
 */

import type { Command } from "commander";

import type { ProgramIO } from "./program.js";

export interface TracesCommandHelpers {
  readonly apiRequest: (
    io: ProgramIO,
    command: Command,
    path: string,
    body?: Record<string, unknown>,
    method?: "GET" | "POST" | "PUT" | "DELETE"
  ) => Promise<unknown>;
  readonly writeOutput: (io: ProgramIO, value: unknown, textField?: string) => void;
}

export function registerTracesCommands(program: Command, io: ProgramIO, helpers: TracesCommandHelpers): void {
  const traces = program.command("traces").description("Inspect recorded trace events / spans");

  traces
    .command("list")
    .description("All recorded trace events (or recorded spans when the trace sink is empty)")
    .action(async (_options, command: Command) => {
      helpers.writeOutput(io, await helpers.apiRequest(io, command, "/api/admin/traces"));
    });

  traces
    .command("spans")
    .description("Spans associated with a specific trace id or run id")
    .argument("<trace-id>", "Trace id (or run id) to filter on")
    .action(async (traceId: string, _options, command: Command) => {
      helpers.writeOutput(
        io,
        await helpers.apiRequest(io, command, `/api/admin/traces/${encodeURIComponent(traceId)}/spans`)
      );
    });
}
