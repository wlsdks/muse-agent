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
import type { SourceCheckSignals } from "@muse/recall";
import { isRecord } from "@muse/shared";

import type { ProgramIO } from "./program.js";

export interface RunSummary {
  readonly runId: string;
  readonly query: string;
  readonly grounded: string | null;
  readonly success: boolean | null;
  readonly recordedAt: string;
}

interface DecompositionSignals {
  readonly subtaskConflicts?: readonly string[];
  readonly synthesisIncomplete?: readonly string[];
  readonly truncated?: boolean;
}

export interface RunDetail extends RunSummary {
  readonly answer: string;
  readonly retrieval: readonly { readonly source: string; readonly score: number }[];
  readonly toolsUsed: readonly string[];
  /** GROUNDED≠TRUE caveats captured at answer time: a "grounded" answer that rested
   *  only on untrusted sources, or carried an unsupported / uncited citation. */
  readonly sourceCheck?: SourceCheckSignals;
  /** Fan-out (decompose) trust signals: a sub-answer contradiction / dropped result / truncation. */
  readonly decomposition?: DecompositionSignals;
}

function asString(v: unknown, fallback = ""): string { return typeof v === "string" ? v : fallback; }
function asBool(v: unknown): boolean { return v === true; }
function strList(v: unknown): readonly string[] | undefined {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined;
}
function toRecord(v: unknown): Record<string, unknown> | undefined {
  return isRecord(v) ? v : undefined;
}

function parseSourceCheck(v: unknown): SourceCheckSignals | undefined {
  const r = toRecord(v);
  if (!r) return undefined;
  const sc = { citationUncited: asBool(r.citationUncited), citationUnsupported: asBool(r.citationUnsupported), untrustedOnly: asBool(r.untrustedOnly) };
  return sc.untrustedOnly || sc.citationUnsupported || sc.citationUncited ? sc : undefined;
}

function parseDecomposition(v: unknown): DecompositionSignals | undefined {
  const r = toRecord(v);
  if (!r) return undefined;
  const conflicts = strList(r.subtaskConflicts);
  const incomplete = strList(r.synthesisIncomplete);
  const truncated = asBool(r.truncated);
  if (!truncated && !conflicts?.length && !incomplete?.length) return undefined;
  return {
    ...(truncated ? { truncated } : {}),
    ...(conflicts?.length ? { subtaskConflicts: conflicts } : {}),
    ...(incomplete?.length ? { synthesisIncomplete: incomplete } : {})
  };
}

/** Parse the LAST event of a run-log JSONL file into a summary (the final outcome). */
export function parseRunEvent(runId: string, raw: string): RunDetail | undefined {
  const lines = raw.trim().split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0) return undefined;
  let event: unknown;
  try {
    event = JSON.parse(lines[lines.length - 1]!.trim());
  } catch {
    return undefined;
  }
  const eventRecord = toRecord(event);
  if (!eventRecord) {
    return undefined;
  }
  const responseRecord = toRecord(eventRecord.response) ?? {};
  const sourceCheck = parseSourceCheck(responseRecord.sourceCheck);
  const decomposition = parseDecomposition(responseRecord.decomposition);
  const retrieval = Array.isArray(responseRecord.retrieval)
    ? responseRecord.retrieval.flatMap((entry): readonly { readonly source: string; readonly score: number }[] => {
      if (!isRecord(entry)) return [];
      const source = entry.source;
      const score = entry.score;
      if (typeof source !== "string" || typeof score !== "number") return [];
      return [{ source, score }];
    })
    : [];
  return {
    answer: asString(responseRecord.response),
    grounded: typeof eventRecord.grounded === "string" ? eventRecord.grounded : null,
    query: asString(eventRecord.message),
    recordedAt: asString(eventRecord.recordedAt),
    retrieval,
    runId,
    success: typeof eventRecord.success === "boolean" ? eventRecord.success : null,
    toolsUsed: Array.isArray(responseRecord.toolsUsed) ? responseRecord.toolsUsed.filter((t): t is string => typeof t === "string") : [],
    ...(sourceCheck ? { sourceCheck } : {}),
    ...(decomposition ? { decomposition } : {})
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
  if (detail.sourceCheck) {
    // A "grounded" verdict can still be GROUNDED≠TRUE — surface the caveats the
    // verdict alone hides, so a confident answer resting on poisonable/uncited
    // sources is visible in the inspector.
    const cues = [
      detail.sourceCheck.untrustedOnly ? "rested only on UNTRUSTED sources" : "",
      detail.sourceCheck.citationUnsupported ? "a citation was UNSUPPORTED" : "",
      detail.sourceCheck.citationUncited ? "a claim was UNCITED" : ""
    ].filter((c) => c.length > 0);
    if (cues.length > 0) lines.push(`  ⚠ grounded≠true: ${cues.join("; ")}`);
  }
  if (detail.decomposition) {
    const d = detail.decomposition;
    const parts = [
      d.subtaskConflicts?.length ? `sub-answers contradicted (${d.subtaskConflicts.length})` : "",
      d.synthesisIncomplete?.length ? `dropped ${d.synthesisIncomplete.length} sub-result(s)` : "",
      d.truncated ? "fan-out TRUNCATED" : ""
    ].filter((p) => p.length > 0);
    if (parts.length > 0) lines.push(`  ⚠ fan-out: ${parts.join("; ")}`);
  }
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
      const store = new FileCheckpointStore(resolveCheckpointsDir(process.env));
      const checkpoints = await store.findByRunId(runId);
      io.stdout(`${formatRunDetail(detail, checkpoints.map((c): { readonly step: number; readonly phase: string } => {
        const state = toRecord(c.state);
        const phase = typeof state?.phase === "string" ? state.phase : "?";
        return { phase, step: c.step };
      }))}\n`);
    });
}
