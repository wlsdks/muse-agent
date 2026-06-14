import type { JsonObject } from "@muse/shared";
import type { MuseTool } from "@muse/tools";

import { runChild, type MacCommandResult } from "./macos-exec.js";

const SHORTCUTS_PATH = "/usr/bin/shortcuts";

/** A shortcut can do real work (network, HomeKit) — give it a longer leash. */
const SHORTCUTS_TIMEOUT_MS = 120_000;

/** Runs the `shortcuts` CLI with argv + optional stdin input. Injected in tests. */
export type ShortcutsRunner = (args: readonly string[], input?: string) => Promise<MacCommandResult>;

const defaultShortcutsRunner: ShortcutsRunner = (args, input) =>
  runChild(SHORTCUTS_PATH, args, input, SHORTCUTS_TIMEOUT_MS);

// ── Tier 1: mac_shortcut_run ──────────────────────────────────────────

export interface MacShortcutRunToolDeps {
  readonly runner?: ShortcutsRunner;
}

export function createMacShortcutRunTool(deps: MacShortcutRunToolDeps = {}): MuseTool {
  const runner = deps.runner ?? defaultShortcutsRunner;
  return {
    definition: {
      description:
        "Run one of the user's own macOS Shortcuts (from the Shortcuts app) by its exact name, " +
        "optionally passing one line of text as input. Use when the user asks to run / trigger / " +
        "start a named shortcut or automation they have set up — e.g. 'run my Morning Routine shortcut', " +
        "'trigger the Focus shortcut', '단축어 \"집 도착\" 실행해줘'. This is the bridge to anything the " +
        "user has automated in Shortcuts (opening apps, setting scenes, files, web requests). Do NOT " +
        "use it to send a message (use mac_message_send), to read app state (use mac_app_read), or to " +
        "act on a web page (use web_action). Do NOT invent a shortcut name the user has not mentioned.",
      domain: "system",
      groundedArgs: ["name"],
      inputSchema: {
        additionalProperties: false,
        properties: {
          input: {
            description: "Optional single line of text passed to the shortcut as its input, e.g. 'Cupertino'.",
            type: "string"
          },
          name: {
            description: "Exact Shortcut name as it appears in the Shortcuts app, e.g. 'Morning Routine'.",
            type: "string"
          }
        },
        required: ["name"],
        type: "object"
      },
      keywords: ["shortcut", "shortcuts", "단축어", "automation", "automate", "workflow", "routine", "trigger"],
      name: "mac_shortcut_run",
      risk: "execute"
    },
    execute: async (args): Promise<JsonObject> => {
      const name = typeof args["name"] === "string" ? args["name"].trim() : "";
      if (name.length === 0) {
        return { ran: false, reason: "mac_shortcut_run requires a non-empty 'name'" };
      }
      const input = typeof args["input"] === "string" && args["input"].length > 0 ? args["input"] : undefined;
      const argv = input !== undefined
        ? ["run", name, "--input-path", "-", "--output-path", "-"]
        : ["run", name, "--output-path", "-"];
      let result: MacCommandResult;
      try {
        result = await runner(argv, input);
      } catch (cause) {
        return { ran: false, reason: `shortcuts spawn failed: ${cause instanceof Error ? cause.message : String(cause)}` };
      }
      if (result.timedOut) {
        return { ran: false, reason: `shortcuts run timed out after ${SHORTCUTS_TIMEOUT_MS.toString()}ms` };
      }
      if (result.exitCode !== 0) {
        const stderr = result.stderr.trim();
        return {
          ran: false,
          reason: stderr.length > 0 ? stderr.slice(0, 500) : `shortcuts exited with code ${result.exitCode?.toString() ?? "null"}`
        };
      }
      return { name, output: result.stdout.trim(), ran: true };
    }
  };
}
