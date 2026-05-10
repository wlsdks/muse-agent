/**
 * `muse today` — personal-JARVIS morning briefing.
 *
 * Hits three existing read-only endpoints in parallel and prints a
 * compact summary:
 *
 *   - GET /api/tasks?status=open        — pending todos
 *   - GET /api/calendar/events?from=...&to=... — next 24h
 *   - GET /api/notes/list               — most-recent 5 by name (sorted descending)
 *
 * No new server route — just an aggregator. The agent / web UI can
 * already build similar views; this exists so a personal user can
 * type one terminal command in the morning and see what's on their
 * plate without going through chat.
 *
 * Same DI injection pattern as the other CLI command modules.
 */

import type { Command } from "commander";

import type { ProgramIO } from "./program.js";

interface TasksResponse {
  readonly tasks: readonly { readonly id: string; readonly title: string; readonly notes?: string }[];
}

interface EventsResponse {
  readonly events: readonly { readonly id: string; readonly title: string; readonly startsAtIso: string; readonly endsAtIso: string; readonly providerId: string }[];
}

interface NotesListResponse {
  readonly entries: readonly { readonly name: string; readonly isDirectory: boolean; readonly sizeBytes?: number }[];
}

export interface TodayCommandHelpers {
  readonly apiRequest: (
    io: ProgramIO,
    command: Command,
    path: string,
    body?: Record<string, unknown>,
    method?: "GET" | "POST" | "PUT" | "DELETE"
  ) => Promise<unknown>;
  readonly writeOutput: (io: ProgramIO, value: unknown, textField?: string) => void;
}

export function registerTodayCommands(program: Command, io: ProgramIO, helpers: TodayCommandHelpers): void {
  program
    .command("today")
    .description("Personal morning briefing — open tasks, next 24h calendar, recent notes")
    .option("--json", "Print machine-readable JSON instead of the formatted summary")
    .option("--lookahead-hours <n>", "Hours of calendar look-ahead (default 24)")
    .action(async (options: { readonly json?: boolean; readonly lookaheadHours?: string }, command) => {
      const now = new Date();
      const hours = Number.parseInt(options.lookaheadHours ?? "24", 10);
      const lookahead = Number.isFinite(hours) && hours > 0 ? hours : 24;
      const horizon = new Date(now.getTime() + lookahead * 3_600_000);
      const fromIso = now.toISOString();
      const toIso = horizon.toISOString();

      const tasks = (await helpers.apiRequest(io, command, "/api/tasks?status=open").catch(() => undefined)) as TasksResponse | undefined;
      const events = (await helpers
        .apiRequest(io, command, `/api/calendar/events?fromIso=${encodeURIComponent(fromIso)}&toIso=${encodeURIComponent(toIso)}`)
        .catch(() => undefined)) as EventsResponse | undefined;
      const notes = (await helpers.apiRequest(io, command, "/api/notes/list").catch(() => undefined)) as NotesListResponse | undefined;

      const briefing = {
        events: events?.events ?? [],
        generatedAt: now.toISOString(),
        notes: pickRecentNotes(notes?.entries ?? [], 5),
        tasks: tasks?.tasks ?? []
      };

      if (options.json) {
        helpers.writeOutput(io, briefing);
        return;
      }

      io.stdout(`Today (${shortDateLabel(now)}, next ${lookahead}h)\n`);
      io.stdout(formatTasks(briefing.tasks));
      io.stdout(formatEvents(briefing.events));
      io.stdout(formatNotes(briefing.notes));
    });
}

function pickRecentNotes(
  entries: readonly { readonly name: string; readonly isDirectory: boolean; readonly sizeBytes?: number }[],
  limit: number
): readonly string[] {
  return entries
    .filter((entry) => !entry.isDirectory)
    .map((entry) => entry.name)
    .sort()
    .reverse()
    .slice(0, limit);
}

function shortDateLabel(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function formatTasks(tasks: readonly { readonly id: string; readonly title: string }[]): string {
  if (tasks.length === 0) {
    return "\nTasks: (none open)\n";
  }
  const lines = tasks.map((task) => `  - [${task.id.slice(0, 12)}] ${task.title}`);
  return `\nTasks (${tasks.length} open):\n${lines.join("\n")}\n`;
}

function formatEvents(events: readonly { readonly id: string; readonly title: string; readonly startsAtIso: string }[]): string {
  if (events.length === 0) {
    return "\nUpcoming: (no calendar events in window)\n";
  }
  const lines = events.map((event) => `  - ${event.startsAtIso.slice(11, 16)} — ${event.title}`);
  return `\nUpcoming (${events.length}):\n${lines.join("\n")}\n`;
}

function formatNotes(notes: readonly string[]): string {
  if (notes.length === 0) {
    return "\nRecent notes: (none)\n";
  }
  return `\nRecent notes:\n${notes.map((name) => `  - ${name}`).join("\n")}\n`;
}
