import { spawn } from "node:child_process";

import { runCommandWithTimeout } from "@muse/shared";

export interface DesktopNotificationRunResult {
  readonly exitCode: number | null;
  readonly stderr: string;
  /** True when the diagnostic stream exceeded Muse's capture boundary. */
  readonly truncated?: boolean;
}

export interface DesktopNotificationCommandOptions {
  readonly args: readonly string[];
  readonly command: string;
  readonly label: string;
  readonly spawnFn?: typeof spawn;
}

const NOTIFICATION_COMMAND_TIMEOUT_MS = 30_000;
const MAX_NOTIFICATION_COMMAND_OUTPUT_BYTES = 16 * 1024;

/**
 * Runs a native desktop notification command with bounded diagnostic output.
 * A zero exit code remains successful even if an unused diagnostic stream was
 * truncated: turning that outcome into a failure could duplicate a delivery.
 */
export async function runDesktopNotificationCommand({
  args,
  command,
  label,
  spawnFn = spawn
}: DesktopNotificationCommandOptions): Promise<DesktopNotificationRunResult> {
  const result = await runCommandWithTimeout({
    args: [...args],
    command,
    killSignal: "SIGKILL",
    maxStderrBytes: MAX_NOTIFICATION_COMMAND_OUTPUT_BYTES,
    maxStdoutBytes: MAX_NOTIFICATION_COMMAND_OUTPUT_BYTES,
    spawnImpl: spawnFn,
    timeoutMs: NOTIFICATION_COMMAND_TIMEOUT_MS
  });

  if (result.timedOut) {
    throw new Error(`${label} timed out after ${NOTIFICATION_COMMAND_TIMEOUT_MS.toString()}ms and was killed`);
  }

  return {
    exitCode: result.exitCode,
    stderr: result.stderr,
    truncated: result.truncated
  };
}
