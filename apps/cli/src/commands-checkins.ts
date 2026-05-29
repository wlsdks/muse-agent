/**
 * `muse checkins` — the user-facing surface for proactive commitment
 * check-ins. `scan` reads the recent chat, detects the user's open-loop
 * commitments (`detectUserCommitments`), and schedules due-windowed check-ins
 * the daemon later delivers. `list` shows what's scheduled/fired. Read-only
 * over last-chat; the schedule is deterministic (no model).
 */

import { detectUserCommitments } from "@muse/agent-core";
import { appendCheckins, readCheckins, scheduleCheckins } from "@muse/mcp";
import type { Command } from "commander";
import { homedir } from "node:os";
import { join } from "node:path";

import { readLastChatHistory } from "./chat-history.js";
import { formatLocalDateTime as shortDateTime } from "./human-formatters.js";
import type { ProgramIO } from "./program.js";

export function checkinsFile(env: NodeJS.ProcessEnv = process.env): string {
  return env.MUSE_CHECKINS_FILE?.trim() || join(homedir(), ".muse", "checkins.json");
}

function resolveUserId(env: NodeJS.ProcessEnv = process.env): string {
  return env.MUSE_USER_ID?.trim() || env.USER?.trim() || "user";
}

export function registerCheckinsCommands(program: Command, io: ProgramIO): void {
  const checkins = program
    .command("checkins")
    .description("Proactive check-ins on things you said you'd do (the daemon asks how they went)");

  checkins
    .command("scan")
    .description("Scan recent chat for your commitments and schedule due-windowed check-ins")
    .option("--slot-hour <h>", "Local hour the next-day check-in fires (default 10)")
    .option("--max-per-day <n>", "Max new check-ins per day (default 3)")
    .option("--json", "Print the raw payload")
    .action(async (options: { readonly slotHour?: string; readonly maxPerDay?: string; readonly json?: boolean }) => {
      const history = await readLastChatHistory().catch(() => []);
      const userTurns = history.filter((line) => line.role === "user").map((line) => line.content);
      const commitments = detectUserCommitments(userTurns).map((c) => c.text);
      const file = checkinsFile();
      const existing = await readCheckins(file).catch(() => []);
      const fresh = scheduleCheckins(commitments, {
        existing,
        now: new Date(),
        userId: resolveUserId(),
        ...(options.slotHour !== undefined ? { slotHour: Number(options.slotHour) } : {}),
        ...(options.maxPerDay !== undefined ? { maxPerDay: Number(options.maxPerDay) } : {})
      });
      await appendCheckins(file, fresh);
      if (options.json) {
        io.stdout(`${JSON.stringify({ scheduled: fresh, total: fresh.length }, null, 2)}\n`);
        return;
      }
      if (fresh.length === 0) {
        io.stdout("No new commitments to schedule a check-in for.\n");
        return;
      }
      io.stdout(`Scheduled ${fresh.length.toString()} check-in(s):\n`);
      for (const c of fresh) io.stdout(`  • ${c.question}  (${shortDateTime(c.dueAtIso)})\n`);
    });

  checkins
    .command("list")
    .description("List scheduled / fired check-ins")
    .option("--status <s>", "scheduled (default) | fired | all", "scheduled")
    .option("--json", "Print the raw payload")
    .action(async (options: { readonly status: string; readonly json?: boolean }) => {
      const all = await readCheckins(checkinsFile()).catch(() => []);
      const status = options.status.trim().toLowerCase();
      const scoped = status === "all" ? all : all.filter((c) => c.status === status);
      if (options.json) {
        io.stdout(`${JSON.stringify({ checkins: scoped, status, total: scoped.length }, null, 2)}\n`);
        return;
      }
      if (scoped.length === 0) {
        io.stdout(`No ${status} check-ins.\n`);
        return;
      }
      io.stdout(`Check-ins (${scoped.length.toString()}, ${status}):\n`);
      for (const c of scoped) {
        const when = c.status === "fired" && c.firedAt ? `fired ${shortDateTime(c.firedAt)}` : `due ${shortDateTime(c.dueAtIso)}`;
        io.stdout(`  • ${c.question}  (${when})\n`);
      }
    });
}
