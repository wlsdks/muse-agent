import type { JsonObject } from "@muse/shared";
import type { MuseTool } from "@muse/tools";

import { defaultPowerShellRunner, POWERSHELL_TIMEOUT_MS, psBase64Expr, type WinPowerShellRunner } from "./windows-exec.js";

export interface WindowsToolDeps {
  readonly runner?: WinPowerShellRunner;
}

export function createWinAppOpenTool(deps: WindowsToolDeps = {}): MuseTool {
  const runner = deps.runner ?? defaultPowerShellRunner;
  return {
    definition: {
      description:
        "Open an app, a URL (in the default browser), or a file on this Windows PC. Use when the user asks to " +
        "open / launch an app, open a link or website, or open a document — e.g. 'open Notepad', " +
        "'open https://news.example.com', 'open my report.pdf', '메모장 열어줘', '이 링크 열어줘'. Pass the " +
        "thing to open as `target`; set `app` only to force which app opens it. " +
        "Do NOT use it to act on a web page's content like submitting a form (use web_action).",
      domain: "system",
      groundedArgs: ["target", "app"],
      inputSchema: {
        additionalProperties: false,
        properties: {
          app: { description: "Optional app to open the target IN, e.g. 'chrome' for a URL. Omit to use the default.", type: "string" },
          target: { description: "What to open: an app name ('notepad'), a URL ('https://example.com'), or a file path ('C:\\\\Users\\\\me\\\\report.pdf').", type: "string" }
        },
        required: ["target"],
        type: "object"
      },
      keywords: ["open", "열어", "열기", "띄워", "launch", "url", "link", "링크", "website", "사이트"],
      name: "win_app_open",
      risk: "execute"
    },
    execute: async (args): Promise<JsonObject> => {
      const target = typeof args["target"] === "string" ? args["target"].trim() : "";
      if (target.length === 0) {
        return { opened: false, reason: "win_app_open requires a non-empty 'target' (an app, URL, or file)" };
      }
      const app = typeof args["app"] === "string" ? args["app"].trim() : "";
      const script = app.length > 0
        ? `Start-Process -FilePath (${psBase64Expr(app)}) -ArgumentList @(${psBase64Expr(target)})`
        : `Start-Process -FilePath (${psBase64Expr(target)})`;
      try {
        const result = await runner(script);
        if (result.timedOut) {
          return { opened: false, reason: `Start-Process timed out after ${POWERSHELL_TIMEOUT_MS.toString()}ms` };
        }
        if (result.exitCode !== 0) {
          const stderr = result.stderr.trim();
          return { opened: false, reason: stderr.length > 0 ? stderr.slice(0, 300) : `powershell exited with code ${result.exitCode?.toString() ?? "null"}` };
        }
        return { opened: true, target, ...(app.length > 0 ? { app } : {}) };
      } catch (cause) {
        return { opened: false, reason: `powershell spawn failed: ${cause instanceof Error ? cause.message : String(cause)}` };
      }
    }
  };
}
