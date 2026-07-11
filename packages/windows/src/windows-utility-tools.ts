/**
 * Small self-contained Windows utilities (clipboard, speech). Grouped like
 * macos-utility-tools: no shared state with the richer tools, one runner seam.
 */

import type { JsonObject } from "@muse/shared";
import type { MuseTool } from "@muse/tools";

import { defaultPowerShellRunner, POWERSHELL_TIMEOUT_MS, psBase64Expr } from "./windows-exec.js";
import type { WindowsToolDeps } from "./windows-app-open-tool.js";

const SAY_TEXT_CAP = 2_000;
const CLIPBOARD_TEXT_CAP = 100_000;

function failSoft(reason: string): JsonObject {
  return { ok: false, reason };
}

export function createWinClipboardSetTool(deps: WindowsToolDeps = {}): MuseTool {
  const runner = deps.runner ?? defaultPowerShellRunner;
  return {
    definition: {
      description:
        "Put text on this Windows PC's clipboard so the user can paste it anywhere. Use when the user asks to " +
        "copy something — e.g. 'copy that address', '그거 클립보드에 복사해줘'. " +
        "Do NOT use it to read the clipboard, or to type into an app.",
      domain: "system",
      groundedArgs: ["text"],
      inputSchema: {
        additionalProperties: false,
        properties: {
          text: { description: "The exact text to place on the clipboard, e.g. 'meet at 3pm at the office'.", type: "string" }
        },
        required: ["text"],
        type: "object"
      },
      keywords: ["clipboard", "클립보드", "copy", "복사", "paste", "붙여넣기"],
      name: "win_clipboard_set",
      risk: "write"
    },
    execute: async (args): Promise<JsonObject> => {
      const text = typeof args["text"] === "string" ? args["text"] : "";
      if (text.trim().length === 0) {
        return failSoft("win_clipboard_set requires non-empty 'text'");
      }
      if (text.length > CLIPBOARD_TEXT_CAP) {
        return failSoft(`text exceeds the ${CLIPBOARD_TEXT_CAP.toString()}-char clipboard cap`);
      }
      try {
        const result = await runner(`Set-Clipboard -Value (${psBase64Expr(text)})`);
        if (result.timedOut) return failSoft(`Set-Clipboard timed out after ${POWERSHELL_TIMEOUT_MS.toString()}ms`);
        if (result.exitCode !== 0) return failSoft(result.stderr.trim().slice(0, 300) || "Set-Clipboard failed");
        return { chars: text.length, ok: true };
      } catch (cause) {
        return failSoft(`powershell spawn failed: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
    }
  };
}

export function createWinSayTool(deps: WindowsToolDeps = {}): MuseTool {
  const runner = deps.runner ?? defaultPowerShellRunner;
  return {
    definition: {
      description:
        "Speak text aloud through this Windows PC's speakers (local text-to-speech). Use when the user asks to " +
        "say / read something out loud — e.g. 'read that back to me', '소리내서 읽어줘'. " +
        "Do NOT use it for silent replies, or to play music (use win_media_control).",
      domain: "system",
      groundedArgs: ["text"],
      inputSchema: {
        additionalProperties: false,
        properties: {
          text: { description: "The text to speak, e.g. 'your meeting starts in ten minutes'.", type: "string" }
        },
        required: ["text"],
        type: "object"
      },
      keywords: ["say", "speak", "말해", "읽어줘", "tts", "voice"],
      name: "win_say",
      risk: "write"
    },
    execute: async (args): Promise<JsonObject> => {
      const text = typeof args["text"] === "string" ? args["text"].trim() : "";
      if (text.length === 0) {
        return failSoft("win_say requires non-empty 'text'");
      }
      if (text.length > SAY_TEXT_CAP) {
        return failSoft(`text exceeds the ${SAY_TEXT_CAP.toString()}-char speech cap`);
      }
      const script = [
        "Add-Type -AssemblyName System.Speech",
        "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer",
        `$s.Speak((${psBase64Expr(text)}))`,
        "$s.Dispose()"
      ].join("\n");
      try {
        const result = await runner(script);
        if (result.timedOut) return failSoft(`speech timed out after ${POWERSHELL_TIMEOUT_MS.toString()}ms`);
        if (result.exitCode !== 0) return failSoft(result.stderr.trim().slice(0, 300) || "speech synthesis failed");
        return { ok: true, spokenChars: text.length };
      } catch (cause) {
        return failSoft(`powershell spawn failed: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
    }
  };
}
