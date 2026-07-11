/**
 * Windows active-window ambient source — the win32 counterpart of
 * MacOsActiveWindowSource: frontmost process + window title live via a stock
 * PowerShell snippet, so the ambient notice loop perceives the desktop without
 * an external helper writing `~/.muse/ambient.json`. Read-only.
 *
 * The PowerShell spawn is injected (`run`) so the deterministic parse +
 * fail-open behaviour is exercised against contract-faithful output, never a
 * real process in tests. Any failure yields `undefined` — never throws — so a
 * perception blip can't crash the tick.
 */

import { execFile } from "node:child_process";

import type { AmbientSignal, AmbientSignalSource } from "./ambient-notice-loop.js";

const ACTIVE_WINDOW_PS_SCRIPT = [
  "Add-Type @'",
  "using System; using System.Runtime.InteropServices; using System.Text;",
  "public class FG { [DllImport(\"user32.dll\")] public static extern IntPtr GetForegroundWindow();",
  "[DllImport(\"user32.dll\")] public static extern int GetWindowText(IntPtr h, StringBuilder t, int c);",
  "[DllImport(\"user32.dll\")] public static extern int GetWindowThreadProcessId(IntPtr h, out int pid); }",
  "'@",
  "$h = [FG]::GetForegroundWindow()",
  "$procId = 0; [void][FG]::GetWindowThreadProcessId($h, [ref]$procId)",
  "$app = ''; try { $app = (Get-Process -Id $procId -ErrorAction Stop).ProcessName } catch { }",
  "$sb = New-Object System.Text.StringBuilder 512",
  "[void][FG]::GetWindowText($h, $sb, $sb.Capacity)",
  "\"$app`n$($sb.ToString())\""
].join("\n");

/**
 * Parse the PowerShell output (`process name` on line 1, window title on
 * line 2) into an `AmbientSignal`. Returns `undefined` when no frontmost
 * process could be read so the loop stays quiet rather than matching on a
 * blank signal.
 */
export function parseWindowsActiveWindow(stdout: string | undefined): AmbientSignal | undefined {
  if (stdout === undefined) {
    return undefined;
  }
  const lines = stdout.split("\n").map((line) => line.trim());
  const app = lines[0] ?? "";
  if (app.length === 0) {
    return undefined;
  }
  const window = (lines[1] ?? "").trim();
  return window.length > 0 ? { app, window } : { app };
}

export interface WindowsActiveWindowSourceOptions {
  /** Injectable PowerShell runner (returns stdout, or undefined on failure). Default spawns `powershell.exe`. */
  readonly run?: (script: string) => Promise<string | undefined>;
  /** Hard wall-clock cap for the spawn. Default 5000ms (Add-Type compiles on first use). */
  readonly timeoutMs?: number;
  /**
   * Also capture the clipboard text (via `Get-Clipboard`) into the signal's
   * `clipboard` field. OFF by default — the clipboard is sensitive, so this
   * is strictly opt-in (same posture as the macOS source).
   */
  readonly includeClipboard?: boolean;
  /** Injectable clipboard reader (returns text, or undefined on failure). */
  readonly readClipboard?: () => Promise<string | undefined>;
  /** Cap the captured clipboard length so a huge paste can't flood the signal. Default 2000. */
  readonly maxClipboardChars?: number;
}

export class WindowsActiveWindowSource implements AmbientSignalSource {
  private readonly run: (script: string) => Promise<string | undefined>;
  private readonly includeClipboard: boolean;
  private readonly readClipboard: () => Promise<string | undefined>;
  private readonly maxClipboardChars: number;

  constructor(options: WindowsActiveWindowSourceOptions = {}) {
    const timeoutMs = options.timeoutMs ?? 5_000;
    this.run = options.run ?? ((script) => defaultPowerShellRun(script, timeoutMs));
    this.includeClipboard = options.includeClipboard ?? false;
    this.readClipboard = options.readClipboard ?? (() => defaultPowerShellRun("Get-Clipboard", timeoutMs));
    this.maxClipboardChars = Number.isFinite(options.maxClipboardChars)
      ? Math.max(1, Math.trunc(options.maxClipboardChars as number))
      : 2_000;
  }

  async snapshot(): Promise<AmbientSignal | undefined> {
    let stdout: string | undefined;
    try {
      stdout = await this.run(ACTIVE_WINDOW_PS_SCRIPT);
    } catch {
      stdout = undefined;
    }
    const base = parseWindowsActiveWindow(stdout);
    if (!this.includeClipboard) {
      return base;
    }
    let clipboardRaw: string | undefined;
    try {
      clipboardRaw = await this.readClipboard();
    } catch {
      clipboardRaw = undefined;
    }
    const clipboard = clipboardRaw?.trim().slice(0, this.maxClipboardChars);
    if (!clipboard || clipboard.length === 0) {
      return base;
    }
    // Clipboard rides the window signal; with no frontmost app it still
    // forms a signal on its own so a clipboard-keyed rule can fire.
    return { ...(base ?? {}), clipboard };
  }
}

function defaultPowerShellRun(script: string, timeoutMs: number): Promise<string | undefined> {
  return new Promise<string | undefined>((resolve) => {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { timeout: timeoutMs }, (error, stdout) => {
      resolve(error ? undefined : stdout);
    });
  });
}
