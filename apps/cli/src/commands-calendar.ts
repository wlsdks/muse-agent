/**
 * `muse calendar` command group.
 *
 * Wraps the read-only slice of `/api/calendar/*`:
 *   - `muse calendar providers` — list configured calendar providers.
 *   - `muse calendar events [--from <iso>] [--to <iso>] [--provider <id>]`
 *     — list events; defaults to now → +30 days, all providers.
 *
 * Same DI injection pattern as scheduler / orchestrate / mcp / specs /
 * config / auth / voice / memory.
 *
 * `events add` (POST) is intentionally not exposed on the CLI yet —
 * for write workflows the user can ask the agent (`muse chat
 * "create a calendar event tomorrow at 3pm"`) which routes through
 * the MCP tool surface. Listing is the genuinely terminal-friendly
 * read path.
 */

import type { Command } from "commander";

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

export function registerCalendarCommands(program: Command, io: ProgramIO, helpers: CalendarCommandHelpers): void {
  const calendar = program.command("calendar").description("Personal calendar (read-only CLI surface)");

  calendar
    .command("providers")
    .description("GET /api/calendar/providers — list configured calendar providers")
    .action(async (_options, command) => {
      helpers.writeOutput(io, await helpers.apiRequest(io, command, "/api/calendar/providers"));
    });

  calendar
    .command("events")
    .description("GET /api/calendar/events — list events between --from and --to (defaults: now → +30 days)")
    .option("--from <iso>", "ISO 8601 start (default: now)")
    .option("--to <iso>", "ISO 8601 end (default: now + 30 days)")
    .option("--provider <id>", "Specific provider id (default: all)")
    .action(async (
      options: { readonly from?: string; readonly to?: string; readonly provider?: string },
      command
    ) => {
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
      helpers.writeOutput(io, await helpers.apiRequest(io, command, path));
    });
}
