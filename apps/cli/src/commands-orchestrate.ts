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

import { closestCommandName } from "./closest-command.js";
import { parseBoundedInt } from "./parse-bounded-int.js";
import type { ProgramIO } from "./program.js";

const ORCHESTRATE_MODES: readonly string[] = ["sequential", "parallel", "race"];

// `race` is accepted for wire compat but currently resolves to `sequential`
// (MultiAgentOrchestrator.run) — a single local GPU serializes the workers
// anyway, so "first useful answer wins" concurrency is not real yet. Honest
// > silent: the CLI tells the user what actually happens instead of letting
// them believe they got true concurrency.
const RACE_RESOLVES_TO_SEQUENTIAL_NOTICE =
  "(note: --mode race resolves to sequential on a single local GPU — there is no true concurrent-worker race yet)";

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
    .option("--mode <mode>", "Orchestration mode: sequential | parallel | race (race currently resolves to sequential — single local GPU)", "sequential")
    .option("--workers <ids>", "Comma-separated worker IDs to constrain")
    .option("--max-workers <n>", "Maximum number of workers to engage")
    .option("--model <model>", "Model name override")
    .option(
      "--tiered",
      "Run each worker on a fast or high-capability local model chosen from its role (lookup → fast, reasoning → heavy). Tier models come from MUSE_FAST_MODEL / MUSE_HEAVY_MODEL on the server (each defaults to the run model). Off by default."
    )
    .action(async (
      messageParts: readonly string[],
      options: { readonly maxWorkers?: string; readonly mode: string; readonly model?: string; readonly workers?: string; readonly tiered?: boolean },
      command
    ) => {
      const message = messageParts.join(" ").trim();
      if (message.length === 0) {
        throw new Error("orchestrate run requires a non-empty message");
      }
      // Normalize before the includes-check so `--mode SEQUENTIAL`
      // doesn't fall into the typo path; matches the sibling CLI
      // enum gates (--status / --kind / --result). The normalized
      // value also rides into the request body so the server
      // doesn't see mixed casing.
      const mode = options.mode.trim().toLowerCase();
      if (!ORCHESTRATE_MODES.includes(mode)) {
        const suggestion = closestCommandName(mode, ORCHESTRATE_MODES);
        const hint = suggestion ? ` — did you mean '${suggestion}'?` : "";
        throw new Error(`--mode must be 'sequential', 'parallel', or 'race' (got '${options.mode}')${hint}`);
      }
      if (mode === "race") {
        io.stderr(`${RACE_RESOLVES_TO_SEQUENTIAL_NOTICE}\n`);
      }
      const workerIds = options.workers
        ? options.workers.split(",").map((id) => id.trim()).filter((id) => id.length > 0)
        : undefined;
      const maxWorkers = options.maxWorkers === undefined
        ? undefined
        : parseBoundedInt(options.maxWorkers, "--max-workers", 1, 64, 1);
      writeOutput(io, await apiRequest(io, command, "/api/multi-agent/orchestrate", {
        message,
        mode,
        ...(options.model ? { model: options.model } : {}),
        ...(workerIds && workerIds.length > 0 ? { workerIds } : {}),
        ...(maxWorkers !== undefined ? { maxWorkers } : {}),
        ...(options.tiered ? { tiered: true } : {})
      }));
    });

  orchestrate
    .command("list")
    .description("GET /api/multi-agent/orchestrations — recent orchestration history")
    .option("--limit <n>", "Maximum entries to return")
    .action(async (options: { readonly limit?: string }, command) => {
      const limit = options.limit === undefined
        ? undefined
        : parseBoundedInt(options.limit, "--limit", 1, 500, 20);
      const path = limit !== undefined
        ? `/api/multi-agent/orchestrations?limit=${limit.toString()}`
        : "/api/multi-agent/orchestrations";
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
