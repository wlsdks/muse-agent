import type { JsonObject } from "@muse/shared";
import type { MuseTool } from "@muse/tools";

import { defaultOsascriptRunner, isPermissionError, OSASCRIPT_TIMEOUT_MS, type MacCommandResult, type MacOsascriptRunner } from "./macos-exec.js";

// ── Tier 1: mac_media_control (Music transport) ───────────────────────

const MEDIA_ACTIONS = ["play", "pause", "playpause", "next", "previous"] as const;
type MediaAction = (typeof MEDIA_ACTIONS)[number];

const MEDIA_VERB: Record<MediaAction, string> = {
  next: "next track",
  pause: "pause",
  play: "play",
  playpause: "playpause",
  previous: "previous track"
};

function buildMediaScript(action: MediaAction): string {
  // play / playpause are allowed to LAUNCH Music (the user asked to start
  // playback); pause / skip only act when Music is already running so we never
  // spuriously launch it just to no-op.
  const launches = action === "play" || action === "playpause";
  if (launches) {
    return [`tell application "Music"`, `  ${MEDIA_VERB[action]}`, `  return (player state as text)`, `end tell`].join("\n");
  }
  return [
    `tell application "Music"`,
    `  if it is running then`,
    `    ${MEDIA_VERB[action]}`,
    `    return (player state as text)`,
    `  else`,
    `    return "not running"`,
    `  end if`,
    `end tell`
  ].join("\n");
}

export interface MacMediaControlToolDeps {
  readonly runner?: MacOsascriptRunner;
}

export function createMacMediaControlTool(deps: MacMediaControlToolDeps = {}): MuseTool {
  const runner = deps.runner ?? defaultOsascriptRunner;
  return {
    definition: {
      description:
        "Control music playback in the Mac's Music app: `action` is 'play' / 'pause' / 'playpause' / " +
        "'next' / 'previous'. Use when the user asks to play, pause, resume, skip, or go back a track — " +
        "e.g. 'pause the music', 'play the next song', 'resume playback', '음악 멈춰', '다음 곡 틀어줘'. This " +
        "CHANGES playback; to only ASK what is currently playing use mac_app_read (app='music') instead.",
      domain: "system",
      inputSchema: {
        additionalProperties: false,
        properties: {
          action: {
            description: "Playback action, e.g. 'pause' or 'next'.",
            enum: [...MEDIA_ACTIONS],
            type: "string"
          }
        },
        required: ["action"],
        type: "object"
      },
      keywords: ["pause", "멈춰", "정지", "next", "다음곡", "다음", "previous", "이전곡", "skip", "play", "틀어", "재생", "resume", "음악"],
      name: "mac_media_control",
      risk: "execute"
    },
    execute: async (args): Promise<JsonObject> => {
      const action = typeof args["action"] === "string" ? args["action"].trim() : "";
      if (!MEDIA_ACTIONS.includes(action as MediaAction)) {
        return { controlled: false, reason: `action must be one of: ${MEDIA_ACTIONS.join(", ")}` };
      }
      let result: MacCommandResult;
      try {
        result = await runner(buildMediaScript(action as MediaAction));
      } catch (cause) {
        return { controlled: false, reason: `osascript spawn failed: ${cause instanceof Error ? cause.message : String(cause)}` };
      }
      if (result.timedOut) {
        return { controlled: false, reason: `osascript timed out after ${OSASCRIPT_TIMEOUT_MS.toString()}ms` };
      }
      if (result.exitCode !== 0) {
        if (isPermissionError(result.stderr)) {
          return { controlled: false, reason: "permission denied for Music — grant access in System Settings → Privacy & Security → Automation" };
        }
        return { controlled: false, reason: `osascript failed: ${result.stderr.trim().slice(0, 300)}` };
      }
      return { action, controlled: true, state: result.stdout.replace(/\n$/u, "") };
    }
  };
}
