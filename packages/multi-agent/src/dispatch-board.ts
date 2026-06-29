/**
 * Board dispatcher (S3) + human-review gate (S6). The dispatcher is the loop that turns
 * a passive Kanban board into work: pick the next dependency-ready task, run it through an
 * injected executor (the lead-worker in production, a fake in tests), and record the
 * outcome back onto the board — carrying the previous failure's reason into a retry's
 * context. A result the executor flags as needing review parks the task in the `review`
 * column instead of completing it; `resolveReview` is the draft-first approval seam that
 * a human (the approval gate) drives to either complete or reject it — never the agent on
 * its own judgement (outbound-safety: a side-effecting task does not self-approve).
 */

import { lastFailureReason, nextReadyTask, recordTaskRun, transitionTask, type AgentTask, type TaskRun } from "./task-board.js";

export interface TaskExecutionResult {
  readonly status: "completed" | "failed";
  readonly reason?: string;
  /** Completed work whose EFFECT needs human sign-off before it counts as done (→ review column). */
  readonly needsReview?: boolean;
}

/** Runs one task. `retryReason` is the prior failure (present only on a retry) to avoid repeating it. */
export type TaskExecutor = (task: AgentTask, ctx: { readonly retryReason?: string }) => Promise<TaskExecutionResult>;

export interface DispatchResult {
  readonly tasks: AgentTask[];
  readonly ran?: AgentTask;
  readonly outcome?: "completed" | "failed" | "review";
}

/**
 * Pick the next ready task, mark it in-progress, run it, and fold the outcome back into the
 * board. Returns the board unchanged (no `ran`) when nothing is runnable. A thrown executor
 * is caught and recorded as a failure (the board never ends in a torn in-progress state).
 */
export async function dispatchNextTask(
  tasks: readonly AgentTask[],
  executor: TaskExecutor,
  nowIso: string
): Promise<DispatchResult> {
  const ready = nextReadyTask(tasks);
  if (!ready) return { tasks: [...tasks] };

  // A decomposed CONTAINER becomes ready only once all its sub-tasks are done — the work was
  // the sub-tasks, so it auto-completes without an executor run (board-as-handoff).
  if (ready.decomposed) {
    return { outcome: "completed", ran: ready, tasks: recordTaskRun(tasks, ready.id, { at: nowIso, reason: "all sub-tasks completed", status: "completed" }) };
  }

  let board = transitionTask(tasks, ready.id, "in_progress", nowIso);
  const retryReason = lastFailureReason(ready);

  let result: TaskExecutionResult;
  try {
    result = await executor(ready, retryReason !== undefined ? { retryReason } : {});
  } catch (cause) {
    result = { reason: cause instanceof Error ? cause.message : String(cause), status: "failed" };
  }

  if (result.status === "completed" && result.needsReview) {
    return { outcome: "review", ran: ready, tasks: transitionTask(board, ready.id, "review", nowIso) };
  }
  const run: TaskRun = { at: nowIso, status: result.status, ...(result.reason !== undefined ? { reason: result.reason } : {}) };
  board = recordTaskRun(board, ready.id, run);
  return { outcome: result.status, ran: ready, tasks: board };
}

/**
 * Resolve a task parked in `review` (S6): a human APPROVAL completes it, a REJECTION blocks
 * it with the reason (so it can be retried after a fix). A no-op on a task that isn't in
 * review — only a parked task can be reviewed, and it can't be approved twice. This is the
 * deterministic seam the draft-first approval gate drives; the decision is never the agent's.
 */
export function resolveReview(
  tasks: readonly AgentTask[],
  id: string,
  approved: boolean,
  nowIso: string,
  reason?: string
): AgentTask[] {
  const task = tasks.find((t) => t.id === id);
  if (!task || task.status !== "review") return [...tasks];
  return recordTaskRun(tasks, id, approved
    ? { at: nowIso, status: "completed", ...(reason !== undefined ? { reason } : {}) }
    : { at: nowIso, reason: reason ?? "review rejected", status: "failed" });
}
