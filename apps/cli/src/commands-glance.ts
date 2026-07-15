/**
 * `muse glance` — frontmost app + window title + selected text.
 *
 * First ambient-screen awareness for Muse. macOS-only
 * (mirrors `MacosNotificationProvider` posture). Pure
 * shell-out to `osascript`; the only failure mode is "user hasn't
 * granted Accessibility permission to the terminal", in which
 * case `selected` comes back empty and we still surface app +
 * window title.
 */

import { spawn } from "node:child_process";

import { stripUntrustedTerminalChars } from "@muse/shared";
import type { Command } from "commander";

import type { ProgramIO } from "./program.js";
import { sleep, waitForChildProcessResult } from "./async-promises.js";

interface GlanceOptions {
  readonly json?: boolean;
}

export interface GlanceSnapshot {
  readonly app: string;
  readonly window: string;
  readonly selected: string;
}

/**
 * Turn osascript's newline-delimited output into a
 * `{ app, window, selected }` triple. Pure so the unit test can
 * pin every corner without touching the real shell.
 *
 * Expected raw shape (app + window on their own lines, then the
 * selected text — which may itself span multiple lines):
 *   <app name>\n<window title>\n<selected text…>
 *
 * The selected text is everything from the third line onward (a
 * multi-line paragraph selection is common); whitespace-collapsing in
 * `norm` flattens it to one terminal-safe line. Missing window title /
 * selected text show as the literal AppleScript "missing value", which
 * we normalise to empty.
 */
export function parseOsascriptGlance(raw: string): GlanceSnapshot {
  const lines = raw.split(/\r?\n/u);
  // Window titles (any website's <title>) and clipboard text are
  // attacker-influenceable and printed straight to the terminal —
  // strip ESC/C0/C1/DEL and collapse whitespace, the same boundary
  // treatment the feeds / inbox / search surfaces apply.
  const norm = (value: string | undefined): string => {
    if (!value) return "";
    const cleaned = stripUntrustedTerminalChars(value).replace(/\s+/gu, " ").trim();
    if (cleaned === "missing value" || cleaned === "") return "";
    return cleaned;
  };
  return {
    app: norm(lines[0]),
    window: norm(lines[1]),
    selected: norm(lines.slice(2).join("\n"))
  };
}

/**
 * Capturing the selection needs a Cmd+C, which overwrites the user's
 * clipboard. We snapshot the existing clipboard text first and restore
 * it afterwards so a `muse glance` never silently destroys what the
 * user had copied. (Non-text clipboard content — an image / file — is
 * an AppleScript limitation and isn't preserved; text, the common
 * case, is.) Exported so a contract test can pin the save/restore.
 */
export const OSASCRIPT_SOURCE = `
tell application "System Events"
  set frontApp to name of first application process whose frontmost is true
  set frontWindow to "missing value"
  try
    set frontWindow to name of front window of first application process whose frontmost is true
  end try
end tell
set savedClipboard to "missing value"
try
  set savedClipboard to (the clipboard as text)
end try
set selectedText to "missing value"
try
  tell application "System Events" to keystroke "c" using {command down}
  delay 0.05
  set selectedText to (the clipboard as text)
end try
try
  if savedClipboard is not "missing value" then set the clipboard to savedClipboard
end try
return frontApp & linefeed & frontWindow & linefeed & selectedText
`;

const GLANCE_OSASCRIPT_TIMEOUT_MS = 30_000;

export async function runOsascript(spawnFn: typeof spawn = spawn): Promise<string> {
  const child = spawnFn("osascript", ["-e", OSASCRIPT_SOURCE], { stdio: ["ignore", "pipe", "pipe"] });
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  let settled = false;
  child.stdout.on("data", (chunk: Buffer) => { stdoutChunks.push(chunk); });
  child.stderr.on("data", (chunk: Buffer) => { stderrChunks.push(chunk); });
  const processResult = waitForChildProcessResult(child, "osascript", stderrChunks).finally(() => {
    settled = true;
  });
  const watchdog = (async () => {
    await sleep(GLANCE_OSASCRIPT_TIMEOUT_MS);
    if (settled) return;
    child.kill("SIGKILL");
    throw new Error(
      `osascript timed out after ${GLANCE_OSASCRIPT_TIMEOUT_MS.toString()}ms and was killed `
      + "(unanswered Accessibility prompt or a wedged UI-scripting target?)"
    );
  })();
  await Promise.race([processResult, watchdog]);
  return Buffer.concat(stdoutChunks).toString("utf8");
}

export function registerGlanceCommand(program: Command, io: ProgramIO): void {
  program
    .command("glance")
    .description("Read the frontmost app + window title (+ selected text when Accessibility is granted). macOS only.")
    .option("--json", "Emit the structured snapshot instead of formatted lines")
    .action(async (options: GlanceOptions) => {
      if (process.platform !== "darwin") {
        io.stderr("muse glance: requires macOS. Linux/Windows support is a follow-up.\n");
        process.exitCode = 1;
        return;
      }
      let raw: string;
      try {
        raw = await runOsascript();
      } catch (cause) {
        io.stderr(`muse glance: osascript failed: ${cause instanceof Error ? cause.message : String(cause)}\n`);
        process.exitCode = 1;
        return;
      }
      const snapshot = parseOsascriptGlance(raw);
      if (options.json) {
        io.stdout(`${JSON.stringify(snapshot, null, 2)}\n`);
        return;
      }
      io.stdout(`app:      ${snapshot.app || "(unknown)"}\n`);
      io.stdout(`window:   ${snapshot.window || "(none)"}\n`);
      io.stdout(`selected: ${snapshot.selected || "(empty — grant Accessibility to the terminal to capture)"}\n`);
    });
}
