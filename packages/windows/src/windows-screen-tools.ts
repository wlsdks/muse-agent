import type { JsonObject } from "@muse/shared";
import type { MuseTool } from "@muse/tools";

import { defaultPowerShellRunner, psBase64Expr } from "./windows-exec.js";
import { resolveWindowsScreenshotPath } from "./windows-screen-path.js";
import type { WindowsToolDeps } from "./windows-app-open-tool.js";

const SCREENSHOT_TIMEOUT_NOTE = "screenshot";

export function createWinScreenshotTool(deps: WindowsToolDeps = {}): MuseTool {
  const runner = deps.runner ?? defaultPowerShellRunner;
  return {
    definition: {
      description:
        "Capture the primary screen of this Windows PC to a PNG file. Use when the user asks for a screenshot — " +
        "e.g. 'take a screenshot', '화면 캡처해줘'. Saves under the temp dir by default; `path` may point under " +
        "~/Pictures, ~/Desktop, or ~/Downloads. Do NOT use it to read what's on screen (use win_app_read frontmost).",
      domain: "system",
      inputSchema: {
        additionalProperties: false,
        properties: {
          path: { description: "Optional output .png path, e.g. 'C:\\\\Users\\\\me\\\\Pictures\\\\shot.png'. Omit for an auto-named file in the temp dir.", type: "string" }
        },
        required: [],
        type: "object"
      },
      keywords: ["screenshot", "스크린샷", "캡처", "capture", "screen", "화면"],
      name: "win_screenshot",
      risk: "write"
    },
    execute: async (args): Promise<JsonObject> => {
      const rawPath = typeof args["path"] === "string" ? args["path"] : undefined;
      const target = resolveWindowsScreenshotPath(rawPath);
      if (!target.ok) {
        return { captured: false, reason: target.error };
      }
      const script = [
        "Add-Type -AssemblyName System.Windows.Forms",
        "Add-Type -AssemblyName System.Drawing",
        "$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds",
        "$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height",
        "$g = [System.Drawing.Graphics]::FromImage($bmp)",
        "$g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)",
        `$bmp.Save((${psBase64Expr(target.resolved)}), [System.Drawing.Imaging.ImageFormat]::Png)`,
        "$g.Dispose(); $bmp.Dispose()"
      ].join("\n");
      try {
        const result = await runner(script);
        if (result.timedOut) return { captured: false, reason: `${SCREENSHOT_TIMEOUT_NOTE} timed out` };
        if (result.exitCode !== 0) return { captured: false, reason: result.stderr.trim().slice(0, 300) || "screen capture failed" };
        return { captured: true, path: target.resolved };
      } catch (cause) {
        return { captured: false, reason: `powershell spawn failed: ${cause instanceof Error ? cause.message : String(cause)}` };
      }
    }
  };
}
