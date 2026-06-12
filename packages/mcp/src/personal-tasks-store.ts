/**
 * Pure data layer for the personal todo list (`~/.muse/tasks.json`).
 *
 * Three callers compose against this module:
 *   - the MCP loopback server in `loopback-tasks.ts` (the LLM tool surface)
 *   - the Fastify REST routes in `apps/api/src/tasks-routes.ts`
 *   - the CLI's `--local` mode in `apps/cli/src/commands-tasks.ts`
 *
 * Keeping the on-disk shape, atomic writes, and dueAt parsing here
 * means CLI-written rows always round-trip cleanly through the API
 * (and vice versa) without each surface re-implementing parts of the
 * format.
 */

import { promises as fs } from "node:fs";
import { dirname } from "node:path";

import type { JsonObject, JsonValue } from "@muse/shared";

import { formatDueLocal } from "./local-due-format.js";
import { resolveRelativeTimePhrase } from "./loopback-relative-time.js";
import { withFileLock } from "./encrypted-file.js";

export interface PersistedTask {
  readonly id: string;
  readonly title: string;
  readonly status: "open" | "done";
  readonly createdAt: string;
  readonly completedAt?: string;
  readonly dueAt?: string;
  readonly notes?: string;
  readonly tags?: readonly string[];
  /**
   * Phase C of docs/design/proactive-surfacing.md. When `false`,
   * the proactive-tick skips this task even though it has an
   * imminent `dueAt`. Default behaviour (undefined or `true`):
   * fire when due-soon.
   */
  readonly proactive?: boolean;
  /**
   * When true, the proactive watcher fires this task EVEN during
   * `routine_active_hours`-derived quiet hours. Use for genuine
   * "wake me at 3 AM" situations (security alert, plane in 6 hours,
   * babysitter cancelling). Default undefined / false → respect
   * quiet hours.
   */
  readonly urgent?: boolean;
}

export type TaskStatusFilter = "open" | "done" | "all";

/**
 * Move a present-but-corrupt store aside so the next write
 * starts fresh WITHOUT permanently destroying the user's prior
 * tasks. Best-effort: a rename failure must not crash the read
 * path. The original bytes survive at `<file>.corrupt-<ts>` for
 * manual recovery.
 */
async function quarantineCorruptStore(file: string): Promise<void> {
  try {
    await fs.rename(file, `${file}.corrupt-${Date.now().toString()}`);
  } catch {
    // ignore — read still degrades to empty either way
  }
}

export async function readTasks(file: string): Promise<readonly PersistedTask[]> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    await quarantineCorruptStore(file);
    return [];
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { tasks?: unknown }).tasks)) {
    await quarantineCorruptStore(file);
    return [];
  }
  return (parsed as { tasks: unknown[] }).tasks.flatMap((entry): readonly PersistedTask[] =>
    isPersistedTask(entry) ? [entry] : []
  );
}

/**
 * Serialized read-modify-write: run `fn` over the current tasks and persist its
 * result under a CROSS-PROCESS file lock, so the proactive daemon and a chat
 * `add` (separate processes) can't both read the same list, each change it, and
 * clobber the other (last-writer-wins lost the unseen write). Returns the
 * persisted list. Every RMW caller must go through this, never read+write
 * directly. Mirrors mutateReminders.
 */
export async function mutateTasks(
  file: string,
  fn: (current: readonly PersistedTask[]) => readonly PersistedTask[] | Promise<readonly PersistedTask[]>
): Promise<readonly PersistedTask[]> {
  return withFileLock(file, async () => {
    const current = await readTasks(file);
    const next = await fn(current);
    await writeTasks(file, next);
    return next;
  });
}

export async function writeTasks(file: string, tasks: readonly PersistedTask[]): Promise<void> {
  const payload = `${JSON.stringify({ tasks }, null, 2)}\n`;
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await fs.mkdir(dirname(file), { recursive: true });
  // fsync before rename so a power-loss/crash can't commit a rename over a
  // not-yet-flushed (0-byte/partial) tmp file — matches the followups /
  // objectives / contacts / action-log stores.
  const handle = await fs.open(tmp, "w", 0o600);
  try {
    await handle.writeFile(payload, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(tmp, file);
  await fs.chmod(file, 0o600).catch(() => undefined);
}

export function serializeTask(task: PersistedTask): JsonObject {
  return {
    createdAt: task.createdAt,
    id: task.id,
    status: task.status,
    title: task.title,
    ...(task.completedAt ? { completedAt: task.completedAt } : {}),
    ...(task.dueAt ? { dueAt: task.dueAt } : {}),
    ...(task.notes ? { notes: task.notes } : {}),
    ...(task.tags && task.tags.length > 0 ? { tags: [...task.tags] as JsonValue } : {}),
    ...(task.proactive === false ? { proactive: false } : {}),
    ...(task.urgent === true ? { urgent: true } : {})
  };
}

/**
 * The model-facing serialization. Identical to `serializeTask` (which the
 * REST API / web UI use, formatting their own times) plus a `dueAtLocal`
 * field — the due time in the SERVER's local timezone — WHEN the task has a
 * `dueAt`, so a chat confirmation echoes the time the user actually asked for
 * instead of the raw UTC ISO hour. Undated tasks are unchanged. Only the LLM
 * tool results carry the extra field; the REST path keeps lean `serializeTask`.
 */
export function serializeTaskForModel(task: PersistedTask, now: () => Date = () => new Date()): JsonObject {
  const base = serializeTask(task);
  return task.dueAt ? { ...base, dueAtLocal: formatDueLocal(task.dueAt, now) } : base;
}

export type TaskRefResolution =
  | { readonly status: "resolved"; readonly task: PersistedTask }
  | { readonly status: "ambiguous"; readonly candidates: readonly PersistedTask[] }
  | { readonly status: "not-found" };

/**
 * Resolve a model-supplied task reference to a single task. The chat model
 * refers to a task by its TITLE ("the milk task"), not its generated id — but
 * complete / update need a unique target, and the model fumbles the 2-step
 * "search to get the id, then act" chain (it passes the TITLE as the id →
 * "not found"). So resolve here: an exact id wins; otherwise a case-insensitive
 * substring match on the task title, preferring an OPEN task over a done one
 * when both match. A UNIQUE match resolves; MULTIPLE matches are ambiguous
 * (return candidates, never act on a guess); none → not-found. Mirrors the
 * reminder `resolveReminderRef`.
 */
export function resolveTaskRef(
  tasks: readonly PersistedTask[],
  ref: string | undefined
): TaskRefResolution {
  const trimmed = ref?.trim() ?? "";
  if (trimmed.length === 0) {
    return { status: "not-found" };
  }
  const byId = tasks.find((task) => task.id === trimmed);
  if (byId) {
    return { status: "resolved", task: byId };
  }
  const needle = trimmed.toLowerCase();
  const matches = tasks.filter((task) => task.title.toLowerCase().includes(needle));
  const open = matches.filter((task) => task.status === "open");
  const pool = open.length > 0 ? open : matches;
  if (pool.length === 1) {
    return { status: "resolved", task: pool[0]! };
  }
  if (pool.length > 1) {
    return { status: "ambiguous", candidates: pool };
  }
  return { status: "not-found" };
}

export function readTaskStatusFilter(value: string | undefined): TaskStatusFilter {
  return value === "done" || value === "all" ? value : "open";
}

/**
 * One-line briefing fragment for OPEN tasks due within `withinDays`
 * (default 1 — today + tomorrow), overdue ones included and listed
 * first: "Buy milk (overdue); Call mom (today); Pay rent (tomorrow)".
 * Returns `undefined` when nothing is due in the window so the brief
 * stays quiet. A task with no / unparseable `dueAt` is skipped.
 */
export interface DueTask {
  readonly task: PersistedTask;
  /** Calendar-day offset of the due date from today (negative = overdue). */
  readonly dayDiff: number;
}

/**
 * Open tasks with a `dueAt` whose due date is within `withinDays`
 * calendar days of today (overdue included — a negative dayDiff),
 * sorted soonest/most-overdue first. The shared due-window selector so
 * the briefing line and the on-demand `list` due filter agree exactly.
 */
export function selectTasksDueWithin(
  tasks: readonly PersistedTask[],
  options: { readonly now?: Date; readonly withinDays?: number } = {}
): DueTask[] {
  const now = options.now ?? new Date();
  const withinDays = Number.isFinite(options.withinDays) ? Math.max(0, Math.trunc(options.withinDays as number)) : 1;
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const due: DueTask[] = [];
  for (const task of tasks) {
    if (task.status !== "open" || !task.dueAt) {
      continue;
    }
    const ms = Date.parse(task.dueAt);
    if (!Number.isFinite(ms)) {
      continue;
    }
    const d = new Date(ms);
    const dayDiff = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() - today.getTime()) / 86_400_000);
    if (dayDiff > withinDays) {
      continue;
    }
    due.push({ dayDiff, task });
  }
  due.sort((a, b) => a.dayDiff - b.dayDiff || a.task.title.localeCompare(b.task.title));
  return due;
}

export function resolveTasksDueLine(
  tasks: readonly PersistedTask[],
  options: { readonly now?: Date; readonly withinDays?: number } = {}
): string | undefined {
  const due = selectTasksDueWithin(tasks, options);
  if (due.length === 0) {
    return undefined;
  }
  return due
    .map(({ task, dayDiff }) => {
      const when = dayDiff < 0 ? "overdue" : dayDiff === 0 ? "today" : dayDiff === 1 ? "tomorrow" : `in ${dayDiff.toString()} days`;
      return `${task.title} (${when})`;
    })
    .join("; ");
}

/**
 * Resolve a user-supplied dueAt string. Accepts an ISO-8601 timestamp
 * starting with `YYYY-MM-DD…` or one of the relative phrases the MCP
 * tool advertises ("tomorrow at 6pm", "in 3 hours", "next Monday").
 * Returns the resolved ISO timestamp or an Error explaining why the
 * input was rejected — callers map that to their surface (HTTP 400,
 * MCP error response, CLI exit message).
 */
const SPELLED_NUMBERS: Record<string, string> = {
  one: "1", two: "2", three: "3", four: "4", five: "5", six: "6",
  seven: "7", eight: "8", nine: "9", ten: "10", eleven: "11", twelve: "12"
};

export function parseTaskDueAt(raw: string, now: () => Date): string | Error {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return new Error("dueAt is empty");
  }
  const isoParsed = new Date(trimmed);
  const dateHead = /^(\d{4})-(\d{2})-(\d{2})/u.exec(trimmed);
  if (!Number.isNaN(isoParsed.getTime()) && dateHead) {
    // `new Date("2026-02-30")` silently rolls over to Mar 2 rather
    // than failing — accepting it would schedule the reminder ~2
    // days off. A real calendar date round-trips its Y-M-D through
    // Date.UTC unchanged; a rolled-over one does not.
    const y = Number(dateHead[1]);
    const mo = Number(dateHead[2]);
    const d = Number(dateHead[3]);
    const probe = new Date(Date.UTC(y, mo - 1, d));
    if (probe.getUTCFullYear() === y && probe.getUTCMonth() === mo - 1 && probe.getUTCDate() === d) {
      return isoParsed.toISOString();
    }
  }
  // A small spelled-out number right before a time unit ("in two weeks",
  // "three days from now") becomes its digit so it resolves like "2 weeks" /
  // "3 days" — the grammar's number patterns only accept digits. Scoped to a
  // number IMMEDIATELY before a unit, so prose ("one of them") is untouched.
  const deSpelled = trimmed
    .replace(
      /\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(seconds?|minutes?|hours?|days?|weeks?|months?|years?)\b/giu,
      (_m, num: string, unit: string) => `${SPELLED_NUMBERS[num.toLowerCase()] ?? num} ${unit}`
    )
    // "this coming Monday" / "coming Friday" — drop the filler "coming" so it
    // resolves like "this Monday" / "Monday" (the grammar already handles those).
    .replace(/\bcoming\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/giu, "$1");
  // "100 days from now" / "45 days from today" are the spoken equivalents of
  // "in 100 days" — which the grammar already resolves. Rewrite that trailing
  // "<n> <unit> from now/today" form to the "in <n> <unit>" form so both phrasings
  // land on the same parse. Purely additive: a phrase that already parses has no
  // "from now/today" tail, so this only rescues inputs that would otherwise error.
  const normalized = deSpelled.replace(
    /(\d+)\s+(seconds?|minutes?|hours?|days?|weeks?|months?|years?)\s+from\s+(?:now|today)\b/iu,
    "in $1 $2"
  );
  const relative = resolveRelativeTimePhrase(normalized, now);
  if (!relative) {
    return new Error(
      `dueAt must be an ISO-8601 timestamp or a supported relative phrase (got ${JSON.stringify(trimmed)}). ` +
      `Examples: "tomorrow 9am", "in 3 hours", "in half an hour", "at 5pm", ` +
      `"day after tomorrow", "this evening", "next monday 6pm", "May 20", ` +
      `"Dec 25 at 3pm", "내일 오후 3시", "3일 후", "다음 주 월요일".`
    );
  }
  return relative.toISOString();
}

/**
 * Comparator that puts the task the user most needs to see at the
 * top: most-imminent dueAt first; tasks without a dueAt sink to the
 * bottom; createdAt-desc breaks remaining ties.
 *
 * Personal-JARVIS UX: when a user has 12 open tasks, "what's due
 * soonest?" is the only question that matters. The previous default
 * (creation-date desc) buried last week's hard deadline behind
 * today's quick capture. Use this with `[...tasks].sort(compareTasksByDueDate)`.
 */
export function compareTasksByDueDate(left: PersistedTask, right: PersistedTask): number {
  const leftDue = left.dueAt;
  const rightDue = right.dueAt;
  if (leftDue && rightDue) {
    // Compare parsed instants, not raw strings: `dueAt` is a
    // free-form string (imports / hand-edited tasks.json / the MCP
    // tool need not be canonical), and lexicographic ISO order is
    // wrong across mixed precision ("…00.500Z" sorts before "…00Z")
    // and timezone offsets — it would surface the wrong task as
    // "most urgent". Unparseable values keep the prior deterministic
    // string order.
    const leftMs = Date.parse(leftDue);
    const rightMs = Date.parse(rightDue);
    if (Number.isFinite(leftMs) && Number.isFinite(rightMs)) {
      if (leftMs !== rightMs) {
        return leftMs - rightMs;
      }
    } else if (leftDue !== rightDue) {
      return leftDue.localeCompare(rightDue);
    }
  } else if (leftDue) {
    return -1;
  } else if (rightDue) {
    return 1;
  }
  // Tie-breaker: most-recently-created first so a fresh quick
  // capture surfaces above stale undated cruft. Falls through to
  // ASC id for a deterministic order when both dueAt AND
  // createdAt are equal (bulk-import duplicates, fast successive
  // creates).
  return (right.createdAt ?? "").localeCompare(left.createdAt ?? "")
    || left.id.localeCompare(right.id);
}

function isPersistedTask(value: unknown): value is PersistedTask {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as PersistedTask;
  if (typeof candidate.id !== "string"
    || typeof candidate.title !== "string"
    || typeof candidate.createdAt !== "string"
    || (candidate.status !== "open" && candidate.status !== "done")) {
    return false;
  }
  if (candidate.dueAt !== undefined && typeof candidate.dueAt !== "string") {
    return false;
  }
  return true;
}
