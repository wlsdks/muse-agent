/**
 * `muse week` — your next 7 days at a glance, grouped BY DAY: events, due
 * tasks, and birthdays under each day's header, so you can plan the week
 * instead of reading a flat next-24h brief. Read-only, local, deterministic
 * (file mtime / dueAt arithmetic; no model). The day-grouped planning twin of
 * `muse today` (which is the today-framed brief).
 */

import { groupWeekAgenda, resolveContactsFile, resolveLocalCalendarFile, resolveTasksFile, type WeekDay } from "@muse/autoconfigure";
import { readTasks } from "@muse/stores";
import { OpenMeteoWeatherProvider, type DailyForecast, type WeatherProvider } from "@muse/domain-tools";
import type { Command } from "commander";

import { readLocalEvents, readUpcomingBirthdays } from "./commands-today.js";
import type { ProgramIO } from "./program.js";

type Env = Record<string, string | undefined>;

// `groupWeekAgenda` + WeekDay/WeekAgendaInput moved to @muse/autoconfigure so the
// `week_agenda` agent tool and this command share one implementation; re-exported
// for callers/tests.
export { groupWeekAgenda, type WeekDay } from "@muse/autoconfigure";

const DAY_MS = 86_400_000;

/** A compact one-day forecast for the week header (no date prefix — the day's header already carries the date). Pure. */
export function formatWeekForecast(day: DailyForecast): string {
  const range = `${Math.round(day.tempMinC).toString()}–${Math.round(day.tempMaxC).toString()}°C`;
  const rain = day.precipitationProbabilityMaxPct !== undefined ? `, rain ${day.precipitationProbabilityMaxPct.toString()}%` : "";
  return `${day.condition}, ${range}${rain}`;
}

/**
 * The next `days` days of forecast summaries keyed by local date, for the week
 * agenda — resolved from `MUSE_WEATHER_LOCATION` via the same Open-Meteo provider
 * `muse today`/`muse brief` use (a public weather DATA api, not a cloud LLM). Returns
 * [] when no location is configured or the lookup fails (graceful, never throws), so
 * the week view simply omits weather rather than erroring.
 */
export async function resolveWeekForecasts(
  env: Env,
  days = 7,
  provider?: WeatherProvider
): Promise<readonly { readonly dateIso: string; readonly summary: string }[]> {
  const location = env.MUSE_WEATHER_LOCATION?.trim();
  if (!location || location.length === 0) {
    return [];
  }
  const wp = provider ?? new OpenMeteoWeatherProvider();
  if (!wp.dailyForecast) {
    return [];
  }
  try {
    const geo = await wp.geocode(location);
    if (!geo) {
      return [];
    }
    const forecast = await wp.dailyForecast(geo, { days });
    return forecast.slice(0, days).map((d) => ({ dateIso: d.dateIso, summary: formatWeekForecast(d) }));
  } catch {
    return [];
  }
}


/** Human-readable week agenda. Pure. */
export function formatWeekAgenda(week: readonly WeekDay[]): string {
  if (week.length === 0) {
    return "📅 Your week ahead is clear — nothing scheduled in the next 7 days.\n";
  }
  const lines = ["📅 This week:"];
  for (const day of week) {
    lines.push("", `  ${day.label}${day.forecast ? ` — ${day.forecast}` : ""}`);
    for (const item of day.lines) {
      lines.push(`    ${item}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

export function registerWeekCommand(program: Command, io: ProgramIO): void {
  program
    .command("week")
    .description("Your next 7 days at a glance — events, due tasks, birthdays, and the daily weather forecast grouped by day (read-only, local)")
    .option("--json", "Emit the agenda as JSON")
    .action(async (options: { readonly json?: boolean }) => {
      const env = process.env;
      const now = new Date();
      const weekEnd = new Date(now.getTime() + 7 * DAY_MS);
      const events = await readLocalEvents(resolveLocalCalendarFile(env), now, weekEnd).catch(() => []);
      const allTasks = await readTasks(resolveTasksFile(env)).catch(() => []);
      const tasks = allTasks
        .filter((task) => task.status === "open" && typeof task.dueAt === "string"
          && Date.parse(task.dueAt) >= now.getTime() && Date.parse(task.dueAt) < weekEnd.getTime())
        .map((task) => ({ dueAt: task.dueAt as string, title: task.title }));
      const birthdays = await readUpcomingBirthdays(resolveContactsFile(env), now).catch(() => []);
      const forecasts = await resolveWeekForecasts(env).catch(() => []);
      const week = groupWeekAgenda({ birthdays, events, forecasts, tasks }, now);
      if (options.json) {
        io.stdout(`${JSON.stringify(week, null, 2)}\n`);
        return;
      }
      io.stdout(formatWeekAgenda(week));
    });
}
