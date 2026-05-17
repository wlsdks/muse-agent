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

import { resolveRelativeTimePhrase } from "./loopback-relative-time.js";

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

export async function writeTasks(file: string, tasks: readonly PersistedTask[]): Promise<void> {
  const payload = `${JSON.stringify({ tasks }, null, 2)}\n`;
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await fs.mkdir(dirname(file), { recursive: true });
  await fs.writeFile(tmp, payload, { encoding: "utf8", mode: 0o600 });
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

export function readTaskStatusFilter(value: string | undefined): TaskStatusFilter {
  return value === "done" || value === "all" ? value : "open";
}

/**
 * Resolve a user-supplied dueAt string. Accepts an ISO-8601 timestamp
 * starting with `YYYY-MM-DD…` or one of the relative phrases the MCP
 * tool advertises ("tomorrow at 6pm", "in 3 hours", "next Monday").
 * Returns the resolved ISO timestamp or an Error explaining why the
 * input was rejected — callers map that to their surface (HTTP 400,
 * MCP error response, CLI exit message).
 */
export function parseTaskDueAt(raw: string, now: () => Date): string | Error {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return new Error("dueAt is empty");
  }
  const isoParsed = new Date(trimmed);
  if (!Number.isNaN(isoParsed.getTime()) && /^\d{4}-\d{2}-\d{2}/u.test(trimmed)) {
    return isoParsed.toISOString();
  }
  const relative = resolveRelativeTimePhrase(trimmed, now);
  if (!relative) {
    return new Error(
      `dueAt must be an ISO-8601 timestamp or a supported relative phrase (got ${JSON.stringify(trimmed)}). ` +
      `Examples: "tomorrow 9am", "in 3 hours", "next monday 6pm", "내일 오후 3시", "3일 후", "다음 주 월요일".`
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
  // capture surfaces above stale undated cruft.
  return (right.createdAt ?? "").localeCompare(left.createdAt ?? "");
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
