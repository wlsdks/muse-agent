/**
 * `muse glance` — frontmost app + window title + selected text.
 *
 * Goal 089 — first ambient-screen awareness for Muse. macOS-only
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

interface GlanceOptions {
  readonly json?: boolean;
}

export interface GlanceSnapshot {
  readonly app: string;
  readonly window: string;
  readonly selected: string;
}

/**
 * Goal 089 — turn osascript's newline-delimited output into a
 * `{ app, window, selected }` triple. Pure so the unit test can
 * pin every corner without touching the real shell.
 *
 * Expected raw shape (three newline-separated lines, in order):
 *   <app name>\n<window title>\n<selected text>
 *
 * Missing window title / selected text show as the literal string
 * "missing value" from AppleScript; we normalise those to empty.
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
    selected: norm(lines[2])
  };
}

const OSASCRIPT_SOURCE = `
tell application "System Events"
  set frontApp to name of first application process whose frontmost is true
  set frontWindow to "missing value"
  try
    set frontWindow to name of front window of first application process whose frontmost is true
  end try
end tell
set selectedText to "missing value"
try
  tell application "System Events" to keystroke "c" using {command down}
  delay 0.05
  set selectedText to (the clipboard as text)
end try
return frontApp & linefeed & frontWindow & linefeed & selectedText
`;

const GLANCE_OSASCRIPT_TIMEOUT_MS = 30_000;

export async function runOsascript(spawnFn: typeof spawn = spawn): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawnFn("osascript", ["-e", OSASCRIPT_SOURCE], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      action();
    };
    // Without this watchdog a wedged osascript — an unanswered
    // Accessibility permission prompt, an unresponsive UI-scripting
    // target — hangs `muse glance` forever.
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(() => reject(new Error(
        `osascript timed out after ${GLANCE_OSASCRIPT_TIMEOUT_MS.toString()}ms and was killed `
        + "(unanswered Accessibility prompt or a wedged UI-scripting target?)"
      )));
    }, GLANCE_OSASCRIPT_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.on("error", (error) => { finish(() => reject(error)); });
    child.on("close", (code) => {
      finish(() => {
        if (code === 0) {
          resolve(stdout);
        } else {
          reject(new Error(`osascript exited ${(code ?? -1).toString()}: ${stderr.trim()}`));
        }
      });
    });
  });
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
