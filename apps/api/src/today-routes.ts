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
 * `muse today` (round 119+121) currently does the same fan-out
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
import type { FastifyInstance } from "fastify";

import { requireAuthenticated } from "./server-helpers.js";
import type { ServerOptions } from "./server.js";

const DEFAULT_LOOKAHEAD_HOURS = 24;
const MAX_LOOKAHEAD_HOURS = 24 * 7;
const MAX_TASKS = 50;
const MAX_RECENT_NOTES = 5;

interface TodayRoutesGate {
  readonly authService: ServerOptions["authService"];
  readonly calendar?: CalendarProviderRegistry;
  readonly notesDir?: string;
  readonly tasksFile?: string;
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
    const hoursParsed = lookaheadHours ? Number.parseInt(lookaheadHours, 10) : DEFAULT_LOOKAHEAD_HOURS;
    const hours = Number.isFinite(hoursParsed) && hoursParsed >= 1
      ? Math.min(hoursParsed, MAX_LOOKAHEAD_HOURS)
      : DEFAULT_LOOKAHEAD_HOURS;
    const now = new Date();
    const horizon = new Date(now.getTime() + hours * 3_600_000);

    const [tasks, events, notes] = await Promise.all([
      readOpenTasks(gate.tasksFile).catch(() => undefined),
      readUpcomingEvents(gate.calendar, now, horizon).catch(() => undefined),
      readRecentNotes(gate.notesDir).catch(() => undefined)
    ]);

    return {
      events,
      generatedAt: now.toISOString(),
      lookaheadHours: hours,
      notes,
      tasks
    };
  });
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
    .sort((left, right) => (right.createdAt ?? "").localeCompare(left.createdAt ?? ""))
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
  let entries: { readonly name: string; isDirectory(): boolean; isFile(): boolean }[];
  try {
    entries = (await fs.readdir(root, { withFileTypes: true })) as unknown as {
      readonly name: string;
      isDirectory(): boolean;
      isFile(): boolean;
    }[];
  } catch {
    return [];
  }
  const files: { name: string; mtime: number }[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".") || !entry.isFile()) {
      continue;
    }
    try {
      const stat = await fs.stat(join(root, entry.name));
      files.push({ mtime: stat.mtime.getTime(), name: entry.name });
    } catch {
      // skip unreadable entries
    }
  }
  return files
    .sort((left, right) => right.mtime - left.mtime)
    .slice(0, MAX_RECENT_NOTES)
    .map((entry) => entry.name);
}
