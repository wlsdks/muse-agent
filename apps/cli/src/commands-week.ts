/**
 * `muse week` — your next 7 days at a glance, grouped BY DAY: events, due
 * tasks, and birthdays under each day's header, so you can plan the week
 * instead of reading a flat next-24h brief. Read-only, local, deterministic
 * (file mtime / dueAt arithmetic; no model). The day-grouped planning twin of
 * `muse today` (which is the today-framed brief).
 */

import { resolveContactsFile, resolveLocalCalendarFile, resolveTasksFile } from "@muse/autoconfigure";
import { readTasks } from "@muse/mcp";
import { stripUntrustedTerminalChars } from "@muse/shared";
import type { Command } from "commander";

import { readLocalEvents, readUpcomingBirthdays } from "./commands-today.js";
import type { ProgramIO } from "./program.js";

type Env = Record<string, string | undefined>;

export interface WeekDay {
  readonly label: string;
  readonly lines: readonly string[];
}

export interface WeekAgendaInput {
  readonly events: readonly { readonly title: string; readonly startsAtIso: string }[];
  readonly tasks: readonly { readonly title: string; readonly dueAt: string }[];
  readonly birthdays: readonly { readonly name: string; readonly daysUntil: number }[];
}

const DAY_MS = 86_400_000;
const clean = (s: string): string => stripUntrustedTerminalChars(s).replace(/\s+/gu, " ").trim();
const startOfLocalDay = (d: Date): number => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
const dayLabel = (d: Date): string => d.toLocaleDateString("en-US", { day: "numeric", month: "short", weekday: "short" });

/**
 * Bucket events / due tasks / birthdays into the next `days` LOCAL calendar
 * days from `now` and render each as a line (timed events first by time, then
 * untimed tasks/birthdays). Only days with something appear. Pure.
 */
export function groupWeekAgenda(data: WeekAgendaInput, now: Date, days = 7): readonly WeekDay[] {
  const today0 = startOfLocalDay(now);
  const dayIndex = (ms: number): number => Math.floor((startOfLocalDay(new Date(ms)) - today0) / DAY_MS);
  const buckets: { time: number; text: string }[][] = Array.from({ length: days }, () => []);
  const push = (idx: number, text: string, time: number): void => {
    if (idx >= 0 && idx < days) {
      buckets[idx]!.push({ text, time });
    }
  };
  for (const event of data.events) {
    const ms = Date.parse(event.startsAtIso);
    if (Number.isFinite(ms)) {
      push(dayIndex(ms), `${new Date(ms).toTimeString().slice(0, 5)} ${clean(event.title)}`, ms);
    }
  }
  for (const task of data.tasks) {
    const ms = Date.parse(task.dueAt);
    if (Number.isFinite(ms)) {
      push(dayIndex(ms), `☑ ${clean(task.title)} (due)`, Number.POSITIVE_INFINITY);
    }
  }
  for (const birthday of data.birthdays) {
    push(birthday.daysUntil, `🎂 ${clean(birthday.name)}'s birthday`, Number.POSITIVE_INFINITY);
  }
  const out: WeekDay[] = [];
  for (let i = 0; i < days; i += 1) {
    const items = buckets[i]!;
    if (items.length === 0) {
      continue;
    }
    items.sort((a, b) => a.time - b.time);
    const date = new Date(today0 + i * DAY_MS);
    const label = i === 0 ? `Today — ${dayLabel(date)}` : i === 1 ? `Tomorrow — ${dayLabel(date)}` : dayLabel(date);
    out.push({ label, lines: items.map((item) => item.text) });
  }
  return out;
}

/** Human-readable week agenda. Pure. */
export function formatWeekAgenda(week: readonly WeekDay[]): string {
  if (week.length === 0) {
    return "📅 Your week ahead is clear — nothing scheduled in the next 7 days.\n";
  }
  const lines = ["📅 This week:"];
  for (const day of week) {
    lines.push("", `  ${day.label}`);
    for (const item of day.lines) {
      lines.push(`    ${item}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

export function registerWeekCommand(program: Command, io: ProgramIO): void {
  program
    .command("week")
    .description("Your next 7 days at a glance — events, due tasks, and birthdays grouped by day (read-only, local)")
    .option("--json", "Emit the agenda as JSON")
    .action(async (options: { readonly json?: boolean }) => {
      const env = process.env as Env;
      const now = new Date();
      const weekEnd = new Date(now.getTime() + 7 * DAY_MS);
      const events = await readLocalEvents(resolveLocalCalendarFile(env), now, weekEnd).catch(() => []);
      const allTasks = await readTasks(resolveTasksFile(env)).catch(() => []);
      const tasks = allTasks
        .filter((task) => task.status === "open" && typeof task.dueAt === "string"
          && Date.parse(task.dueAt) >= now.getTime() && Date.parse(task.dueAt) < weekEnd.getTime())
        .map((task) => ({ dueAt: task.dueAt as string, title: task.title }));
      const birthdays = await readUpcomingBirthdays(resolveContactsFile(env), now).catch(() => []);
      const week = groupWeekAgenda({ birthdays, events, tasks }, now);
      if (options.json) {
        io.stdout(`${JSON.stringify(week, null, 2)}\n`);
        return;
      }
      io.stdout(formatWeekAgenda(week));
    });
}
