/**
 * `muse cost` command group. Wraps `/api/admin/token-cost/*` so token
 * spend can be inspected from the terminal without curl or the web UI.
 */

import type { Command } from "commander";

import { aggregateTokenUsage, readLocalTokenUsage, resolveTokenUsageFile, type TokenUsageSummary } from "@muse/autoconfigure";

import type { ProgramIO } from "./program.js";

/** Render a local token-usage summary as a compact text report. Pure + exported
 *  for direct testing (the aggregation already has unit coverage upstream). */
export function formatTokenUsageSummary(summary: TokenUsageSummary): string {
  if (summary.calls === 0) {
    return "No file-backed token usage recorded yet.\nRun `muse ask` / `muse chat` and usage lands in ~/.muse/token-usage.jsonl (no server required).";
  }
  const n = (v: number) => v.toLocaleString("en-US");
  const lines: string[] = [
    `Token usage — ${n(summary.calls)} model call(s), ${n(summary.totalTokens)} tokens` +
      ` (${n(summary.promptTokens)} prompt + ${n(summary.completionTokens)} completion` +
      `${summary.reasoningTokens > 0 ? ` + ${n(summary.reasoningTokens)} reasoning` : ""})` +
      `${summary.estimatedCostUsd > 0 ? ` ≈ $${summary.estimatedCostUsd.toFixed(4)}` : " · $0 (local)"}`
  ];
  if (summary.byModel.length > 0) {
    lines.push("", "By model:");
    for (const m of summary.byModel.slice(0, 10)) lines.push(`  ${m.key} — ${n(m.totalTokens)} tokens, ${n(m.calls)} call(s)`);
  }
  if (summary.byDay.length > 0) {
    lines.push("", "By day:");
    for (const d of summary.byDay.slice(0, 14)) lines.push(`  ${d.key} — ${n(d.totalTokens)} tokens, ${n(d.calls)} call(s)`);
  }
  return lines.join("\n");
}

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
    .command("local")
    .description("File-backed token usage from ~/.muse/token-usage.jsonl — totals + per-model/day, no server required")
    .option("--json", "Emit the raw aggregate as JSON")
    .action(async (options: { readonly json?: boolean }) => {
      const summary = aggregateTokenUsage(await readLocalTokenUsage(resolveTokenUsageFile(process.env)));
      if (options.json) {
        helpers.writeOutput(io, summary);
        return;
      }
      io.stdout(`${formatTokenUsageSummary(summary)}\n`);
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
