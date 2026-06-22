/**
 * Parse a whole iCalendar (`.ics`) document into CalendarEvents.
 *
 * A real beachhead user exports their calendar to a local `.ics` file
 * (Google/Apple "export"), so Muse can read it WITHOUT any cloud/CalDAV
 * round-trip. This splits the VCALENDAR into its VEVENT blocks and reuses the
 * proven CalDAV `parseVEvent` for each (UID/SUMMARY/DTSTART/DTEND, all-day,
 * TZID). Tolerant: a malformed VEVENT is skipped, never throwing.
 */
import { parseVEvent } from "./caldav-ics.js";
import type { CalendarEvent } from "./types.js";

/** Every VEVENT in `icsText` as a CalendarEvent, sorted by start; bad ones skipped. */
export function parseIcsCalendar(icsText: string, providerId: string): readonly CalendarEvent[] {
  const blocks = icsText.match(/BEGIN:VEVENT[\s\S]*?END:VEVENT/gu) ?? [];
  return blocks
    .map((block, index) => parseVEvent(block, providerId, `${providerId}-${index.toString()}`))
    .filter((event): event is CalendarEvent => event !== undefined)
    .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
}

const MAX_RECURRENCE_INSTANCES = 200;

interface ParsedRrule {
  readonly freq: "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";
  readonly interval: number;
  readonly count?: number;
  readonly until?: number; // ms-epoch
}

/** Parse FREQ=DAILY|WEEKLY|MONTHLY|YEARLY RRULE forms (INTERVAL/COUNT/UNTIL); others ⇒ undefined. */
function parseRrule(rrule: string): ParsedRrule | undefined {
  const parts = new Map(rrule.split(";").map((p) => {
    const [k, v] = p.split("=");
    return [(k ?? "").toUpperCase().trim(), (v ?? "").trim()] as const;
  }));
  const freq = parts.get("FREQ");
  if (freq !== "DAILY" && freq !== "WEEKLY" && freq !== "MONTHLY" && freq !== "YEARLY") {
    return undefined; // the calendar cadences we expand — never guess BYDAY/BYSETPOS etc.
  }
  const interval = Math.max(1, Number(parts.get("INTERVAL") ?? "1") || 1);
  const countRaw = parts.get("COUNT");
  const count = countRaw ? Math.max(1, Number(countRaw) || 1) : undefined;
  const untilRaw = parts.get("UNTIL");
  const until = untilRaw ? parseUntil(untilRaw) : undefined;
  return { freq, interval, ...(count !== undefined ? { count } : {}), ...(until !== undefined ? { until } : {}) };
}

/** ICS UNTIL — `20261231T235959Z` or `20261231` → ms-epoch. */
function parseUntil(value: string): number | undefined {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z?)?$/u.exec(value);
  if (!m) return undefined;
  const t = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4] ?? "23"}:${m[5] ?? "59"}:${m[6] ?? "59"}Z`);
  return Number.isNaN(t) ? undefined : t;
}

/**
 * Advance a date by `months`, clamping the day to the target month's length so
 * Jan 31 + 1 month → Feb 28 (or 29 on a leap year), never rolled into March.
 * Steps in UTC — consistent with the DAILY/WEEKLY ms-offset stepping and
 * timezone-deterministic — preserving the UTC clock time.
 */
function addMonthsClamped(date: Date, months: number): Date {
  const day = date.getUTCDate();
  const result = new Date(date);
  result.setUTCDate(1); // park on the 1st so setUTCMonth can't overflow off a long day
  result.setUTCMonth(result.getUTCMonth() + months);
  const lastDayOfTargetMonth = new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)).getUTCDate();
  result.setUTCDate(Math.min(day, lastDayOfTargetMonth));
  return result;
}

/** The i-th occurrence's start, computed from the BASE (not cumulatively) so a
 *  monthly Jan-31 series stays 31st-or-clamped each month rather than drifting. */
function occurrenceStart(base: Date, rule: ParsedRrule, i: number): Date {
  if (rule.freq === "DAILY") return new Date(base.getTime() + i * rule.interval * 86_400_000);
  if (rule.freq === "WEEKLY") return new Date(base.getTime() + i * rule.interval * 7 * 86_400_000);
  if (rule.freq === "MONTHLY") return addMonthsClamped(base, i * rule.interval);
  return addMonthsClamped(base, i * rule.interval * 12); // YEARLY
}

/**
 * Index of the first occurrence whose end can fall at/after `fromMs`, so the
 * MAX_RECURRENCE_INSTANCES cap is spent on the QUERY WINDOW, not exhausted
 * stepping through years of past occurrences before reaching it. Computed by
 * integer arithmetic from the fixed period (the cadence's average ms for
 * MONTHLY/YEARLY); deliberately UNDER-estimates (floor, then back off one) so
 * day-clamping / month-length variance never skips a real in-window instance.
 */
function firstWindowIndex(base: Date, rule: ParsedRrule, fromMs: number, durationMs: number): number {
  const baseMs = base.getTime();
  const earliestStartMs = fromMs - durationMs; // an occurrence whose end ≥ fromMs may start this early
  if (earliestStartMs <= baseMs) return 0;
  const dayMs = 86_400_000;
  const periodMs =
    rule.freq === "DAILY" ? rule.interval * dayMs
    : rule.freq === "WEEKLY" ? rule.interval * 7 * dayMs
    : rule.freq === "MONTHLY" ? rule.interval * 30 * dayMs
    : rule.freq === "YEARLY" ? rule.interval * 365 * dayMs
    : dayMs;
  const estimate = Math.floor((earliestStartMs - baseMs) / periodMs);
  return Math.max(0, estimate - 1); // back off one so an under-count from clamping can't skip an instance
}

/**
 * Expand a recurring event into the instances that fall within `[from, to]`.
 * Non-recurring (or an unsupported RRULE) ⇒ the event unchanged. Handles
 * FREQ=DAILY/WEEKLY/MONTHLY/YEARLY (+INTERVAL/COUNT/UNTIL) — monthly/yearly step
 * by calendar months with day-clamping, the rest by fixed offset — so "when's my
 * weekly standup / monthly rent?" surfaces the NEXT instance even when the base
 * DTSTART is in the past. Capped so a never-ending rule can't blow up. Deterministic.
 */
export function expandRecurringEvent(event: CalendarEvent, from: Date, to: Date): readonly CalendarEvent[] {
  if (!event.recurrence) {
    return [event];
  }
  const rule = parseRrule(event.recurrence);
  if (!rule) {
    return [event]; // unsupported RRULE — surface the base event, never fabricate instances
  }
  const base = event.startsAt;
  const durationMs = event.endsAt.getTime() - base.getTime();
  const fromMs = from.getTime();
  const toMs = to.getTime();
  const out: CalendarEvent[] = [];
  const firstIndex = firstWindowIndex(base, rule, fromMs, durationMs);
  for (let n = 0, i = firstIndex; n < MAX_RECURRENCE_INSTANCES; n += 1, i += 1) {
    if (rule.count !== undefined && i >= rule.count) break;
    const startMs = occurrenceStart(base, rule, i).getTime();
    if (rule.until !== undefined && startMs > rule.until) break;
    if (startMs > toMs) break;
    const endMs = startMs + durationMs;
    if (endMs >= fromMs) {
      out.push({ ...event, endsAt: new Date(endMs), id: `${event.id}-${i.toString()}`, startsAt: new Date(startMs) });
    }
  }
  return out;
}
