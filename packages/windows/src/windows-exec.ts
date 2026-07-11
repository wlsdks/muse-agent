/**
 * Shared low-level exec primitive for the `@muse/windows` native tools: every
 * tool drives stock Windows PowerShell through this one injectable seam, so
 * unit tests fake the transport and the win32 CI runner exercises it for real.
 */

import { spawn } from "node:child_process";

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
  return new Promise((resolve, reject) => {
    // `-Command -` reads the script from stdin: no argv-length ceiling, and
    // nothing in the script ever passes through cmd/PowerShell argv parsing.
    const child = spawnImpl("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "-"], { stdio: ["pipe", "pipe", "pipe"] });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let settled = false;
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      action();
    };
    // Without the watchdog a wedged PowerShell (a hung CIM query, a blocked
    // Add-Type compile) parks the awaiting agent turn forever.
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(() => resolve({
        exitCode: null,
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        timedOut: true
      }));
    }, timeoutMs);
    // Chunks are decoded ONCE from the fully concatenated bytes — a multi-byte
    // UTF-8 character split across two `data` events would otherwise decode as
    // U+FFFD on both sides of the split.
    child.stdout.on("data", (chunk: Buffer) => { stdoutChunks.push(chunk); });
    child.stderr.on("data", (chunk: Buffer) => { stderrChunks.push(chunk); });
    child.on("error", (error) => { finish(() => reject(error)); });
    child.on("close", (code) => {
      finish(() => resolve({
        exitCode: code,
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        timedOut: false
      }));
    });
    // A failed spawn destroys stdin; writing then emits EPIPE — swallow it,
    // the real failure surfaces via the 'error'/'close' handlers.
    child.stdin.on("error", () => { /* surfaced via child 'error'/'close' */ });
    child.stdin.write(script);
    child.stdin.end();
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
