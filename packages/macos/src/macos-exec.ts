/**
 * Shared low-level exec primitives for the `@muse/macos` native tools: the
 * child-process spawn helper every tool drives its Apple CLI through, plus the
 * AppleScript string escaper and the Automation-permission error matcher used
 * by the osascript-backed tools. Split out of `macos-tools.ts` so the tool
 * factories can be decomposed into per-family modules over the shared base.
 */

import { spawn } from "node:child_process";
import { runCommandWithTimeout } from "@muse/shared";

export interface MacCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
}

export function runChild(
  bin: string,
  argv: readonly string[],
  stdin: string | undefined,
  timeoutMs: number,
  spawnImpl: typeof spawn = spawn
): Promise<MacCommandResult> {
  return runCommandWithTimeout({
    command: bin,
    args: argv,
    stdin,
    spawnImpl,
    timeoutMs
  });
}

/**
 * Escapes user text for an AppleScript double-quoted string literal.
 * `\` and `"` are backslash-escaped (identical to JS/JSON); newlines are
 * flattened to spaces — classic AppleScript string literals can't carry a
 * raw newline, and flattening keeps the generated script single-statement.
 */
export function escapeAppleScript(text: string): string {
  return text.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"').replace(/[\r\n]+/gu, " ");
}

export function isPermissionError(stderr: string): boolean {
  // osascript error -1743 is the canonical "not authorised to send Apple
  // events"; the wording varies by locale so match the numeric code too.
  return /not allowed|don't have permission|not authori[sz]|-1743/iu.test(stderr);
}

const OSASCRIPT_PATH = "/usr/bin/osascript";
export const OSASCRIPT_TIMEOUT_MS = 30_000;

/** Runs an AppleScript via `osascript -` (script on stdin). Injected in tests. */
export type MacOsascriptRunner = (script: string) => Promise<MacCommandResult>;

export const defaultOsascriptRunner: MacOsascriptRunner = (script) =>
  runChild(OSASCRIPT_PATH, ["-"], script, OSASCRIPT_TIMEOUT_MS);

export const NETWORKSETUP_PATH = "/usr/sbin/networksetup";

export const PMSET_PATH = "/usr/bin/pmset";

/** Parses `networksetup -listallhardwareports` for the Wi-Fi interface (e.g. 'en0'). */
export function parseWifiDevice(stdout: string): string | undefined {
  const lines = stdout.split(/\r?\n/u);
  for (let i = 0; i < lines.length; i += 1) {
    if (/Hardware Port:\s*Wi-Fi/iu.test(lines[i] ?? "")) {
      const device = /Device:\s*(\S+)/u.exec(lines[i + 1] ?? "");
      if (device) return device[1];
    }
  }
  return undefined;
}
