/**
 * `muse routine` — pattern-learning aggregator.
 *
 * Reads `~/.muse/activity.jsonl` (the REPL writes one line per
 * session start), aggregates the last N days, and computes:
 *
 *   - top-3 hours-of-day the user is active
 *   - most active day-of-week
 *   - average sessions per day
 *
 * With `--apply`, writes the result back to the persistent user
 * memory as a `routine.active_hours` fact. The next REPL session's
 * persona prompt then includes "active hours: 09, 14, 20" so the
 * model can answer "am I usually awake at midnight?" with grounded
 * data instead of generic guessing — and proactive notices can
 * eventually skip firing during low-activity windows.
 *
 * Pure file-IO; no model call; runs in <50 ms.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { createMuseRuntimeAssembly } from "@muse/autoconfigure";
import type { Command } from "commander";

import { parseBoundedInt } from "./parse-bounded-int.js";
import type { ProgramIO } from "./program.js";

interface RoutineOptions {
  readonly user?: string;
  readonly days?: string;
  readonly apply?: boolean;
  readonly json?: boolean;
}

interface ActivityRow {
  readonly tsIso: string;
  readonly userId: string;
  readonly kind: string;
}

export function activityPath(): string {
  const raw = process.env.MUSE_ACTIVITY_FILE?.trim();
  return raw && raw.length > 0 ? raw : join(homedir(), ".muse", "activity.jsonl");
}

async function readActivity(file: string): Promise<readonly ActivityRow[]> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const rows: ActivityRow[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (typeof parsed === "object" && parsed && "tsIso" in parsed && "userId" in parsed) {
        const row = parsed as ActivityRow;
        if (typeof row.tsIso === "string" && typeof row.userId === "string") {
          rows.push(row);
        }
      }
    } catch { /* skip malformed */ }
  }
  return rows;
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function computeRoutine(rows: readonly ActivityRow[]) {
  const hourCounts = new Array(24).fill(0) as number[];
  const dowCounts = new Array(7).fill(0) as number[];
  const days = new Set<string>();
  // Count only rows whose timestamp parsed — otherwise a malformed
  // activity.jsonl line would inflate the average vs. daysObserved
  // (which already skips it), making the displayed math
  // `total / days = avg` arithmetically wrong.
  let validSessions = 0;
  for (const row of rows) {
    const date = new Date(row.tsIso);
    if (!Number.isFinite(date.getTime())) continue;
    validSessions += 1;
    const h = date.getHours();
    const d = date.getDay();
    hourCounts[h] = (hourCounts[h] ?? 0) + 1;
    dowCounts[d] = (dowCounts[d] ?? 0) + 1;
    days.add(date.toISOString().slice(0, 10));
  }
  const ranked = hourCounts
    .map((count, hour) => ({ hour, count }))
    .filter((entry) => entry.count > 0)
    .sort((a, b) => b.count - a.count);
  const topHours = ranked.slice(0, 3).map((entry) => entry.hour);
  const dowRanked = dowCounts
    .map((count, dow) => ({ count, dow }))
    .filter((entry) => entry.count > 0)
    .sort((a, b) => b.count - a.count);
  return {
    totalSessions: validSessions,
    daysObserved: days.size,
    topHours,
    topDays: dowRanked.slice(0, 3).map((entry) => DAY_NAMES[entry.dow]),
    sessionsPerDay: days.size > 0 ? Number((validSessions / days.size).toFixed(2)) : 0
  };
}

export function registerRoutineCommand(program: Command, io: ProgramIO): void {
  program
    .command("routine")
    .description("Aggregate ~/.muse/activity.jsonl into routine.active_hours + topDays; --apply writes the fact")
    .option("--user <id>", "Filter by user identity (default: aggregate across all users)")
    .option("--days <n>", "Rolling window in days (default 30)", "30")
    .option("--apply", "Write the routine as a fact into ~/.muse/user-memory.json (requires --user)")
    .option("--json", "Emit JSON instead of formatted text")
    .action(async (options: RoutineOptions) => {
      const days = parseBoundedInt(options.days, "--days", 1, 365, 30);
      const cutoff = Date.now() - days * 86_400_000;
      const file = activityPath();
      const all = await readActivity(file);
      const filtered = all.filter((row) => {
        const ts = new Date(row.tsIso).getTime();
        if (!Number.isFinite(ts) || ts < cutoff) return false;
        if (options.user && row.userId !== options.user) return false;
        return true;
      });
      const summary = computeRoutine(filtered);
      const result = {
        user: options.user ?? "(all)",
        windowDays: days,
        ...summary,
        activeHoursFact: summary.topHours.length > 0
          ? summary.topHours.map((h) => h.toString().padStart(2, "0")).join(",")
          : undefined,
        activeDaysFact: summary.topDays.join(",") || undefined
      };

      if (options.json) {
        io.stdout(`${JSON.stringify(result, null, 2)}\n`);
        return;
      }

      const dayUnit = summary.daysObserved === 1 ? "day" : "days";
      io.stdout(`Routine — user=${result.user}, window=${days.toString()}d, file=${file}\n`);
      io.stdout(`  sessions: ${summary.totalSessions.toString()} across ${summary.daysObserved.toString()} ${dayUnit} (avg ${summary.sessionsPerDay.toString()}/day)\n`);
      if (summary.topHours.length > 0) {
        io.stdout(`  top active hours: ${result.activeHoursFact}\n`);
        io.stdout(`  top active days:  ${result.activeDaysFact ?? "(none)"}\n`);
      } else {
        io.stdout("  (no sessions in window — run `muse repl` a few times to seed)\n");
      }

      if (options.apply) {
        if (!options.user) {
          io.stderr("--apply requires --user <id> so the fact lands on the right persona.\n");
          process.exitCode = 1;
          return;
        }
        if (!result.activeHoursFact) {
          io.stderr("Nothing to apply — no sessions in the window.\n");
          return;
        }
        const assembly = createMuseRuntimeAssembly();
        if (!assembly.userMemoryStore) {
          io.stderr("No userMemoryStore in assembly. Did MUSE_USER_MEMORY_PERSIST=false?\n");
          process.exitCode = 1;
          return;
        }
        await assembly.userMemoryStore.upsertFact(options.user, "routine_active_hours", result.activeHoursFact);
        if (result.activeDaysFact) {
          await assembly.userMemoryStore.upsertFact(options.user, "routine_active_days", result.activeDaysFact);
        }
        io.stdout(`\nApplied — facts written to ~/.muse/user-memory.json for user '${options.user}'.\n`);
      }
    });
}
