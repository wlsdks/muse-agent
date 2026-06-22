/**
 * `muse session` — focus / DND controls for the JARVIS daemons.
 *
 * Proactive notices are great, but only when the user
 * wants them. `muse session lock --hours N [--reason "deep work"]`
 * writes `~/.muse/session-lock.json` with a future `until`
 * timestamp; the proactive notice loop reads the marker on every
 * tick and skips firing while it's active. `muse session unlock`
 * clears the file. `muse session status` prints whether the
 * marker is active and how long is left.
 */

import { existsSync } from "node:fs";
import { stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { readSessionLock, writeSessionLock, type SessionLockPayload } from "@muse/proactivity";
import type { Command } from "commander";

import type { ProgramIO } from "./program.js";

interface LockOptions {
  readonly hours?: string;
  readonly minutes?: string;
  readonly reason?: string;
  readonly json?: boolean;
}

interface UnlockOptions {
  readonly json?: boolean;
}

interface StatusOptions {
  readonly json?: boolean;
}

function defaultSessionLockFile(): string {
  const fromEnv = process.env.MUSE_SESSION_LOCK_FILE?.trim();
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  return join(homedir(), ".muse", "session-lock.json");
}

/**
 * Format a minute count the way a human reads a
 * duration: `5m` → `"5 min"`, `60m` → `"1h"`, `90m` → `"1h 30m"`,
 * `0m` → `"<1 min"` (so a near-expired lock doesn't display as
 * `"0 min"`). Pure helper so the unit test pins every branch.
 *
 * Negative inputs clamp to `"<1 min"` (the caller shouldn't reach
 * this with negatives, but defensive).
 */
export function formatRemainingDuration(rawMinutes: number): string {
  if (!Number.isFinite(rawMinutes) || rawMinutes < 1) {
    return "<1 min";
  }
  const total = Math.round(rawMinutes);
  if (total < 60) {
    return `${total.toString()} min`;
  }
  const hours = Math.trunc(total / 60);
  const mins = total % 60;
  if (mins === 0) {
    return `${hours.toString()}h`;
  }
  return `${hours.toString()}h ${mins.toString()}m`;
}

export function resolveLockUntilMs(rawHours: string | undefined, rawMinutes: string | undefined, nowMs: number): number {
  // strict Number() (not parseFloat) so a "4h" unit-slip rejects
  // instead of silently becoming a 4-hour lock.
  const hours = parseStrictNumeric("--hours", rawHours);
  const minutes = parseStrictNumeric("--minutes", rawMinutes);
  if (hours < 0 || minutes < 0) {
    throw new Error("--hours / --minutes must be non-negative");
  }
  const totalMs = hours * 60 * 60 * 1000 + minutes * 60 * 1000;
  if (totalMs <= 0) {
    // Default to 1 hour when nothing was passed.
    return nowMs + 60 * 60 * 1000;
  }
  return nowMs + totalMs;
}

function parseStrictNumeric(flag: string, raw: string | undefined): number {
  if (raw === undefined) return 0;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return 0;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${flag} must be numeric (got '${raw}')`);
  }
  return parsed;
}

export function registerSessionCommands(program: Command, io: ProgramIO): void {
  const session = program.command("session").description("Focus / Do-Not-Disturb controls for proactive notices");

  session
    .command("lock")
    .description("Pause proactive notices until --hours / --minutes elapses (default 1 hour)")
    .option("--hours <n>", "Lock duration in hours (decimal OK; combines with --minutes)")
    .option("--minutes <n>", "Lock duration in minutes (combines with --hours)")
    .option("--reason <text>", "Optional note surfaced by `muse session status` (e.g. \"deep work\")")
    .option("--json", "Emit the written marker as JSON")
    .action(async (options: LockOptions) => {
      const file = defaultSessionLockFile();
      const nowMs = Date.now();
      let untilMs: number;
      try {
        untilMs = resolveLockUntilMs(options.hours, options.minutes, nowMs);
      } catch (cause) {
        io.stderr(`${cause instanceof Error ? cause.message : String(cause)}\n`);
        process.exitCode = 1;
        return;
      }
      const payload: SessionLockPayload = {
        setAt: new Date(nowMs).toISOString(),
        until: new Date(untilMs).toISOString(),
        ...(options.reason && options.reason.trim().length > 0 ? { reason: options.reason.trim() } : {})
      };
      await writeSessionLock(file, payload);
      if (options.json) {
        io.stdout(`${JSON.stringify(payload, null, 2)}\n`);
        return;
      }
      const minsRemaining = (untilMs - nowMs) / 60_000;
      const reasonClause = payload.reason ? ` (${payload.reason})` : "";
      io.stdout(`session locked${reasonClause} until ${payload.until} — ${formatRemainingDuration(minsRemaining)}\n`);
      io.stdout(`(proactive notices will resume after that. \`muse session unlock\` to clear.)\n`);
    });

  session
    .command("unlock")
    .description("Clear an active session lock so proactive notices resume immediately")
    .option("--json", "Emit a JSON status payload instead of human-readable text")
    .action(async (options: UnlockOptions) => {
      const file = defaultSessionLockFile();
      const had = existsSync(file);
      if (had) {
        await unlink(file).catch(() => undefined);
      }
      if (options.json) {
        io.stdout(`${JSON.stringify({ cleared: had }, null, 2)}\n`);
        return;
      }
      io.stdout(had ? "session unlocked.\n" : "(no active session lock to clear)\n");
    });

  session
    .command("status")
    .description("Report whether the session is locked and how long is left")
    .option("--json", "Emit a JSON status payload instead of human-readable text")
    .action(async (options: StatusOptions) => {
      const file = defaultSessionLockFile();
      const nowDate = new Date();
      const until = await readSessionLock(file, nowDate);
      if (!until) {
        // Lock either doesn't exist, expired, or is corrupted.
        // Disambiguate the expired-vs-missing case for human output
        // by reading file mtime; on missing the message is fine
        // either way.
        const exists = await stat(file).then(() => true).catch(() => false);
        if (options.json) {
          io.stdout(`${JSON.stringify({ active: false, expired: exists, file }, null, 2)}\n`);
          return;
        }
        io.stdout(exists ? "session unlocked (marker is stale — safe to ignore)\n" : "session unlocked.\n");
        return;
      }
      const minsRemainingFloat = (new Date(until).getTime() - nowDate.getTime()) / 60_000;
      const minsRemaining = Math.round(minsRemainingFloat);
      if (options.json) {
        // JSON shape unchanged for downstream consumers — humans
        // get the formatted string, scripts get the raw integer in
        // minutesRemaining.
        io.stdout(`${JSON.stringify({ active: true, file, minutesRemaining: minsRemaining, until }, null, 2)}\n`);
        return;
      }
      io.stdout(`session locked until ${until} — ${formatRemainingDuration(minsRemainingFloat)} remaining\n`);
    });
}
