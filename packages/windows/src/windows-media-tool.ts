/**
 * Media transport + system setting tools. Both drive Windows virtual-key
 * events (keybd_event) — the only dependency-free way to reach the system
 * media/volume controls from a stock PowerShell.
 */

import type { JsonObject } from "@muse/shared";
import type { MuseTool } from "@muse/tools";

import { defaultPowerShellRunner, POWERSHELL_TIMEOUT_MS } from "./windows-exec.js";
import type { WindowsToolDeps } from "./windows-app-open-tool.js";

export const WIN_MEDIA_ACTIONS = ["playpause", "next", "previous"] as const;
type WinMediaAction = (typeof WIN_MEDIA_ACTIONS)[number];

const MEDIA_VK: Readonly<Record<WinMediaAction, string>> = {
  next: "0xB0",
  playpause: "0xB3",
  previous: "0xB1"
};

export function keyEventScript(vkHex: string): string {
  return [
    "Add-Type @'",
    "using System; using System.Runtime.InteropServices;",
    "public class KB { [DllImport(\"user32.dll\")] public static extern void keybd_event(byte k, byte s, int f, int e); }",
    "'@",
    `[KB]::keybd_event(${vkHex}, 0, 0, 0); [KB]::keybd_event(${vkHex}, 0, 2, 0)`
  ].join("\n");
}

export function createWinMediaControlTool(deps: WindowsToolDeps = {}): MuseTool {
  const runner = deps.runner ?? defaultPowerShellRunner;
  return {
    definition: {
      description:
        "Control media playback on this Windows PC: play/pause, next track, previous track — whatever app is " +
        "playing. Use when the user asks to pause / resume / skip music — e.g. 'pause the music', '다음 곡 틀어줘'. " +
        "Do NOT use it to open a music app (use win_app_open) or to change the volume (use win_system_set).",
      domain: "system",
      inputSchema: {
        additionalProperties: false,
        properties: {
          action: { description: "Transport action, e.g. 'playpause'.", enum: [...WIN_MEDIA_ACTIONS], type: "string" }
        },
        required: ["action"],
        type: "object"
      },
      keywords: ["music", "음악", "pause", "일시정지", "play", "재생", "next", "다음곡", "skip"],
      name: "win_media_control",
      risk: "write"
    },
    execute: async (args): Promise<JsonObject> => {
      const action = typeof args["action"] === "string" ? args["action"].trim() : "";
      if (!(WIN_MEDIA_ACTIONS as readonly string[]).includes(action)) {
        return { ok: false, reason: `unknown action '${action}' — valid: ${WIN_MEDIA_ACTIONS.join(", ")}` };
      }
      try {
        const result = await runner(keyEventScript(MEDIA_VK[action as WinMediaAction]));
        if (result.timedOut) return { ok: false, reason: `media key timed out after ${POWERSHELL_TIMEOUT_MS.toString()}ms` };
        if (result.exitCode !== 0) return { ok: false, reason: result.stderr.trim().slice(0, 300) || "media key event failed" };
        return { action, ok: true };
      } catch (cause) {
        return { ok: false, reason: `powershell spawn failed: ${cause instanceof Error ? cause.message : String(cause)}` };
      }
    }
  };
}
