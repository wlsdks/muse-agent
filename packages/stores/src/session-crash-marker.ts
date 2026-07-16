/**
 * Crash-detection marker for the chat-session lifecycle.
 *
 * Muse flushes a session's turns to long-term memory in an END-of-session
 * pipeline. If the process dies first (crash / kill / power loss) that
 * flush never runs and the turns are stranded in the working log. This
 * marker makes the loss DETECTABLE: write it at boot, remove it on a clean
 * end-session. If it is still present at the next boot, the previous
 * session exited uncleanly — the caller can recover the stranded turns
 * before starting fresh.
 *
 * Atomic write (a crash mid-write can't leave a corrupt half-marker) and
 * fully deterministic. The caller MUST `detectUncleanShutdown` BEFORE
 * `markSessionStart`, since starting overwrites the prior marker.
 */

import { promises as fs } from "node:fs";

import { atomicWriteFile } from "./atomic-file-store.js";

export interface SessionStartInfo {
  readonly startedAt: string;
  readonly pid: number;
}

export async function markSessionStart(markerPath: string, info: SessionStartInfo): Promise<void> {
  await atomicWriteFile(markerPath, `${JSON.stringify(info)}\n`);
}

export async function markSessionCleanExit(markerPath: string): Promise<void> {
  await fs.rm(markerPath, { force: true });
}

/**
 * Returns the prior session's start info when a marker survives (an
 * unclean shutdown), or `undefined` when there is no marker (clean) or it
 * is unreadable/corrupt.
 */
export async function detectUncleanShutdown(markerPath: string): Promise<SessionStartInfo | undefined> {
  let raw: string;
  try {
    raw = await fs.readFile(markerPath, "utf8");
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (isSessionStartInfo(parsed)) {
      return parsed;
    }
  } catch {
    /* corrupt marker → treat as no recoverable info */
  }
  return undefined;
}

function isSessionStartInfo(value: unknown): value is SessionStartInfo {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.startedAt === "string"
    && Number.isFinite(Date.parse(record.startedAt))
    && typeof record.pid === "number"
    && Number.isSafeInteger(record.pid)
    && record.pid > 0
  );
}
