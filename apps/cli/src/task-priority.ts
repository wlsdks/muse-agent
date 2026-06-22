import type { PersistedTask } from "@muse/stores";

// "What should I do next?" — a principled urgency ranking over your open tasks.
//
// Cross-field mechanism: EARLIEST DEADLINE FIRST (Liu & Layland, "Scheduling
// Algorithms for Multiprogramming in a Hard-Real-Time Environment", JACM
// 20(1):46-61, 1973) — proved optimal for meeting deadlines on a single
// processor: always work the job whose deadline is soonest. A human is a
// single processor for focused work, so EDF is the right backbone. Paired with
// AGING (the classic anti-starvation technique in OS schedulers / multilevel
// feedback queues): a job that waits too long has its priority raised so a
// stream of newer deadline-bearing jobs can't starve it forever. Here an
// undated task gets an implicit deadline `createdAt + TASK_AGING_DAYS`, so a
// "someday" task can't languish unseen behind dated ones — it creeps up as it
// ages and eventually surfaces.
//
// Deterministic by construction (pure date arithmetic), so the ordering never
// depends on the model. Distinct from `tasks list` (newest-first, a flat dump)
// and `tasks flow` (Little's Law throughput): this answers WHICH ONE NOW.

export const TASK_AGING_DAYS = 14;
const DAY_MS = 86_400_000;

export interface RankedTask {
  readonly task: PersistedTask;
  /** The deadline EDF sorts on — real `dueAt`, `now` for urgent, or the aging horizon. */
  readonly effectiveDueMs: number;
  /** Human-readable why-now ("overdue 2d", "due in 3h", "urgent", "open 12d (aging)"). */
  readonly reason: string;
}

function parseMs(iso: string | undefined): number {
  if (iso === undefined) return Number.NaN;
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? Number.NaN : parsed;
}

/**
 * The deadline this task is scheduled against:
 * - urgent ⇒ `now` (float to the top), or its real deadline if already earlier;
 * - else a real `dueAt` if present (pure EDF);
 * - else `createdAt + TASK_AGING_DAYS` (aging — an undated task becomes "due"
 *   that many days after capture so it can't starve).
 */
export function taskEffectiveDueMs(task: PersistedTask, nowMs: number): number {
  const due = parseMs(task.dueAt);
  const hasDue = Number.isFinite(due);
  if (task.urgent) return hasDue ? Math.min(due, nowMs) : nowMs;
  if (hasDue) return due;
  const created = parseMs(task.createdAt);
  const base = Number.isFinite(created) ? created : nowMs;
  return base + TASK_AGING_DAYS * DAY_MS;
}

function humanizeSpan(ms: number): string {
  const abs = Math.abs(ms);
  if (abs < 60 * 60 * 1000) return `${Math.max(1, Math.round(abs / 60000)).toString()}m`;
  if (abs < 2 * DAY_MS) return `${Math.round(abs / (60 * 60 * 1000)).toString()}h`;
  return `${Math.round(abs / DAY_MS).toString()}d`;
}

function reasonFor(task: PersistedTask, nowMs: number): string {
  const parts: string[] = [];
  if (task.urgent) parts.push("urgent");
  const due = parseMs(task.dueAt);
  if (Number.isFinite(due)) {
    parts.push(due < nowMs ? `overdue ${humanizeSpan(nowMs - due)}` : `due in ${humanizeSpan(due - nowMs)}`);
  } else if (!task.urgent) {
    const created = parseMs(task.createdAt);
    const age = Number.isFinite(created) ? nowMs - created : 0;
    parts.push(`open ${humanizeSpan(age)} (aging)`);
  }
  return parts.join(" · ");
}

/** Open tasks ranked most-urgent first (EDF + aging), createdAt then id as stable tiebreaks. */
export function rankTasksByUrgency(tasks: readonly PersistedTask[], nowMs: number): RankedTask[] {
  return tasks
    .filter((task) => task.status === "open")
    .map((task) => ({ effectiveDueMs: taskEffectiveDueMs(task, nowMs), reason: reasonFor(task, nowMs), task }))
    .sort((a, b) =>
      a.effectiveDueMs - b.effectiveDueMs ||
      ((parseMs(a.task.createdAt) || 0) - (parseMs(b.task.createdAt) || 0)) ||
      a.task.id.localeCompare(b.task.id));
}

export function formatTaskQueue(ranked: readonly RankedTask[], limit?: number): string {
  if (ranked.length === 0) return "No open tasks — you're clear. 🎉";
  const shown = limit !== undefined && limit > 0 ? ranked.slice(0, limit) : ranked;
  const lines = shown.map((entry, index) => {
    const marker = index === 0 ? "→" : " ";
    const suffix = entry.reason.length > 0 ? ` — ${entry.reason}` : "";
    return `${marker} ${(index + 1).toString()}. ${entry.task.title}${suffix}`;
  });
  const more = ranked.length > shown.length ? `\n  …and ${(ranked.length - shown.length).toString()} more` : "";
  return `What to do next (earliest deadline first):\n${lines.join("\n")}${more}`;
}
