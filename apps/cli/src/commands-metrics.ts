/**
 * `muse metrics show` — pretty-print the observability snapshot.
 *
 * Wraps `/api/admin/muse/snapshot` (already exposed
 * by the API server) and renders an at-a-glance view of the
 * SLO / drift / token-cost / budget counters that the runtime
 * tracks. JSON pass-through is available for jq pipelines.
 */

import type { Command } from "commander";

import type { ProgramIO } from "./program.js";

export interface MetricsCommandHelpers {
  readonly apiRequest: (
    io: ProgramIO,
    command: Command,
    path: string,
    body?: Record<string, unknown>,
    method?: "GET" | "POST" | "PUT" | "DELETE"
  ) => Promise<unknown>;
  readonly writeOutput: (io: ProgramIO, value: unknown, textField?: string) => void;
}

function toRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const result: Record<string, unknown> = {};
    for (const [key, nestedValue] of Object.entries(value)) {
      if (typeof key === "string") {
        result[key] = nestedValue;
      }
    }
    return result;
  }
  return undefined;
}

export function registerMetricsCommands(program: Command, io: ProgramIO, helpers: MetricsCommandHelpers): void {
  const metrics = program.command("metrics").description("Observability surfaces (SLO + drift + budget + token cost)");

  metrics
    .command("show")
    .description("At-a-glance snapshot from /api/admin/muse/snapshot")
    .option("--json", "Print the raw payload instead of the formatted summary")
    .action(async (options: { readonly json?: boolean }, command: Command) => {
      const snapshot = await helpers.apiRequest(io, command, "/api/admin/muse/snapshot");
      if (options.json) {
        helpers.writeOutput(io, snapshot);
        return;
      }
      io.stdout(formatMetricsSnapshot(snapshot));
    });
}

/**
 * Pure formatter for the snapshot payload. Exported
 * so the unit test can drive it with a fixture instead of
 * standing up the API server. The renderer is intentionally
 * defensive: unknown / missing fields render as `(none)` rather
 * than throwing, so a partial snapshot still surfaces what's
 * available.
 */
export function formatMetricsSnapshot(snapshot: unknown): string {
  if (!snapshot || typeof snapshot !== "object") {
    return "(empty snapshot — observability is not configured on this server)\n";
  }
  const s = toRecord(snapshot);
  if (!s) {
    return "(empty snapshot — observability is not configured on this server)\n";
  }
  const lines: string[] = [];
  lines.push("Muse metrics:");
  lines.push("");

  // SLO section.
  const slo = readSection(s, "slo");
  if (slo) {
    lines.push("  slo:");
    for (const [key, value] of Object.entries(slo)) {
      lines.push(`    ${key}: ${stringifyValue(value)}`);
    }
    lines.push("");
  }

  // Drift section — typically `{ runs, percent }` per agent.
  const drift = readSection(s, "drift");
  if (drift) {
    lines.push("  drift:");
    for (const [key, value] of Object.entries(drift)) {
      lines.push(`    ${key}: ${stringifyValue(value)}`);
    }
    lines.push("");
  }

  // Token cost rollup.
  const tokens = readSection(s, "tokenCost") ?? readSection(s, "tokens");
  if (tokens) {
    lines.push("  token cost:");
    for (const [key, value] of Object.entries(tokens)) {
      lines.push(`    ${key}: ${stringifyValue(value)}`);
    }
    lines.push("");
  }

  // Budget tracker.
  const budget = readSection(s, "budget");
  if (budget) {
    lines.push("  budget:");
    for (const [key, value] of Object.entries(budget)) {
      lines.push(`    ${key}: ${stringifyValue(value)}`);
    }
    lines.push("");
  }

  // Top-level scalars that didn't match a known section.
  const known = new Set(["slo", "drift", "tokenCost", "tokens", "budget"]);
  const stragglers = Object.entries(s).filter(([key]) => !known.has(key));
  if (stragglers.length > 0) {
    lines.push("  other:");
    for (const [key, value] of stragglers) {
      lines.push(`    ${key}: ${stringifyValue(value)}`);
    }
    lines.push("");
  }

  if (lines.length === 2) {
    // Only the header + blank line — nothing recognised.
    return "(empty snapshot — observability is not configured on this server)\n";
  }
  return lines.join("\n");
}

function readSection(source: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = source[key];
  if (value && typeof value === "object" && !Array.isArray(value)) return toRecord(value);
  return undefined;
}

function stringifyValue(value: unknown): string {
  if (value === null || value === undefined) return "(none)";
  if (typeof value === "number") return value.toString();
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "true" : "false";
  // Compact JSON for arrays + nested objects to keep the table tight.
  return JSON.stringify(value);
}
