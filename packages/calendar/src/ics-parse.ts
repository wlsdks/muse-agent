/**
 * Parse a whole iCalendar (`.ics`) document into CalendarEvents.
 *
 * A real beachhead user exports their calendar to a local `.ics` file
 * (Google/Apple "export"), so Muse can read it WITHOUT any cloud/CalDAV
 * round-trip. This splits the VCALENDAR into its VEVENT blocks and reuses the
 * proven CalDAV `parseVEvent` for each (UID/SUMMARY/DTSTART/DTEND, all-day,
 * TZID). Tolerant: a malformed VEVENT is skipped, never throwing.
 */
import { parseVEvent } from "./caldav-provider.js";
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
  readonly freq: "DAILY" | "WEEKLY";
  readonly interval: number;
  readonly count?: number;
  readonly until?: number; // ms-epoch
}

/** Parse the common FREQ=DAILY|WEEKLY RRULE forms (INTERVAL/COUNT/UNTIL); others ⇒ undefined. */
function parseRrule(rrule: string): ParsedRrule | undefined {
  const parts = new Map(rrule.split(";").map((p) => {
    const [k, v] = p.split("=");
    return [(k ?? "").toUpperCase().trim(), (v ?? "").trim()] as const;
  }));
  const freq = parts.get("FREQ");
  if (freq !== "DAILY" && freq !== "WEEKLY") {
    return undefined; // only the dominant daily/weekly cases — never guess the rest
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
 * Expand a recurring event into the instances that fall within `[from, to]`.
 * Non-recurring (or an unsupported RRULE) ⇒ the event unchanged. Handles the
 * dominant FREQ=DAILY/WEEKLY (+INTERVAL/COUNT/UNTIL) so "when's my weekly
 * standup?" surfaces the NEXT instance even though the base VEVENT's DTSTART is
 * in the past. Capped so a never-ending rule can't blow up. Deterministic.
 */
export function expandRecurringEvent(event: CalendarEvent, from: Date, to: Date): readonly CalendarEvent[] {
  if (!event.recurrence) {
    return [event];
  }
  const rule = parseRrule(event.recurrence);
  if (!rule) {
    return [event]; // unsupported RRULE — surface the base event, never fabricate instances
  }
  const stepMs = (rule.freq === "DAILY" ? 1 : 7) * rule.interval * 24 * 60 * 60 * 1000;
  const durationMs = event.endsAt.getTime() - event.startsAt.getTime();
  const fromMs = from.getTime();
  const toMs = to.getTime();
  const out: CalendarEvent[] = [];
  let startMs = event.startsAt.getTime();
  for (let i = 0; i < MAX_RECURRENCE_INSTANCES; i += 1) {
    if (rule.count !== undefined && i >= rule.count) break;
    if (rule.until !== undefined && startMs > rule.until) break;
    if (startMs > toMs) break;
    const endMs = startMs + durationMs;
    if (endMs >= fromMs) {
      out.push({ ...event, endsAt: new Date(endMs), id: `${event.id}-${i.toString()}`, startsAt: new Date(startMs) });
    }
    startMs += stepMs;
  }
  return out;
}
