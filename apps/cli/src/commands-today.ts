/**
 * `muse today` — personal-JARVIS morning briefing.
 *
 * Remote mode: GET /api/today?lookaheadHours=N (one round-trip).
 * Local mode (--local): compose the same shape from the on-disk
 * tasks file and notes dir without an API server. Calendar events
 * are skipped in --local because the CalendarProviderRegistry
 * requires async boot (OAuth tokens, CalDAV creds) — running through
 * the API server still serves that case.
 */

import { promises as fs } from "node:fs";
import { join, resolve as resolvePath } from "node:path";

import { resolveNotesDir, resolveTasksFile } from "@muse/autoconfigure";
import { readTasks, serializeTask, type PersistedTask } from "@muse/mcp";
import type { Command } from "commander";

import type { ProgramIO } from "./program.js";

const MAX_RECENT_NOTES = 5;
const MAX_NOTES_WALK_DEPTH = 8;

interface TodayBriefing {
  readonly generatedAt: string;
  readonly lookaheadHours: number;
  readonly tasks?: readonly { readonly id: string; readonly title: string }[];
  readonly events?: readonly { readonly id: string; readonly title: string; readonly startsAtIso: string }[];
  readonly notes?: readonly string[];
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
    .option("--local", "Compose locally without the API (calendar events are skipped)")
    .action(async (
      options: { readonly json?: boolean; readonly lookaheadHours?: string; readonly local?: boolean },
      command
    ) => {
      const briefing = options.local
        ? await composeLocalBriefing(parseLookaheadHours(options.lookaheadHours))
        : await fetchRemoteBriefing(io, command, helpers, options.lookaheadHours);

      if (options.json) {
        helpers.writeOutput(io, briefing);
        return;
      }

      io.stdout(`Today (${shortDateLabel(briefing.generatedAt)}, next ${briefing.lookaheadHours}h${options.local ? ", local" : ""})\n`);
      io.stdout(formatTasks(briefing.tasks));
      io.stdout(formatEvents(briefing.events));
      io.stdout(formatNotes(briefing.notes));
    });
}

async function fetchRemoteBriefing(
  io: ProgramIO,
  command: Command,
  helpers: TodayCommandHelpers,
  lookaheadHoursFlag: string | undefined
): Promise<TodayBriefing> {
  const lookaheadParam = lookaheadHoursFlag
    ? `?lookaheadHours=${encodeURIComponent(lookaheadHoursFlag)}`
    : "";
  return (await helpers.apiRequest(io, command, `/api/today${lookaheadParam}`)) as TodayBriefing;
}

async function composeLocalBriefing(lookaheadHours: number): Promise<TodayBriefing> {
  const env = process.env as Record<string, string | undefined>;
  const tasksFile = resolveTasksFile(env);
  const notesDir = resolveNotesDir(env);

  const [tasks, notes] = await Promise.all([
    readOpenTasks(tasksFile).catch(() => undefined),
    readRecentNotes(notesDir).catch(() => undefined)
  ]);

  return {
    events: undefined,
    generatedAt: new Date().toISOString(),
    lookaheadHours,
    notes,
    tasks
  };
}

async function readOpenTasks(tasksFile: string): Promise<readonly { id: string; title: string }[]> {
  const all = await readTasks(tasksFile);
  return all
    .filter((task: PersistedTask) => task.status === "open")
    .sort((left, right) => (right.createdAt ?? "").localeCompare(left.createdAt ?? ""))
    .slice(0, 50)
    .map((task) => {
      const serialized = serializeTask(task);
      return { id: String(serialized.id), title: String(serialized.title) };
    });
}

async function readRecentNotes(notesDir: string): Promise<readonly string[]> {
  const root = resolvePath(notesDir);
  const collected: { name: string; mtime: number }[] = [];
  await collectNotesRecursive(root, "", collected, 0);
  return collected
    .sort((left, right) => right.mtime - left.mtime)
    .slice(0, MAX_RECENT_NOTES)
    .map((entry) => entry.name);
}

async function collectNotesRecursive(
  absDir: string,
  relPrefix: string,
  out: { name: string; mtime: number }[],
  depth: number
): Promise<void> {
  if (depth > MAX_NOTES_WALK_DEPTH) {
    return;
  }
  let entries: { readonly name: string; isDirectory(): boolean; isFile(): boolean }[];
  try {
    entries = (await fs.readdir(absDir, { withFileTypes: true })) as unknown as {
      readonly name: string;
      isDirectory(): boolean;
      isFile(): boolean;
    }[];
  } catch {
    return;
  }
  const visible = entries.filter((entry) => !entry.name.startsWith("."));
  const fileStats = await Promise.all(
    visible
      .filter((entry) => entry.isFile())
      .map(async (entry) => {
        const rel = relPrefix.length > 0 ? join(relPrefix, entry.name) : entry.name;
        try {
          const stat = await fs.stat(join(absDir, entry.name));
          return { mtime: stat.mtime.getTime(), name: rel };
        } catch {
          return undefined;
        }
      })
  );
  for (const entry of fileStats) {
    if (entry) {
      out.push(entry);
    }
  }
  for (const entry of visible) {
    if (entry.isDirectory()) {
      const childAbs = join(absDir, entry.name);
      const childRel = relPrefix.length > 0 ? join(relPrefix, entry.name) : entry.name;
      await collectNotesRecursive(childAbs, childRel, out, depth + 1);
    }
  }
}

function parseLookaheadHours(raw: string | undefined): number {
  if (!raw) {
    return 24;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return 24;
  }
  return Math.min(parsed, 24 * 7);
}

function shortDateLabel(generatedAt: string): string {
  return generatedAt.slice(0, 10);
}

function formatTasks(tasks: readonly { readonly id: string; readonly title: string }[] | undefined): string {
  if (!tasks) {
    return "\nTasks: (not configured)\n";
  }
  if (tasks.length === 0) {
    return "\nTasks: (none open)\n";
  }
  const lines = tasks.map((task) => `  - [${task.id.slice(0, 12)}] ${task.title}`);
  return `\nTasks (${tasks.length} open):\n${lines.join("\n")}\n`;
}

function formatEvents(events: readonly { readonly id: string; readonly title: string; readonly startsAtIso: string }[] | undefined): string {
  if (!events) {
    return "\nUpcoming: (calendar not configured)\n";
  }
  if (events.length === 0) {
    return "\nUpcoming: (no calendar events in window)\n";
  }
  const lines = events.map((event) => `  - ${event.startsAtIso.slice(11, 16)} — ${event.title}`);
  return `\nUpcoming (${events.length}):\n${lines.join("\n")}\n`;
}

function formatNotes(notes: readonly string[] | undefined): string {
  if (!notes) {
    return "\nRecent notes: (notes dir not configured)\n";
  }
  if (notes.length === 0) {
    return "\nRecent notes: (none)\n";
  }
  return `\nRecent notes:\n${notes.map((name) => `  - ${name}`).join("\n")}\n`;
}
