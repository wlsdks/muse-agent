/**
 * `muse orchestrate` command group, extracted from
 * apps/cli/src/program.ts.
 *
 * Self-contained: only consumes the `apiRequest` / `writeOutput`
 * helpers (passed in as dependencies). Wraps the four
 * `/api/multi-agent/orchestrations` endpoints (run / list / get /
 * stats) in commander argument-parsing.
 */

import type { Command } from "commander";

import type { ProgramIO } from "./program.js";

export interface OrchestrateHelpers {
  readonly apiRequest: (
    io: ProgramIO,
    command: Command,
    path: string,
    body?: Record<string, unknown>,
    method?: "GET" | "POST"
  ) => Promise<unknown>;
  readonly writeOutput: (io: ProgramIO, value: unknown, textField?: string) => void;
}

export function registerOrchestrateCommands(program: Command, io: ProgramIO, helpers: OrchestrateHelpers): void {
  const { apiRequest, writeOutput } = helpers;
  const orchestrate = program.command("orchestrate").description("Drive multi-agent orchestration runs and inspect history");

  orchestrate
    .command("run")
    .description("POST /api/multi-agent/orchestrate — run a multi-agent orchestration")
    .argument("<message...>", "User prompt to dispatch")
    .option("--mode <mode>", "Orchestration mode: sequential | parallel | race", "sequential")
    .option("--workers <ids>", "Comma-separated worker IDs to constrain")
    .option("--max-workers <n>", "Maximum number of workers to engage")
    .option("--model <model>", "Model name override")
    .action(async (
      messageParts: readonly string[],
      options: { readonly maxWorkers?: string; readonly mode: string; readonly model?: string; readonly workers?: string },
      command
    ) => {
      const message = messageParts.join(" ").trim();
      if (message.length === 0) {
        throw new Error("orchestrate run requires a non-empty message");
      }
      if (!["sequential", "parallel", "race"].includes(options.mode)) {
        throw new Error(`--mode must be 'sequential', 'parallel', or 'race' (got '${options.mode}')`);
      }
      const workerIds = options.workers
        ? options.workers.split(",").map((id) => id.trim()).filter((id) => id.length > 0)
        : undefined;
      const maxWorkers = options.maxWorkers === undefined ? undefined : Number.parseInt(options.maxWorkers, 10);
      if (maxWorkers !== undefined && (!Number.isInteger(maxWorkers) || maxWorkers <= 0)) {
        throw new Error("--max-workers must be a positive integer");
      }
      writeOutput(io, await apiRequest(io, command, "/api/multi-agent/orchestrate", {
        message,
        mode: options.mode,
        ...(options.model ? { model: options.model } : {}),
        ...(workerIds ? { workerIds } : {}),
        ...(maxWorkers !== undefined ? { maxWorkers } : {})
      }));
    });

  orchestrate
    .command("list")
    .description("GET /api/multi-agent/orchestrations — recent orchestration history")
    .option("--limit <n>", "Maximum entries to return")
    .action(async (options: { readonly limit?: string }, command) => {
      const path = options.limit ? `/api/multi-agent/orchestrations?limit=${encodeURIComponent(options.limit)}` : "/api/multi-agent/orchestrations";
      writeOutput(io, await apiRequest(io, command, path));
    });

  orchestrate
    .command("get")
    .description("GET /api/multi-agent/orchestrations/:runId — single orchestration with conversation")
    .argument("<runId>", "Orchestration run ID")
    .action(async (runId: string, _options, command) => {
      writeOutput(io, await apiRequest(io, command, `/api/multi-agent/orchestrations/${encodeURIComponent(runId)}`));
    });

  orchestrate
    .command("stats")
    .description("GET /api/multi-agent/orchestrations/stats — totals, durations, per-mode runs")
    .action(async (_options, command) => {
      writeOutput(io, await apiRequest(io, command, "/api/multi-agent/orchestrations/stats"));
    });
}
