/**
 * Shared low-level exec primitive for the `@muse/windows` native tools: every
 * tool drives stock Windows PowerShell through this one injectable seam, so
 * unit tests fake the transport and the win32 CI runner exercises it for real.
 */

import { spawn } from "node:child_process";
import { runCommandWithTimeout } from "@muse/shared";

export interface WinCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
}

export const POWERSHELL_TIMEOUT_MS = 30_000;

/** Runs a PowerShell script (delivered over stdin). Injected in tests. */
export type WinPowerShellRunner = (script: string) => Promise<WinCommandResult>;

export function runPowerShellWith(
  script: string,
  timeoutMs: number,
  spawnImpl: typeof spawn = spawn
): Promise<WinCommandResult> {
  return runCommandWithTimeout({
    // `-Command -` reads the script from stdin: no argv-length ceiling, and
    // nothing in the script ever passes through cmd/PowerShell argv parsing.
    command: "powershell.exe",
    args: ["-NoProfile", "-NonInteractive", "-Command", "-"],
    stdin: script,
    spawnImpl,
    timeoutMs
  });
}

export const defaultPowerShellRunner: WinPowerShellRunner = (script) =>
  runPowerShellWith(script, POWERSHELL_TIMEOUT_MS);

/**
 * User text never interpolates into a script: embed it as base64 and decode
 * inside PowerShell, so quotes/`$()`/backticks in the text stay inert data.
 */
export function psBase64Expr(text: string): string {
  const b64 = Buffer.from(text, "utf8").toString("base64");
  return `[System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}'))`;
}
