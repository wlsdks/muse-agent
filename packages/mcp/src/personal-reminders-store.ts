/**
 * Pure data layer for personal reminders (`~/.muse/reminders.json`).
 *
 * Three callers compose against this module:
 *   - REST routes in `apps/api/src/reminders-routes.ts`
 *   - CLI's `--local` mode in `apps/cli/src/commands-remind.ts`
 *   - `muse today` (both API and CLI local) — surfaces overdue +
 *     upcoming entries
 *
 * Reminders are passive in this iter — there's no daemon firing
 * messenger pushes. The contract leaves `firedAt` open so a future
 * iter can flip status to "fired" once an active firing loop ships.
 *
 * Reuses `parseTaskDueAt` for the dueAt parser because reminders
 * accept the same ISO-or-relative-phrase grammar as task dueAt.
 */

import { promises as fs } from "node:fs";
import { dirname } from "node:path";

import type { JsonObject } from "@muse/shared";

import { parseTaskDueAt } from "./personal-tasks-store.js";

export interface ReminderVia {
  readonly providerId: string;
  readonly destination: string;
}

export interface PersistedReminder {
  readonly id: string;
  readonly text: string;
  readonly dueAt: string;
  readonly createdAt: string;
  readonly status: "pending" | "fired";
  readonly firedAt?: string;
  /**
   * Phase C of docs/design/reminder-firing.md. Optional per-reminder
   * routing override — when set, the firing loop ignores its
   * `providerId`/`destination` defaults and delivers via this
   * platform / chat instead. Useful when the user mixes channels
   * ("send the deploy alerts to Slack but the daily brief to
   * Telegram"); the daemon stays a single tick.
   */
  readonly via?: ReminderVia;
}

export type ReminderStatusFilter = "pending" | "fired" | "all" | "due";

// Move a present-but-corrupt store aside so the next write
// starts fresh WITHOUT permanently destroying the user's prior
// reminders. Best-effort; the original bytes survive at
// `<file>.corrupt-<ts>` for manual recovery.
async function quarantineCorruptStore(file: string): Promise<void> {
  try {
    await fs.rename(file, `${file}.corrupt-${Date.now().toString()}`);
  } catch {
    // ignore — read still degrades to empty either way
  }
}

export async function readReminders(file: string): Promise<readonly PersistedReminder[]> {
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
  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { reminders?: unknown }).reminders)) {
    await quarantineCorruptStore(file);
    return [];
  }
  return (parsed as { reminders: unknown[] }).reminders.flatMap((entry): readonly PersistedReminder[] =>
    isPersistedReminder(entry) ? [entry] : []
  );
}

export async function writeReminders(file: string, reminders: readonly PersistedReminder[]): Promise<void> {
  const payload = `${JSON.stringify({ reminders }, null, 2)}\n`;
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await fs.mkdir(dirname(file), { recursive: true });
  await fs.writeFile(tmp, payload, { encoding: "utf8", mode: 0o600 });
  await fs.rename(tmp, file);
  await fs.chmod(file, 0o600).catch(() => undefined);
}

export function serializeReminder(reminder: PersistedReminder): JsonObject {
  return {
    createdAt: reminder.createdAt,
    dueAt: reminder.dueAt,
    id: reminder.id,
    status: reminder.status,
    text: reminder.text,
    ...(reminder.firedAt ? { firedAt: reminder.firedAt } : {}),
    ...(reminder.via
      ? { via: { destination: reminder.via.destination, providerId: reminder.via.providerId } }
      : {})
  };
}

export function readReminderStatusFilter(value: string | undefined): ReminderStatusFilter {
  if (value === "fired" || value === "all" || value === "due") {
    return value;
  }
  return "pending";
}

/**
 * Resolve a user-supplied reminder dueAt — same grammar as
 * `parseTaskDueAt`, just delegated for reuse.
 */
export function parseReminderDueAt(raw: string, now: () => Date): string | Error {
  return parseTaskDueAt(raw, now);
}

/**
 * Validate a `via` payload supplied by the REST route, the MCP
 * `add` tool, or any future `update` surface. Returns the cleaned
 * `{ providerId, destination }` (trimmed) or an Error explaining
 * what's wrong. Both fields must be present + non-empty strings.
 *
 * Returns `undefined` when the input is `undefined` so the caller
 * can use the result directly in an optional spread.
 */
export function parseReminderVia(raw: unknown): ReminderVia | Error | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (!raw || typeof raw !== "object") {
    return new Error("via must be an object with providerId + destination");
  }
  const candidate = raw as { providerId?: unknown; destination?: unknown };
  if (typeof candidate.providerId !== "string"
    || typeof candidate.destination !== "string"
    || candidate.providerId.trim().length === 0
    || candidate.destination.trim().length === 0) {
    return new Error("via.providerId and via.destination must be non-empty strings");
  }
  return { destination: candidate.destination.trim(), providerId: candidate.providerId.trim() };
}

/**
 * Flip a reminder pending → fired. Phase A of active firing
 * (see `docs/design/reminder-firing.md`): the LLM can call
 * `muse.reminders.fire` after it's delivered the reminder
 * through messaging, closing the loop without a daemon.
 *
 * Returns the new array (immutable, status flipped, `firedAt`
 * set) on success or `undefined` when no reminder matches `id`,
 * letting the caller surface its own 404.
 */
export function fireReminder(
  reminders: readonly PersistedReminder[],
  id: string,
  firedAt: string
): readonly PersistedReminder[] | undefined {
  const index = reminders.findIndex((reminder) => reminder.id === id);
  if (index < 0) {
    return undefined;
  }
  const fired: PersistedReminder = {
    ...reminders[index]!,
    firedAt,
    status: "fired"
  };
  const next = [...reminders];
  next[index] = fired;
  return next;
}

/**
 * Filter helper used by both the REST list endpoint and the CLI's
 * `--local` mode. `due` returns reminders whose dueAt is at or
 * before `now` AND status is still "pending" — i.e. things the
 * user should be reminded about right now.
 */
export function filterReminders(
  reminders: readonly PersistedReminder[],
  status: ReminderStatusFilter,
  now: () => Date
): readonly PersistedReminder[] {
  if (status === "all") {
    return [...reminders];
  }
  if (status === "due") {
    const cutoff = now().getTime();
    return reminders.filter(
      (entry) => entry.status === "pending" && Date.parse(entry.dueAt) <= cutoff
    );
  }
  return reminders.filter((entry) => entry.status === status);
}

/**
 * Soonest-due-first reminder ordering, parallel to
 * `compareTasksByDueDate`. Compare parsed instants, not raw
 * strings: `dueAt` is a free-form string (hand-edited
 * reminders.json / imports / REST need not be canonical) and
 * lexicographic ISO order is wrong across mixed precision
 * ("…00.500Z" sorts before "…00Z") and timezone offsets — it
 * would surface the wrong reminder as most imminent. Equal
 * instants break to newest-created-first; unparseable values keep
 * the prior deterministic string order.
 */
export function compareRemindersByDueAt(left: PersistedReminder, right: PersistedReminder): number {
  const leftMs = Date.parse(left.dueAt);
  const rightMs = Date.parse(right.dueAt);
  if (Number.isFinite(leftMs) && Number.isFinite(rightMs)) {
    if (leftMs !== rightMs) {
      return leftMs - rightMs;
    }
  } else if (left.dueAt !== right.dueAt) {
    return left.dueAt.localeCompare(right.dueAt);
  }
  return right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id);
}

function isPersistedReminder(value: unknown): value is PersistedReminder {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as PersistedReminder;
  if (typeof candidate.id !== "string"
    || typeof candidate.text !== "string"
    || typeof candidate.createdAt !== "string"
    || (candidate.status !== "pending" && candidate.status !== "fired")) {
    return false;
  }
  // dueAt must actually PARSE, not merely be a string: filterReminders
  // selects due entries with `Date.parse(dueAt) <= now`, and an
  // unparseable value yields NaN — `NaN <= now` is false, so a
  // hand-edited/imported reminders.json with a bad timestamp would
  // never fire and sit "pending" forever with no error. Drop it at
  // load, the posture isPersistedEvent / isPersistedFollowup use.
  if (typeof candidate.dueAt !== "string"
    || !Number.isFinite(Date.parse(candidate.dueAt))) {
    return false;
  }
  if (candidate.firedAt !== undefined && typeof candidate.firedAt !== "string") {
    return false;
  }
  if (candidate.via !== undefined) {
    if (!candidate.via || typeof candidate.via !== "object"
      || typeof candidate.via.providerId !== "string"
      || typeof candidate.via.destination !== "string") {
      return false;
    }
  }
  return true;
}
