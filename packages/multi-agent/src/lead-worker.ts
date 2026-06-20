import { decomposeRequest, shouldDecompose, type Subtask } from "./decompose-trigger.js";

export type SubtaskStatus = "completed" | "failed" | "ungrounded";

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
  const split = planned ? "model-planned" : "structural";
  const completed = executions.filter((e) => e.status === "completed").length;

  return {
    decomposed: subtasks.length > 1,
    executions,
    finalAnswer,
    reason:
      `${split} decomposition → ${completed}/${executions.length} sub-tasks grounded` +
      (truncated ? ` (capped at ${MAX_SUBTASKS})` : ""),
    subtasks
  };
}
