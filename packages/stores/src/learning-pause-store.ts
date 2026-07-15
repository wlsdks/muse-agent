/**
 * Learning pause switch (`~/.muse/learning-paused.json`) — the user's kill
 * switch over background self-learning (B1 §5). When paused, the idle distiller
 * writes ZERO strategies and the session producer enqueues ZERO corrections, so
 * nothing is learned (and nothing accumulates to be learned on resume) until the
 * user resumes. A persisted flag — not an env var — so a daemon already running
 * honors it without a restart, and the user toggles it with one command.
 *
 * Tolerant read: a missing or unreadable file ⇒ NOT paused (learning proceeds
 * under its own enable flag). Fail-OPEN here is deliberate: a corrupt pause file
 * must not silently wedge learning off forever — the worse failure is the user
 * thinking it's on when it's stuck off.
 */

import { promises as fs } from "node:fs";

import { atomicWriteFile } from "./atomic-file-store.js";

export interface LearningPauseState {
  readonly paused: boolean;
  /** ISO timestamp the current pause began (for display); absent when not paused. */
  readonly since?: string;
}

export async function readLearningPauseState(file: string): Promise<LearningPauseState> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    return { paused: false };
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && (parsed as { paused?: unknown }).paused === true) {
      const since = (parsed as { since?: unknown }).since;
      return { paused: true, ...(typeof since === "string" ? { since } : {}) };
    }
  } catch {
    // corrupt ⇒ fail-open (not paused)
  }
  return { paused: false };
}

/** True iff background learning is currently paused. */
export async function isLearningPaused(file: string): Promise<boolean> {
  return (await readLearningPauseState(file)).paused;
}

/** Set the pause switch. `since` stamps the start of a pause (ignored when resuming). */
export async function setLearningPaused(file: string, paused: boolean, since?: string): Promise<void> {
  const state: LearningPauseState = paused ? { paused: true, ...(since ? { since } : {}) } : { paused: false };
  await atomicWriteFile(file, `${JSON.stringify(state, null, 2)}\n`);
}
