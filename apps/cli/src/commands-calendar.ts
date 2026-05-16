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
import { LocalCalendarProvider } from "@muse/calendar";
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

function localCalendarProvider(): LocalCalendarProvider {
  const file = resolveLocalCalendarFile(process.env as Record<string, string | undefined>);
  return new LocalCalendarProvider({ file });
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
      const rangeFrom = new Date(Math.min(...startsAtMs));
      const rangeTo = new Date(Math.max(...parsed.map((e) => e.endsAt.getTime())) + 24 * 60 * 60 * 1000);
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
