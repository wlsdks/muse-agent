/**
 * Task-flow analysis — Little's Law (Little, "A Proof for the Queuing Formula
 * L = λW", Operations Research 9(3):383-387, 1961). A todo list is a queue:
 * tasks ARRIVE (created) and DEPART (completed). Little's Law relates the
 * average backlog L, the arrival rate λ, and the average time a task spends open
 * W by L = λW — and its stability corollary: if the arrival rate stays above the
 * completion rate, the backlog grows without bound. So this surfaces whether you
 * are creating tasks faster than you finish them (an overcommitment signal) and
 * your real lead time W. Deterministic, no model — counts + arithmetic over the
 * createdAt / completedAt timestamps the store already keeps.
 */

export interface TaskFlowInput {
  readonly createdAt: string;
  readonly completedAt?: string;
  readonly status: "open" | "done";
}

type FlowTrend = "growing" | "shrinking" | "steady";

export interface TaskFlowStats {
  readonly windowDays: number;
  /** Tasks created within the window (arrivals). */
  readonly created: number;
  /** Tasks completed within the window (departures). */
  readonly completed: number;
  /** created − completed: how much the backlog moved over the window. */
  readonly net: number;
  /** Open tasks right now (the current backlog L). */
  readonly openNow: number;
  /** Average days a task-completed-in-window stayed open (Little's W) — undefined if none completed in window. */
  readonly avgLeadDays?: number;
  readonly trend: FlowTrend;
}

const DAY_MS = 86_400_000;

function parseMs(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

/**
 * Analyze the task queue over the trailing `windowDays`. `created`/`completed`
 * count arrivals/departures inside the window; `openNow` is the current backlog;
 * `avgLeadDays` is the mean open-time of tasks completed in the window (Little's
 * W). A task with an unparseable timestamp is skipped for the affected count.
 */
export function analyzeTaskFlow(tasks: readonly TaskFlowInput[], now: Date, windowDays: number): TaskFlowStats {
  const win = Math.max(1, Math.trunc(Number.isFinite(windowDays) ? windowDays : 7));
  const nowMs = now.getTime();
  const windowStart = nowMs - win * DAY_MS;
  let created = 0;
  let completed = 0;
  let openNow = 0;
  let leadSum = 0;
  let leadCount = 0;
  for (const task of tasks) {
    const createdMs = parseMs(task.createdAt);
    if (createdMs !== undefined && createdMs >= windowStart && createdMs <= nowMs) created += 1;
    if (task.status === "open") openNow += 1;
    const completedMs = parseMs(task.completedAt);
    if (completedMs !== undefined && completedMs >= windowStart && completedMs <= nowMs) {
      completed += 1;
      if (createdMs !== undefined && completedMs >= createdMs) {
        leadSum += (completedMs - createdMs) / DAY_MS;
        leadCount += 1;
      }
    }
  }
  const net = created - completed;
  return {
    avgLeadDays: leadCount > 0 ? leadSum / leadCount : undefined,
    completed,
    created,
    net,
    openNow,
    trend: net > 0 ? "growing" : net < 0 ? "shrinking" : "steady",
    windowDays: win
  };
}

/** Round to one decimal for display. */
const round1 = (n: number): string => (Math.round(n * 10) / 10).toString();

/** Render the human-readable task-flow report, with the Little's-Law interpretation line. */
export function formatTaskFlow(stats: TaskFlowStats): string {
  const perDay = (n: number): string => `${round1(n / stats.windowDays)}/day`;
  const lines = [
    `📊 Task flow — last ${stats.windowDays.toString()} day${stats.windowDays === 1 ? "" : "s"}`,
    `  Created:   ${stats.created.toString()}  (${perDay(stats.created)})`,
    `  Completed: ${stats.completed.toString()}  (${perDay(stats.completed)})`,
    `  Net:       ${stats.net > 0 ? "+" : ""}${stats.net.toString()}  → backlog ${stats.trend === "growing" ? "GROWING" : stats.trend === "shrinking" ? "shrinking" : "steady"}`,
    `  Open now:  ${stats.openNow.toString()}`
  ];
  if (stats.avgLeadDays !== undefined) {
    lines.push(`  Avg time to done: ${round1(stats.avgLeadDays)} days  (your lead time W)`);
  }
  if (stats.trend === "growing" && stats.completed > 0) {
    const ratio = stats.created / stats.completed;
    lines.push(`  ⚠ You're adding tasks ~${round1(ratio)}× faster than you finish them — by Little's Law (L = λW), an arrival rate above your completion rate grows the backlog without bound. Finish or prune to stay sustainable.`);
  } else if (stats.trend === "growing") {
    lines.push("  ⚠ Tasks are arriving but none were completed in this window — the backlog is growing. Finish or prune some.");
  } else if (stats.trend === "shrinking") {
    lines.push("  ✓ You're completing faster than you add — the backlog is shrinking.");
  } else {
    lines.push("  Arrivals and completions are balanced — the backlog is holding steady.");
  }
  return `${lines.join("\n")}\n`;
}
