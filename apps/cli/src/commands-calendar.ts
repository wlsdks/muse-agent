/**
 * `muse calendar` command group — read-only slice of `/api/calendar/*`.
 *
 *   - `muse calendar providers [--local] [--json]`
 *   - `muse calendar events [--from <iso>] [--to <iso>] [--provider <id>] [--local] [--json]`
 *
 * `--local` instantiates `LocalCalendarProvider` against
 * `~/.muse/calendar.json` directly so the CLI works without an API
 * server. OAuth (Google) and CalDAV providers stay API-only — they
 * need credential bootstrapping that's owned by the runtime
 * assembly.
 */

import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

import { resolveLocalCalendarFile, resolveRemindersFile, resolveWeaknessesFile } from "@muse/autoconfigure";
import { eventsToIcs, LocalCalendarProvider, type CalendarEvent, type IcsEvent } from "@muse/calendar";
import { computeAvailability, detectCalendarConflicts, readReminders, recordTimeParseWeakness, recordWeakness, resolveRelativeTimePhrase, writeReminders, type AvailabilityEventLike, type AvailabilityResult, type CalendarConflict, type ConflictEventLike, type PersistedReminder, removeRemindersForEvent, rescheduleRemindersForEvent } from "@muse/mcp";
export { removeRemindersForEvent, rescheduleRemindersForEvent } from "@muse/mcp";
import type { Command } from "commander";

import { analyzeFocusWindows, buildDayWindows, findFirstFreeBlock, formatFocus } from "./calendar-focus.js";
import { formatCalendarEvents, formatProvidersList } from "./human-formatters.js";
import { parseIcsEvents } from "./ics-parser.js";
import { withApiLocalFallback } from "./program-helpers.js";
import type { ProgramIO } from "./program.js";

export interface CalendarCommandHelpers {
  readonly apiRequest: (
    io: ProgramIO,
    command: Command,
    path: string,
    body?: Record<string, unknown>,
    method?: "GET" | "POST" | "PUT" | "DELETE"
  ) => Promise<unknown>;
  readonly writeOutput: (io: ProgramIO, value: unknown, textField?: string) => void;
}

interface SharedOptions {
  readonly local?: boolean;
  readonly json?: boolean;
}

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

function localCalendarProvider(): LocalCalendarProvider {
  const file = resolveLocalCalendarFile(process.env as Record<string, string | undefined>);
  return new LocalCalendarProvider({ file });
}

const clockOf = (d: Date): string => d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });

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

/** Events across a wide (±10y) window — enough to resolve any realistic personal event by id. */
function listLocalEventsWide(provider: LocalCalendarProvider): Promise<readonly CalendarEvent[]> {
  const now = Date.now();
  return Promise.resolve(provider.listEvents({ from: new Date(now - 3650 * 86_400_000), to: new Date(now + 3650 * 86_400_000) }));
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

export function registerCalendarCommands(program: Command, io: ProgramIO, helpers: CalendarCommandHelpers): void {
  const calendar = program.command("calendar").description("Personal calendar (read-only CLI surface)");

  calendar
    .command("providers")
    .description("List configured calendar providers (--local skips the API and reports the local file backend)")
    .option("--local", "Describe the local-file calendar provider instead of querying the API")
    .option("--json", "Print the raw response instead of the formatted list")
    .action(async (options: SharedOptions, command) => {
      const payload = await withApiLocalFallback(
        io,
        Boolean(options.local),
        async () => ({ providers: [localCalendarProvider().describe()] }) as Record<string, unknown>,
        async () => (await helpers.apiRequest(io, command, "/api/calendar/providers")) as Record<string, unknown>,
        "calendar"
      );
      if (options.json) {
        helpers.writeOutput(io, payload);
        return;
      }
      const providers = (payload as { providers?: Parameters<typeof formatProvidersList>[1] }).providers ?? [];
      io.stdout(formatProvidersList("Calendar providers", providers));
    });

  calendar
    .command("events")
    .description("List events between --from and --to (defaults: now → +30 days; --local hits the local file)")
    .option("--from <iso>", "ISO 8601 start (default: now)")
    .option("--to <iso>", "ISO 8601 end (default: now + 30 days)")
    .option("--provider <id>", "Specific provider id (default: all)")
    .option("--local", "Read directly from the local calendar file instead of the API")
    .option("--json", "Print the raw response instead of the day-grouped agenda")
    .action(async (
      options: { readonly from?: string; readonly to?: string; readonly provider?: string } & SharedOptions,
      command
    ) => {
      // Validate up front so the API path rejects a bad timestamp
      // with the same actionable error as --local, instead of
      // forwarding garbage to the server as a silently-wrong window.
      if (
        (options.from && Number.isNaN(new Date(options.from).getTime())) ||
        (options.to && Number.isNaN(new Date(options.to).getTime()))
      ) {
        throw new Error("--from / --to must be ISO 8601 timestamps");
      }
      const readLocal = async (): Promise<Record<string, unknown>> => {
        const from = options.from ? new Date(options.from) : new Date();
        const to = options.to
          ? new Date(options.to)
          : new Date(from.getTime() + 30 * 24 * 3_600_000);
        const raw = await localCalendarProvider().listEvents({ from, to });
        // The provider speaks `Date` instances; the API serializes them
        // as `startsAtIso`/`endsAtIso`. Normalise to the API shape so
        // `formatCalendarEvents` and `--json` emit consistent output
        // regardless of mode.
        const events = raw.map((event) => ({
          endsAtIso: event.endsAt.toISOString(),
          id: event.id,
          providerId: event.providerId,
          startsAtIso: event.startsAt.toISOString(),
          title: event.title,
          ...(event.allDay ? { allDay: true } : {}),
          ...(event.location ? { location: event.location } : {}),
          ...(event.notes ? { notes: event.notes } : {}),
          ...(event.tags && event.tags.length > 0 ? { tags: event.tags } : {})
        }));
        return { events, total: events.length };
      };
      const readApi = async (): Promise<Record<string, unknown>> => {
        const params = new URLSearchParams();
        if (options.from) {
          params.set("fromIso", options.from);
        }
        if (options.to) {
          params.set("toIso", options.to);
        }
        if (options.provider) {
          params.set("providerId", options.provider);
        }
        const query = params.toString();
        const path = query.length > 0 ? `/api/calendar/events?${query}` : "/api/calendar/events";
        return (await helpers.apiRequest(io, command, path)) as Record<string, unknown>;
      };
      const payload = await withApiLocalFallback(io, Boolean(options.local), readLocal, readApi, "calendar");
      if (options.json) {
        helpers.writeOutput(io, payload);
        return;
      }
      io.stdout(formatCalendarEvents(payload as unknown as Parameters<typeof formatCalendarEvents>[0]));
    });

  calendar
    .command("export")
    .description("Export events to iCalendar (.ics) — to --out <file> or stdout, for any calendar app")
    .option("--from <iso>", "ISO 8601 start (default: now)")
    .option("--to <iso>", "ISO 8601 end (default: now + 365 days)")
    .option("--provider <id>", "Specific provider id (default: all)")
    .option("--out <file>", "Write the .ics to this path (default: stdout)")
    .option("--local", "Read directly from the local calendar file instead of the API")
    .action(async (
      options: { readonly from?: string; readonly to?: string; readonly provider?: string; readonly out?: string; readonly local?: boolean },
      command
    ) => {
      if (
        (options.from && Number.isNaN(new Date(options.from).getTime())) ||
        (options.to && Number.isNaN(new Date(options.to).getTime()))
      ) {
        throw new Error("--from / --to must be ISO 8601 timestamps");
      }
      const events = await withApiLocalFallback<readonly IcsEvent[]>(
        io,
        Boolean(options.local),
        async () => {
          const from = options.from ? new Date(options.from) : new Date();
          const to = options.to ? new Date(options.to) : new Date(from.getTime() + 365 * 24 * 3_600_000);
          return localCalendarProvider().listEvents({ from, to });
        },
        async () => {
          const params = new URLSearchParams();
          if (options.from) params.set("fromIso", options.from);
          if (options.to) params.set("toIso", options.to);
          if (options.provider) params.set("providerId", options.provider);
          const query = params.toString();
          const path = query.length > 0 ? `/api/calendar/events?${query}` : "/api/calendar/events";
          const payload = (await helpers.apiRequest(io, command, path)) as { readonly events?: readonly Record<string, unknown>[] };
          return (payload.events ?? []).map((raw) => ({
            id: typeof raw.id === "string" ? raw.id : "",
            title: typeof raw.title === "string" ? raw.title : "(untitled)",
            startsAt: new Date(String(raw.startsAtIso ?? raw.startsAt)),
            endsAt: new Date(String(raw.endsAtIso ?? raw.endsAt)),
            ...(raw.allDay === true ? { allDay: true } : {}),
            ...(typeof raw.location === "string" ? { location: raw.location } : {}),
            ...(typeof raw.notes === "string" ? { notes: raw.notes } : {})
          }));
        },
        "calendar"
      );
      const ics = eventsToIcs(events);
      if (options.out) {
        await writeFile(options.out, ics, "utf8");
        io.stdout(`Exported ${events.length.toString()} event(s) to ${options.out}\n`);
        return;
      }
      io.stdout(ics);
    });

  calendar
    .command("free")
    .description("Show free/busy in a window — 'am I free?' / find a gap. Defaults: now → +8 hours.")
    .option("--from <iso>", "ISO 8601 window start (default: now)")
    .option("--to <iso>", "ISO 8601 window end (default: from + 8 hours)")
    .option("--min-minutes <n>", "Only show free gaps at least this many minutes long")
    .option("--provider <id>", "Specific provider id (default: all)")
    .option("--local", "Read directly from the local calendar file instead of the API")
    .option("--json", "Print the raw availability result instead of the formatted summary")
    .action(async (
      options: { readonly from?: string; readonly to?: string; readonly minMinutes?: string; readonly provider?: string } & SharedOptions,
      command
    ) => {
      if (
        (options.from && Number.isNaN(new Date(options.from).getTime())) ||
        (options.to && Number.isNaN(new Date(options.to).getTime()))
      ) {
        throw new Error("--from / --to must be ISO 8601 timestamps");
      }
      const minMinutes = options.minMinutes !== undefined ? Number(options.minMinutes) : undefined;
      if (minMinutes !== undefined && !Number.isFinite(minMinutes)) {
        throw new Error("--min-minutes must be a number");
      }
      const from = options.from ? new Date(options.from) : new Date();
      const to = options.to ? new Date(options.to) : new Date(from.getTime() + 8 * 3_600_000);
      const rows = await withApiLocalFallback<Array<Record<string, unknown>>>(
        io,
        Boolean(options.local),
        async () => (await localCalendarProvider().listEvents({ from, to })).map((event) => ({
          allDay: event.allDay,
          endsAtIso: event.endsAt.toISOString(),
          startsAtIso: event.startsAt.toISOString(),
          title: event.title
        })),
        async () => {
          const params = new URLSearchParams({ fromIso: from.toISOString(), toIso: to.toISOString() });
          if (options.provider) params.set("providerId", options.provider);
          const payload = (await helpers.apiRequest(io, command, `/api/calendar/events?${params.toString()}`)) as { events?: Array<Record<string, unknown>> };
          return Array.isArray(payload.events) ? payload.events : [];
        },
        "calendar"
      );
      const result = computeAvailability(eventsToAvailability(rows), { from, to }, minMinutes !== undefined ? { minFreeMinutes: minMinutes } : {});
      if (options.json) {
        helpers.writeOutput(io, {
          busy: result.busy.map((b) => ({ endsAtIso: b.endsAt.toISOString(), startsAtIso: b.startsAt.toISOString(), titles: b.titles })),
          free: result.free.map((s) => ({ endsAtIso: s.endsAt.toISOString(), startsAtIso: s.startsAt.toISOString() })),
          fullyFree: result.fullyFree
        });
        return;
      }
      io.stdout(formatAvailability(result, { from, to }));
    });

  calendar
    .command("focus")
    .description("Your longest uninterrupted free block each day — protect deep work, since fragmented time can't (attention residue, Leroy 2009). Read-only, deterministic, no model. e.g. `muse calendar focus --days 5`")
    .option("--days <n>", "How many days from today to analyze (default 5)")
    .option("--start <hour>", "Working-hours start hour 0-23 (default 9)")
    .option("--end <hour>", "Working-hours end hour 0-23 (default 18)")
    .option("--min-minutes <n>", "Deep-work block threshold in minutes (default 60)")
    .option("--local", "Read directly from the local calendar file instead of the API")
    .option("--json", "Print the structured result")
    .action(async (
      options: { readonly days?: string; readonly start?: string; readonly end?: string; readonly minMinutes?: string } & SharedOptions,
      command
    ) => {
      const parseInt0 = (raw: string | undefined, label: string, lo: number, hi: number, dflt: number): number => {
        if (raw === undefined) return dflt;
        const n = Number(raw.trim());
        if (!Number.isInteger(n) || n < lo || n > hi) throw new Error(`${label} must be an integer in [${lo.toString()}, ${hi.toString()}]`);
        return n;
      };
      const days = parseInt0(options.days, "--days", 1, 60, 5);
      const startHour = parseInt0(options.start, "--start", 0, 23, 9);
      const endHour = parseInt0(options.end, "--end", 1, 24, 18);
      const minMinutes = parseInt0(options.minMinutes, "--min-minutes", 1, 1440, 60);
      const windows = buildDayWindows(new Date(), days, startHour, endHour);
      if (windows.length === 0) {
        throw new Error("--end must be after --start");
      }
      const rangeFrom = windows[0]!.from;
      const rangeTo = windows[windows.length - 1]!.to;
      const rows = await withApiLocalFallback<Array<Record<string, unknown>>>(
        io,
        Boolean(options.local),
        async () => (await localCalendarProvider().listEvents({ from: rangeFrom, to: rangeTo })).map((event) => ({
          allDay: event.allDay,
          endsAtIso: event.endsAt.toISOString(),
          startsAtIso: event.startsAt.toISOString(),
          title: event.title
        })),
        async () => {
          const params = new URLSearchParams({ fromIso: rangeFrom.toISOString(), toIso: rangeTo.toISOString() });
          const payload = (await helpers.apiRequest(io, command, `/api/calendar/events?${params.toString()}`)) as { events?: Array<Record<string, unknown>> };
          return Array.isArray(payload.events) ? payload.events : [];
        },
        "calendar"
      );
      const result = analyzeFocusWindows(eventsToAvailability(rows), windows, minMinutes);
      if (options.json) {
        helpers.writeOutput(io, {
          days: result.map((d) => ({
            dayStart: d.dayStart.toISOString(),
            fragmented: d.fragmented,
            longestFreeMinutes: d.longestFreeMinutes,
            meetingCount: d.meetingCount,
            totalFreeMinutes: d.totalFreeMinutes
          }))
        });
        return;
      }
      io.stdout(formatFocus(result, minMinutes));
    });

  calendar
    .command("block")
    .description("Protect focus time — Muse finds your earliest free block long enough and CREATES a calendar event to hold it (time-blocking / implementation intentions, Gollwitzer 1999). Writes to your LOCAL calendar; undo with `calendar delete`. e.g. `muse calendar block \"write the report\" --duration 90`")
    .argument("<title...>", "What the block is for, e.g. 'write the report'")
    .option("--duration <min>", "Block length in minutes (default 60)")
    .option("--days <n>", "How many days ahead to search for a slot (default 5)")
    .option("--start <hour>", "Working-hours start hour 0-23 (default 9)")
    .option("--end <hour>", "Working-hours end hour 1-24 (default 18)")
    .option("--json", "Print the created event as JSON")
    .action(async (
      titleParts: readonly string[],
      options: { readonly duration?: string; readonly days?: string; readonly start?: string; readonly end?: string; readonly json?: boolean }
    ) => {
      const title = titleParts.join(" ").trim();
      if (title.length === 0) {
        throw new Error("muse calendar block: a non-empty title is required");
      }
      const parseIntOpt = (raw: string | undefined, label: string, lo: number, hi: number, dflt: number): number => {
        if (raw === undefined) return dflt;
        const n = Number(raw.trim());
        if (!Number.isInteger(n) || n < lo || n > hi) throw new Error(`${label} must be an integer in [${lo.toString()}, ${hi.toString()}]`);
        return n;
      };
      const duration = parseIntOpt(options.duration, "--duration", 1, 1440, 60);
      const days = parseIntOpt(options.days, "--days", 1, 60, 5);
      const startHour = parseIntOpt(options.start, "--start", 0, 23, 9);
      const endHour = parseIntOpt(options.end, "--end", 1, 24, 18);
      const windows = buildDayWindows(new Date(), days, startHour, endHour);
      if (windows.length === 0) {
        throw new Error("--end must be after --start");
      }
      const provider = localCalendarProvider();
      const events = await provider.listEvents({ from: windows[0]!.from, to: windows[windows.length - 1]!.to });
      const block = findFirstFreeBlock(events, windows, duration, new Date());
      if (!block) {
        io.stderr(`muse calendar block: no free ${duration.toString()}-minute block in the next ${days.toString()} day(s) within ${startHour.toString()}:00-${endHour.toString()}:00 — your calendar is full. Try a shorter --duration or a wider --days.\n`);
        process.exitCode = 1;
        return;
      }
      const event = await provider.createEvent({ endsAt: block.to, startsAt: block.from, title });
      const when = block.from.toLocaleString("en-US", { day: "numeric", hour: "numeric", minute: "2-digit", month: "short", weekday: "short" });
      if (options.json) {
        helpers.writeOutput(io, { endsAtIso: event.endsAt.toISOString(), id: event.id, startsAtIso: event.startsAt.toISOString(), title: event.title });
        return;
      }
      io.stdout(`📅 Blocked ${duration.toString()}m for '${title}': ${when} (id ${event.id}). Undo: muse calendar delete ${event.id}\n`);
    });

  calendar
    .command("conflicts")
    .description("Flag double-booked events — overlapping items in a window. Defaults: now → +30 days.")
    .option("--from <iso>", "ISO 8601 window start (default: now)")
    .option("--to <iso>", "ISO 8601 window end (default: from + 30 days)")
    .option("--provider <id>", "Specific provider id (default: all)")
    .option("--local", "Read directly from the local calendar file instead of the API")
    .option("--json", "Print the raw conflicts instead of the formatted summary")
    .action(async (
      options: { readonly from?: string; readonly to?: string; readonly provider?: string } & SharedOptions,
      command
    ) => {
      if (
        (options.from && Number.isNaN(new Date(options.from).getTime())) ||
        (options.to && Number.isNaN(new Date(options.to).getTime()))
      ) {
        throw new Error("--from / --to must be ISO 8601 timestamps");
      }
      const from = options.from ? new Date(options.from) : new Date();
      const to = options.to ? new Date(options.to) : new Date(from.getTime() + 30 * 86_400_000);
      const rows = await withApiLocalFallback<Array<Record<string, unknown>>>(
        io,
        Boolean(options.local),
        async () => (await localCalendarProvider().listEvents({ from, to })).map((event) => ({
          allDay: event.allDay,
          endsAtIso: event.endsAt.toISOString(),
          startsAtIso: event.startsAt.toISOString(),
          title: event.title
        })),
        async () => {
          const params = new URLSearchParams({ fromIso: from.toISOString(), toIso: to.toISOString() });
          if (options.provider) params.set("providerId", options.provider);
          const payload = (await helpers.apiRequest(io, command, `/api/calendar/events?${params.toString()}`)) as { events?: Array<Record<string, unknown>> };
          return Array.isArray(payload.events) ? payload.events : [];
        },
        "calendar"
      );
      const conflicts = detectCalendarConflicts(eventsToAvailability(rows));
      if (options.json) {
        helpers.writeOutput(io, conflicts.map((c) => ({
          a: { endsAtIso: c.a.endsAt.toISOString(), startsAtIso: c.a.startsAt.toISOString(), title: c.a.title },
          b: { endsAtIso: c.b.endsAt.toISOString(), startsAtIso: c.b.startsAt.toISOString(), title: c.b.title },
          overlapEndsAtIso: c.overlapEndsAt.toISOString(),
          overlapStartsAtIso: c.overlapStartsAt.toISOString()
        })));
        return;
      }
      io.stdout(formatConflicts(conflicts));
    });

  calendar
    .command("add")
    .description("Create an event in your LOCAL calendar. --at takes ISO-8601 or a phrase ('tomorrow 3pm', '내일 오후 3시').")
    .argument("<title...>", "Event title (joined by spaces)")
    .requiredOption("--at <when>", "Start time — ISO-8601 or a relative phrase")
    .option("--for <minutes>", "Duration in minutes (default 60)")
    .option("--location <where>", "Where the event is, e.g. 'Room 4'")
    .option("--remind <minutes>", "Also set a reminder this many minutes BEFORE the event, e.g. --remind 30")
    .option("--repeat <cadence>", "Make it recurring: 'daily', 'weekly', 'monthly', or 'yearly' (e.g. a weekly standup, monthly rent). Omit for one-time.")
    .option("--json", "Print the created event as JSON")
    .action(async (
      titleParts: readonly string[],
      options: { readonly at: string; readonly for?: string; readonly location?: string; readonly remind?: string; readonly repeat?: string; readonly json?: boolean }
    ) => {
      const title = titleParts.join(" ").trim();
      if (title.length === 0) {
        throw new Error("muse calendar add: a non-empty title is required");
      }
      const startsAt = parseEventStart(options.at);
      if (!startsAt) {
        // Whetstone: the DETERMINISTIC parser (not the model) couldn't resolve this
        // time phrase — record the previously-dead `time-parse` weakness so a recurring
        // misread surfaces for remediation. Fail-soft: never mask the user-facing error.
        try {
          await recordTimeParseWeakness(options.at, true, {
            recordWeakness,
            weaknessesFile: resolveWeaknessesFile(process.env as Record<string, string | undefined>)
          });
        } catch { /* ledger write must never surface as a command error */ }
        throw new Error(`--at must be an ISO-8601 timestamp or a relative phrase ('tomorrow 3pm', 'in 2 hours'), got '${options.at}'`);
      }
      const minutes = options.for !== undefined ? Number(options.for) : 60;
      if (!Number.isFinite(minutes) || minutes <= 0) {
        throw new Error("--for must be a positive number of minutes");
      }
      const endsAt = new Date(startsAt.getTime() + Math.trunc(minutes) * 60_000);
      let recurrence: string | undefined;
      if (options.repeat !== undefined) {
        recurrence = recurrenceRuleFor(options.repeat);
        if (!recurrence) {
          throw new Error(`--repeat must be 'daily', 'weekly', 'monthly', or 'yearly', got '${options.repeat}'`);
        }
      }
      const provider = localCalendarProvider();
      const event = await provider.createEvent({
        endsAt,
        startsAt,
        title,
        ...(options.location ? { location: options.location } : {}),
        ...(recurrence ? { recurrence } : {})
      });
      // Conflict heads-up: an event overlapping [startsAt, endsAt] is exactly an
      // overlap, so listing that window (then excluding the new event by id) gives
      // the candidates; `conflictWarningForNewEvent` excludes touching/back-to-back.
      let conflictWarning = "";
      try {
        const nearby = await provider.listEvents({ from: startsAt, to: endsAt });
        // Exclude the new event AND its own recurring instances (expandRecurringEvent
        // ids them `${baseId}-N`), else a recurring event flags a conflict with itself.
        conflictWarning = conflictWarningForNewEvent(event, nearby.filter((other) => other.id !== event.id && !other.id.startsWith(`${event.id}-`)));
      } catch {
        // calendar read failed — still confirm the create, just without the heads-up
      }
      // --remind: ALSO create a reminder N minutes before the event, so a single
      // command schedules the event AND its heads-up (the firing loop delivers it).
      let reminder: PersistedReminder | undefined;
      if (options.remind !== undefined) {
        const mins = Number(options.remind);
        if (!Number.isFinite(mins) || mins < 0) {
          throw new Error("--remind must be a non-negative number of minutes");
        }
        reminder = buildEventReminder(title, startsAt, mins, new Date(), `rem_${randomUUID()}`, event.id);
        const remindersFile = resolveRemindersFile(process.env as Record<string, string | undefined>);
        await writeReminders(remindersFile, [...await readReminders(remindersFile), reminder]);
      }
      if (options.json) {
        helpers.writeOutput(io, {
          event: { endsAtIso: event.endsAt.toISOString(), id: event.id, startsAtIso: event.startsAt.toISOString(), title: event.title, ...(recurrence ? { recurrence } : {}) },
          ...(conflictWarning ? { conflict: conflictWarning } : {}),
          ...(reminder ? { reminder: { dueAtIso: reminder.dueAt, id: reminder.id, text: reminder.text } } : {})
        });
        return;
      }
      io.stdout(`Created: ${event.title} — ${event.startsAt.toISOString()} → ${event.endsAt.toISOString()}${options.repeat ? ` (repeats ${options.repeat.trim().toLowerCase()})` : ""}\n`);
      if (reminder) {
        io.stdout(`Reminder set for ${clockOf(new Date(reminder.dueAt))} (${Math.max(0, Math.trunc(Number(options.remind)))} min before).\n`);
      }
      if (conflictWarning) {
        io.stderr(`${conflictWarning}\n`);
      }
    });

  calendar
    .command("delete")
    .description("Cancel/remove an event from your LOCAL calendar by id (the [id] shown in `muse calendar events`)")
    .argument("<id>", "Event id — the short [id] from the listing, or a full id")
    .option("--json", "Print the result as JSON")
    .action(async (idArg: string, options: { readonly json?: boolean }) => {
      const target = idArg.trim();
      if (target.length === 0) {
        throw new Error("muse calendar delete: an event id is required");
      }
      const provider = localCalendarProvider();
      const resolved = resolveEventIdMatch(await listLocalEventsWide(provider), target);
      if (resolved.kind !== "match") {
        io.stderr(resolved.kind === "ambiguous"
          ? `muse calendar delete: '${target}' is ambiguous (${resolved.count.toString()} events) — use a longer id\n`
          : `muse calendar delete: no event matches id '${target}'\n`);
        process.exitCode = 1;
        return;
      }
      const match = resolved.event;
      await provider.deleteEvent(match.id);
      // Clean up any reminder linked to this event (muse calendar add --remind), so a
      // cancelled meeting can't keep firing. Best-effort: a reminders-store error must
      // NOT abort the event deletion (the primary action already succeeded).
      let clearedReminders = 0;
      try {
        const remindersFile = resolveRemindersFile(process.env as Record<string, string | undefined>);
        const { kept, removed } = removeRemindersForEvent(await readReminders(remindersFile), match.id);
        if (removed > 0) {
          await writeReminders(remindersFile, kept);
          clearedReminders = removed;
        }
      } catch {
        // reminders cleanup is best-effort
      }
      if (options.json) {
        helpers.writeOutput(io, { deleted: true, id: match.id, title: match.title, ...(clearedReminders > 0 ? { clearedReminders } : {}) });
        return;
      }
      io.stdout(`Cancelled: ${match.title} — ${match.startsAt.toISOString()}\n`);
      if (clearedReminders > 0) {
        io.stdout(`Also cleared ${clearedReminders.toString()} linked reminder${clearedReminders === 1 ? "" : "s"}.\n`);
      }
    });

  calendar
    .command("edit")
    .description("Reschedule / rename an event in your LOCAL calendar by id (the [id] from `muse calendar events`)")
    .argument("<id>", "Event id — the short [id] from the listing, or a full id")
    .option("--at <when>", "New start — ISO-8601 or a phrase ('tomorrow 3pm'); duration preserved unless --for is given")
    .option("--for <minutes>", "New duration in minutes")
    .option("--title <text...>", "New title")
    .option("--location <where>", "New location")
    .option("--json", "Print the updated event as JSON")
    .action(async (
      idArg: string,
      options: { readonly at?: string; readonly for?: string; readonly title?: string | readonly string[]; readonly location?: string; readonly json?: boolean }
    ) => {
      const target = idArg.trim();
      if (target.length === 0) {
        throw new Error("muse calendar edit: an event id is required");
      }
      const nextTitle = Array.isArray(options.title) ? options.title.join(" ").trim() : (typeof options.title === "string" ? options.title.trim() : undefined);
      if (options.at === undefined && options.for === undefined && !nextTitle && options.location === undefined) {
        throw new Error("muse calendar edit needs at least one of --at / --for / --title / --location");
      }
      const provider = localCalendarProvider();
      const resolved = resolveEventIdMatch(await listLocalEventsWide(provider), target);
      if (resolved.kind !== "match") {
        io.stderr(resolved.kind === "ambiguous"
          ? `muse calendar edit: '${target}' is ambiguous (${resolved.count.toString()} events) — use a longer id\n`
          : `muse calendar edit: no event matches id '${target}'\n`);
        process.exitCode = 1;
        return;
      }
      const match = resolved.event;
      const update: { title?: string; startsAt?: Date; endsAt?: Date; location?: string } = {};
      if (options.at !== undefined) {
        const startsAt = parseEventStart(options.at);
        if (!startsAt) {
          // Whetstone (sibling of `calendar add`): same deterministic time-parse signal.
          try {
            await recordTimeParseWeakness(options.at, true, {
              recordWeakness,
              weaknessesFile: resolveWeaknessesFile(process.env as Record<string, string | undefined>)
            });
          } catch { /* ledger write must never surface as a command error */ }
          throw new Error(`--at must be an ISO-8601 timestamp or a relative phrase ('tomorrow 3pm'), got '${options.at}'`);
        }
        update.startsAt = startsAt;
      }
      if (options.at !== undefined || options.for !== undefined) {
        const start = update.startsAt ?? match.startsAt;
        const durationMs = options.for !== undefined
          ? (() => {
              const m = Number(options.for);
              if (!Number.isFinite(m) || m <= 0) {
                throw new Error("--for must be a positive number of minutes");
              }
              return Math.trunc(m) * 60_000;
            })()
          : match.endsAt.getTime() - match.startsAt.getTime();
        update.endsAt = new Date(start.getTime() + durationMs);
      }
      if (nextTitle) {
        update.title = nextTitle;
      }
      if (options.location !== undefined) {
        update.location = options.location;
      }
      const updated = await provider.updateEvent(match.id, update);
      // When the START moved, shift any linked --remind reminder by the same delta
      // so it stays the same minutes before the NEW start (the --remind link kept
      // daily-reliable across reschedules). Best-effort: a reminders-store error
      // must never break the edit (the event update already succeeded).
      let shiftedReminders = 0;
      if (options.at !== undefined) {
        try {
          const remindersFile = resolveRemindersFile(process.env as Record<string, string | undefined>);
          const { next, shifted } = rescheduleRemindersForEvent(await readReminders(remindersFile), match.id, match.startsAt, updated.startsAt);
          if (shifted > 0) {
            await writeReminders(remindersFile, next);
            shiftedReminders = shifted;
          }
        } catch {
          // reminders reschedule is best-effort
        }
      }
      if (options.json) {
        helpers.writeOutput(io, {
          event: { endsAtIso: updated.endsAt.toISOString(), id: updated.id, startsAtIso: updated.startsAt.toISOString(), title: updated.title },
          ...(shiftedReminders > 0 ? { shiftedReminders } : {})
        });
        return;
      }
      io.stdout(`Updated: ${updated.title} — ${updated.startsAt.toISOString()} → ${updated.endsAt.toISOString()}\n`);
      if (shiftedReminders > 0) {
        io.stdout(`Also shifted ${shiftedReminders.toString()} linked reminder${shiftedReminders === 1 ? "" : "s"}.\n`);
      }
    });

  const registerQuickRange = (name: string, description: string, computeRange: () => { from: Date; to: Date }): void => {
    calendar
      .command(name)
      .description(description)
      .option("--provider <id>", "Specific provider id (default: all)")
      .option("--local", "Read directly from the local calendar file instead of the API")
      .option("--json", "Print the raw response instead of the day-grouped agenda")
      .action(async (options: { readonly provider?: string } & SharedOptions, command) => {
        const { from, to } = computeRange();
        const params = new URLSearchParams();
        params.set("fromIso", from.toISOString());
        params.set("toIso", to.toISOString());
        if (options.provider) params.set("providerId", options.provider);
        const payload = await withApiLocalFallback<Record<string, unknown>>(
          io,
          Boolean(options.local),
          async () => {
            const events = (await localCalendarProvider().listEvents({ from, to })).map((event) => ({
              endsAtIso: event.endsAt.toISOString(),
              id: event.id,
              providerId: event.providerId,
              startsAtIso: event.startsAt.toISOString(),
              title: event.title,
              ...(event.allDay ? { allDay: true } : {}),
              ...(event.location ? { location: event.location } : {}),
              ...(event.notes ? { notes: event.notes } : {}),
              ...(event.tags && event.tags.length > 0 ? { tags: event.tags } : {})
            }));
            return { events, total: events.length };
          },
          async () => (await helpers.apiRequest(io, command, `/api/calendar/events?${params.toString()}`)) as Record<string, unknown>,
          "calendar"
        );
        if (options.json) {
          helpers.writeOutput(io, payload);
          return;
        }
        io.stdout(formatCalendarEvents(payload as unknown as Parameters<typeof formatCalendarEvents>[0]));
      });
  };

  registerQuickRange("tomorrow", "List events for tomorrow (local timezone, 00:00 → 23:59)", () => {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() + 1);
    const end = new Date(start);
    end.setHours(23, 59, 59, 999);
    return { from: start, to: end };
  });

  registerQuickRange("this-week", "List events from now through end-of-week (local timezone, Sunday end-of-day)", () => {
    const now = new Date();
    const end = new Date(now);
    const daysUntilEow = (7 - now.getDay()) % 7; // 0=Sunday → 0 days, Mon → 6, etc.
    end.setDate(end.getDate() + daysUntilEow);
    end.setHours(23, 59, 59, 999);
    return { from: now, to: end };
  });

  calendar
    .command("show")
    .description("Show one event's full details (incl. notes) by id — the [id] from `muse calendar events`")
    .argument("<id>", "Event id — the short [id] from the listing, or a full id")
    .option("--json", "Print the raw event as JSON")
    .action(async (idArg: string, options: { readonly json?: boolean }) => {
      const target = idArg.trim();
      if (target.length === 0) {
        throw new Error("muse calendar show: an event id is required");
      }
      const resolved = resolveEventIdMatch(await listLocalEventsWide(localCalendarProvider()), target);
      if (resolved.kind !== "match") {
        io.stderr(resolved.kind === "ambiguous"
          ? `muse calendar show: '${target}' is ambiguous (${resolved.count.toString()} events) — use a longer id\n`
          : `muse calendar show: no event matches id '${target}'\n`);
        process.exitCode = 1;
        return;
      }
      const e = resolved.event;
      if (options.json) {
        helpers.writeOutput(io, {
          endsAtIso: e.endsAt.toISOString(), id: e.id, startsAtIso: e.startsAt.toISOString(), title: e.title,
          ...(e.location ? { location: e.location } : {}),
          ...(e.notes ? { notes: e.notes } : {}),
          ...(e.tags && e.tags.length > 0 ? { tags: e.tags } : {})
        });
        return;
      }
      const lines = [
        `${e.title}`,
        `  ${e.startsAt.toISOString()} → ${e.endsAt.toISOString()}`
      ];
      if (e.location) {
        lines.push(`  @ ${e.location}`);
      }
      if (e.tags && e.tags.length > 0) {
        lines.push(`  #${e.tags.join(" #")}`);
      }
      if (e.notes && e.notes.trim().length > 0) {
        lines.push("", e.notes.trim());
      }
      io.stdout(`${lines.join("\n")}\n`);
    });

  // Idempotent by (title, startsAt) — re-running the same import
  // doesn't duplicate. --allow-duplicates bypasses the dedupe.
  calendar
    .command("import")
    .description("Bulk-import an .ics file into the local calendar provider (idempotent by title+start)")
    .argument("<file>", "Path to a .ics file")
    .option("--allow-duplicates", "Skip the (title, startsAt) dedupe check and write every parsed event")
    .option("--dry-run", "Parse + report what would be written without touching disk")
    .option("--json", "Emit a structured summary instead of a formatted report")
    .action(async (
      file: string,
      options: { readonly allowDuplicates?: boolean; readonly dryRun?: boolean; readonly json?: boolean }
    ) => {
      let body: string;
      try {
        body = await readFile(file, "utf8");
      } catch (cause) {
        io.stderr(`Could not read ${file}: ${cause instanceof Error ? cause.message : String(cause)}\n`);
        process.exitCode = 1;
        return;
      }
      const parsed = parseIcsEvents(body);
      if (parsed.length === 0) {
        const empty = { created: 0, parsed: 0, skipped: 0 };
        if (options.json) {
          helpers.writeOutput(io, empty);
        } else {
          io.stdout(`No VEVENT blocks found in ${file}\n`);
        }
        return;
      }
      const provider = localCalendarProvider();
      // Range covers every parsed event so we can dedupe against
      // existing rows by (title, startsAt-ms). Cheap enough at the
      // single-user scale this importer targets.
      const startsAtMs = parsed.map((e) => e.startsAt.getTime());
      const rangeFrom = new Date(minOfNumbers(startsAtMs));
      const rangeTo = new Date(maxOfNumbers(parsed.map((e) => e.endsAt.getTime())) + 24 * 60 * 60 * 1000);
      const existing = options.allowDuplicates
        ? []
        : await provider.listEvents({ from: rangeFrom, to: rangeTo });
      const dupKey = (title: string, startsAt: Date): string => `${title}|${startsAt.toISOString()}`;
      const existingKeys = new Set(existing.map((e) => dupKey(e.title, e.startsAt)));
      let created = 0;
      let skipped = 0;
      for (const event of parsed) {
        if (existingKeys.has(dupKey(event.title, event.startsAt))) {
          skipped += 1;
          continue;
        }
        if (!options.dryRun) {
          await provider.createEvent({
            title: event.title,
            startsAt: event.startsAt,
            endsAt: event.endsAt,
            ...(event.allDay ? { allDay: true } : {}),
            ...(event.location ? { location: event.location } : {}),
            ...(event.notes ? { notes: event.notes } : {})
          });
        }
        created += 1;
        existingKeys.add(dupKey(event.title, event.startsAt));
      }
      const summary = { parsed: parsed.length, created, skipped, dryRun: options.dryRun === true };
      if (options.json) {
        helpers.writeOutput(io, summary);
        return;
      }
      io.stdout(
        `Imported ${created.toString()}${options.dryRun ? " (dry-run)" : ""} event(s) from ${file} ` +
        `(${parsed.length.toString()} parsed, ${skipped.toString()} skipped as duplicate)\n`
      );
    });
}
