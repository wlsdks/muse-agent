/**
 * The Home reconfirm-card "already answered today" sidecar
 * (`~/.muse/reconfirm-card-answered.json`). Records only the LOCAL calendar
 * date of the last answered (confirm OR reject) reconfirm card so the
 * once-per-day gate holds regardless of how many times the card is fetched —
 * mere viewing never consumes the day, only a recorded verdict does. Same
 * shape + fail-open read convention as the sibling `digest-sent-store.ts`.
 */

import { promises as fs } from "node:fs";

import { atomicWriteFile } from "./atomic-file-store.js";
import { localDateKey } from "./digest-sent-store.js";

export interface ReconfirmCardAnsweredState {
  /** Local calendar date the reconfirm card was last answered, `YYYY-MM-DD`. */
  readonly lastAnsweredDate: string;
}

/** The last local date a reconfirm card was answered, or undefined when never / unreadable. */
export async function readReconfirmCardAnsweredDate(file: string): Promise<string | undefined> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    const lastAnsweredDate = (parsed as { lastAnsweredDate?: unknown } | null)?.lastAnsweredDate;
    return typeof lastAnsweredDate === "string" && lastAnsweredDate.length > 0 ? lastAnsweredDate : undefined;
  } catch {
    return undefined;
  }
}

/** True when a reconfirm card was already answered on `at`'s local calendar date. */
export async function reconfirmCardAlreadyAnsweredToday(file: string, at: Date): Promise<boolean> {
  const lastAnsweredDate = await readReconfirmCardAnsweredDate(file);
  return lastAnsweredDate === localDateKey(at);
}

/** Record that a reconfirm card was answered at `at` (stores only `at`'s local date). */
export async function markReconfirmCardAnswered(file: string, at: Date): Promise<void> {
  const state: ReconfirmCardAnsweredState = { lastAnsweredDate: localDateKey(at) };
  await atomicWriteFile(file, `${JSON.stringify(state, null, 2)}\n`);
}
