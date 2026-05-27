/**
 * `GET /api/today` — server-side morning briefing.
 *
 * Consolidates the three personal-domain reads into one round-trip:
 *   - Open tasks from `tasksFile` (sorted newest-first, capped at 50)
 *   - Calendar events between `now` and `now + lookaheadHours`,
 *     fanned across every registered calendar provider
 *   - Recent notes from `notesDir` (top 5 by descending name; the
 *     same heuristic the CLI's `muse today` uses)
 *
 * `muse today` currently does the same fan-out
 * client-side over three separate routes; this gives the same view
 * to the web UI / future surfaces as one fetch and centralizes the
 * formatting decisions on the server.
 *
 * Behavior:
 *   - All three reads run in `Promise.all` with per-promise
 *     `.catch(() => undefined)` so a missing notesDir / unreachable
 *     calendar provider doesn't collapse the whole briefing.
 *   - Sections that aren't configured (e.g. tasksFile undefined)
 *     come back as `undefined`. The route still returns 200 so a
 *     client can probe what's wired up.
 *   - Auth: same gate as the underlying routes (`requireAuthenticated`).
 *
 * Query params:
 *   - `lookaheadHours` — integer ≥ 1, default 24, capped at 168 (7d).
 */

import { promises as fs } from "node:fs";
import { join, resolve as pathResolve } from "node:path";

import type { CalendarEvent, CalendarProviderRegistry } from "@muse/calendar";
import {
  compareFollowupsByScheduledFor,
  compareRemindersByDueAt,
  readFollowups,
  readReminders,
  serializeFollowup,
  serializeReminder,
  type PersistedFollowup,
  type PersistedReminder
} from "@muse/mcp";
import type { FastifyInstance } from "fastify";

import { requireAuthenticated } from "./server-helpers.js";
import type { ServerOptions } from "./server.js";

const DEFAULT_LOOKAHEAD_HOURS = 24;
const MAX_LOOKAHEAD_HOURS = 24 * 7;
const MAX_TASKS = 50;
const MAX_RECENT_NOTES = 5;

export function parseLookaheadHours(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_LOOKAHEAD_HOURS;
  const trimmed = raw.trim();
  if (!/^\d+$/u.test(trimmed)) return DEFAULT_LOOKAHEAD_HOURS;
  return Number(trimmed);
}

interface TodayRoutesGate {
  readonly authService: ServerOptions["authService"];
  readonly calendar?: CalendarProviderRegistry;
  readonly notesDir?: string;
  readonly tasksFile?: string;
  readonly remindersFile?: string;
  readonly followupsFile?: string;
}

interface PersistedTaskRow {
  readonly id: string;
  readonly title: string;
  readonly status: "open" | "done";
  readonly createdAt: string;
  readonly notes?: string;
}

export function registerTodayRoutes(server: FastifyInstance, gate: TodayRoutesGate): void {
  server.get("/api/today", async (request, reply) => {
    if (!requireAuthenticated(request, reply, Boolean(gate.authService))) {
      return reply;
    }

    const { lookaheadHours } = (request.query as { lookaheadHours?: string } | undefined) ?? {};
    const hoursParsed = parseLookaheadHours(lookaheadHours);
    const hours = Number.isFinite(hoursParsed) && hoursParsed >= 1
      ? Math.min(hoursParsed, MAX_LOOKAHEAD_HOURS)
      : DEFAULT_LOOKAHEAD_HOURS;
    const now = new Date();
    const horizon = new Date(now.getTime() + hours * 3_600_000);

    const [tasks, events, notes, reminders, followups] = await Promise.all([
      readOpenTasks(gate.tasksFile).catch(() => undefined),
      readUpcomingEvents(gate.calendar, now, horizon).catch(() => undefined),
      readRecentNotes(gate.notesDir).catch(() => undefined),
      readDueReminders(gate.remindersFile, now, horizon).catch(() => undefined),
      readDueFollowups(gate.followupsFile, horizon).catch(() => undefined)
    ]);

    return {
      events: events ? events.map(serializeTodayEvent) : undefined,
      followups,
      generatedAt: now.toISOString(),
      lookaheadHours: hours,
      notes,
      reminders,
      tasks
    };
  });
}

/**
 * Map a calendar event to the briefing's wire shape the CLI consumes
 * (`startsAtIso` / `endsAtIso`, not raw `startsAt`/`endsAt` Dates). Without
 * this the CLI — which reads `event.startsAtIso` — saw `undefined` and the
 * `muse today` events render threw; carrying `endsAtIso` also lets the brief's
 * double-booking warning fire on the remote path, not just `--local`.
 */
function serializeTodayEvent(event: CalendarEvent): {
  readonly id: string;
  readonly title: string;
  readonly startsAtIso: string;
  readonly endsAtIso: string;
  readonly allDay: boolean;
} {
  return {
    allDay: event.allDay,
    endsAtIso: event.endsAt.toISOString(),
    id: event.id,
    startsAtIso: event.startsAt.toISOString(),
    title: event.title
  };
}

/**
 * Reminders surfaced in the briefing: anything pending whose dueAt
 * is at-or-before the lookahead horizon. The window includes
 * already-overdue reminders (dueAt < now) so the user sees them
 * even if they skipped earlier briefings.
 */
async function readDueReminders(
  file: string | undefined,
  _now: Date,
  horizon: Date
): Promise<readonly Record<string, unknown>[] | undefined> {
  if (!file) {
    return undefined;
  }
  const all = await readReminders(file);
  const surfaced = all.filter((reminder: PersistedReminder) => {
    if (reminder.status !== "pending") {
      return false;
    }
    const due = Date.parse(reminder.dueAt);
    if (Number.isNaN(due)) {
      return false;
    }
    return due <= horizon.getTime();
  });
  return surfaced
    // Parsed instants, not lexicographic: a mixed-precision / offset
    // dueAt would otherwise mis-order the briefing (same canonical
    // comparator `muse reminders` + `muse today --local` use).
    .slice()
    .sort(compareRemindersByDueAt)
    .map(serializeReminder);
}

/**
 * Followups surfaced in the briefing: anything `scheduled` whose
 * `scheduledFor` is at-or-before the lookahead horizon. Like
 * reminders, the window includes already-overdue followups (the
 * agent promised to do X yesterday, didn't fire, today is the day).
 */
async function readDueFollowups(
  file: string | undefined,
  horizon: Date
): Promise<readonly Record<string, unknown>[] | undefined> {
  if (!file) {
    return undefined;
  }
  const all = await readFollowups(file);
  const surfaced = all.filter((followup: PersistedFollowup) => {
    if (followup.status !== "scheduled") {
      return false;
    }
    const when = Date.parse(followup.scheduledFor);
    if (Number.isNaN(when)) {
      return false;
    }
    return when <= horizon.getTime();
  });
  return surfaced
    .slice()
    .sort(compareFollowupsByScheduledFor)
    .map(serializeFollowup);
}

async function readOpenTasks(tasksFile: string | undefined): Promise<readonly PersistedTaskRow[] | undefined> {
  if (!tasksFile) {
    return undefined;
  }
  let raw: string;
  try {
    raw = await fs.readFile(tasksFile, "utf8");
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { tasks?: unknown }).tasks)) {
    return [];
  }
  return ((parsed as { tasks: unknown[] }).tasks as PersistedTaskRow[])
    .filter(isOpenPersistedTask)
    .sort((left, right) =>
      (right.createdAt ?? "").localeCompare(left.createdAt ?? "") || right.id.localeCompare(left.id)
    )
    .slice(0, MAX_TASKS);
}

function isOpenPersistedTask(value: unknown): value is PersistedTaskRow {
  return Boolean(value)
    && typeof value === "object"
    && (value as PersistedTaskRow).status === "open"
    && typeof (value as PersistedTaskRow).id === "string"
    && typeof (value as PersistedTaskRow).title === "string"
    && typeof (value as PersistedTaskRow).createdAt === "string";
}

async function readUpcomingEvents(
  registry: CalendarProviderRegistry | undefined,
  from: Date,
  to: Date
): Promise<readonly CalendarEvent[] | undefined> {
  if (!registry) {
    return undefined;
  }
  return registry.listEvents({ from, to });
}

async function readRecentNotes(notesDir: string | undefined): Promise<readonly string[] | undefined> {
  if (!notesDir) {
    return undefined;
  }
  const root = pathResolve(notesDir);
  const collected: { name: string; mtime: number }[] = [];
  await collectNotesRecursive(root, "", collected, 0);
  return collected
    .sort((left, right) => right.mtime - left.mtime)
    .slice(0, MAX_RECENT_NOTES)
    .map((entry) => entry.name);
}

const MAX_NOTES_WALK_DEPTH = 8;

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
  // Stat all visible files in this directory in parallel, then recurse
  // into visible subdirectories. Recursion lets `today` surface notes
  // organized into subfolders (e.g. Obsidian-style daily/weekly vaults).
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
