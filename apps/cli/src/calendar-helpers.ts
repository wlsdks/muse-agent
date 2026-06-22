/**
 * Pure, commander-free helpers for the `muse calendar` command group —
 * the testable date/ics/availability logic, kept separate from the
 * command-registration surface in `commands-calendar.ts`.
 */

import { resolveRelativeTimePhrase, type AvailabilityEventLike, type AvailabilityResult } from "@muse/mcp-shared";
import { type PersistedReminder } from "@muse/stores";
import { detectCalendarConflicts, type CalendarConflict, type ConflictEventLike } from "@muse/domain-tools";

/**
 * Reduce-based min/max over a number array. `Math.min(...arr)` /
 * `Math.max(...arr)` spread every element as a call argument and
 * RangeError ("Maximum call stack size exceeded") once the array
 * exceeds the engine's argument-count limit (~65k-125k) — a large
 * `.ics` import (a multi-year calendar export) can hit that. The
 * reduce never spreads. Callers guard against the empty array;
 * the `Infinity` seeds are the documented empty-input fallback.
 */
export function minOfNumbers(values: readonly number[]): number {
  let min = Infinity;
  for (const value of values) {
    if (value < min) min = value;
  }
  return min;
}

export function maxOfNumbers(values: readonly number[]): number {
  let max = -Infinity;
  for (const value of values) {
    if (value > max) max = value;
  }
  return max;
}

export const clockOf = (d: Date): string => d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });

/**
 * Heads-up when a JUST-CREATED event overlaps existing ones — so `muse calendar
 * add` catches a double-booking the moment you make it, not later. The event is
 * still added; this only warns, naming each clashing event with its time.
 * Empty when there's no real overlap. Reuses `detectCalendarConflicts` (which
 * excludes back-to-back / touching events). Pure. Exported for testing.
 */
export function conflictWarningForNewEvent(
  newEvent: ConflictEventLike & { readonly allDay?: boolean },
  existing: readonly (ConflictEventLike & { readonly allDay?: boolean })[]
): string {
  // An all-day event is a date backdrop (holiday, birthday, vacation), not a
  // time slot — it spans the whole day and would "overlap" every timed event,
  // so it's never a double-booking. Skip them both ways (same as the briefing
  // imminent-conflict path), or `calendar add` cries double-book on every
  // meeting scheduled on a holiday.
  if (newEvent.allDay) {
    return "";
  }
  const timedExisting = existing.filter((e) => !e.allDay);
  const clashes = detectCalendarConflicts([newEvent, ...timedExisting])
    .filter((conflict) => conflict.a === newEvent || conflict.b === newEvent)
    .map((conflict) => (conflict.a === newEvent ? conflict.b : conflict.a));
  const unique: ConflictEventLike[] = [];
  for (const clash of clashes) {
    if (!unique.includes(clash)) {
      unique.push(clash);
    }
  }
  if (unique.length === 0) {
    return "";
  }
  const list = unique.map((event) => `"${event.title}" (${clockOf(event.startsAt)}–${clockOf(event.endsAt)})`).join(", ");
  return `⚠ Heads up — this overlaps ${list}. (Added anyway.)`;
}

/**
 * Build the "remind me N minutes before this event" reminder for `muse calendar
 * add --remind`. Due `minutesBefore` before the event start (clamped at 0 = at
 * start); the firing loop delivers it like any other reminder. Pure (id + now
 * injected for testability).
 */
export function buildEventReminder(
  title: string,
  eventStart: Date,
  minutesBefore: number,
  now: Date,
  id: string,
  eventId?: string
): PersistedReminder {
  const mins = Math.max(0, Math.trunc(minutesBefore));
  return {
    createdAt: now.toISOString(),
    dueAt: new Date(eventStart.getTime() - mins * 60_000).toISOString(),
    id,
    status: "pending",
    text: mins === 0 ? `${title} — starting now` : `${title} — in ${mins.toString()} min`,
    ...(eventId ? { eventId } : {})
  };
}

/**
 * Map a `--repeat` cadence word to the RRULE the local provider stores and
 * `expandRecurringEvent` understands (daily / weekly / monthly / yearly — the
 * engine's four FREQ cases, monthly/yearly day-clamped). Anything else returns
 * undefined so the caller rejects it loudly rather than creating an event that
 * never recurs.
 */
export function recurrenceRuleFor(cadence: string): string | undefined {
  const c = cadence.trim().toLowerCase();
  if (c === "daily") return "FREQ=DAILY";
  if (c === "weekly") return "FREQ=WEEKLY";
  if (c === "monthly") return "FREQ=MONTHLY";
  if (c === "yearly") return "FREQ=YEARLY";
  return undefined;
}

/**
 * Resolve a user-supplied event id (the short `[id]` from the listing, or
 * a full id) to one event: exact match wins, else a UNIQUE id-prefix.
 * Reports `ambiguous` (multiple prefix matches) or `none` rather than
 * guessing — so `delete` / `edit` never act on the wrong event.
 */
export function resolveEventIdMatch<T extends { readonly id: string }>(
  events: readonly T[],
  target: string
): { readonly kind: "match"; readonly event: T } | { readonly kind: "ambiguous"; readonly count: number } | { readonly kind: "none" } {
  const exact = events.find((event) => event.id === target);
  if (exact) {
    return { event: exact, kind: "match" };
  }
  const prefix = events.filter((event) => event.id.startsWith(target));
  if (prefix.length === 1) {
    return { event: prefix[0]!, kind: "match" };
  }
  return prefix.length > 1 ? { count: prefix.length, kind: "ambiguous" } : { kind: "none" };
}

/** Parse a `--at` value: an ISO-8601 timestamp OR a relative phrase ('tomorrow 3pm'). Returns undefined when neither. */
export function parseEventStart(raw: string, now: () => Date = () => new Date()): Date | undefined {
  if (/^\d{4}-\d{2}-\d{2}/u.test(raw)) {
    const parsed = new Date(raw);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed;
  }
  return resolveRelativeTimePhrase(raw, now);
}

function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}
function hhmm(date: Date): string {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/** Map an API/local event payload row to the availability engine's shape (skips rows with an unparseable time). */
export function eventsToAvailability(rows: ReadonlyArray<Record<string, unknown>>): AvailabilityEventLike[] {
  return rows.flatMap((row): AvailabilityEventLike[] => {
    const startsAt = typeof row.startsAtIso === "string" ? new Date(row.startsAtIso) : undefined;
    const endsAt = typeof row.endsAtIso === "string" ? new Date(row.endsAtIso) : undefined;
    if (!startsAt || !endsAt || Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime())) {
      return [];
    }
    return [{ allDay: row.allDay === true, endsAt, startsAt, title: typeof row.title === "string" ? row.title : "(busy)" }];
  });
}

/** Human free/busy summary for `muse calendar free`. */
export function formatAvailability(result: AvailabilityResult, window: { readonly from: Date; readonly to: Date }): string {
  if (result.fullyFree) {
    return `Free all of ${hhmm(window.from)}–${hhmm(window.to)}.`;
  }
  const busy = result.busy
    .map((block) => `${hhmm(block.startsAt)}–${hhmm(block.endsAt)} ${block.titles.join(", ")}`)
    .join("; ");
  const free = result.free.length > 0
    ? result.free.map((slot) => `${hhmm(slot.startsAt)}–${hhmm(slot.endsAt)}`).join(", ")
    : "none";
  return `Busy: ${busy}\nFree: ${free}`;
}

export function formatConflicts(conflicts: readonly CalendarConflict[]): string {
  if (conflicts.length === 0) {
    return "No double-booked events. ✓\n";
  }
  const lines = [`⚠️  ${conflicts.length.toString()} double-booking${conflicts.length === 1 ? "" : "s"}:`];
  for (const c of conflicts) {
    lines.push(`  "${c.a.title}" (${hhmm(c.a.startsAt)}–${hhmm(c.a.endsAt)}) overlaps "${c.b.title}" (${hhmm(c.b.startsAt)}–${hhmm(c.b.endsAt)}) at ${hhmm(c.overlapStartsAt)}–${hhmm(c.overlapEndsAt)}`);
  }
  return `${lines.join("\n")}\n`;
}
