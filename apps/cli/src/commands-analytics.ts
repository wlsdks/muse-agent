/**
 * `muse analytics` command group. Wraps the
 * /api/admin/conversation-analytics/* observability surfaces.
 */

import type { Command } from "commander";

import type { ProgramIO } from "./program.js";

export interface AnalyticsCommandHelpers {
  readonly apiRequest: (
    io: ProgramIO,
    command: Command,
    path: string,
    body?: Record<string, unknown>,
    method?: "GET" | "POST" | "PUT" | "DELETE"
  ) => Promise<unknown>;
  readonly writeOutput: (io: ProgramIO, value: unknown, textField?: string) => void;
}

export function registerAnalyticsCommands(program: Command, io: ProgramIO, helpers: AnalyticsCommandHelpers): void {
  const analytics = program.command("analytics").description("Inspect conversation analytics (failure patterns / latency distribution)");

  analytics
    .command("failures")
    .description("Recurring failure patterns across recent conversations")
    .action(async (_options, command: Command) => {
      helpers.writeOutput(io, await helpers.apiRequest(io, command, "/api/admin/conversation-analytics/failure-patterns"));
    });

  analytics
    .command("latency-distribution")
    .description("Latency distribution buckets across conversations")
    .action(async (_options, command: Command) => {
      helpers.writeOutput(io, await helpers.apiRequest(io, command, "/api/admin/conversation-analytics/latency-distribution"));
    });
}
