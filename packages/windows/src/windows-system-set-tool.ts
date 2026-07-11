import type { JsonObject } from "@muse/shared";
import type { MuseTool } from "@muse/tools";

import { defaultPowerShellRunner, POWERSHELL_TIMEOUT_MS } from "./windows-exec.js";
import { keyEventScript } from "./windows-media-tool.js";
import type { WindowsToolDeps } from "./windows-app-open-tool.js";

export const WIN_SYSTEM_SETTINGS = ["volume_up", "volume_down", "mute", "display_sleep"] as const;
type WinSystemSetting = (typeof WIN_SYSTEM_SETTINGS)[number];

const VOLUME_VK: Readonly<Partial<Record<WinSystemSetting, string>>> = {
  mute: "0xAD",
  volume_down: "0xAE",
  volume_up: "0xAF"
};

// SendMessage(HWND_BROADCAST, WM_SYSCOMMAND, SC_MONITORPOWER, 2) — the
// documented way to power the display down without a scheduled task.
const DISPLAY_SLEEP_SCRIPT = [
  "$t = Add-Type -MemberDefinition '[DllImport(\"user32.dll\")]public static extern int SendMessage(int hWnd,int msg,int wParam,int lParam);' -Name NativeMonitor -PassThru",
  "[void]$t::SendMessage(0xffff, 0x0112, 0xf170, 2)"
].join("\n");

export function createWinSystemSetTool(deps: WindowsToolDeps = {}): MuseTool {
  const runner = deps.runner ?? defaultPowerShellRunner;
  return {
    definition: {
      description:
        "Change one Windows system setting: volume up, volume down, mute toggle, or put the display to sleep. " +
        "Use when the user asks to change volume / mute / turn the screen off — e.g. 'volume down a bit', " +
        "'음소거 해줘', '화면 꺼줘'. Do NOT use it for media transport like pause/skip (use win_media_control).",
      domain: "system",
      inputSchema: {
        additionalProperties: false,
        properties: {
          setting: { description: "Which setting to change, e.g. 'mute'.", enum: [...WIN_SYSTEM_SETTINGS], type: "string" }
        },
        required: ["setting"],
        type: "object"
      },
      keywords: ["volume", "볼륨", "소리", "mute", "음소거", "display", "화면", "screen", "sleep"],
      name: "win_system_set",
      risk: "write"
    },
    execute: async (args): Promise<JsonObject> => {
      const setting = typeof args["setting"] === "string" ? args["setting"].trim() : "";
      if (!(WIN_SYSTEM_SETTINGS as readonly string[]).includes(setting)) {
        return { ok: false, reason: `unknown setting '${setting}' — valid: ${WIN_SYSTEM_SETTINGS.join(", ")}` };
      }
      const vk = VOLUME_VK[setting as WinSystemSetting];
      const script = vk ? keyEventScript(vk) : DISPLAY_SLEEP_SCRIPT;
      try {
        const result = await runner(script);
        if (result.timedOut) return { ok: false, reason: `system_set timed out after ${POWERSHELL_TIMEOUT_MS.toString()}ms` };
        if (result.exitCode !== 0) return { ok: false, reason: result.stderr.trim().slice(0, 300) || "system setting failed" };
        return { ok: true, setting };
      } catch (cause) {
        return { ok: false, reason: `powershell spawn failed: ${cause instanceof Error ? cause.message : String(cause)}` };
      }
    }
  };
}
