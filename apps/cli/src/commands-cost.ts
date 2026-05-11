/**
 * `muse cost` command group. Wraps `/api/admin/token-cost/*` so token
 * spend can be inspected from the terminal without curl or the web UI.
 */

import type { Command } from "commander";

import type { ProgramIO } from "./program.js";

export interface CostCommandHelpers {
  readonly apiRequest: (
    io: ProgramIO,
    command: Command,
    path: string,
    body?: Record<string, unknown>,
    method?: "GET" | "POST" | "PUT" | "DELETE"
  ) => Promise<unknown>;
  readonly writeOutput: (io: ProgramIO, value: unknown, textField?: string) => void;
}

export function registerCostCommands(program: Command, io: ProgramIO, helpers: CostCommandHelpers): void {
  const cost = program.command("cost").description("Inspect token-cost usage (daily roll-ups, top spenders, per-run)");

  cost
    .command("daily")
    .description("Per-day token totals + estimated cost across the lookback window")
    .option("--days <n>", "Window length in days (default 7)")
    .action(async (options: { readonly days?: string }, command: Command) => {
      const path = options.days
        ? `/api/admin/token-cost/daily?days=${encodeURIComponent(options.days)}`
        : "/api/admin/token-cost/daily";
      helpers.writeOutput(io, await helpers.apiRequest(io, command, path));
    });

  cost
    .command("top")
    .description("Most expensive runs within the lookback window")
    .option("--days <n>", "Window length in days (default 7)")
    .option("--limit <n>", "Max rows to return (default 20, max 100)")
    .action(async (options: { readonly days?: string; readonly limit?: string }, command: Command) => {
      const params = new URLSearchParams();
      if (options.days) params.set("days", options.days);
      if (options.limit) params.set("limit", options.limit);
      const qs = params.toString();
      const path = qs.length > 0 ? `/api/admin/token-cost/top-expensive?${qs}` : "/api/admin/token-cost/top-expensive";
      helpers.writeOutput(io, await helpers.apiRequest(io, command, path));
    });

  cost
    .command("for")
    .description("Per-step token usage for a specific run (alias: by-session)")
    .argument("<run-id>", "Run ID (matches the token-cost sessionId)")
    .action(async (runId: string, _options, command: Command) => {
      helpers.writeOutput(
        io,
        await helpers.apiRequest(io, command, `/api/admin/token-cost/by-session?runId=${encodeURIComponent(runId)}`)
      );
    });
}
