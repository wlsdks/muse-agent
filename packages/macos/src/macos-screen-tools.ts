/**
 * Screen-capture tools: mac_screenshot (capture to a sandboxed path) and
 * mac_screen_read (capture + vision-describe). Split out of macos-tools.ts;
 * both drive `screencapture -x` via runChild, and screenshot validates its
 * output path through the macos-screen-path traversal sandbox.
 */

import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { JsonObject } from "@muse/shared";
import type { MuseTool } from "@muse/tools";

import { runChild, type MacCommandResult } from "./macos-exec.js";
import { resolveScreenshotPath, tryRealpath } from "./macos-screen-path.js";

const SCREENCAPTURE_PATH = "/usr/sbin/screencapture";

// ── Tier 1: mac_screenshot (screencapture) ────────────────────────────

const SCREENSHOT_TIMEOUT_MS = 15_000;


export interface MacScreenshotToolDeps {
  /** Runs `screencapture -x <path>`. Injected in tests. */
  readonly runner?: (path: string) => Promise<MacCommandResult>;
  /** Path factory for the default save location (tests inject a fixed one). */
  readonly pathFactory?: () => string;
  /** Resolves a target's real path (symlink check); injected in tests. */
  readonly realpath?: (p: string) => string;
}

export function createMacScreenshotTool(deps: MacScreenshotToolDeps = {}): MuseTool {
  const runner = deps.runner ?? ((path: string) => runChild(SCREENCAPTURE_PATH, ["-x", path], undefined, SCREENSHOT_TIMEOUT_MS));
  const pathFactory = deps.pathFactory ?? (() => join(tmpdir(), `muse-screenshot-${Date.now().toString()}.png`));
  const realpath = deps.realpath ?? tryRealpath;
  return {
    definition: {
      description:
        "Capture the whole screen to an image FILE (silent, non-interactive) and return its path. Use " +
        "when the user asks to take / grab / save a screenshot — e.g. 'take a screenshot', " +
        "'capture my screen', '스크린샷 찍어줘', '화면 캡처해줘'. NOT for telling the user what is on the " +
        "screen — mac_screen_read does that. Optionally pass `path` to choose where the " +
        ".png is saved; omit it to use a temp file. Note: macOS requires the Screen Recording permission " +
        "(System Settings → Privacy & Security → Screen Recording) or the capture may be blank.",
      domain: "system",
      inputSchema: {
        additionalProperties: false,
        properties: {
          path: {
            description: "Optional .png destination path under ~/Desktop, ~/Downloads, or /tmp, e.g. '~/Desktop/shot.png'. Omit for a temp file.",
            type: "string"
          }
        },
        required: [],
        type: "object"
      },
      keywords: ["screenshot", "스크린샷", "capture", "캡처", "screen", "화면", "grab", "snapshot"],
      name: "mac_screenshot",
      risk: "execute"
    },
    execute: async (args): Promise<JsonObject> => {
      let targetPath: string;
      if (typeof args["path"] === "string" && args["path"].trim().length > 0) {
        const guard = resolveScreenshotPath(args["path"], realpath);
        if (!guard.ok) {
          return { captured: false, reason: guard.error };
        }
        targetPath = guard.resolved;
      } else {
        targetPath = pathFactory();
      }
      let result: MacCommandResult;
      try {
        result = await runner(targetPath);
      } catch (cause) {
        return { captured: false, reason: `screencapture spawn failed: ${cause instanceof Error ? cause.message : String(cause)}` };
      }
      if (result.timedOut) {
        return { captured: false, reason: `screencapture timed out after ${SCREENSHOT_TIMEOUT_MS.toString()}ms` };
      }
      if (result.exitCode !== 0) {
        return { captured: false, reason: result.stderr.trim().slice(0, 300) || `screencapture exited with code ${result.exitCode?.toString() ?? "null"}` };
      }
      return { captured: true, path: targetPath };
    }
  };
}

// ── Tier 0: mac_screen_read (screencapture + local vision) ───────────

export interface MacScreenReadDescribeInput {
  readonly imageBase64: string;
  readonly mimeType: string;
  readonly question?: string;
}

export interface MacScreenReadDescribeResult {
  readonly ok: boolean;
  readonly text?: string;
  readonly error?: string;
}

export interface MacScreenReadToolDeps {
  /** Runs `screencapture -x <path>`. Injected in tests. */
  readonly runner?: (path: string) => Promise<MacCommandResult>;
  readonly pathFactory?: () => string;
  readonly readImageBase64?: (path: string) => Promise<string>;
  readonly cleanup?: (path: string) => Promise<void>;
  /**
   * The local vision model, injected by the CLI — this package stays
   * model-free. The capture never leaves the machine.
   */
  readonly describeImage: (input: MacScreenReadDescribeInput) => Promise<MacScreenReadDescribeResult>;
}

export function createMacScreenReadTool(deps: MacScreenReadToolDeps): MuseTool {
  const runner = deps.runner ?? ((path: string) => runChild(SCREENCAPTURE_PATH, ["-x", path], undefined, SCREENSHOT_TIMEOUT_MS));
  const pathFactory = deps.pathFactory ?? (() => join(tmpdir(), `muse-screen-read-${Date.now().toString()}.png`));
  const readImageBase64 = deps.readImageBase64 ?? (async (path: string) => (await readFile(path)).toString("base64"));
  const cleanup = deps.cleanup ?? (async (path: string) => { await rm(path, { force: true }); });
  return {
    definition: {
      description:
        "Look at the user's screen and SAY what is on it — captures the screen and describes the visible " +
        "windows, text, and content with the LOCAL vision model (the image never leaves this Mac). Use when " +
        "the user asks what is on / visible on their screen, or to read an error or dialog they are looking " +
        "at — e.g. '지금 화면에 뭐 떠있어?', \"what's this error on my screen?\", '화면에 보이는 거 읽어줘'. Pass " +
        "`question` to focus the look (e.g. 'what does the error dialog say?'). NOT for saving a screenshot " +
        "file — mac_screenshot does that. Needs the macOS Screen Recording permission.",
      domain: "system",
      inputSchema: {
        additionalProperties: false,
        properties: {
          question: {
            description: "Optional focus for the description, e.g. 'what does the error dialog say?'.",
            type: "string"
          }
        },
        required: [],
        type: "object"
      },
      keywords: ["screen", "화면", "보여", "떠있", "look", "read screen", "what's on", "dialog", "error", "에러", "창"],
      name: "mac_screen_read",
      risk: "read"
    },
    execute: async (args): Promise<JsonObject> => {
      const path = pathFactory();
      let captureResult: MacCommandResult;
      try {
        captureResult = await runner(path);
      } catch (cause) {
        return { described: false, reason: `screencapture spawn failed: ${cause instanceof Error ? cause.message : String(cause)}` };
      }
      if (captureResult.timedOut || captureResult.exitCode !== 0) {
        return {
          described: false,
          reason: captureResult.stderr.trim().slice(0, 300) ||
            (captureResult.timedOut ? "screencapture timed out" : "screencapture failed — check the Screen Recording permission")
        };
      }
      try {
        const imageBase64 = await readImageBase64(path);
        const question = typeof args["question"] === "string" && args["question"].trim().length > 0 ? args["question"].trim() : undefined;
        const described = await deps.describeImage({ imageBase64, mimeType: "image/png", ...(question ? { question } : {}) });
        if (!described.ok || !described.text) {
          return { described: false, reason: described.error ?? "the vision model could not describe the screen" };
        }
        return { described: true, text: described.text };
      } catch (cause) {
        return { described: false, reason: cause instanceof Error ? cause.message : String(cause) };
      } finally {
        await cleanup(path).catch(() => { /* best-effort */ });
      }
    }
  };
}
