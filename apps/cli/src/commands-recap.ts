import { resolveActionLogFile, resolveEpisodesFile, resolveFollowupsFile, resolveRemindersFile } from "@muse/autoconfigure";
import { readActionLog, readEpisodes, readFollowups, readReminders } from "@muse/mcp";
import type { Command } from "commander";

import type { ProgramIO } from "./program.js";

/**
 * `muse recap` — the EVENING, retrospective sibling of `muse brief` (which is
 * the morning, prospective briefing). Deterministic (no model): a digest of
 * what actually got done today (the action log + sessions) plus what's coming
 * up next, so the day closes with a felt summary instead of vanishing. P43-4
 * "evening recap"; the proactive (daemon-fired) version is a follow-on.
 */

const DAY_MS = 86_400_000;

function sameLocalDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

export interface EveningRecapInput {
  readonly now: Date;
  /** Human descriptions of actions Muse PERFORMED for the user today. */
  readonly performedToday: readonly string[];
  /** Count of chat sessions with Muse today. */
  readonly sessionsToday: number;
  /** "thing — due <time>" lines for reminders due in the next 24h. */
  readonly comingUp: readonly string[];
  readonly openFollowups: number;
}

/**
 * Pure: render the evening recap from gathered facts. No model, no IO — so the
 * digest is fully deterministic + unit-testable (the same property the brief's
 * grounding gate protects).
 */
export function composeEveningRecap(input: EveningRecapInput): string {
  const lines: string[] = [];
  lines.push(`🌙 Evening recap — ${input.now.toLocaleDateString("en-US", { day: "numeric", month: "long", weekday: "long" })}`);

  if (input.performedToday.length > 0) {
    lines.push("", `Today you got done (${input.performedToday.length.toString()}):`);
    for (const what of input.performedToday.slice(0, 8)) {
      lines.push(`  ✓ ${what}`);
    }
    if (input.performedToday.length > 8) {
      lines.push(`  …and ${(input.performedToday.length - 8).toString()} more`);
    }
  }
  if (input.sessionsToday > 0) {
    lines.push("", `${input.sessionsToday.toString()} session${input.sessionsToday === 1 ? "" : "s"} with Muse today.`);
  }
  if (input.performedToday.length === 0 && input.sessionsToday === 0) {
    lines.push("", "Quiet day — nothing logged yet.");
  }

  if (input.comingUp.length > 0) {
    lines.push("", "Coming up (next 24h):");
    for (const item of input.comingUp.slice(0, 8)) {
      lines.push(`  ⏰ ${item}`);
    }
  }
  if (input.openFollowups > 0) {
    lines.push("", `${input.openFollowups.toString()} open follow-up${input.openFollowups === 1 ? "" : "s"} — see \`muse followups\`.`);
  }
  return lines.join("\n");
}

export function registerRecapCommand(program: Command, io: ProgramIO): void {
  program
    .command("recap")
    .description("Evening recap — what you got done today + what's coming up (the retrospective sibling of `muse brief`)")
    .option("--json", "Emit the structured recap as JSON instead of the digest")
    .action(async (options: { readonly json?: boolean }) => {
      const env = process.env as Record<string, string | undefined>;
      const now = new Date();
      const horizon = new Date(now.getTime() + DAY_MS);

      const performedToday: string[] = [];
      let sessionsToday = 0;
      const comingUp: string[] = [];
      let openFollowups = 0;

      // Each source is fail-soft: a missing/corrupt store degrades that section
      // to empty rather than crashing the recap.
      try {
        for (const entry of await readActionLog(resolveActionLogFile(env))) {
          const when = new Date(entry.when);
          if (entry.result === "performed" && !Number.isNaN(when.getTime()) && sameLocalDay(when, now)) {
            performedToday.push(entry.what);
          }
        }
      } catch { /* fail-soft */ }
      try {
        for (const episode of await readEpisodes(resolveEpisodesFile(env))) {
          const ended = new Date(episode.endedAt);
          if (!Number.isNaN(ended.getTime()) && sameLocalDay(ended, now)) {
            sessionsToday += 1;
          }
        }
      } catch { /* fail-soft */ }
      try {
        for (const reminder of await readReminders(resolveRemindersFile(env))) {
          const due = new Date(reminder.dueAt);
          if (reminder.status === "pending" && !Number.isNaN(due.getTime()) && due >= now && due <= horizon) {
            comingUp.push(`${reminder.text} — due ${due.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`);
          }
        }
      } catch { /* fail-soft */ }
      try {
        openFollowups = (await readFollowups(resolveFollowupsFile(env))).length;
      } catch { /* fail-soft */ }

      if (options.json === true) {
        io.stdout(`${JSON.stringify({ comingUp, openFollowups, performedToday, sessionsToday })}\n`);
        return;
      }
      io.stdout(`${composeEveningRecap({ comingUp, now, openFollowups, performedToday, sessionsToday })}\n`);
    });
}
