import { atomicWriteFile } from "./atomic-file-store.js";
/**
 * Pure data layer for personal reminders (`~/.muse/reminders.json`).
 *
 * Three callers compose against this module:
 *   - REST routes in `apps/api/src/reminders-routes.ts`
 *   - CLI's `--local` mode in `apps/cli/src/commands-remind.ts`
 *   - `muse today` (both API and CLI local) — surfaces overdue +
 *     upcoming entries
 *
 * Reuses `parseTaskDueAt` for the dueAt parser because reminders
 * accept the same ISO-or-relative-phrase grammar as task dueAt.
 */

import { promises as fs } from "node:fs";

import type { JsonObject } from "@muse/shared";

import { formatDueLocal } from "@muse/mcp-shared";
import { withFileLock } from "./encrypted-file.js";
import { parseTaskDueAt } from "./personal-tasks-store.js";
import { quarantineCorruptStore } from "./store-quarantine.js";

export interface ReminderVia {
  readonly providerId: string;
  readonly destination: string;
}

export type ReminderRecurrence = "daily" | "weekly" | "monthly" | "yearly";

export interface PersistedReminder {
  readonly id: string;
  readonly text: string;
  readonly dueAt: string;
  readonly createdAt: string;
  readonly status: "pending" | "fired";
  readonly firedAt?: string;
  /**
   * When set, firing re-arms the reminder to its next occurrence
   * (dueAt + 1 day / 7 days, advanced past the fire time) and keeps it
   * pending instead of marking it fired — so "remind me every Monday"
   * keeps recurring. Fixed-interval (not calendar/DST-aware).
   */
  readonly recurrence?: ReminderRecurrence;
  /**
   * Optional per-reminder
   * routing override — when set, the firing loop ignores its
   * `providerId`/`destination` defaults and delivers via this
   * platform / chat instead. Useful when the user mixes channels
   * ("send the deploy alerts to Slack but the daily brief to
   * Telegram"); the daemon stays a single tick.
   */
  readonly via?: ReminderVia;
  /**
   * The calendar event this reminder is the "remind me before" heads-up for
   * (`muse calendar add --remind`). When the event is deleted, the linked
   * reminder is removed too — so a cancelled meeting can't keep firing.
   */
  readonly eventId?: string;
}

export type ReminderStatusFilter = "pending" | "fired" | "all" | "due";

export class ReminderStoreUnavailableError extends Error {
  constructor() {
    super("reminder store cannot be read or validated");
    this.name = "ReminderStoreUnavailableError";
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

/** Strict, non-mutating reader for exact-source and audit seams. Unlike the
 * recovery-oriented reader above, it never quarantines malformed bytes or
 * normalizes an unreadable/invalid store to an empty list. */
export async function readRemindersStrict(file: string): Promise<readonly PersistedReminder[]> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    throw new ReminderStoreUnavailableError();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new ReminderStoreUnavailableError();
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
    || Object.keys(parsed).join("\0") !== "reminders"
    || !Array.isArray((parsed as { reminders?: unknown }).reminders)) {
    throw new ReminderStoreUnavailableError();
  }
  const entries = (parsed as { reminders: unknown[] }).reminders;
  if (entries.some((entry) => !isPersistedReminderStrict(entry))) {
    throw new ReminderStoreUnavailableError();
  }
  const reminders = entries as readonly PersistedReminder[];
  if (new Set(reminders.map((reminder) => reminder.id)).size !== reminders.length) {
    throw new ReminderStoreUnavailableError();
  }
  return reminders;
}

/** Exact reminder lookup with strict, byte-preserving store semantics. */
export async function readReminderByIdStrict(file: string, id: string): Promise<PersistedReminder | undefined> {
  return (await readRemindersStrict(file)).find((reminder) => reminder.id === id);
}

/**
 * Serialized read-modify-write: run `fn` over the current reminders and persist
 * its result under a CROSS-PROCESS file lock, so the daemon's firing loop and a
 * chat `add` (separate processes) can't both read the same list, each append,
 * and clobber the other (last-writer-wins lost the unseen write). Returns the
 * persisted list. Every RMW caller must go through this, never read+write
 * directly.
 */
export async function mutateReminders(
  file: string,
  fn: (current: readonly PersistedReminder[]) => readonly PersistedReminder[] | Promise<readonly PersistedReminder[]>
): Promise<readonly PersistedReminder[]> {
  return withFileLock(file, async () => {
    const current = await readReminders(file);
    const next = await fn(current);
    if (next !== current) {
      await writeReminders(file, next);
    }
    return next;
  });
}

export async function writeReminders(file: string, reminders: readonly PersistedReminder[]): Promise<void> {
  const payload = `${JSON.stringify({ reminders }, null, 2)}\n`;
  await atomicWriteFile(file, payload);
}

export function serializeReminder(reminder: PersistedReminder): JsonObject {
  return {
    createdAt: reminder.createdAt,
    dueAt: reminder.dueAt,
    id: reminder.id,
    status: reminder.status,
    text: reminder.text,
    ...(reminder.recurrence ? { recurrence: reminder.recurrence } : {}),
    ...(reminder.firedAt ? { firedAt: reminder.firedAt } : {}),
    ...(reminder.via
      ? { via: { destination: reminder.via.destination, providerId: reminder.via.providerId } }
      : {}),
    ...(reminder.eventId ? { eventId: reminder.eventId } : {})
  };
}

/**
 * Reminder-named alias of the shared {@link formatDueLocal} — kept so the
 * existing reminder tests / batteries import a domain name.
 */
export const formatReminderDueLocal = formatDueLocal;

/**
 * The model-facing serialization. Identical to `serializeReminder`
 * (which the REST API / web UI use, and which format the time
 * themselves) plus a `dueAtLocal` field carrying the local wall-clock
 * time — so a chat confirmation echoes the time the user actually asked
 * for, not the UTC ISO hour. The REST path deliberately keeps the lean
 * `serializeReminder`; this enrichment is only for the LLM tool results.
 */
export function serializeReminderForModel(reminder: PersistedReminder, now: () => Date = () => new Date()): JsonObject {
  return { ...serializeReminder(reminder), dueAtLocal: formatDueLocal(reminder.dueAt, now) };
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

// Sentinels the chat model emits to mean "this is a one-time reminder" instead
// of just OMITTING `recurrence` as the schema asks. Treated as no recurrence.
const ONE_TIME_RECURRENCE_SENTINELS = new Set([
  "none", "once", "one-time", "one time", "one_time", "onetime", "single", "no", "never", "n/a", "false"
]);

/**
 * Deterministically normalize the model-supplied `recurrence` arg. Only
 * "daily"/"weekly" are real cadences; everything else maps to a ONE-SHOT
 * reminder — NEVER a hard error that drops the reminder entirely (a multi-step
 * "add the event AND remind me" request used to lose the reminder when the model
 * passed "none"/"once"). A one-time SENTINEL resolves silently; a genuinely
 * unsupported cadence ("monthly") still creates the one-shot but returns a `note`
 * so the caller can surface that the cadence wasn't applied. Repair, don't reject.
 */
export function normalizeReminderRecurrence(raw: string | undefined): { recurrence?: ReminderRecurrence; note?: string } {
  const value = raw?.trim();
  if (value === undefined || value.length === 0) {
    return {};
  }
  const lower = value.toLowerCase();
  if (lower === "daily" || lower === "weekly" || lower === "monthly" || lower === "yearly") {
    return { recurrence: lower };
  }
  if (ONE_TIME_RECURRENCE_SENTINELS.has(lower)) {
    return {};
  }
  return { note: `recurrence '${value}' isn't supported (only 'daily', 'weekly', 'monthly', or 'yearly'); created a one-time reminder` };
}

export type ReminderRefResolution =
  | { readonly status: "resolved"; readonly reminder: PersistedReminder }
  | { readonly status: "ambiguous"; readonly candidates: readonly PersistedReminder[] }
  | { readonly status: "not-found" };

/**
 * Resolve a model-supplied reminder reference to a single reminder. The chat
 * model refers to a reminder by its TEXT ("my dentist reminder"), not its id —
 * but snooze / fire / clear need a unique target, and the model fumbles the
 * 2-step "search to get the id, then act" chain (it passes the TEXT as the id →
 * "not found"). So resolve here: an exact id wins; otherwise a case-insensitive
 * substring match on the reminder text, preferring PENDING over already-fired
 * when both match. A UNIQUE match resolves; MULTIPLE matches are ambiguous
 * (return candidates, never act on a guess); none → not-found.
 */
export function resolveReminderRef(
  reminders: readonly PersistedReminder[],
  ref: string | undefined
): ReminderRefResolution {
  const trimmed = ref?.trim() ?? "";
  if (trimmed.length === 0) {
    return { status: "not-found" };
  }
  const byId = reminders.find((reminder) => reminder.id === trimmed);
  if (byId) {
    return { status: "resolved", reminder: byId };
  }
  const needle = trimmed.toLowerCase();
  const matches = reminders.filter((reminder) => reminder.text.toLowerCase().includes(needle));
  const pending = matches.filter((reminder) => reminder.status === "pending");
  const pool = pending.length > 0 ? pending : matches;
  if (pool.length === 1) {
    return { status: "resolved", reminder: pool[0]! };
  }
  if (pool.length > 1) {
    return { status: "ambiguous", candidates: pool };
  }
  return { status: "not-found" };
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
 * The next due timestamp for a recurring reminder: advance `dueAt` by
 * the recurrence period (1 / 7 days) to the first instant strictly
 * after `from` (the fire time), skipping any missed occurrences so a
 * reminder fired late — or after the daemon was off — re-arms to the
 * upcoming slot, not a backlog. Fixed-interval (not DST/calendar
 * aware). Returns `dueAt` unchanged if either timestamp is unparseable.
 */
export function nextReminderOccurrence(dueAt: string, recurrence: ReminderRecurrence, from: string): string {
  const due = Date.parse(dueAt);
  const fromMs = Date.parse(from);
  if (!Number.isFinite(due) || !Number.isFinite(fromMs)) {
    return dueAt;
  }
  if (recurrence === "monthly" || recurrence === "yearly") {
    // Calendar-aware (months vary 28–31 days; a year is 12 months): the Nth
    // occurrence is the original due day in `due` + N*step months, the day CLAMPED
    // to that month's length so a "31st" monthly (or "Feb 29th" yearly) reminder
    // lands on the LAST valid day of a short month (Feb 28) and RETURNS to the 31st
    // (or Feb 29 in a leap year) — computed from the ORIGINAL due each time so the
    // anchor day never drifts down. Advance N until strictly after `from` (skips
    // missed periods after daemon downtime).
    const stepMonths = recurrence === "yearly" ? 12 : 1;
    const dueDate = new Date(due);
    let n = 1;
    let next = addMonthsClamped(dueDate, stepMonths * n);
    while (next.getTime() <= fromMs) {
      n += 1;
      next = addMonthsClamped(dueDate, stepMonths * n);
    }
    return next.toISOString();
  }
  // Daily/weekly step in LOCAL days (setDate), not flat 86_400_000-ms ticks: across a DST
  // transition a real day is 23/25h, so flat-ms drifts a daily 09:00 reminder (rent, medication)
  // to 10:00/08:00 after the change. Step from the ORIGINAL due — like the monthly branch — and
  // advance until strictly after `from` (skips periods missed during daemon downtime).
  const stepDays = recurrence === "weekly" ? 7 : 1;
  const dueDate = new Date(due);
  let n = 1;
  let next = addLocalDays(dueDate, stepDays * n);
  while (next.getTime() <= fromMs) {
    n += 1;
    next = addLocalDays(dueDate, stepDays * n);
  }
  return next.toISOString();
}

// Advance a date by whole days in LOCAL time, preserving the wall-clock time across DST (the
// daily/weekly counterpart of addMonthsClamped's local-time stepping).
function addLocalDays(date: Date, days: number): Date {
  const d = new Date(date.getTime());
  d.setDate(d.getDate() + days);
  return d;
}

/**
 * Advance a date by `months`, clamping the day to the target month's length:
 * Jan 31 + 1 month → Feb 28 (or 29 on a leap year), NEVER rolled into March (the
 * default `Date.setMonth` overflow). Preserves the local clock time.
 */
function addMonthsClamped(date: Date, months: number): Date {
  const day = date.getDate();
  const result = new Date(date);
  result.setDate(1); // park on the 1st so setMonth can't overflow off a long day
  result.setMonth(result.getMonth() + months);
  const lastDayOfTargetMonth = new Date(result.getFullYear(), result.getMonth() + 1, 0).getDate();
  result.setDate(Math.min(day, lastDayOfTargetMonth));
  return result;
}

export function fireReminder(
  reminders: readonly PersistedReminder[],
  id: string,
  firedAt: string
): readonly PersistedReminder[] | undefined {
  const index = reminders.findIndex((reminder) => reminder.id === id);
  if (index < 0) {
    return undefined;
  }
  const current = reminders[index]!;
  // A recurring reminder re-arms to its next occurrence and stays
  // pending; a one-shot flips to fired. Delivery already happened in
  // the caller — this only advances the schedule.
  const updated: PersistedReminder = current.recurrence
    ? { ...current, dueAt: nextReminderOccurrence(current.dueAt, current.recurrence, firedAt), status: "pending" }
    : { ...current, firedAt, status: "fired" };
  const next = [...reminders];
  next[index] = updated;
  return next;
}

/** Re-arm a reminder for a later delivery, clearing its prior fire receipt. */
export function snoozeReminder(
  reminders: readonly PersistedReminder[],
  id: string,
  dueAt: string
): readonly PersistedReminder[] | undefined {
  const index = reminders.findIndex((reminder) => reminder.id === id);
  if (index < 0) {
    return undefined;
  }
  const { firedAt: _firedAt, ...pending } = reminders[index]!;
  const next = [...reminders];
  next[index] = { ...pending, dueAt, status: "pending" };
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
  if (candidate.recurrence !== undefined
    && candidate.recurrence !== "daily"
    && candidate.recurrence !== "weekly"
    && candidate.recurrence !== "monthly"
    && candidate.recurrence !== "yearly") {
    return false;
  }
  if (candidate.via !== undefined) {
    if (!candidate.via || typeof candidate.via !== "object"
      || typeof candidate.via.providerId !== "string"
      || typeof candidate.via.destination !== "string"
      || candidate.via.providerId.trim().length === 0
      || candidate.via.destination.trim().length === 0) {
      return false;
    }
  }
  if (candidate.eventId !== undefined && typeof candidate.eventId !== "string") {
    return false;
  }
  return true;
}

function isPersistedReminderStrict(value: unknown): value is PersistedReminder {
  if (!isPersistedReminder(value) || !value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as PersistedReminder;
  const allowed = ["createdAt", "dueAt", "eventId", "firedAt", "id", "recurrence", "status", "text", "via"];
  if (Object.keys(value).some((key) => !allowed.includes(key))) return false;
  if (!isCanonicalIso(candidate.createdAt) || !isCanonicalIso(candidate.dueAt)) return false;
  if (candidate.firedAt !== undefined && !isCanonicalIso(candidate.firedAt)) return false;
  if (candidate.via !== undefined && Object.keys(candidate.via).sort().join("\0") !== "destination\0providerId") return false;
  return true;
}

function isCanonicalIso(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}
