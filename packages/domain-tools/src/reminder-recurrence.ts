import {
  hasTimeComponent,
  isTimeOnlyPhrase,
  isUtcMidnight,
  recurrenceFromPhrase,
  startOfLocalDay,
  withTimeOfDay
} from "@muse/mcp-shared";
import { normalizeReminderRecurrence, type ReminderRecurrence } from "@muse/stores";

/**
 * Non-tool-definition recurrence / due-date reconciliation logic lifted out
 * of `loopback-reminders.ts` — the `add` recurrence-arg resolver and the
 * `snooze` anchor + date-only reconciliation (both local-day/DST-sensitive).
 * `loopback-reminders.ts` keeps the MCP tool surface itself
 * (name/description/schema/execute wiring, byte-stable for tool-calling)
 * and re-exports the symbols below so its import sites stay unchanged.
 */

/**
 * Coerce, never reject: a one-time reminder whose `recurrence` the model
 * filled with "none"/"once" (instead of omitting) must still be CREATED, not
 * dropped. Deterministic fallback: when the local model fills the recurring
 * TIME ("매주 월요일 아침 9시") but FORGETS the `recurrence` arg, infer the
 * cadence from the phrase so a weekly reminder doesn't silently become
 * one-time. The explicit arg always wins.
 */
export function resolveRecurrenceForAdd(
  dueAtRaw: string,
  recurrenceArgRaw: string | undefined
): { recurrence?: ReminderRecurrence; note?: string } {
  const recurrenceArg = recurrenceArgRaw ?? recurrenceFromPhrase(dueAtRaw);
  return normalizeReminderRecurrence(recurrenceArg);
}

/**
 * A bare time-of-day ("오후 6시로 바꿔줘") on a still-FUTURE reminder keeps its
 * DATE — you're rescheduling it, not snoozing a firing one. A firing/overdue
 * reminder snoozes to later TODAY (now-anchor), the ordinary snooze meaning.
 * Date-bearing phrases resolve against now.
 */
export function resolveSnoozeAnchor(
  dueAtRaw: string,
  existingDueAt: Date,
  haveExisting: boolean,
  now: () => Date
): () => Date {
  return isTimeOnlyPhrase(dueAtRaw) && haveExisting && existingDueAt.getTime() > now().getTime()
    ? () => startOfLocalDay(existingDueAt)
    : now;
}

/**
 * A bare DATE ("다음 주 월요일로 옮겨줘") keeps the reminder's time-of-day, not
 * the resolver's default midnight. The UTC-midnight check excludes a
 * relative OFFSET ("in 30 minutes"), which resolves to now-plus-delta.
 */
export function reconcileSnoozeDueAt(
  dueAtRaw: string,
  parsedIso: string,
  existingDueAt: Date,
  haveExisting: boolean
): string {
  const isDateOnly = !/^\d{4}-\d{2}-\d{2}T/u.test(dueAtRaw) && !isTimeOnlyPhrase(dueAtRaw)
    && !hasTimeComponent(dueAtRaw) && isUtcMidnight(new Date(parsedIso));
  return isDateOnly && haveExisting
    ? withTimeOfDay(new Date(parsedIso), existingDueAt).toISOString()
    : parsedIso;
}
