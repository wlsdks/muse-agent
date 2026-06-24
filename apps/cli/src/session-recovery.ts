/**
 * SES crash-recovery wiring for the chat REPL (uses the @muse/stores
 * session crash marker). At boot we DETECT a surviving marker (the prior
 * session didn't reach its clean end → a crash/kill/power-loss) and then
 * mark THIS session started; at a clean exit we remove the marker. The
 * detection lets the REPL surface that the previous session ended
 * unexpectedly — the turns themselves are already durable in
 * last-chat.jsonl, so this is a notice, not data loss.
 *
 * Order matters: detect BEFORE marking start, since marking overwrites the
 * prior marker. Kept as a thin, injectable seam so the lifecycle logic is
 * unit-tested without the Ink runtime.
 */

import { homedir } from "node:os";
import { join } from "node:path";

import { detectUncleanShutdown, markSessionCleanExit, markSessionStart, type SessionStartInfo } from "@muse/stores";

export function sessionMarkerPath(): string {
  return join(homedir(), ".muse", "session.marker");
}

/**
 * Detect a prior unclean shutdown (returns its start info, else undefined)
 * THEN record this session's start. The detect-before-mark order is the
 * contract — marking would otherwise overwrite the evidence.
 */
export async function beginSessionWithCrashCheck(
  markerPath: string,
  info: SessionStartInfo
): Promise<SessionStartInfo | undefined> {
  const prior = await detectUncleanShutdown(markerPath);
  await markSessionStart(markerPath, info);
  return prior;
}

export async function endSessionClean(markerPath: string): Promise<void> {
  await markSessionCleanExit(markerPath);
}
