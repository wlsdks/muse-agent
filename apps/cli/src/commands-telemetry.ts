/**
 * `muse telemetry` command group.
 *
 * Closes the read loop: the runtime's `InMemoryTelemetryAggregator`
 * was wired into autoconfigure and exposed via `/admin/telemetry/summary`
 * and `/admin/telemetry/recent`, but the user had no way to ASK for the
 * data — they'd have to know the endpoint and curl it. This module
 * adds two CLI subcommands that hit those endpoints and pretty-print
 * the result so the operator can answer "how often did inbox surface
 * in the last 24h?" / "what's my average run latency?" without leaving
 * the terminal.
 *
 * Subcommands:
 *   - `muse telemetry summary [--since-ms <ms>] [--json]`
 *   - `muse telemetry recent  [--limit N] [--since-ms <ms>] [--json]`
 *
 * Both work against the same `--api-url` / `--token` flags the other
 * API-backed CLI commands honour.
 */

import type { Command } from "commander";

import type { ProgramIO } from "./program.js";

export interface TelemetryHelpers {
  readonly apiRequest: (
    io: ProgramIO,
    command: Command,
    path: string,
    body?: Record<string, unknown>,
    method?: "GET" | "POST"
  ) => Promise<unknown>;
  readonly writeOutput: (io: ProgramIO, value: unknown, textField?: string) => void;
}

interface SummaryResponse {
  readonly enabled: boolean;
  readonly summary?: {
    readonly windowStartMs: number;
    readonly windowEndMs: number;
    readonly totalRuns: number;
    readonly flagCounts: Readonly<Record<string, number>>;
    readonly counterAverages: Readonly<Record<string, number>>;
    readonly budgetAverages: Readonly<Record<string, number>>;
    readonly tokenTotals: {
      readonly input: number;
      readonly output: number;
      readonly cachedInput: number;
    };
    readonly latency?: {
      readonly count: number;
      readonly averageMs: number;
      readonly maxMs: number;
      readonly p95Ms: number;
    };
  };
}

interface RecentResponse {
  readonly enabled: boolean;
  readonly events: readonly Readonly<{
    runId: string;
    model: string;
    providerId: string;
    recordedAtMs: number;
    latencyMs?: number;
    inputTokens?: number;
    outputTokens?: number;
  }>[];
}

export function formatRecordedAtIso(ms: number): string {
  if (typeof ms !== "number") return "(invalid)";
  const date = new Date(ms);
  if (!Number.isFinite(date.getTime())) return "(invalid)";
  return date.toISOString();
}

export function parseTelemetryLimit(raw: string | undefined, fallback = 10): number {
  if (raw === undefined || raw.trim().length === 0) return fallback;
  const parsed = Number(raw.trim());
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error(`--limit must be an integer >= 1 (got '${raw}')`);
  }
  return Math.min(500, Math.trunc(parsed));
}

export function parseTelemetrySinceMs(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim().length === 0) return undefined;
  const parsed = Number(raw.trim());
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`--since-ms must be a non-negative integer (got '${raw}')`);
  }
  return Math.trunc(parsed);
}

export function registerTelemetryCommands(program: Command, io: ProgramIO, helpers: TelemetryHelpers): void {
  const telemetry = program.command("telemetry").description("Inspect runtime telemetry (ctx flags / token totals / latency)");

  telemetry
    .command("summary")
    .description("Show rolled-up telemetry over a window (default 7 days)")
    .option("--since-ms <ms>", "Window lower bound (UNIX ms timestamp)")
    .option("--json", "Print machine-readable JSON")
    .action(async (options: { readonly sinceMs?: string; readonly json?: boolean }, command: Command) => {
      const sinceMs = parseTelemetrySinceMs(options.sinceMs);
      const query = sinceMs !== undefined ? `?sinceMs=${sinceMs.toString()}` : "";
      const response = await helpers.apiRequest(io, command, `/admin/telemetry/summary${query}`) as SummaryResponse;
      if (options.json) {
        helpers.writeOutput(io, response);
        return;
      }
      renderSummary(io, response);
    });

  telemetry
    .command("recent")
    .description("Show the last N raw telemetry events")
    .option("--limit <n>", "Max events to return (default 10)", "10")
    .option("--since-ms <ms>", "Lower bound (UNIX ms timestamp)")
    .option("--json", "Print machine-readable JSON")
    .action(async (
      options: { readonly limit?: string; readonly sinceMs?: string; readonly json?: boolean },
      command: Command
    ) => {
      const limit = parseTelemetryLimit(options.limit);
      const sinceMs = parseTelemetrySinceMs(options.sinceMs);
      const params = new URLSearchParams();
      params.set("limit", limit.toString());
      if (sinceMs !== undefined) {
        params.set("sinceMs", sinceMs.toString());
      }
      const qs = params.toString();
      const path = qs.length > 0 ? `/admin/telemetry/recent?${qs}` : "/admin/telemetry/recent";
      const response = await helpers.apiRequest(io, command, path) as RecentResponse;
      if (options.json) {
        helpers.writeOutput(io, response);
        return;
      }
      renderRecent(io, response);
    });
}

function renderSummary(io: ProgramIO, response: SummaryResponse): void {
  if (!response.enabled) {
    io.stdout("Telemetry aggregator is disabled (MUSE_TELEMETRY_AGGREGATOR_ENABLED=false).\n");
    return;
  }
  const summary = response.summary;
  if (!summary) {
    io.stdout("Telemetry enabled but no summary returned.\n");
    return;
  }
  const windowStart = formatRecordedAtIso(summary.windowStartMs);
  const windowEnd = formatRecordedAtIso(summary.windowEndMs);
  io.stdout(`Window: ${windowStart} → ${windowEnd}\n`);
  io.stdout(`Total runs: ${summary.totalRuns.toString()}\n`);
  if (summary.latency && summary.latency.count > 0) {
    io.stdout(`Latency (n=${summary.latency.count.toString()}):\n`);
    io.stdout(`  average: ${summary.latency.averageMs.toFixed(0)} ms\n`);
    io.stdout(`  p95:     ${summary.latency.p95Ms.toFixed(0)} ms\n`);
    io.stdout(`  max:     ${summary.latency.maxMs.toFixed(0)} ms\n`);
  }
  io.stdout(`Tokens: input=${summary.tokenTotals.input.toString()} output=${summary.tokenTotals.output.toString()} cachedInput=${summary.tokenTotals.cachedInput.toString()}\n`);
  const flagKeys = Object.keys(summary.flagCounts).sort();
  if (flagKeys.length > 0) {
    io.stdout("Flag counts:\n");
    for (const key of flagKeys) {
      io.stdout(`  ${key}: ${(summary.flagCounts[key] ?? 0).toString()}\n`);
    }
  }
  const counterKeys = Object.keys(summary.counterAverages).sort();
  if (counterKeys.length > 0) {
    io.stdout("Counter averages:\n");
    for (const key of counterKeys) {
      io.stdout(`  ${key}: ${(summary.counterAverages[key] ?? 0).toFixed(2)}\n`);
    }
  }
  const budgetKeys = Object.keys(summary.budgetAverages).sort();
  if (budgetKeys.length > 0) {
    io.stdout("Budget averages (tokens):\n");
    for (const key of budgetKeys) {
      io.stdout(`  ${key}: ${(summary.budgetAverages[key] ?? 0).toFixed(0)}\n`);
    }
  }
}

function renderRecent(io: ProgramIO, response: RecentResponse): void {
  if (!response.enabled) {
    io.stdout("Telemetry aggregator is disabled.\n");
    return;
  }
  if (response.events.length === 0) {
    io.stdout("(no events in window)\n");
    return;
  }
  for (const event of response.events) {
    const when = formatRecordedAtIso(event.recordedAtMs);
    const latency = event.latencyMs !== undefined ? `${event.latencyMs.toString()}ms` : "?";
    const tokens = `in=${event.inputTokens ?? "?"} out=${event.outputTokens ?? "?"}`;
    io.stdout(`${when}  ${event.providerId}/${event.model}  latency=${latency}  ${tokens}  run=${event.runId}\n`);
  }
}
