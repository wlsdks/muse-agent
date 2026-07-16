/**
 * Agent task board — the durable Kanban coordination layer for ops-style multi-agent
 * work (the "handoff layer" hermes/openclaw build their orchestration on). A board is
 * an ordered list of tasks moving across columns (todo → in_progress → review → done),
 * gated by DEPENDENCIES (a task is runnable only once every task it `dependsOn` is done)
 * and carrying a RUN HISTORY so a retry feeds the previous failure's reason back into the
 * next attempt's context. This module is the PURE core (immutable transforms, no I/O); a
 * file-backed store + the dispatcher that assigns ready tasks to agents build on it.
 */

export type TaskStatus = "todo" | "in_progress" | "review" | "blocked" | "done" | "failed";

/**
 * Default ceiling on `expandTaskIntoSubtasks` recursion: a task may be decomposed into
 * sub-tasks, and each of THOSE sub-tasks may be decomposed once more (depth 0 → 1), but a
 * depth-1 sub-task is a leaf — it cannot itself be expanded. Matches hermes'
 * `max_spawn_depth=1` / openclaw's subagent depth ceiling: unbounded recursive
 * decomposition is a real failure mode (a sub-task is a plain task with no marker
 * distinguishing it from a top-level one), not a hypothetical one.
 */
export const DEFAULT_BOARD_MAX_DEPTH = 1;
/** Keep durable retry context useful without allowing an indefinitely retried task to grow forever. */
export const DEFAULT_TASK_RUN_HISTORY_LIMIT = 20;

/** One execution attempt of a task — the history a retry reads to avoid repeating a failure. */
export interface TaskRun {
  /** ISO timestamp of the attempt's conclusion. */
  readonly at: string;
  readonly status: "completed" | "failed";
  /** Why it failed (fed into the retry's context) / a short completion note. */
  readonly reason?: string;
  /** The agent's produced answer for this run — kept so a synthesis container can combine it. */
  readonly output?: string;
}

export interface AgentTask {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly status: TaskStatus;
  /** Ids of tasks that must reach `done` before this one is runnable (the DAG edges). */
  readonly dependsOn: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
  /** The agent/profile currently assigned (set when it leaves `todo`). */
  readonly assignee?: string;
  readonly runs: readonly TaskRun[];
  /** Set when blocked/failed — surfaced for human input and replayed on retry. */
  readonly blockedReason?: string;
  /**
   * True once this task was EXPANDED into sub-tasks (board-as-handoff): it becomes a
   * container that depends on them and auto-completes when they're done — the dispatcher
   * runs the sub-tasks, not the container, and never re-expands it.
   */
  readonly decomposed?: boolean;
  /**
   * A decomposed container that must COMBINE its (parallel, independent) sub-task outputs into
   * one answer when they finish — instead of just auto-completing (the sequential case, where
   * the last sub-task already IS the synthesis). Set by a parallel expansion.
   */
  readonly synthesize?: boolean;
  /** The agent's answer from this task's last completed run (kept for a container to synthesize). */
  readonly result?: string;
  /**
   * How many `expandTaskIntoSubtasks` hops separate this task from the top-level task it
   * descends from (0 = top-level). Omitted (not `0`) for a top-level task, matching this
   * file's convention of leaving out a field when it carries no information beyond the
   * default — and letting an EXISTING stored task with no `depth` read back as depth 0
   * (back-compat, no migration needed).
   */
  readonly depth?: number;
}

/** True when EVERY task this one depends on is `done` (a missing/incomplete dep ⇒ not met). */
export function taskDepsMet(task: AgentTask, tasks: readonly AgentTask[]): boolean {
  if (task.dependsOn.length === 0) return true;
  const byId = new Map(tasks.map((t) => [t.id, t]));
  return task.dependsOn.every((dep) => byId.get(dep)?.status === "done");
}

/**
 * The next task the dispatcher should hand to an agent: the OLDEST `todo` task whose
 * dependencies are all met (FIFO within ready). `undefined` when nothing is runnable —
 * every remaining task is done, in flight, blocked, or waiting on an unmet dependency.
 */
export function nextReadyTask(tasks: readonly AgentTask[]): AgentTask | undefined {
  return [...tasks]
    .filter((t) => t.status === "todo" && taskDepsMet(t, tasks))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
}

/** Immutably move a task to a new status (+ optional assignee), stamping updatedAt. */
export function transitionTask(
  tasks: readonly AgentTask[],
  id: string,
  status: TaskStatus,
  nowIso: string,
  assignee?: string
): AgentTask[] {
  return tasks.map((t) =>
    t.id === id
      ? { ...t, status, updatedAt: nowIso, ...(assignee !== undefined ? { assignee } : {}) }
      : t
  );
}

/**
 * Append a run to a task's history. A FAILED run moves it to `blocked` and stamps the
 * reason (so a human can intervene and a retry can replay it); a COMPLETED run moves it
 * to `done`. The recent bounded history keeps retries informed without letting a stuck task
 * retain an unbounded amount of persisted output.
 */
export function recordTaskRun(
  tasks: readonly AgentTask[],
  id: string,
  run: TaskRun,
  maxHistory: number = DEFAULT_TASK_RUN_HISTORY_LIMIT
): AgentTask[] {
  if (!Number.isSafeInteger(maxHistory) || maxHistory <= 0) {
    throw new RangeError("maxHistory must be a positive safe integer");
  }
  return tasks.map((t) => {
    if (t.id !== id) return t;
    const runs = [...t.runs, run].slice(-maxHistory);
    if (run.status === "failed") {
      return { ...t, runs, status: "blocked", updatedAt: run.at, ...(run.reason !== undefined ? { blockedReason: run.reason } : {}) };
    }
    const { blockedReason: _dropped, ...rest } = t;
    return { ...rest, runs, status: "done", updatedAt: run.at, ...(run.output !== undefined ? { result: run.output } : {}) };
  });
}

/**
 * Re-queue a blocked/failed task for another attempt (blocked → todo), KEEPING its run
 * history so the dispatcher can prepend the last failure reason to the retry's context
 * (hermes' "retry with the previous run's reason included"). Returns the board unchanged
 * if the task isn't blocked/failed (only a stuck task is retryable).
 */
export function retryTask(tasks: readonly AgentTask[], id: string, nowIso: string): AgentTask[] {
  return tasks.map((t) =>
    t.id === id && (t.status === "blocked" || t.status === "failed")
      ? { ...t, status: "todo", updatedAt: nowIso }
      : t
  );
}

/** Append a new task to the board (immutable). The caller supplies a unique id + clock. */
export function addTask(
  tasks: readonly AgentTask[],
  spec: {
    readonly id: string;
    readonly title: string;
    readonly description?: string;
    readonly dependsOn?: readonly string[];
    readonly depth?: number;
  },
  nowIso: string
): AgentTask[] {
  return [
    ...tasks,
    {
      createdAt: nowIso,
      dependsOn: spec.dependsOn ?? [],
      id: spec.id,
      runs: [],
      status: "todo",
      title: spec.title,
      updatedAt: nowIso,
      ...(spec.description !== undefined ? { description: spec.description } : {}),
      ...(spec.depth ? { depth: spec.depth } : {})
    }
  ];
}

/**
 * Turn a lead agent's DECOMPOSITION into board tasks (S5 — board-as-handoff): each
 * subtask becomes a `todo` card, and `dependsOn` edges make the board the fan-in gate
 * — a downstream subtask is not runnable until its upstream subtasks are `done`, so the
 * dependency DAG (not an in-memory promise) coordinates the workers. Pure.
 */
export function tasksFromSubtasks(
  subtasks: readonly { readonly id: string; readonly title: string; readonly dependsOn?: readonly string[] }[],
  nowIso: string
): AgentTask[] {
  return subtasks.reduce<AgentTask[]>((board, s) => addTask(board, s, nowIso), []);
}

/**
 * Board-as-handoff (S5 wired through the dispatcher): EXPAND a parent task into a sub-task
 * DAG on the board. The parent is rewired to depend on every sub-task + flagged `decomposed`
 * so it becomes a CONTAINER the dispatcher runs the sub-tasks for, then auto-completes.
 *
 * `mode` shapes the sub-task graph:
 * - `"sequential"` (default) — a chain (s_i waits on s_{i-1}), for ordered steps where a later
 *   one builds on the earlier one's result (decomposeRequest's "X then Y").
 * - `"parallel"` — INDEPENDENT sub-tasks (no inter-dependencies), all immediately runnable, for
 *   work that doesn't need ordering ("research A / research B / research C"). With cloud
 *   providers these run truly concurrently; on one local model they still run, just serially.
 *
 * A no-op if the parent is missing, already decomposed, there's nothing to expand into
 * (<2 sub-tasks isn't a decomposition), or the parent is already AT `maxDepth` (openclaw
 * subagent-capabilities / hermes `max_spawn_depth`: a task at the ceiling is a leaf — this
 * is what stops a sub-task from being expanded again into grandchildren without bound).
 * The caller supplies sub-task ids + the clock.
 */
export function expandTaskIntoSubtasks(
  tasks: readonly AgentTask[],
  parentId: string,
  subtasks: readonly { readonly id: string; readonly title: string }[],
  nowIso: string,
  mode: "sequential" | "parallel" = "sequential",
  maxDepth: number = DEFAULT_BOARD_MAX_DEPTH
): AgentTask[] {
  const parent = tasks.find((t) => t.id === parentId);
  const parentDepth = parent?.depth ?? 0;
  if (!parent || parent.decomposed || subtasks.length < 2 || parentDepth >= maxDepth) return [...tasks];
  let board: AgentTask[] = [...tasks];
  subtasks.forEach((sub, i) => {
    const dependsOn = mode === "sequential" && i > 0 ? [subtasks[i - 1]!.id] : [];
    board = addTask(board, { depth: parentDepth + 1, dependsOn, id: sub.id, title: sub.title }, nowIso);
  });
  const subIds = subtasks.map((s) => s.id);
  return board.map((t) =>
    t.id === parentId
      ? { ...t, decomposed: true, dependsOn: [...t.dependsOn, ...subIds], updatedAt: nowIso, ...(mode === "parallel" ? { synthesize: true } : {}) }
      : t
  );
}

/**
 * Tasks stuck `in_progress` past `staleMs` — a run that started but never recorded an outcome,
 * i.e. the process died mid-execution (a "zombie"; the board is otherwise synchronous, so a
 * lingering in_progress can only be a crash). Pure; a non-parseable `updatedAt` is treated as
 * not-stale (never reclaim on a bad timestamp).
 */
export function staleInProgressTasks(tasks: readonly AgentTask[], nowMs: number, staleMs: number): AgentTask[] {
  return tasks.filter((t) => {
    if (t.status !== "in_progress") return false;
    const age = nowMs - Date.parse(t.updatedAt);
    return Number.isFinite(age) && age >= staleMs;
  });
}

/**
 * Recover zombie tasks: a stale `in_progress` task → `blocked` (NOT auto-re-queued). A crashed
 * run may have half-applied a side effect and the in-memory dedup is gone, so re-running it
 * autonomously could double-execute (the resume hazard) — it waits for an explicit `retry`
 * instead. Stamps a reason so the board shows why. Pure.
 */
export function reclaimStaleTasks(tasks: readonly AgentTask[], nowMs: number, staleMs: number): AgentTask[] {
  const stale = new Set(staleInProgressTasks(tasks, nowMs, staleMs).map((t) => t.id));
  if (stale.size === 0) return [...tasks];
  const nowIso = new Date(nowMs).toISOString();
  return tasks.map((t) =>
    stale.has(t.id)
      ? { ...t, blockedReason: "stale in-progress — a run likely crashed; `board retry` to re-run", status: "blocked", updatedAt: nowIso }
      : t
  );
}

/**
 * Remove a task and prune its id from every other task's `dependsOn`, so removing a sub-task
 * never leaves a dependent stuck waiting on a ghost dependency (taskDepsMet treats a missing
 * dep as unmet). Pure; a no-op for an unknown id.
 */
export function removeTask(tasks: readonly AgentTask[], id: string): AgentTask[] {
  return tasks
    .filter((t) => t.id !== id)
    .map((t) => (t.dependsOn.includes(id) ? { ...t, dependsOn: t.dependsOn.filter((d) => d !== id) } : t));
}

/** A task's answer from its most recent completed run — what a container synthesis reads. */
export function latestOutput(task: AgentTask): string | undefined {
  if (task.result !== undefined) return task.result;
  for (let i = task.runs.length - 1; i >= 0; i--) {
    const run = task.runs[i]!;
    if (run.status === "completed" && run.output !== undefined) return run.output;
  }
  return undefined;
}

/** The reason of a task's most recent FAILED run — the context a retry replays. */
export function lastFailureReason(task: AgentTask): string | undefined {
  for (let i = task.runs.length - 1; i >= 0; i--) {
    const run = task.runs[i]!;
    if (run.status === "failed") return run.reason;
  }
  return undefined;
}

/**
 * The board's decomposition depth ceiling from `MUSE_BOARD_MAX_DEPTH`. Unlike
 * `resolveAskMaxTools`'s `0`/`"off"` escape hatch, a max-depth of 0 would forbid ALL
 * decomposition (a top-level task could never expand), which isn't what an operator
 * asking for a lower ceiling wants — so this floors at 1 instead of treating 0 as
 * "disabled". Absent, non-integer, or non-positive → `DEFAULT_BOARD_MAX_DEPTH`.
 */
export function resolveBoardMaxDepth(env: Record<string, string | undefined>): number {
  const raw = env.MUSE_BOARD_MAX_DEPTH?.trim();
  const parsed = Number(raw);
  if (raw && Number.isInteger(parsed) && parsed > 0) return parsed;
  return DEFAULT_BOARD_MAX_DEPTH;
}
