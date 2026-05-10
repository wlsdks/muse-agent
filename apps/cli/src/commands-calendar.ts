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

import { resolveLocalCalendarFile } from "@muse/autoconfigure";
import { LocalCalendarProvider } from "@muse/calendar";
import type { Command } from "commander";

import { formatCalendarEvents, formatProvidersList } from "./human-formatters.js";
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
      if (options.local) {
        const from = options.from ? new Date(options.from) : new Date();
        const to = options.to
          ? new Date(options.to)
          : new Date(from.getTime() + 30 * 24 * 3_600_000);
        if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
          throw new Error("--from / --to must be ISO 8601 timestamps");
        }
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
}
