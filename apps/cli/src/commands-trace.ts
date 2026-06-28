/**
 * `muse trace` — local-first run inspector ("time-travel debugging"). Reads the
 * local run-log (.muse/runs/*.jsonl) + per-step checkpoints (.muse/checkpoints) the
 * agent now persists, so you can see — with NO server — WHY a run answered the way
 * it did: the query, the answer, which sources were RETRIEVED at what score, which
 * tools ran, the grounding verdict, and the step-by-step checkpoints. The existing
 * `muse runs` wraps the admin API; this is the local read.
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import type { Command } from "commander";

import { FileCheckpointStore, resolveCheckpointsDir, type MuseEnvironment } from "@muse/autoconfigure";

import type { ProgramIO } from "./program.js";

export interface RunSummary {
  readonly runId: string;
  readonly query: string;
  readonly grounded: string | null;
  readonly success: boolean | null;
  readonly recordedAt: string;
}

export interface RunDetail extends RunSummary {
  readonly answer: string;
  readonly retrieval: readonly { readonly source: string; readonly score: number }[];
  readonly toolsUsed: readonly string[];
}

function asString(v: unknown, fallback = ""): string { return typeof v === "string" ? v : fallback; }

/** Parse the LAST event of a run-log JSONL file into a summary (the final outcome). */
export function parseRunEvent(runId: string, raw: string): RunDetail | undefined {
  const lines = raw.trim().split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0) return undefined;
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(lines[lines.length - 1]!) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const response = (event.response && typeof event.response === "object" ? event.response : {}) as Record<string, unknown>;
  const retrieval = Array.isArray(response.retrieval)
    ? response.retrieval.filter((r): r is { source: string; score: number } =>
        !!r && typeof r === "object"
        && typeof (r as { source?: unknown }).source === "string"
        && typeof (r as { score?: unknown }).score === "number") // guard `.score.toFixed` against a malformed entry
    : [];
  return {
    answer: asString(response.response),
    grounded: typeof event.grounded === "string" ? event.grounded : null,
    query: asString(event.message),
    recordedAt: asString(event.recordedAt),
    retrieval,
    runId,
    success: typeof event.success === "boolean" ? event.success : null,
    toolsUsed: Array.isArray(response.toolsUsed) ? response.toolsUsed.filter((t): t is string => typeof t === "string") : []
  };
}

/** Read all local run summaries (most-recent first). */
export async function readLocalRuns(runsDir: string): Promise<readonly RunSummary[]> {
  let names: string[];
  try {
    names = (await readdir(runsDir)).filter((n) => n.endsWith(".jsonl"));
  } catch {
    return [];
  }
  const out: RunDetail[] = [];
  for (const name of names) {
    try {
      const detail = parseRunEvent(name.replace(/\.jsonl$/u, ""), await readFile(join(runsDir, name), "utf8"));
      if (detail) out.push(detail);
    } catch { /* skip an unreadable run file */ }
  }
  return out.sort((a, b) => b.recordedAt.localeCompare(a.recordedAt));
}

export function formatRunList(runs: readonly RunSummary[]): string {
  if (runs.length === 0) return "No local runs recorded yet — run `muse ask` and traces land in .muse/runs/.";
  const lines = ["Recent runs (inspect with `muse trace <run-id>`):"];
  for (const r of runs.slice(0, 25)) {
    const mark = r.success === false ? "✗" : r.grounded === "misgrounded" ? "⚠" : "✓";
    lines.push(`  ${mark} ${r.runId}  ${r.grounded ?? "—"}  "${r.query.slice(0, 50)}"`);
  }
  return lines.join("\n");
}

export function formatRunDetail(detail: RunDetail, checkpoints: readonly { readonly step: number; readonly phase: string }[]): string {
  const lines = [
    `Run ${detail.runId}  (${detail.recordedAt})`,
    `  Q: ${detail.query}`,
    `  A: ${detail.answer.slice(0, 300)}${detail.answer.length > 300 ? "…" : ""}`,
    `  grounding: ${detail.grounded ?? "—"}   success: ${String(detail.success)}   tools: ${detail.toolsUsed.length > 0 ? detail.toolsUsed.join(", ") : "none"}`
  ];
  if (detail.retrieval.length > 0) {
    lines.push("  retrieved (why this answer):");
    for (const r of detail.retrieval) lines.push(`    ${r.score.toFixed(4)}  ${r.source}`);
  }
  if (checkpoints.length > 0) {
    lines.push(`  steps: ${checkpoints.map((c) => `${c.step.toString()}:${c.phase}`).join(" → ")}`);
  }
  return lines.join("\n");
}

export function registerTraceCommand(program: Command, io: ProgramIO): void {
  program
    .command("trace")
    .description("Inspect a local run — query, answer, RETRIEVED sources+scores, tools, grounding, steps (no server)")
    .argument("[run-id]", "The run to inspect; omit to LIST recent runs")
    .action(async (runId: string | undefined) => {
      const workspaceDir = io.workspaceDir ?? process.cwd();
      const runsDir = join(workspaceDir, ".muse", "runs");
      if (!runId) {
        io.stdout(`${formatRunList(await readLocalRuns(runsDir))}\n`);
        return;
      }
      let raw: string;
      try {
        raw = await readFile(join(runsDir, `${runId}.jsonl`), "utf8");
      } catch {
        io.stderr(`No local trace for run '${runId}'. Run \`muse trace\` to list runs.\n`);
        return;
      }
      const detail = parseRunEvent(runId, raw);
      if (!detail) {
        io.stderr(`Trace for '${runId}' is empty or unreadable.\n`);
        return;
      }
      const store = new FileCheckpointStore(resolveCheckpointsDir(process.env as MuseEnvironment));
      const checkpoints = await store.findByRunId(runId);
      io.stdout(`${formatRunDetail(detail, checkpoints.map((c) => ({ phase: typeof (c.state as { phase?: unknown }).phase === "string" ? (c.state as { phase: string }).phase : "?", step: c.step })))}\n`);
    });
}
