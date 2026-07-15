import type { JsonObject } from "@muse/shared";
import type { MuseTool } from "@muse/tools";
import { createStringSetGuard } from "@muse/shared";

import { defaultOsascriptRunner, escapeAppleScript, NETWORKSETUP_PATH, OSASCRIPT_TIMEOUT_MS, parseWifiDevice, PMSET_PATH, runChild, type MacCommandResult, type MacOsascriptRunner } from "./macos-exec.js";
import { defaultShortcutsRunner, type ShortcutsRunner } from "./macos-shortcut-tool.js";

// ── Tier 1: mac_system_set (volume / mute / sleep / Wi-Fi / Focus / quit app) ─────

const SYSTEM_SETTINGS = ["volume", "mute", "unmute", "display_sleep", "sleep", "wifi_on", "wifi_off", "focus_on", "focus_off", "bluetooth_on", "bluetooth_off", "quit_app", "dark_mode_on", "dark_mode_off", "brightness"] as const;
const isSystemSetting = createStringSetGuard(SYSTEM_SETTINGS);

/**
 * macOS has NO official CLI to toggle a Focus / Do-Not-Disturb mode, so the
 * policy-safe path is a NAMED user Shortcut (the `shortcuts run` keystone) that
 * carries Apple's own "Set Focus" action. These are the conventional names the
 * user creates once; overridable per-install via the MUSE_FOCUS_ON_SHORTCUT /
 * MUSE_FOCUS_OFF_SHORTCUT env vars.
 */
export const DEFAULT_FOCUS_ON_SHORTCUT = "Muse Focus On";
export const DEFAULT_FOCUS_OFF_SHORTCUT = "Muse Focus Off";

/**
 * macOS also has NO official CLI to toggle Bluetooth power, so this mirrors
 * the Focus shortcut fallback exactly: a NAMED user Shortcut carrying
 * Apple's own "Set Bluetooth" action. Overridable via MUSE_BLUETOOTH_ON_SHORTCUT
 * / MUSE_BLUETOOTH_OFF_SHORTCUT.
 */
export const DEFAULT_BLUETOOTH_ON_SHORTCUT = "Muse Bluetooth On";
export const DEFAULT_BLUETOOTH_OFF_SHORTCUT = "Muse Bluetooth Off";

/**
 * macOS also has no official CLI for display brightness, so this mirrors the
 * Bluetooth shortcut fallback: a NAMED user Shortcut carrying Apple's own
 * "Set Brightness" action, with the requested level passed in as the
 * shortcut's input (not on/off — a 0–100 value). Overridable via
 * MUSE_BRIGHTNESS_SHORTCUT.
 */
export const DEFAULT_BRIGHTNESS_SHORTCUT = "Muse Set Brightness";

/**
 * True when a `shortcuts run` stderr says the named shortcut doesn't exist. The
 * wording is localised (EN "Shortcut not found", KO "단축어를 찾을 수 없음"), so
 * match the shared "not found" token in either language — grounded in the real
 * error captured on macOS, not an assumed string.
 */
export function isMissingShortcutError(stderr: string): boolean {
  return /찾을 수 없|not found/iu.test(stderr);
}

/** Actionable one-time setup message shown when a Focus shortcut is missing. */
export function focusShortcutSetupMessage(name: string, on: boolean): string {
  const choice = on ? "Do Not Disturb → Turn On" : "Turn Off";
  const envVar = on ? "MUSE_FOCUS_ON_SHORTCUT" : "MUSE_FOCUS_OFF_SHORTCUT";
  return (
    `Shortcut "${name}" not found. Create it once: open Shortcuts.app → New Shortcut → ` +
    `name it exactly "${name}" → add the "Set Focus" action → set it to ${choice}. ` +
    `(Or point ${envVar} at a shortcut you already have.)`
  );
}

/** Actionable one-time setup message shown when a Bluetooth shortcut is missing. */
export function bluetoothShortcutSetupMessage(name: string, on: boolean): string {
  const envVar = on ? "MUSE_BLUETOOTH_ON_SHORTCUT" : "MUSE_BLUETOOTH_OFF_SHORTCUT";
  return (
    `Shortcut "${name}" not found. Create it once: open Shortcuts.app → New Shortcut → ` +
    `name it exactly "${name}" → add the "Set Bluetooth" action → set it ${on ? "On" : "Off"}. ` +
    `(Or point ${envVar} at a shortcut you already have.)`
  );
}

/** Actionable one-time setup message shown when the Brightness shortcut is missing. */
export function brightnessShortcutSetupMessage(name: string): string {
  return (
    `Shortcut "${name}" not found. Create it once: open Shortcuts.app → New Shortcut → ` +
    `name it exactly "${name}" → add the "Set Brightness" action → set its value to ` +
    `"Shortcut Input" (so the number Muse passes becomes the brightness). ` +
    `(Or point MUSE_BRIGHTNESS_SHORTCUT at a shortcut you already have.)`
  );
}

export interface MacSystemSetToolDeps {
  readonly osascript?: MacOsascriptRunner;
  readonly pmset?: (args: readonly string[]) => Promise<MacCommandResult>;
  readonly networksetup?: (args: readonly string[]) => Promise<MacCommandResult>;
  readonly shortcuts?: ShortcutsRunner;
  readonly focusOnShortcut?: string;
  readonly focusOffShortcut?: string;
  readonly bluetoothOnShortcut?: string;
  readonly bluetoothOffShortcut?: string;
  readonly brightnessShortcut?: string;
}

export function createMacSystemSetTool(deps: MacSystemSetToolDeps = {}): MuseTool {
  const osascript = deps.osascript ?? defaultOsascriptRunner;
  const pmset = deps.pmset ?? ((args: readonly string[]) => runChild(PMSET_PATH, args, undefined, 10_000));
  const networksetup = deps.networksetup ?? ((args: readonly string[]) => runChild(NETWORKSETUP_PATH, args, undefined, 10_000));
  const shortcuts = deps.shortcuts ?? defaultShortcutsRunner;
  const focusOnShortcut = deps.focusOnShortcut?.trim() || DEFAULT_FOCUS_ON_SHORTCUT;
  const focusOffShortcut = deps.focusOffShortcut?.trim() || DEFAULT_FOCUS_OFF_SHORTCUT;
  const bluetoothOnShortcut = deps.bluetoothOnShortcut?.trim() || DEFAULT_BLUETOOTH_ON_SHORTCUT;
  const bluetoothOffShortcut = deps.bluetoothOffShortcut?.trim() || DEFAULT_BLUETOOTH_OFF_SHORTCUT;
  const brightnessShortcut = deps.brightnessShortcut?.trim() || DEFAULT_BRIGHTNESS_SHORTCUT;
  return {
    definition: {
      description:
        "Change a Mac system setting: `setting` is 'volume' (needs `value` 0–100), 'mute', 'unmute', " +
        "'display_sleep' (screen off now), 'sleep' (put the whole Mac to sleep), 'wifi_on', 'wifi_off', " +
        "'focus_on' (turn ON Do Not Disturb / a Focus mode), 'focus_off' (turn it OFF), " +
        "'bluetooth_on' (turn ON Bluetooth), 'bluetooth_off' (turn it OFF), " +
        "'quit_app' (quit an app — needs `app`), 'dark_mode_on' / 'dark_mode_off' " +
        "(turn macOS Dark Mode on/off), or 'brightness' (needs `value` 0–100, dims/brightens the display). " +
        "Use when the user asks to set/raise/lower the volume, mute/unmute, sleep the screen or the Mac, " +
        "turn Wi-Fi on/off, turn Do Not Disturb / Focus on or off, turn Bluetooth on or off, quit/close a " +
        "named app, switch Dark Mode / Light Mode / appearance on or off, or dim/brighten the screen — e.g. " +
        "'set the volume to 30', 'mute the sound', 'turn off wifi', 'turn on do not disturb', " +
        "'enable focus mode', 'turn on bluetooth', 'turn off bluetooth', 'quit Safari', 'turn on dark mode', " +
        "'switch to light mode', 'set brightness to 40', 'dim the screen', " +
        "'볼륨 50으로 해줘', '와이파이 꺼줘', '방해금지 켜줘', " +
        "'집중모드 꺼줘', '블루투스 켜줘', '블투 꺼줘', 'Safari 종료해줘', '메모장 닫아줘', '다크모드 켜줘', '화면 어둡게 해줘', " +
        "'화면 밝기 60으로 해줘', '화면 밝게 해줘'. Do NOT use it to control music " +
        "playback (that is mac_media_control) or to run a user-named Shortcut (that is mac_shortcut_run).",
      domain: "system",
      groundedArgs: ["value"],
      inputSchema: {
        additionalProperties: false,
        properties: {
          setting: {
            description: "Which setting to change, e.g. 'volume', 'wifi_off', or 'focus_on'.",
            enum: [...SYSTEM_SETTINGS],
            type: "string"
          },
          value: {
            description: "Volume or brightness level 0–100 — REQUIRED when setting is 'volume' or 'brightness', e.g. 30. Ignored otherwise.",
            type: "number"
          },
          app: {
            description: "App name to quit — REQUIRED only when setting is 'quit_app', e.g. 'Safari'. Ignored otherwise.",
            type: "string"
          }
        },
        required: ["setting"],
        type: "object"
      },
      keywords: [
        "volume", "볼륨", "소리", "mute", "음소거", "unmute", "sound", "display", "화면", "screen", "절전",
        "sleep", "잠자기", "잠들", "wifi", "wi-fi", "와이파이", "네트워크",
        "focus", "집중", "집중모드", "방해금지", "방해 금지", "dnd", "do not disturb",
        "bluetooth", "블루투스", "블투",
        "quit", "종료", "닫아", "close app",
        "dark mode", "다크모드", "다크 모드", "어둡게", "light mode", "라이트모드", "appearance",
        "brightness", "밝기", "화면 밝기", "밝게", "dim", "화면 밝게"
      ],
      name: "mac_system_set",
      risk: "execute"
    },
    execute: async (args): Promise<JsonObject> => {
      const setting = typeof args["setting"] === "string" ? args["setting"].trim() : "";
      if (!isSystemSetting(setting)) {
        return { set: false, reason: `setting must be one of: ${SYSTEM_SETTINGS.join(", ")}` };
      }
      if (setting === "focus_on" || setting === "focus_off") {
        const on = setting === "focus_on";
        const name = on ? focusOnShortcut : focusOffShortcut;
        let result: MacCommandResult;
        try {
          result = await shortcuts(["run", name, "--output-path", "-"]);
        } catch (cause) {
          return { reason: `shortcuts spawn failed: ${cause instanceof Error ? cause.message : String(cause)}`, set: false };
        }
        if (result.timedOut) {
          return { reason: "shortcuts run timed out", set: false };
        }
        if (result.exitCode !== 0) {
          const stderr = result.stderr.trim();
          return {
            reason: isMissingShortcutError(stderr)
              ? focusShortcutSetupMessage(name, on)
              : stderr.length > 0 ? stderr.slice(0, 500) : `shortcuts exited with code ${result.exitCode?.toString() ?? "null"}`,
            set: false
          };
        }
        return { set: true, setting, shortcut: name };
      }
      if (setting === "bluetooth_on" || setting === "bluetooth_off") {
        const on = setting === "bluetooth_on";
        const name = on ? bluetoothOnShortcut : bluetoothOffShortcut;
        let result: MacCommandResult;
        try {
          result = await shortcuts(["run", name, "--output-path", "-"]);
        } catch (cause) {
          return { reason: `shortcuts spawn failed: ${cause instanceof Error ? cause.message : String(cause)}`, set: false };
        }
        if (result.timedOut) {
          return { reason: "shortcuts run timed out", set: false };
        }
        if (result.exitCode !== 0) {
          const stderr = result.stderr.trim();
          return {
            reason: isMissingShortcutError(stderr)
              ? bluetoothShortcutSetupMessage(name, on)
              : stderr.length > 0 ? stderr.slice(0, 500) : `shortcuts exited with code ${result.exitCode?.toString() ?? "null"}`,
            set: false
          };
        }
        return { set: true, setting, shortcut: name };
      }
      if (setting === "display_sleep" || setting === "sleep") {
        const argv = setting === "sleep" ? ["sleepnow"] : ["displaysleepnow"];
        const result = await pmset(argv).catch((cause: unknown) => ({ exitCode: 1, stderr: cause instanceof Error ? cause.message : String(cause), stdout: "", timedOut: false }));
        return result.exitCode === 0
          ? { set: true, setting }
          : { reason: `pmset failed: ${result.stderr.trim().slice(0, 200)}`, set: false };
      }
      if (setting === "wifi_on" || setting === "wifi_off") {
        let ports: MacCommandResult;
        try {
          ports = await networksetup(["-listallhardwareports"]);
        } catch (cause) {
          return { reason: `networksetup spawn failed: ${cause instanceof Error ? cause.message : String(cause)}`, set: false };
        }
        const device = parseWifiDevice(ports.stdout);
        if (!device) {
          return { reason: "no Wi-Fi interface found on this Mac", set: false };
        }
        const power = await networksetup(["-setairportpower", device, setting === "wifi_on" ? "on" : "off"])
          .catch((cause: unknown) => ({ exitCode: 1, stderr: cause instanceof Error ? cause.message : String(cause), stdout: "", timedOut: false }));
        return power.exitCode === 0
          ? { device, set: true, setting }
          : { reason: `networksetup failed: ${power.stderr.trim().slice(0, 200)}`, set: false };
      }
      if (setting === "quit_app") {
        const app = typeof args["app"] === "string" ? args["app"].trim() : "";
        if (app.length === 0) {
          return { set: false, reason: "setting 'quit_app' requires a non-empty 'app' (the app name to quit), e.g. 'Safari'" };
        }
        // The app name MUST pass through the shared escaper before embedding
        // in the AppleScript string literal — a raw `"` would otherwise break
        // out of `tell application "..."` and let injected script text run.
        const script = `tell application "${escapeAppleScript(app)}" to quit`;
        let result: MacCommandResult;
        try {
          result = await osascript(script);
        } catch (cause) {
          return { reason: `osascript spawn failed: ${cause instanceof Error ? cause.message : String(cause)}`, set: false };
        }
        if (result.timedOut) {
          return { reason: `osascript timed out after ${OSASCRIPT_TIMEOUT_MS.toString()}ms`, set: false };
        }
        if (result.exitCode !== 0) {
          return { reason: `osascript failed: ${result.stderr.trim().slice(0, 300)}`, set: false };
        }
        return { app, set: true, setting };
      }
      if (setting === "dark_mode_on" || setting === "dark_mode_off") {
        const on = setting === "dark_mode_on";
        // Fixed script, no user input — no escaping needed (unlike quit_app's app name above).
        const script = `tell application "System Events" to tell appearance preferences to set dark mode to ${on ? "true" : "false"}`;
        let result: MacCommandResult;
        try {
          result = await osascript(script);
        } catch (cause) {
          return { reason: `osascript spawn failed: ${cause instanceof Error ? cause.message : String(cause)}`, set: false };
        }
        if (result.timedOut) {
          return { reason: `osascript timed out after ${OSASCRIPT_TIMEOUT_MS.toString()}ms`, set: false };
        }
        if (result.exitCode !== 0) {
          return { reason: `osascript failed: ${result.stderr.trim().slice(0, 300)}`, set: false };
        }
        return { set: true, setting };
      }
      if (setting === "brightness") {
        const raw = args["value"];
        if (typeof raw !== "number" || !Number.isFinite(raw)) {
          return { set: false, reason: "setting 'brightness' requires a numeric 'value' between 0 and 100" };
        }
        const level = Math.max(0, Math.min(100, Math.round(raw)));
        let result: MacCommandResult;
        try {
          result = await shortcuts(["run", brightnessShortcut, "--input-path", "-", "--output-path", "-"], String(level));
        } catch (cause) {
          return { reason: `shortcuts spawn failed: ${cause instanceof Error ? cause.message : String(cause)}`, set: false };
        }
        if (result.timedOut) {
          return { reason: "shortcuts run timed out", set: false };
        }
        if (result.exitCode !== 0) {
          const stderr = result.stderr.trim();
          return {
            reason: isMissingShortcutError(stderr)
              ? brightnessShortcutSetupMessage(brightnessShortcut)
              : stderr.length > 0 ? stderr.slice(0, 500) : `shortcuts exited with code ${result.exitCode?.toString() ?? "null"}`,
            set: false
          };
        }
        return { set: true, setting, shortcut: brightnessShortcut, value: level };
      }
      let script: string;
      let echoValue: number | undefined;
      if (setting === "volume") {
        const raw = args["value"];
        if (typeof raw !== "number" || !Number.isFinite(raw)) {
          return { reason: "setting 'volume' requires a numeric 'value' between 0 and 100", set: false };
        }
        echoValue = Math.max(0, Math.min(100, Math.round(raw)));
        script = `set volume output volume ${echoValue.toString()}`;
      } else {
        script = `set volume output muted ${setting === "mute" ? "true" : "false"}`;
      }
      let result: MacCommandResult;
      try {
        result = await osascript(script);
      } catch (cause) {
        return { reason: `osascript spawn failed: ${cause instanceof Error ? cause.message : String(cause)}`, set: false };
      }
      if (result.timedOut) {
        return { reason: `osascript timed out after ${OSASCRIPT_TIMEOUT_MS.toString()}ms`, set: false };
      }
      if (result.exitCode !== 0) {
        return { reason: `osascript failed: ${result.stderr.trim().slice(0, 300)}`, set: false };
      }
      return { set: true, setting, ...(echoValue !== undefined ? { value: echoValue } : {}) };
    }
  };
}
