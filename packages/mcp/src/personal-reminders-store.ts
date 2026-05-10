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

export interface PersistedReminder {
  readonly id: string;
  readonly text: string;
  readonly dueAt: string;
  readonly createdAt: string;
  readonly status: "pending" | "fired";
  readonly firedAt?: string;
}

export type ReminderStatusFilter = "pending" | "fired" | "all" | "due";

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
    return [];
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { reminders?: unknown }).reminders)) {
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
  await fs.writeFile(tmp, payload, "utf8");
  await fs.rename(tmp, file);
}

export function serializeReminder(reminder: PersistedReminder): JsonObject {
  return {
    createdAt: reminder.createdAt,
    dueAt: reminder.dueAt,
    id: reminder.id,
    status: reminder.status,
    text: reminder.text,
    ...(reminder.firedAt ? { firedAt: reminder.firedAt } : {})
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

function isPersistedReminder(value: unknown): value is PersistedReminder {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as PersistedReminder;
  if (typeof candidate.id !== "string"
    || typeof candidate.text !== "string"
    || typeof candidate.dueAt !== "string"
    || typeof candidate.createdAt !== "string"
    || (candidate.status !== "pending" && candidate.status !== "fired")) {
    return false;
  }
  if (candidate.firedAt !== undefined && typeof candidate.firedAt !== "string") {
    return false;
  }
  return true;
}
