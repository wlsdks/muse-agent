import type { JsonObject } from "@muse/shared";
import type { MuseTool } from "@muse/tools";

import { defaultPowerShellRunner, POWERSHELL_TIMEOUT_MS } from "./windows-exec.js";
import type { WindowsToolDeps } from "./windows-app-open-tool.js";

export const WIN_APP_READ_SOURCES = ["battery", "wifi", "storage", "frontmost"] as const;
type WinReadSource = (typeof WIN_APP_READ_SOURCES)[number];

const READ_SCRIPTS: Readonly<Record<WinReadSource, string>> = {
  battery: "$b = Get-CimInstance Win32_Battery; if ($b) { \"$($b.EstimatedChargeRemaining)`t$($b.BatteryStatus -eq 2)\" }",
  frontmost: [
    "Add-Type @'",
    "using System; using System.Runtime.InteropServices; using System.Text;",
    "public class FG { [DllImport(\"user32.dll\")] public static extern IntPtr GetForegroundWindow();",
    "[DllImport(\"user32.dll\")] public static extern int GetWindowText(IntPtr h, StringBuilder t, int c); }",
    "'@",
    "$h = [FG]::GetForegroundWindow(); $sb = New-Object System.Text.StringBuilder 512",
    "[void][FG]::GetWindowText($h, $sb, $sb.Capacity); $sb.ToString()"
  ].join("\n"),
  storage: "Get-PSDrive -PSProvider FileSystem | ForEach-Object { \"$($_.Name)`t$([math]::Round($_.Free/1GB,1))`t$([math]::Round(($_.Used+$_.Free)/1GB,1))\" }",
  wifi: "(netsh wlan show interfaces) -match '^\\s*SSID' | Select-Object -First 1"
};

export function createWinAppReadTool(deps: WindowsToolDeps = {}): MuseTool {
  const runner = deps.runner ?? defaultPowerShellRunner;
  return {
    definition: {
      description:
        "Read one live system fact from this Windows PC: battery level, current wifi network, free disk storage, " +
        "or the frontmost window title. Use when the user asks 'how much battery', 'what wifi am I on', " +
        "'how much disk space', '배터리 몇 프로야', '무슨 창 보고 있어'. Read-only. " +
        "Do NOT use it to open or change anything (use win_app_open / win_system_set).",
      domain: "system",
      inputSchema: {
        additionalProperties: false,
        properties: {
          source: { description: "Which fact to read, e.g. 'battery'.", enum: [...WIN_APP_READ_SOURCES], type: "string" }
        },
        required: ["source"],
        type: "object"
      },
      keywords: ["battery", "배터리", "wifi", "와이파이", "storage", "disk", "용량", "window", "창"],
      name: "win_app_read",
      risk: "read"
    },
    execute: async (args): Promise<JsonObject> => {
      const source = typeof args["source"] === "string" ? args["source"].trim() : "";
      if (!(WIN_APP_READ_SOURCES as readonly string[]).includes(source)) {
        return { ok: false, reason: `unknown source '${source}' — valid: ${WIN_APP_READ_SOURCES.join(", ")}` };
      }
      try {
        const result = await runner(READ_SCRIPTS[source as WinReadSource]);
        if (result.timedOut) {
          return { ok: false, reason: `read timed out after ${POWERSHELL_TIMEOUT_MS.toString()}ms`, source };
        }
        if (result.exitCode !== 0) {
          return { ok: false, reason: result.stderr.trim().slice(0, 300) || "powershell failed", source };
        }
        return parseReadOutput(source as WinReadSource, result.stdout);
      } catch (cause) {
        return { ok: false, reason: `powershell spawn failed: ${cause instanceof Error ? cause.message : String(cause)}`, source };
      }
    }
  };
}

export function parseReadOutput(source: WinReadSource, stdout: string): JsonObject {
  const text = stdout.trim();
  if (source === "battery") {
    const [pct, charging] = text.split("\t");
    const percent = Number.parseInt(pct ?? "", 10);
    if (!Number.isFinite(percent)) {
      return { ok: false, reason: "no battery detected (desktop PC?)", source };
    }
    return { charging: /true/iu.test(charging ?? ""), ok: true, percent, source };
  }
  if (source === "frontmost") {
    return text.length > 0 ? { ok: true, source, window: text } : { ok: false, reason: "no foreground window", source };
  }
  if (source === "wifi") {
    const ssid = /SSID\s*:\s*(.+)$/mu.exec(text)?.[1]?.trim();
    return ssid ? { ok: true, source, ssid } : { ok: false, reason: "not connected to wifi", source };
  }
  const drives = text.split("\n").filter(Boolean).map((line) => {
    const [name, freeGb, totalGb] = line.split("\t");
    return { freeGb: Number.parseFloat(freeGb ?? "0"), name: name ?? "?", totalGb: Number.parseFloat(totalGb ?? "0") };
  });
  return drives.length > 0 ? { drives, ok: true, source } : { ok: false, reason: "no drives reported", source };
}
