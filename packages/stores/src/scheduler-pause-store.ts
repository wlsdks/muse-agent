/**
 * Scheduler pause switch (`~/.muse/scheduler-paused.json`) — the user's kill
 * switch over AUTONOMOUS scheduled jobs (proactive check-ins, background cron
 * work). When paused, the scheduler skips automatic firings until the user
 * resumes; a manual `trigger` still runs (explicit intent overrides). A
 * persisted flag (not an env var) so an already-running daemon honors it
 * without a restart, toggled with one command. Mirrors the learning-pause
 * switch.
 *
 * Tolerant + fail-OPEN read: a missing/corrupt file ⇒ NOT paused. A corrupt
 * pause file must not silently wedge every scheduled job off forever — the
 * worse failure is the user thinking jobs run when they're stuck off.
 */

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { isRecord } from "@muse/shared";

import { atomicWriteFile } from "./atomic-file-store.js";

/** Shared pause-file path so the CLI toggle and the daemon agree. Override with MUSE_SCHEDULER_PAUSE_FILE. */
export function defaultSchedulerPauseFile(env: Readonly<Record<string, string | undefined>> = process.env): string {
  return env.MUSE_SCHEDULER_PAUSE_FILE ?? join(homedir(), ".muse", "scheduler-paused.json");
}

export interface SchedulerPauseState {
  readonly paused: boolean;
  /** ISO timestamp the current pause began (for display); absent when not paused. */
  readonly since?: string;
}

export async function readSchedulerPauseState(file: string): Promise<SchedulerPauseState> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    return { paused: false };
  }
  try {
    const parsed = JSON.parse(raw);
    if (isRecord(parsed) && parsed.paused === true) {
      const since = parsed.since;
      return { paused: true, ...(typeof since === "string" ? { since } : {}) };
    }
  } catch {
    // corrupt ⇒ fail-open (not paused)
  }
  return { paused: false };
}

export async function isSchedulerPaused(file: string): Promise<boolean> {
  return (await readSchedulerPauseState(file)).paused;
}

export async function setSchedulerPaused(file: string, paused: boolean, since?: string): Promise<void> {
  const state: SchedulerPauseState = paused ? { paused: true, ...(since ? { since } : {}) } : { paused: false };
  await atomicWriteFile(file, `${JSON.stringify(state, null, 2)}\n`);
}
