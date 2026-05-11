/**
 * `muse latency` command group. Wraps `/api/admin/metrics/latency/*`
 * so latency rollups and per-bucket timeseries can be inspected from
 * the terminal.
 */

import type { Command } from "commander";

import type { ProgramIO } from "./program.js";

export interface LatencyCommandHelpers {
  readonly apiRequest: (
    io: ProgramIO,
    command: Command,
    path: string,
    body?: Record<string, unknown>,
    method?: "GET" | "POST" | "PUT" | "DELETE"
  ) => Promise<unknown>;
  readonly writeOutput: (io: ProgramIO, value: unknown, textField?: string) => void;
}

export function registerLatencyCommands(program: Command, io: ProgramIO, helpers: LatencyCommandHelpers): void {
  const latency = program.command("latency").description("Inspect latency metrics (summary + timeseries)");

  latency
    .command("summary")
    .description("Roll-up latency percentiles across the lookback window")
    .option("--days <n>", "Window length in days (default 7)")
    .action(async (options: { readonly days?: string }, command: Command) => {
      const path = options.days
        ? `/api/admin/metrics/latency/summary?days=${encodeURIComponent(options.days)}`
        : "/api/admin/metrics/latency/summary";
      helpers.writeOutput(io, await helpers.apiRequest(io, command, path));
    });

  latency
    .command("timeseries")
    .description("Latency timeseries bucketed by day")
    .option("--days <n>", "Window length in days (default 7)")
    .action(async (options: { readonly days?: string }, command: Command) => {
      const path = options.days
        ? `/api/admin/metrics/latency/timeseries?days=${encodeURIComponent(options.days)}`
        : "/api/admin/metrics/latency/timeseries";
      helpers.writeOutput(io, await helpers.apiRequest(io, command, path));
    });
}
