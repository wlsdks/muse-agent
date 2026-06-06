/**
 * `muse anomaly` — your most unusual days, measured against your OWN history.
 *
 * Robust point-anomaly detection (median + MAD; agent-core/activity-anomaly.ts)
 * over a daily count of your activity (tasks added, conversations, reminders
 * set). Local, deterministic, draft-first — it surfaces the day, never acts.
 */

import { dailyCounts, mostAnomalousDays, type DayAnomaly } from "@muse/agent-core";
import { resolveEpisodesFile, resolveRemindersFile, resolveTasksFile } from "@muse/autoconfigure";
import { readEpisodes, readReminders, readTasks } from "@muse/mcp";
import type { Command } from "commander";

import type { ProgramIO } from "./program.js";

const parseMs = (iso: string | undefined): number => (iso ? Date.parse(iso) : Number.NaN);

/** Gather the user's activity timestamps (tasks + episodes + reminders created). Fail-soft per store. */
export async function gatherActivityTimestamps(env: Record<string, string | undefined>): Promise<number[]> {
  const [tasks, episodes, reminders] = await Promise.all([
    readTasks(resolveTasksFile(env)).catch(() => []),
    readEpisodes(resolveEpisodesFile(env)).catch(() => []),
    readReminders(resolveRemindersFile(env)).catch(() => [])
  ]);
  return [
    ...tasks.map((task) => parseMs(task.createdAt)),
    ...episodes.map((episode) => parseMs(episode.endedAt)),
    ...reminders.map((reminder) => parseMs(reminder.createdAt))
  ].filter((value) => Number.isFinite(value));
}

/** Render the anomaly readout. Pure. */
export function formatAnomaly(anomalies: readonly DayAnomaly[], dayCount: number): string {
  if (dayCount < 7) {
    return "📊 Not enough history yet to spot an unusual day — keep using Muse for a couple of weeks.\n";
  }
  if (anomalies.length === 0) {
    return `📊 No unusual days across your ${dayCount.toString()}-day history — steady as she goes.\n`;
  }
  const lines = [`📊 Your most unusual days (vs your own ${dayCount.toString()}-day history):`];
  for (const anomaly of anomalies) {
    const verb = anomaly.direction === "high" ? "much busier" : "much quieter";
    lines.push(
      `  • ${anomaly.date} — ${verb} than usual (${anomaly.count.toString()} vs a typical ${anomaly.median.toString()}; ${Math.abs(anomaly.modZScore).toFixed(1)}σ)`
    );
  }
  return `${lines.join("\n")}\n`;
}

export function registerAnomalyCommand(program: Command, io: ProgramIO): void {
  program
    .command("anomaly")
    .description("Spot your most unusual days — activity that stands out against your own history (local, robust, draft-first)")
    .option("--json", "Print the raw anomalies")
    .action(async (options: { readonly json?: boolean }) => {
      const stamps = await gatherActivityTimestamps(process.env as Record<string, string | undefined>);
      const days = dailyCounts(stamps);
      const anomalies = mostAnomalousDays(days);
      if (options.json) {
        io.stdout(`${JSON.stringify({ anomalies, days: days.length }, null, 2)}\n`);
        return;
      }
      io.stdout(formatAnomaly(anomalies, days.length));
    });
}
