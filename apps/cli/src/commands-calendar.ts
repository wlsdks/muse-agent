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

import { readFile } from "node:fs/promises";

import { resolveLocalCalendarFile } from "@muse/autoconfigure";
import { LocalCalendarProvider, type CalendarEvent } from "@muse/calendar";
import { computeAvailability, detectCalendarConflicts, resolveRelativeTimePhrase, type AvailabilityEventLike, type AvailabilityResult, type CalendarConflict } from "@muse/mcp";
import type { Command } from "commander";

import { formatCalendarEvents, formatProvidersList } from "./human-formatters.js";
import { parseIcsEvents } from "./ics-parser.js";
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
      let payload: Record<string, unknown>;
      if (options.local) {
        const info = localCalendarProvider().describe();
        payload = { providers: [info] };
      } else {
        payload = (await helpers.apiRequest(io, command, "/api/calendar/providers")) as Record<string, unknown>;
      }
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
      let payload: Record<string, unknown>;
      // Validate up front so the API path rejects a bad timestamp
      // with the same actionable error as --local, instead of
      // forwarding garbage to the server as a silently-wrong window.
      if (
        (options.from && Number.isNaN(new Date(options.from).getTime())) ||
        (options.to && Number.isNaN(new Date(options.to).getTime()))
      ) {
        throw new Error("--from / --to must be ISO 8601 timestamps");
      }
      if (options.local) {
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
        payload = { events, total: events.length };
      } else {
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
        payload = (await helpers.apiRequest(io, command, path)) as Record<string, unknown>;
      }
      if (options.json) {
        helpers.writeOutput(io, payload);
        return;
      }
      io.stdout(formatCalendarEvents(payload as unknown as Parameters<typeof formatCalendarEvents>[0]));
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
      let rows: Array<Record<string, unknown>>;
      if (options.local) {
        const raw = await localCalendarProvider().listEvents({ from, to });
        rows = raw.map((event) => ({
          allDay: event.allDay,
          endsAtIso: event.endsAt.toISOString(),
          startsAtIso: event.startsAt.toISOString(),
          title: event.title
        }));
      } else {
        const params = new URLSearchParams({ fromIso: from.toISOString(), toIso: to.toISOString() });
        if (options.provider) params.set("providerId", options.provider);
        const payload = (await helpers.apiRequest(io, command, `/api/calendar/events?${params.toString()}`)) as { events?: Array<Record<string, unknown>> };
        rows = Array.isArray(payload.events) ? payload.events : [];
      }
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
      let rows: Array<Record<string, unknown>>;
      if (options.local) {
        const raw = await localCalendarProvider().listEvents({ from, to });
        rows = raw.map((event) => ({
          allDay: event.allDay,
          endsAtIso: event.endsAt.toISOString(),
          startsAtIso: event.startsAt.toISOString(),
          title: event.title
        }));
      } else {
        const params = new URLSearchParams({ fromIso: from.toISOString(), toIso: to.toISOString() });
        if (options.provider) params.set("providerId", options.provider);
        const payload = (await helpers.apiRequest(io, command, `/api/calendar/events?${params.toString()}`)) as { events?: Array<Record<string, unknown>> };
        rows = Array.isArray(payload.events) ? payload.events : [];
      }
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
    .option("--json", "Print the created event as JSON")
    .action(async (
      titleParts: readonly string[],
      options: { readonly at: string; readonly for?: string; readonly location?: string; readonly json?: boolean }
    ) => {
      const title = titleParts.join(" ").trim();
      if (title.length === 0) {
        throw new Error("muse calendar add: a non-empty title is required");
      }
      const startsAt = parseEventStart(options.at);
      if (!startsAt) {
        throw new Error(`--at must be an ISO-8601 timestamp or a relative phrase ('tomorrow 3pm', 'in 2 hours'), got '${options.at}'`);
      }
      const minutes = options.for !== undefined ? Number(options.for) : 60;
      if (!Number.isFinite(minutes) || minutes <= 0) {
        throw new Error("--for must be a positive number of minutes");
      }
      const endsAt = new Date(startsAt.getTime() + Math.trunc(minutes) * 60_000);
      const event = await localCalendarProvider().createEvent({
        endsAt,
        startsAt,
        title,
        ...(options.location ? { location: options.location } : {})
      });
      if (options.json) {
        helpers.writeOutput(io, {
          event: { endsAtIso: event.endsAt.toISOString(), id: event.id, startsAtIso: event.startsAt.toISOString(), title: event.title }
        });
        return;
      }
      io.stdout(`Created: ${event.title} — ${event.startsAt.toISOString()} → ${event.endsAt.toISOString()}\n`);
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
      if (options.json) {
        helpers.writeOutput(io, { deleted: true, id: match.id, title: match.title });
        return;
      }
      io.stdout(`Cancelled: ${match.title} — ${match.startsAt.toISOString()}\n`);
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
      if (options.json) {
        helpers.writeOutput(io, { event: { endsAtIso: updated.endsAt.toISOString(), id: updated.id, startsAtIso: updated.startsAt.toISOString(), title: updated.title } });
        return;
      }
      io.stdout(`Updated: ${updated.title} — ${updated.startsAt.toISOString()} → ${updated.endsAt.toISOString()}\n`);
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
        let payload: Record<string, unknown>;
        if (options.local) {
          const raw = await localCalendarProvider().listEvents({ from, to });
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
          payload = { events, total: events.length };
        } else {
          payload = (await helpers.apiRequest(io, command, `/api/calendar/events?${params.toString()}`)) as Record<string, unknown>;
        }
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
