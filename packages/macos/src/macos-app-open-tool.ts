import type { JsonObject } from "@muse/shared";
import type { MuseTool } from "@muse/tools";

import { runChild, type MacCommandResult } from "./macos-exec.js";

// ── Tier 1: mac_app_open ──────────────────────────────────────────────

const OPEN_PATH = "/usr/bin/open";
const OPEN_TIMEOUT_MS = 15_000;

/** A URL (scheme://) or a filesystem path — vs a bare app name. */
function looksLikeUrlOrPath(target: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//iu.test(target) || /^[~/.]/u.test(target);
}

export interface MacAppOpenToolDeps {
  readonly runner?: (args: readonly string[]) => Promise<MacCommandResult>;
}

export function createMacAppOpenTool(deps: MacAppOpenToolDeps = {}): MuseTool {
  const runner = deps.runner ?? ((args: readonly string[]) => runChild(OPEN_PATH, args, undefined, OPEN_TIMEOUT_MS));
  return {
    definition: {
      description:
        "Open an app, a URL (in the default browser), or a file on the Mac. Use when the user asks to " +
        "open / launch an app, open a link or website, or open a document — e.g. 'open Safari', " +
        "'open https://news.example.com', 'open my report.pdf', '사파리 열어줘', '이 링크 열어줘'. Pass the " +
        "thing to open as `target`; set `app` only to force which app opens it ('open this link in Chrome'). " +
        "Do NOT use it to run a Shortcut (use mac_shortcut_run) or to act on a web page's content " +
        "like submitting a form (use web_action).",
      domain: "system",
      groundedArgs: ["target", "app"],
      inputSchema: {
        additionalProperties: false,
        properties: {
          app: {
            description: "Optional app to open the target IN, e.g. 'Google Chrome' for a URL. Omit to use the default.",
            type: "string"
          },
          target: {
            description: "What to open: an app name ('Safari'), a URL ('https://example.com'), or a file path ('~/report.pdf').",
            type: "string"
          }
        },
        required: ["target"],
        type: "object"
      },
      keywords: ["open", "열어", "열기", "띄워", "launch", "url", "link", "링크", "website", "사이트"],
      name: "mac_app_open",
      risk: "execute"
    },
    execute: async (args): Promise<JsonObject> => {
      const target = typeof args["target"] === "string" ? args["target"].trim() : "";
      if (target.length === 0) {
        return { opened: false, reason: "mac_app_open requires a non-empty 'target' (an app, URL, or file)" };
      }
      const app = typeof args["app"] === "string" ? args["app"].trim() : "";
      const argv = app.length > 0
        ? ["-a", app, target]
        : (looksLikeUrlOrPath(target) ? [target] : ["-a", target]);
      let result: MacCommandResult;
      try {
        result = await runner(argv);
      } catch (cause) {
        return { opened: false, reason: `open spawn failed: ${cause instanceof Error ? cause.message : String(cause)}` };
      }
      if (result.timedOut) {
        return { opened: false, reason: `open timed out after ${OPEN_TIMEOUT_MS.toString()}ms` };
      }
      if (result.exitCode !== 0) {
        const stderr = result.stderr.trim();
        return { opened: false, reason: stderr.length > 0 ? stderr.slice(0, 300) : `open exited with code ${result.exitCode?.toString() ?? "null"}` };
      }
      return { opened: true, target, ...(app.length > 0 ? { app } : {}) };
    }
  };
}
