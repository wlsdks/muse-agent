/**
 * Pure aggregation helpers for the Reactor-compat admin observability and
 * analytics routes. None take ReactorCompatibilityRouteOptions, none touch
 * DB stores, none have I/O side effects — they consume readonly arrays of
 * AgentRunRecord/ToolCallRecord and return plain JSON envelopes.
 *
 * Wires into:
 *   - admin-observability-compat-routes.ts (tool-calls, users/usage,
 *     conversation-analytics)
 *   - admin-analytics-compat-routes.ts (tenant quality/quota, latency
 *     metrics, slack-activity, tools)
 *   - agent-eval-compat-routes.ts (tools/stats, tools/accuracy)
 */

import type { AgentRunRecord, ToolCallRecord } from "@muse/runtime-state";
import type { LatencyPoint, LatencySummary } from "@muse/observability";
import type { JsonObject } from "@muse/shared";
import { numberField } from "./reactor-compat-routes.js";

export function toolCallRanking(toolCalls: readonly ToolCallRecord[]) {
  const byName = new Map<string, { failures: number; name: string; total: number }>();

  for (const call of toolCalls) {
    const existing = byName.get(call.name) ?? { failures: 0, name: call.name, total: 0 };
    byName.set(call.name, {
      failures: existing.failures + (call.status === "failed" ? 1 : 0),
      name: call.name,
      total: existing.total + 1
    });
  }

  return [...byName.values()].sort((left, right) => right.total - left.total);
}

export function toolOutcomeStats(toolCalls: readonly ToolCallRecord[], server?: string): JsonObject {
  const rows = toolCalls
    .filter((call) => !server || call.name.startsWith(`${server}:`) || call.name.startsWith(`${server}.`))
    .map((call) => ({
      outcome: toolOutcome(call),
      server: call.name.includes(":") ? call.name.split(":")[0] ?? "local" : "local",
      tool: call.name
    }));
  const byOutcome: Record<string, number> = {};
  const byServer: Record<string, number> = {};
  const byTool = new Map<string, { count: number; outcome: string; server: string; tool: string }>();

  for (const row of rows) {
    byOutcome[row.outcome] = (byOutcome[row.outcome] ?? 0) + 1;
    byServer[row.server] = (byServer[row.server] ?? 0) + 1;
    const key = `${row.server}:${row.tool}:${row.outcome}`;
    const existing = byTool.get(key) ?? { count: 0, outcome: row.outcome, server: row.server, tool: row.tool };
    byTool.set(key, { ...existing, count: existing.count + 1 });
  }

  const total = rows.length;
  const ok = byOutcome.ok ?? 0;
  return {
    accuracy: total > 0 ? ok / total : 0,
    byOutcome,
    byServer,
    byTool: [...byTool.values()].sort((left, right) => right.count - left.count).slice(0, 50),
    total
  };
}

export function aggregateFailurePatterns(runs: readonly AgentRunRecord[]): JsonObject {
  const totalFailures = runs.length;
  const byClass = new Map<string, { errorClass: string; count: number; sampleRunIds: string[] }>();
  for (const run of runs) {
    const errorClass = classifyRunError(run.error);
    const entry = byClass.get(errorClass) ?? { count: 0, errorClass, sampleRunIds: [] };
    entry.count += 1;
    if (entry.sampleRunIds.length < 5) {
      entry.sampleRunIds.push(run.id);
    }
    byClass.set(errorClass, entry);
  }
  const ranked = [...byClass.values()].sort((left, right) => right.count - left.count);
  return {
    byClass: ranked,
    totalFailures
  };
}

function classifyRunError(error: string | null | undefined): string {
  if (!error || error.trim().length === 0) {
    return "unknown";
  }
  const normalized = error.toLowerCase();
  if (normalized.includes("timeout")) {
    return "timeout";
  }
  if (normalized.includes("guard")) {
    return "guard_rejection";
  }
  if (normalized.includes("plan_validation_failed")) {
    return "plan_validation_failed";
  }
  if (normalized.includes("plan_all_steps_failed")) {
    return "plan_all_steps_failed";
  }
  if (normalized.includes("response_synthesis_failed")) {
    return "response_synthesis_failed";
  }
  if (normalized.includes("plan_generation_failed")) {
    return "plan_generation_failed";
  }
  if (normalized.includes("rate") && normalized.includes("limit")) {
    return "rate_limit";
  }
  if (normalized.includes("auth") || normalized.includes("unauthorized")) {
    return "auth";
  }
  if (normalized.includes("not found") || normalized.includes("not_found")) {
    return "not_found";
  }
  return "other";
}

function toolOutcome(toolCall: ToolCallRecord): string {
  if (toolCall.status === "completed") {
    return "ok";
  }

  if (toolCall.status === "blocked") {
    return "invalid_arg";
  }

  const error = toolCall.error?.toLowerCase() ?? "";
  if (error.includes("timeout")) {
    return "timeout";
  }
  if (error.includes("not found") || error.includes("not_found") || error.includes("404")) {
    return "not_found";
  }
  return "error";
}

export function dailyUsage(runs: readonly AgentRunRecord[]) {
  const byDay = new Map<string, { costUsd: number; date: string; runs: number }>();

  for (const run of runs) {
    const date = run.createdAt.toISOString().slice(0, 10);
    const existing = byDay.get(date) ?? { costUsd: 0, date, runs: 0 };
    byDay.set(date, {
      costUsd: existing.costUsd + Number(run.costUsd),
      date,
      runs: existing.runs + 1
    });
  }

  return [...byDay.values()].sort((left, right) => left.date.localeCompare(right.date));
}

export function latencyDistribution(runs: readonly AgentRunRecord[]) {
  const buckets = { "0-1s": 0, "1-5s": 0, "5-30s": 0, "30s+": 0, unknown: 0 };

  for (const run of runs) {
    if (!run.startedAt || !run.completedAt) {
      buckets.unknown += 1;
      continue;
    }

    const latencyMs = run.completedAt.getTime() - run.startedAt.getTime();

    if (latencyMs < 1_000) {
      buckets["0-1s"] += 1;
    } else if (latencyMs < 5_000) {
      buckets["1-5s"] += 1;
    } else if (latencyMs < 30_000) {
      buckets["5-30s"] += 1;
    } else {
      buckets["30s+"] += 1;
    }
  }

  return buckets;
}

export function latencyWindowStart(days: number): Date {
  const start = new Date();
  start.setUTCDate(start.getUTCDate() - days);
  return start;
}

export function latencySummaryFromQuery(summary: LatencySummary): JsonObject {
  return {
    count: summary.count,
    p50Ms: summary.p50Ms,
    p95Ms: summary.p95Ms,
    p99Ms: summary.p99Ms
  };
}

export function latencyTimeseriesFromQuery(points: readonly LatencyPoint[]): readonly JsonObject[] {
  return points.map((point) => ({
    avgLatencyMs: point.avgMs,
    count: point.count,
    date: point.bucketStart.toISOString().slice(0, 10)
  }));
}

export function latencySummary(runs: readonly AgentRunRecord[], days: number): JsonObject {
  const latencies = runsInLastDays(runs, days).map(runLatencyMs).filter((value): value is number => value !== undefined);
  return {
    count: latencies.length,
    p50Ms: percentile(latencies, 0.5),
    p95Ms: percentile(latencies, 0.95),
    p99Ms: percentile(latencies, 0.99)
  };
}

export function latencyTimeseries(runs: readonly AgentRunRecord[], days: number): readonly JsonObject[] {
  const byDay = new Map<string, { count: number; date: string; totalMs: number }>();

  for (const run of runsInLastDays(runs, days)) {
    const latencyMs = runLatencyMs(run);

    if (latencyMs === undefined) {
      continue;
    }

    const date = run.createdAt.toISOString().slice(0, 10);
    const existing = byDay.get(date) ?? { count: 0, date, totalMs: 0 };
    byDay.set(date, { count: existing.count + 1, date, totalMs: existing.totalMs + latencyMs });
  }

  return [...byDay.values()].map((row) => ({
    avgLatencyMs: row.count > 0 ? row.totalMs / row.count : 0,
    count: row.count,
    date: row.date
  }));
}

function runLatencyMs(run: AgentRunRecord): number | undefined {
  return run.startedAt && run.completedAt
    ? Math.max(0, run.completedAt.getTime() - run.startedAt.getTime())
    : undefined;
}

function runsInLastDays(runs: readonly AgentRunRecord[], days: number): readonly AgentRunRecord[] {
  const cutoff = Date.now() - Math.min(90, Math.max(1, days)) * 86_400_000;
  return runs.filter((run) => run.createdAt.getTime() >= cutoff);
}

function percentile(values: readonly number[], percentileValue: number): number {
  if (values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * percentileValue));
  return sorted[index] ?? 0;
}
