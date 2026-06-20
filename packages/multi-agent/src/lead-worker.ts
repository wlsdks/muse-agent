import { lexicalTokens } from "@muse/agent-core";

import { decomposeRequest, shouldDecompose, type Subtask } from "./decompose-trigger.js";

export type SubtaskStatus = "completed" | "failed" | "ungrounded";

/** Verdict of the fan-in objective-satisfaction check. */
export interface SynthesisVerdict {
  readonly satisfied: boolean;
  /** Texts of completed sub-tasks whose result the synthesis dropped. */
  readonly missing: readonly string[];
}

/**
 * Objective-satisfaction verifier on the FAN-IN (maker != judge): does the
 * synthesized answer actually INCORPORATE each completed sub-task's result, or did it
 * silently drop one? A confident synthesis that omits a worker's output is the MAST
 * "done-by-self-report / unaware of termination" failure (agent-testing.md: a "done"
 * signal must be backed by a real verification step). Deterministic + conservative —
 * a COMPLETED, non-empty sub-task whose salient tokens are ENTIRELY absent from the
 * synthesis is flagged dropped; a paraphrase (any shared salient token) passes. Pure.
 */
export function verifySynthesisCoverage(finalAnswer: string, executions: readonly SubtaskExecution[]): SynthesisVerdict {
  const answerTokens = lexicalTokens(finalAnswer);
  const missing: string[] = [];
  for (const ex of executions) {
    if (ex.status !== "completed") continue;
    const out = ex.output?.trim();
    if (!out) continue;
    const tokens = [...lexicalTokens(out)];
    if (tokens.length > 0 && !tokens.some((t) => answerTokens.has(t))) missing.push(ex.subtask.text);
  }
  return { missing, satisfied: missing.length === 0 };
}

export interface SubtaskOutput {
  readonly output: string;
  readonly sources?: readonly string[];
}

export interface SubtaskExecution {
  readonly subtask: Subtask;
  readonly status: SubtaskStatus;
  readonly output?: string;
  readonly error?: string;
}

export interface LeadWorkerResult {
  readonly decomposed: boolean;
  readonly subtasks: readonly Subtask[];
  readonly executions: readonly SubtaskExecution[];
  readonly finalAnswer: string;
  readonly reason: string;
  /**
   * Set when the fan-in `verifySynthesis` judged the synthesis INCOMPLETE — the
   * texts of completed sub-tasks whose result the answer dropped. Absent ⇒ the
   * synthesis covered every completed sub-task (or no verifier was supplied). The
   * caller surfaces it rather than returning a confident-but-incomplete answer.
   */
  readonly synthesisIncomplete?: readonly string[];
}

export interface LeadWorkerDeps {
  /**
   * Run ONE sub-task in its OWN clean context (a real sub-agent — it receives
   * only its sub-task text, never the other sub-tasks' outputs). This context
   * isolation is the whole point on a single GPU: the lead's context budget is
   * preserved and each worker stays focused.
   */
  readonly execute: (subtask: Subtask) => Promise<SubtaskOutput>;
  /** Fan-in: combine the completed sub-task outputs into the final answer. */
  readonly synthesize: (request: string, executions: readonly SubtaskExecution[]) => Promise<string>;
  /**
   * Per-sub-task grounding verifier. A false verdict marks the execution
   * `ungrounded` (fail-close — its output is withheld from the lead, never
   * silently merged). Absent → no per-sub-task gate (the caller's own gate
   * still runs on the synthesized answer).
   */
  readonly groundingGate?: (output: SubtaskOutput, subtask: Subtask) => Promise<boolean> | boolean;
  /**
   * Model planner for a complex request with NO literal structure to split
   * (a broad-scope aggregation). Invoked only when deterministic
   * decomposition yields a single task; must return 2+ sub-task texts to take
   * effect, else the request runs single (fail to no-decompose).
   */
  readonly planner?: (request: string) => Promise<readonly string[]>;
  /**
   * Fan-in objective-satisfaction verifier (maker != judge): given the synthesized
   * answer + the executions, return whether it incorporated every completed sub-task.
   * A `!satisfied` verdict marks the result `synthesisIncomplete` so a dropped worker
   * surfaces instead of being returned as confident-complete. Absent ⇒ no fan-in
   * check (back-compat). Wire {@link verifySynthesisCoverage} for the deterministic
   * default.
   */
  readonly verifySynthesis?: (request: string, finalAnswer: string, executions: readonly SubtaskExecution[]) => SynthesisVerdict | Promise<SynthesisVerdict>;
}

const MAX_SUBTASKS = 8;

async function runOne(subtask: Subtask, deps: LeadWorkerDeps): Promise<SubtaskExecution> {
  let produced: SubtaskOutput;
  try {
    produced = await deps.execute(subtask);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error), status: "failed", subtask };
  }

  // Blank output is fail-close, never a silent success: a worker that returned
  // nothing did NOT complete its sub-task, so it must not be folded into the
  // synthesis as if it had (the "blank = success" trap the handoff validator
  // closes on the orchestrator path — closed here too).
  if (produced.output.trim().length === 0) {
    return { error: "empty sub-task output (fail-close)", output: produced.output, status: "failed", subtask };
  }

  if (deps.groundingGate) {
    let grounded: boolean;
    try {
      grounded = await deps.groundingGate(produced, subtask);
    } catch {
      grounded = false;
    }
    if (!grounded) {
      return { output: produced.output, status: "ungrounded", subtask };
    }
  }

  return { output: produced.output, status: "completed", subtask };
}

/**
 * Lead-worker fan-out: a complex request is split into independent sub-tasks,
 * each run in its own clean context (sequential on a single GPU), then the lead
 * synthesizes one answer. A simple request bypasses the whole machinery and
 * runs as a single execution. Failures NEVER abort the run or silently vanish
 * (MAST "information withholding"): a failed/ungrounded sub-task is recorded
 * and surfaced to `synthesize`, which decides how to fold partial results.
 * Termination is bounded — at most {@link MAX_SUBTASKS} sub-tasks run.
 */
function normalizeSubtaskText(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/gu, " ");
}

/**
 * MAST #3 (no duplicated sub-agent work): a decomposer OR model planner can emit two
 * case/whitespace-identical subtasks; on a single GPU that runs the SAME work twice
 * (Anthropic's "vague sub-agent instructions → identical searches" failure mode).
 * Dedup by normalized text — keep the first occurrence's original text, drop empties,
 * re-id sequentially — BEFORE fan-out. Pure; covers both the structural and planner
 * subtask sources since both flow through here.
 */
export function dedupeSubtasks(subtasks: readonly Subtask[]): Subtask[] {
  const seen = new Set<string>();
  const out: Subtask[] = [];
  for (const subtask of subtasks) {
    const norm = normalizeSubtaskText(subtask.text);
    if (norm.length === 0 || seen.has(norm)) continue;
    seen.add(norm);
    out.push({ id: `subtask_${(out.length + 1).toString()}`, text: subtask.text });
  }
  return out;
}

export async function runLeadWorkerTask(request: string, deps: LeadWorkerDeps): Promise<LeadWorkerResult> {
  const decision = shouldDecompose(request);

  if (!decision.decompose) {
    const single: Subtask = { id: "subtask_1", text: request.trim() };
    const execution = await runOne(single, deps);
    return {
      decomposed: false,
      executions: [execution],
      finalAnswer: execution.status === "completed" ? (execution.output ?? "") : "",
      reason: `single-agent (${decision.reason})`,
      subtasks: [single]
    };
  }

  let subtasks = decomposeRequest(request);
  let planned = false;
  if (subtasks.length < 2 && deps.planner) {
    try {
      const texts = (await deps.planner(request)).map((t) => t.trim()).filter(Boolean);
      if (texts.length >= 2) {
        subtasks = texts.map((text, index) => ({ id: `subtask_${index + 1}`, text }));
        planned = true;
      }
    } catch {
      // planner failure is non-fatal — fall through to the single sub-task
    }
  }

  subtasks = dedupeSubtasks(subtasks);

  const truncated = subtasks.length > MAX_SUBTASKS;
  if (truncated) subtasks = subtasks.slice(0, MAX_SUBTASKS);

  const executions: SubtaskExecution[] = [];
  for (const subtask of subtasks) {
    executions.push(await runOne(subtask, deps));
  }

  const finalAnswer = await deps.synthesize(request, executions);
  // Fan-in objective-satisfaction (maker != judge): did the synthesis incorporate
  // every completed sub-task, or silently drop one? Fail-soft — a verifier error
  // leaves the answer as-is (never blocks the run).
  let synthesisIncomplete: readonly string[] | undefined;
  if (deps.verifySynthesis) {
    try {
      const verdict = await deps.verifySynthesis(request, finalAnswer, executions);
      if (!verdict.satisfied && verdict.missing.length > 0) synthesisIncomplete = verdict.missing;
    } catch { /* verifier unavailable — surface nothing, return the answer */ }
  }
  const split = planned ? "model-planned" : "structural";
  const completed = executions.filter((e) => e.status === "completed").length;

  return {
    decomposed: subtasks.length > 1,
    executions,
    finalAnswer,
    reason:
      `${split} decomposition → ${completed}/${executions.length} sub-tasks grounded` +
      (truncated ? ` (capped at ${MAX_SUBTASKS})` : "") +
      (synthesisIncomplete ? ` · synthesis incomplete (${synthesisIncomplete.length.toString()} dropped)` : ""),
    subtasks,
    ...(synthesisIncomplete ? { synthesisIncomplete } : {})
  };
}
