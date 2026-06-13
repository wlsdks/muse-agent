/**
 * `muse checkins` — the user-facing surface for proactive commitment
 * check-ins. `scan` reads the recent chat, detects the user's open-loop
 * commitments (`detectUserCommitments`), and schedules due-windowed check-ins
 * the daemon later delivers. `list` shows what's scheduled/fired. Read-only
 * over last-chat; the schedule is deterministic (no model).
 */

import { detectUserCommitments } from "@muse/agent-core";
import { appendCheckins, cancelCheckin, parseReminderDueAt, readCheckins, scheduleCheckins, snoozeCheckin, writeCheckins, type PersistedCheckin } from "@muse/mcp";
import type { Command } from "commander";
import { homedir } from "node:os";
import { join } from "node:path";

import { readLastChatHistory } from "./chat-history.js";
import { closestCommandName } from "./closest-command.js";
import { formatLocalDateTime as shortDateTime } from "./human-formatters.js";
import type { ProgramIO } from "./program.js";

const CHECKIN_STATUS_VALUES = ["scheduled", "fired", "all"] as const;

export function checkinsFile(env: NodeJS.ProcessEnv = process.env): string {
  return env.MUSE_CHECKINS_FILE?.trim() || join(homedir(), ".muse", "checkins.json");
}

/**
 * Read recent chat, detect the user's open-loop commitments, and schedule
 * due-windowed check-ins (deduped + per-day capped). Returns the NEW
 * check-ins. Shared by `muse checkins scan` and the session-end auto-scan so
 * both behave identically.
 */
export async function scanSessionCheckins(
  options: {
    readonly slotHour?: number;
    readonly maxPerDay?: number;
    /** Test seams — default to the real chat-history reader / store path / clock. */
    readonly readHistory?: () => Promise<readonly { readonly role: string; readonly content: string }[]>;
    readonly file?: string;
    readonly userId?: string;
    readonly now?: () => Date;
  } = {}
): Promise<readonly PersistedCheckin[]> {
  const readHistory = options.readHistory ?? readLastChatHistory;
  const history = await readHistory().catch(() => []);
  const userTurns = history.filter((line) => line.role === "user").map((line) => line.content);
  const commitments = detectUserCommitments(userTurns).map((c) => c.text);
  const file = options.file ?? checkinsFile();
  const existing = await readCheckins(file).catch(() => []);
  const fresh = scheduleCheckins(commitments, {
    existing,
    now: options.now ? options.now() : new Date(),
    userId: options.userId ?? resolveUserId(),
    ...(options.slotHour !== undefined ? { slotHour: options.slotHour } : {}),
    ...(options.maxPerDay !== undefined ? { maxPerDay: options.maxPerDay } : {})
  });
  await appendCheckins(file, fresh);
  return fresh;
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
      const fresh = await scanSessionCheckins({
        ...(options.slotHour !== undefined ? { slotHour: Number(options.slotHour) } : {}),
        ...(options.maxPerDay !== undefined ? { maxPerDay: Number(options.maxPerDay) } : {})
      });
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
      const status = options.status.trim().toLowerCase();
      // Validate like `tasks list` — a typo'd --status must error loudly, not
      // silently filter to an empty (misleading-as-"no check-ins") result.
      if (!(CHECKIN_STATUS_VALUES as readonly string[]).includes(status)) {
        const suggestion = closestCommandName(status, CHECKIN_STATUS_VALUES);
        const hint = suggestion ? ` — did you mean '${suggestion}'?` : "";
        io.stderr(`muse checkins list: --status must be one of: ${CHECKIN_STATUS_VALUES.join(", ")} (got '${options.status}')${hint}\n`);
        process.exitCode = 1;
        return;
      }
      const all = await readCheckins(checkinsFile()).catch(() => []);
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
        io.stdout(`  • [${c.id}] ${c.question}  (${when})\n`);
      }
    });

  checkins
    .command("cancel <id>")
    .description("Cancel a scheduled check-in by id (you already did it, or don't want the nudge)")
    .option("--json", "Print the raw payload")
    .action(async (id: string, options: { readonly json?: boolean }) => {
      const file = checkinsFile();
      const all = await readCheckins(file).catch(() => []);
      const result = cancelCheckin(all, id);
      if (result.cancelled) {
        await writeCheckins(file, result.checkins);
      }
      if (options.json) {
        io.stdout(`${JSON.stringify({ cancelled: result.cancelled ?? null, reason: result.reason ?? null }, null, 2)}\n`);
        return;
      }
      if (result.cancelled) {
        io.stdout(`Cancelled check-in [${result.cancelled.id}] — "${result.cancelled.question}" won't fire.\n`);
        return;
      }
      const message =
        result.reason === "ambiguous" ? `'${id}' matches ${String(result.matches)} check-ins — use a longer id.`
        : result.reason === "already-fired" ? `Check-in '${id}' already fired — nothing to cancel.`
        : result.reason === "already-cancelled" ? `Check-in '${id}' is already cancelled.`
        : `No scheduled check-in matches '${id}'. Run \`muse checkins list\` to see ids.`;
      io.stderr(`${message}\n`);
    });

  checkins
    .command("snooze <id> <when>")
    .description("Defer a scheduled check-in to a later time (e.g. \"next week\", \"the 15th\", \"3 days\")")
    .option("--json", "Print the raw payload")
    .action(async (id: string, when: string, options: { readonly json?: boolean }) => {
      const parsed = parseReminderDueAt(when, () => new Date());
      if (parsed instanceof Error) {
        io.stderr(`muse checkins snooze: ${parsed.message}\n`);
        return;
      }
      const file = checkinsFile();
      const all = await readCheckins(file).catch(() => []);
      const result = snoozeCheckin(all, id, parsed);
      if (result.snoozed) {
        await writeCheckins(file, result.checkins);
      }
      if (options.json) {
        io.stdout(`${JSON.stringify({ reason: result.reason ?? null, snoozed: result.snoozed ?? null }, null, 2)}\n`);
        return;
      }
      if (result.snoozed) {
        io.stdout(`Snoozed check-in [${result.snoozed.id}] — now due ${shortDateTime(result.snoozed.dueAtIso)}.\n`);
        return;
      }
      const message =
        result.reason === "ambiguous" ? `'${id}' matches ${String(result.matches)} check-ins — use a longer id.`
        : result.reason === "already-fired" ? `Check-in '${id}' already fired — nothing to snooze.`
        : result.reason === "already-cancelled" ? `Check-in '${id}' is cancelled — nothing to snooze.`
        : `No scheduled check-in matches '${id}'. Run \`muse checkins list\` to see ids.`;
      io.stderr(`${message}\n`);
    });
}
