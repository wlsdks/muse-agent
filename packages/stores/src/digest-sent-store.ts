/**
 * The digest-flush "already sent today" sidecar (`~/.muse/digest-sent.json`).
 * Records only the LOCAL calendar date of the last successful daily-digest
 * send so the flush tick can dedupe to once per day regardless of tick
 * cadence — the same shape as `learning-pause-store.ts`'s single-value
 * sidecar. Tolerant read: missing / malformed → undefined (never sent),
 * matching the sibling stores' fail-open convention (§4 of the interruption-
 * budget plan: I/O errors never block a delivery — here, never block the
 * daily flush from firing).
 */

import { promises as fs } from "node:fs";

import { isRecord } from "@muse/shared";

import { atomicWriteFile } from "./atomic-file-store.js";

export interface DigestSentState {
  /** Local calendar date the digest last sent, `YYYY-MM-DD`. */
  readonly lastSentDate: string;
}

/** `YYYY-MM-DD` in LOCAL time (not UTC) — matches the flush's own local-hour gate. */
export function localDateKey(at: Date): string {
  const year = at.getFullYear().toString().padStart(4, "0");
  const month = (at.getMonth() + 1).toString().padStart(2, "0");
  const day = at.getDate().toString().padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** The last local date the digest sent, or undefined when never sent / unreadable. */
export async function readDigestSentDate(file: string): Promise<string | undefined> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw);
    if (!isRecord(parsed)) return undefined;
    const lastSentDate = parsed.lastSentDate;
    return typeof lastSentDate === "string" && lastSentDate.length > 0 ? lastSentDate : undefined;
  } catch {
    return undefined;
  }
}

/** True when the digest already sent on `at`'s local calendar date. */
export async function digestAlreadySentToday(file: string, at: Date): Promise<boolean> {
  const lastSentDate = await readDigestSentDate(file);
  return lastSentDate === localDateKey(at);
}

/** Record that the digest sent at `at` (stores only `at`'s local date). */
export async function markDigestSent(file: string, at: Date): Promise<void> {
  const state: DigestSentState = { lastSentDate: localDateKey(at) };
  await atomicWriteFile(file, `${JSON.stringify(state, null, 2)}\n`);
}
