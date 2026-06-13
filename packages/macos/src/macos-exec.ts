/**
 * Shared low-level exec primitives for the `@muse/macos` native tools: the
 * child-process spawn helper every tool drives its Apple CLI through, plus the
 * AppleScript string escaper and the Automation-permission error matcher used
 * by the osascript-backed tools. Split out of `macos-tools.ts` so the tool
 * factories can be decomposed into per-family modules over the shared base.
 */

import { spawn } from "node:child_process";

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
  timeoutMs: number
): Promise<MacCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, [...argv], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      action();
    };
    // Without this watchdog an unanswered Automation consent prompt (or a
    // wedged app) leaves osascript/shortcuts blocked and the tool call hangs
    // forever — the awaiting agent turn never resolves.
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(() => resolve({ exitCode: null, stderr, stdout, timedOut: true }));
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.on("error", (error) => { finish(() => reject(error)); });
    child.on("close", (code) => { finish(() => resolve({ exitCode: code, stderr, stdout, timedOut: false })); });
    // A failed spawn destroys stdin; writing then emits EPIPE — swallow it,
    // the real failure surfaces via the 'error'/'close' handlers.
    child.stdin.on("error", () => { /* surfaced via child 'error'/'close' */ });
    if (stdin !== undefined) child.stdin.write(stdin);
    child.stdin.end();
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
