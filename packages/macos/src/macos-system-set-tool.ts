import type { JsonObject } from "@muse/shared";
import type { MuseTool } from "@muse/tools";

import { defaultOsascriptRunner, NETWORKSETUP_PATH, OSASCRIPT_TIMEOUT_MS, parseWifiDevice, PMSET_PATH, runChild, type MacCommandResult, type MacOsascriptRunner } from "./macos-exec.js";

// ── Tier 1: mac_system_set (volume / mute / sleep / Wi-Fi) ────────────

const SYSTEM_SETTINGS = ["volume", "mute", "unmute", "display_sleep", "sleep", "wifi_on", "wifi_off"] as const;
type SystemSetting = (typeof SYSTEM_SETTINGS)[number];

export interface MacSystemSetToolDeps {
  readonly osascript?: MacOsascriptRunner;
  readonly pmset?: (args: readonly string[]) => Promise<MacCommandResult>;
  readonly networksetup?: (args: readonly string[]) => Promise<MacCommandResult>;
}

export function createMacSystemSetTool(deps: MacSystemSetToolDeps = {}): MuseTool {
  const osascript = deps.osascript ?? defaultOsascriptRunner;
  const pmset = deps.pmset ?? ((args: readonly string[]) => runChild(PMSET_PATH, args, undefined, 10_000));
  const networksetup = deps.networksetup ?? ((args: readonly string[]) => runChild(NETWORKSETUP_PATH, args, undefined, 10_000));
  return {
    definition: {
      description:
        "Change a Mac system setting: `setting` is 'volume' (needs `value` 0–100), 'mute', 'unmute', " +
        "'display_sleep' (screen off now), 'sleep' (put the whole Mac to sleep), 'wifi_on', or 'wifi_off'. " +
        "Use when the user asks to set/raise/lower the volume, mute/unmute, sleep the screen or the Mac, or " +
        "turn Wi-Fi on/off — e.g. 'set the volume to 30', 'mute the sound', 'go to sleep', 'turn off wifi', " +
        "'볼륨 50으로 해줘', '와이파이 꺼줘'. Do NOT use it to control music playback (that is mac_media_control).",
      domain: "system",
      groundedArgs: ["value"],
      inputSchema: {
        additionalProperties: false,
        properties: {
          setting: {
            description: "Which setting to change, e.g. 'volume' or 'wifi_off'.",
            enum: [...SYSTEM_SETTINGS],
            type: "string"
          },
          value: {
            description: "Volume level 0–100 — REQUIRED only when setting is 'volume', e.g. 30. Ignored otherwise.",
            type: "number"
          }
        },
        required: ["setting"],
        type: "object"
      },
      keywords: [
        "volume", "볼륨", "소리", "mute", "음소거", "unmute", "sound", "display", "화면", "screen", "절전",
        "sleep", "잠자기", "잠들", "wifi", "wi-fi", "와이파이", "네트워크"
      ],
      name: "mac_system_set",
      risk: "execute"
    },
    execute: async (args): Promise<JsonObject> => {
      const setting = typeof args["setting"] === "string" ? args["setting"].trim() : "";
      if (!SYSTEM_SETTINGS.includes(setting as SystemSetting)) {
        return { set: false, reason: `setting must be one of: ${SYSTEM_SETTINGS.join(", ")}` };
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
