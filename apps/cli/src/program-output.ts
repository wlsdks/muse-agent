/**
 * Output shaping + run-log persistence, extracted from
 * `program-helpers.ts`:
 *
 *   - Output shaping: `writeOutput`, `dropUndefined`,
 *     `renderActiveContext`.
 *   - `muse ask` run-log entry construction: `buildAskRunLog`,
 *     `chatTurnPersistText`, `summarizeRetrieval`, and their types.
 *   - Run-log file persistence + retention: `writeRunLog`,
 *     `pruneRunLogDir`, `readResponseSuccess`, `readResponseGrounded`.
 *
 * No dependency on the HTTP/config/auth modules — this is a leaf.
 */

import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { isRecord } from "./credential-store.js";
import type { ProgramIO } from "./program.js";

export interface RunLogInput {
  readonly apiUrl?: string;
  readonly message: string;
  readonly model?: string;
  readonly response: unknown;
  readonly source?: "cli.local" | "cli.remote" | "cli.remote.stream" | "cli.ink";
}

export interface AskRunLogParams {
  readonly query: string;
  readonly model?: string;
  /** The agent run id — written into the event so the run-log FILENAME matches the
   *  checkpoints' runId (lets `muse trace <id>` link a run to its steps). */
  readonly runId?: string;
  readonly timings: Record<string, number>;
  /** summarizeTokenConfidence output (may be null); omitted from the entry when undefined. */
  readonly confidence?: unknown;
  /** The outcome label (askOutcomeLabel); an explicit null is a real label, kept distinct from absent. */
  readonly grounded: string | null;
  readonly response: string;
  readonly success: boolean;
  readonly toolsUsed: readonly string[];
  /** Present on a FAILED run, so a thrown ask leaves a success:false trace. */
  readonly errorMessage?: string;
  /**
   * Fan-out trust signals (decomposed runs only) — so a self-contradicting / incomplete /
   * truncated fan-out is NOT logged as a clean `success:true, grounded` row. Without this
   * the error-analysis flywheel sees a fan-out failure as a success and gets no fuel.
   */
  readonly decomposition?: {
    readonly subtaskCount: number;
    readonly truncated: boolean;
    readonly subtaskConflicts?: readonly string[];
    readonly synthesisIncomplete?: readonly string[];
  };
  /**
   * Source-check signals on a GROUNDED answer (grounded≠true): the answer rested
   * only on untrusted sources, or a citation was unsupported / a claim uncited.
   * Logged so the error-analysis flywheel doesn't see a grounded-but-untrusted
   * answer as a clean success — the same reason `decomposition` is logged.
   */
  readonly sourceCheck?: {
    readonly untrustedOnly: boolean;
    readonly citationUnsupported: boolean;
    readonly citationUncited: boolean;
  };
  /**
   * What retrieval actually surfaced for this answer — the top sources + their
   * cosine score, BEFORE the answer/citation step. Lets a local trace answer
   * "why this answer / why these sources / what ranked but wasn't cited", which
   * the final `grounded`/citations alone can't. Read-only forensics (P1.2).
   */
  readonly retrieval?: readonly RetrievalTraceEntry[];
}

export interface RetrievalTraceEntry {
  readonly source: string;
  readonly score: number;
}

/**
 * Summarize ranked retrieval matches into the trace's `retrieval` field — top-K
 * source + cosine (falling back to score), rounded. Pure + exported for tests.
 */
export function summarizeRetrieval(
  matches: readonly { readonly source: string; readonly cosine?: number; readonly score: number }[],
  topK = 5
): readonly RetrievalTraceEntry[] {
  // Preserve ASSEMBLY order (semantic note matches lead the array). Do NOT sort by
  // score: the synthetic exact-match entries (task:/event:/memory:) carry a constant
  // 1.0 and would dominate the top-K, burying the real cosine-ranked notes that
  // actually informed the answer — the opposite of useful for "why this answer".
  return matches
    .slice(0, Math.max(0, Math.trunc(topK)))
    .map((m) => ({ score: Number((m.cosine ?? m.score).toFixed(4)), source: m.source }));
}

/**
 * Build the cli.local `muse ask` run-log entry. Single source of truth for the
 * SUCCESS path (today's inline payload) AND the FAILURE path (a thrown run
 * must still leave a `success:false` trace for error-analysis, not vanish). The
 * caller's catch passes `success:false` + `errorMessage`; everything else mirrors
 * the success entry so both rows are shaped identically for the analyzer.
 */
export function buildAskRunLog(params: AskRunLogParams): RunLogInput {
  return {
    message: params.query,
    ...(params.model !== undefined ? { model: params.model } : {}),
    response: {
      ...(params.runId !== undefined ? { runId: params.runId } : {}),
      timings: params.timings,
      ...(params.confidence !== undefined ? { confidence: params.confidence } : {}),
      grounded: params.grounded,
      response: params.response,
      success: params.success,
      toolsUsed: params.toolsUsed,
      ...(params.decomposition !== undefined ? { decomposition: params.decomposition } : {}),
      ...(params.sourceCheck !== undefined ? { sourceCheck: params.sourceCheck } : {}),
      ...(params.retrieval !== undefined ? { retrieval: params.retrieval } : {}),
      ...(params.errorMessage !== undefined ? { error: params.errorMessage } : {})
    },
    source: "cli.local"
  };
}

/**
 * The text of a just-completed local chat turn to PERSIST (appendLastChatTurn) for
 * session resume. Prefers `responseForHistory` — the CUE-FREE twin runLocalChat
 * supplies — over the displayed `response`, so the display-only source-check
 * warnings (untrusted-source / citation cues) are NOT replayed as trusted grounding
 * evidence on the next session's priorHistory (poisoned-source defense; parity with
 * the Ink chat). Falls back to `response` for any path without the twin,
 * and `undefined` when there's no usable string (caller skips the write). Pure.
 */
export function chatTurnPersistText(body: unknown): string | undefined {
  if (!isRecord(body)) return undefined;
  if (typeof body.responseForHistory === "string") return body.responseForHistory;
  if (typeof body.response === "string") return body.response;
  return undefined;
}

export function writeOutput(io: ProgramIO, value: unknown, textField?: string): void {
  if (textField && isRecord(value) && typeof value[textField] === "string") {
    io.stdout(`${value[textField]}\n`);
    return;
  }

  io.stdout(`${JSON.stringify(value, null, 2)}\n`);
}

export function dropUndefined(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter((entry) => entry[1] !== undefined));
}

export function renderActiveContext(snapshot: Record<string, unknown>): string {
  // Pretty-print the same fields the agent loop renders into the
  // `[Active Context]` system section. Layout mirrors
  // `renderActiveContextSection` from @muse/agent-core so the CLI
  // operator sees what the prompt will contain — without committing
  // to a structural import that drags agent-core into the CLI tree.
  const lines: string[] = [];
  const nowIso = typeof snapshot.nowIso === "string" ? snapshot.nowIso : undefined;
  const weekday = typeof snapshot.weekday === "string" ? snapshot.weekday : "?";
  const timezone = typeof snapshot.timezone === "string" ? snapshot.timezone : "?";
  lines.push(`now=${nowIso ?? "?"} (${weekday}, ${timezone})`);
  const workingHours = isRecord(snapshot.workingHours)
    ? snapshot.workingHours as { start?: number; end?: number }
    : undefined;
  if (workingHours && typeof workingHours.start === "number" && typeof workingHours.end === "number") {
    const inWindow = snapshot.isWorkingHours === undefined
      ? "unknown"
      : snapshot.isWorkingHours ? "yes" : "no";
    lines.push(`working_hours=${workingHours.start.toString()}-${workingHours.end.toString()} (in_window=${inWindow})`);
  }
  if (typeof snapshot.currentFocus === "string" && snapshot.currentFocus.trim()) {
    lines.push(`current_focus: ${snapshot.currentFocus}`);
  }
  const activeTask = isRecord(snapshot.activeTask) ? snapshot.activeTask : undefined;
  if (activeTask && typeof activeTask.title === "string") {
    const parts = [activeTask.title];
    if (typeof activeTask.id === "string") { parts.push(`id=${activeTask.id}`); }
    if (typeof activeTask.dueIso === "string") { parts.push(`due=${activeTask.dueIso}`); }
    lines.push(`active_task: ${parts.join(" · ")}`);
  }
  const events = Array.isArray(snapshot.todaysEvents) ? snapshot.todaysEvents : [];
  if (events.length > 0) {
    lines.push("today_events:");
    for (const eventValue of events.slice(0, 8)) {
      if (!isRecord(eventValue)) { continue; }
      const title = typeof eventValue.title === "string" ? eventValue.title : "(untitled)";
      const startIso = typeof eventValue.startIso === "string" ? eventValue.startIso : "?";
      const allDay = eventValue.allDay === true;
      const locationPart = typeof eventValue.location === "string" ? ` @ ${eventValue.location}` : "";
      lines.push(`  · ${allDay ? "(all day)" : startIso} ${title}${locationPart}`);
    }
  }
  return lines.join("\n");
}

export async function writeRunLog(workspaceDir: string, input: RunLogInput, now = new Date()): Promise<string> {
  const runDir = path.join(workspaceDir, ".muse", "runs");
  const runId = readResponseRunId(input.response) ?? `cli-${now.getTime().toString()}`;
  const filePath = path.join(runDir, `${runId}.jsonl`);
  const event = {
    apiUrl: input.apiUrl ?? process.env.MUSE_API_URL ?? "http://127.0.0.1:3030",
    // Outcome labels lifted to the TOP LEVEL so a trace is greppable for error-analysis
    // without descending into `response`. cli.remote responses carry these; cli.local
    // responses do not yet, so they are null there for now — but the schema
    // error-analysis reads is fixed here.
    grounded: readResponseGrounded(input.response) ?? null,
    message: input.message,
    model: input.model ?? null,
    recordedAt: now.toISOString(),
    response: input.response,
    source: input.source ?? "cli.remote",
    success: readResponseSuccess(input.response) ?? null,
    type: "chat.completed"
  };

  await mkdir(runDir, { recursive: true });
  await writeFile(filePath, `${JSON.stringify(event)}\n`, { flag: "a" });
  // Bound the run-log: it was append-per-run forever (observed 1000+ files), which
  // both wastes disk and slows every reader that globs the dir (scout-signals, the
  // flywheel, `muse trace`). Keep the most-recent MUSE_RUN_LOG_MAX_FILES; the
  // flywheel cares about RECENT recurring failures, so pruning the oldest is safe.
  const cap = Number(process.env.MUSE_RUN_LOG_MAX_FILES);
  await pruneRunLogDir(runDir, Number.isFinite(cap) && cap > 0 ? cap : 2_000);
  return filePath;
}

/**
 * Keep only the most-recently-modified `maxFiles` `.jsonl` run-logs in `runDir`,
 * pruning the oldest. Best-effort + exported for tests: a missing dir / stat error
 * never throws (a retention failure must not break a turn). Returns the count pruned.
 */
export async function pruneRunLogDir(runDir: string, maxFiles: number): Promise<number> {
  if (!Number.isFinite(maxFiles) || maxFiles < 1) return 0;
  let files: string[];
  try {
    files = (await readdir(runDir)).filter((name) => name.endsWith(".jsonl"));
  } catch {
    return 0;
  }
  if (files.length <= maxFiles) return 0;
  const withMtime = await Promise.all(files.map(async (name) => {
    try {
      return { mtime: (await stat(path.join(runDir, name))).mtimeMs, name };
    } catch {
      return { mtime: 0, name };
    }
  }));
  withMtime.sort((a, b) => b.mtime - a.mtime); // newest first
  const toPrune = withMtime.slice(Math.trunc(maxFiles));
  await Promise.all(toPrune.map((entry) => rm(path.join(runDir, entry.name), { force: true }).catch(() => undefined)));
  return toPrune.length;
}

function readResponseRunId(value: unknown): string | undefined {
  if (isRecord(value) && typeof value.runId === "string" && value.runId.trim().length > 0) {
    return value.runId;
  }

  return undefined;
}

/** Lift a boolean `success` outcome from a response, if it carries one (cli.remote does). */
export function readResponseSuccess(value: unknown): boolean | undefined {
  if (isRecord(value) && typeof value.success === "boolean") {
    return value.success;
  }
  return undefined;
}

/** Lift the `grounded` verdict from a response, if present (may be an object or explicit null). */
export function readResponseGrounded(value: unknown): unknown {
  if (isRecord(value) && "grounded" in value) {
    return value.grounded;
  }
  return undefined;
}
