/**
 * Simple single-CLI macOS utility tools (clipboard write, Spotlight search, say/TTS).
 * Split out of macos-tools.ts; each drives one Apple CLI through the shared `runChild`
 * exec helper — no AppleScript escaping, so they share no state with the osascript tools.
 */

import type { JsonObject, JsonValue } from "@muse/shared";
import type { MuseTool } from "@muse/tools";

import { runChild, type MacCommandResult } from "./macos-exec.js";

const PBCOPY_PATH = "/usr/bin/pbcopy";
const MDFIND_PATH = "/usr/bin/mdfind";
const SAY_PATH = "/usr/bin/say";

// ── Tier 1: mac_clipboard_set (pbcopy) ────────────────────────────────

export interface MacClipboardSetToolDeps {
  /** Runs `pbcopy` with the text on stdin. Injected in tests. */
  readonly runner?: (text: string) => Promise<MacCommandResult>;
}

export function createMacClipboardSetTool(deps: MacClipboardSetToolDeps = {}): MuseTool {
  const runner = deps.runner ?? ((text: string) => runChild(PBCOPY_PATH, [], text, 5_000));
  return {
    definition: {
      description:
        "Put text onto the Mac clipboard (so the user can paste it). Use when the user asks to copy " +
        "something to their clipboard — e.g. 'copy this to my clipboard', 'put my address on the " +
        "clipboard', '이거 클립보드에 복사해줘'. To READ what's currently on the clipboard, use mac_app_read " +
        "(app='clipboard') instead.",
      domain: "system",
      groundedArgs: ["text"],
      inputSchema: {
        additionalProperties: false,
        properties: {
          text: { description: "The text to place on the clipboard, e.g. '123 Main St'.", type: "string" }
        },
        required: ["text"],
        type: "object"
      },
      keywords: ["clipboard", "클립보드", "copy", "복사", "paste"],
      name: "mac_clipboard_set",
      risk: "execute"
    },
    execute: async (args): Promise<JsonObject> => {
      const text = typeof args["text"] === "string" ? args["text"] : "";
      if (text.length === 0) {
        return { reason: "mac_clipboard_set requires non-empty 'text'", set: false };
      }
      let result: MacCommandResult;
      try {
        result = await runner(text);
      } catch (cause) {
        return { reason: `pbcopy spawn failed: ${cause instanceof Error ? cause.message : String(cause)}`, set: false };
      }
      if (result.timedOut || result.exitCode !== 0) {
        return { reason: `pbcopy failed: ${result.stderr.trim().slice(0, 200) || "timed out"}`, set: false };
      }
      return { chars: text.length, set: true };
    }
  };
}

// ── Tier 0: mac_spotlight_search (mdfind) ─────────────────────────────

const SPOTLIGHT_TIMEOUT_MS = 15_000;
const SPOTLIGHT_MAX_RESULTS = 25;

// Extensions checked in code (never built into the mdfind predicate) so
// `imagesOnly` stays an injection-safe post-hoc filter on returned paths.
const IMAGE_EXTENSIONS = new Set([
  "jpg", "jpeg", "png", "heic", "heif", "gif", "tiff", "tif", "webp", "bmp", "raw", "dng", "cr2", "nef", "arw"
]);

function isImagePath(path: string): boolean {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return false;
  return IMAGE_EXTENSIONS.has(path.slice(dot + 1).toLowerCase());
}

export interface MacSpotlightSearchToolDeps {
  readonly runner?: (args: readonly string[]) => Promise<MacCommandResult>;
}

export function createMacSpotlightSearchTool(deps: MacSpotlightSearchToolDeps = {}): MuseTool {
  const runner = deps.runner ?? ((args: readonly string[]) => runChild(MDFIND_PATH, args, undefined, SPOTLIGHT_TIMEOUT_MS));
  return {
    definition: {
      description:
        "Find FILES on the Mac by name (or content) using Spotlight, returning their PATHS on disk — " +
        "including PHOTOS and other images. Use when the user wants to LOCATE a file, document, photo, or " +
        "app on their computer — e.g. 'find the file called budget.xlsx', 'where is my résumé PDF', " +
        "'find my photos of the beach', '내 컴퓨터에서 발표자료 파일 찾아줘', '사진 찾아줘'. Set `nameOnly` " +
        "true to match the filename only (the default also matches content). Set `imagesOnly` true to " +
        "return only photo/image files. This searches the FILESYSTEM and returns paths — it is NOT " +
        "knowledge_search (which recalls what you NOTED or discussed) and NOT web_search (the public web).",
      domain: "system",
      groundedArgs: ["query"],
      inputSchema: {
        additionalProperties: false,
        properties: {
          imagesOnly: {
            description:
              "true to return only PHOTOS / image files (jpg, png, heic, …). Use for 'find my photos of " +
              "…', '사진 찾아줘'.",
            type: "boolean"
          },
          nameOnly: { description: "true to match the file NAME only (default matches content too).", type: "boolean" },
          query: { description: "Filename or text to find on disk, e.g. 'budget.xlsx' or 'tax return'.", type: "string" }
        },
        required: ["query"],
        type: "object"
      },
      keywords: [
        "file", "파일", "파일명", "spotlight", "disk", "folder", "폴더", "document", "pdf", "locate", "컴퓨터",
        "photo", "사진", "image", "이미지"
      ],
      name: "mac_spotlight_search",
      risk: "read"
    },
    execute: async (args): Promise<JsonObject> => {
      const query = typeof args["query"] === "string" ? args["query"].trim() : "";
      if (query.length === 0) {
        return { error: "mac_spotlight_search requires a non-empty 'query'" };
      }
      const nameOnly = args["nameOnly"] === true;
      const imagesOnly = args["imagesOnly"] === true;
      // Same mdfind argv regardless of imagesOnly — the query is never turned into a
      // predicate string; image filtering happens on the returned paths, in code.
      const argv = nameOnly ? ["-name", query] : [query];
      let result: MacCommandResult;
      try {
        result = await runner(argv);
      } catch (cause) {
        return { error: `mdfind spawn failed: ${cause instanceof Error ? cause.message : String(cause)}` };
      }
      if (result.timedOut) {
        return { error: `mdfind timed out after ${SPOTLIGHT_TIMEOUT_MS.toString()}ms` };
      }
      if (result.exitCode !== 0) {
        return { error: `mdfind failed: ${result.stderr.trim().slice(0, 200)}` };
      }
      const all = result.stdout.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line.length > 0);
      const matched = imagesOnly ? all.filter(isImagePath) : all;
      return {
        paths: matched.slice(0, SPOTLIGHT_MAX_RESULTS) as JsonValue,
        query,
        total: matched.length,
        ...(imagesOnly ? { imagesOnly: true } : {}),
        ...(matched.length > SPOTLIGHT_MAX_RESULTS ? { truncated: true } : {})
      };
    }
  };
}

// ── Tier 1: mac_say (text-to-speech) ──────────────────────────────────

const SAY_TIMEOUT_MS = 60_000;

export interface MacSayToolDeps {
  /** Runs `say [-v voice] <text>`. Injected in tests. */
  readonly runner?: (args: readonly string[]) => Promise<MacCommandResult>;
}

export function createMacSayTool(deps: MacSayToolDeps = {}): MuseTool {
  const runner = deps.runner ?? ((args: readonly string[]) => runChild(SAY_PATH, args, undefined, SAY_TIMEOUT_MS));
  return {
    definition: {
      description:
        "Speak text aloud through the Mac's speakers (text-to-speech). Use when the user asks to say / read " +
        "something out loud — e.g. 'say hello', 'read this out loud', 'announce that the build is done', " +
        "'이거 소리내서 읽어줘', '말해줘'. Optionally pass `voice` to pick a named system voice. This SPEAKS " +
        "text; it does not change any setting.",
      domain: "system",
      groundedArgs: ["text"],
      inputSchema: {
        additionalProperties: false,
        properties: {
          text: { description: "What to speak aloud, e.g. 'The build finished successfully'.", type: "string" },
          voice: { description: "Optional system voice name, e.g. 'Samantha'. Omit for the default.", type: "string" }
        },
        required: ["text"],
        type: "object"
      },
      keywords: ["say", "speak", "말해", "읽어", "소리내서", "aloud", "announce", "tts", "voice"],
      name: "mac_say",
      risk: "execute"
    },
    execute: async (args): Promise<JsonObject> => {
      const text = typeof args["text"] === "string" ? args["text"].trim() : "";
      if (text.length === 0) {
        return { reason: "mac_say requires non-empty 'text'", spoke: false };
      }
      const voice = typeof args["voice"] === "string" && args["voice"].trim().length > 0 ? args["voice"].trim() : undefined;
      // `--` terminates option parsing so a user text like "-0" / "--version" reaches
      // `say` as the spoken string, not as a flag. `say` supports `--`; mdfind/pbcopy
      // do not, so this guard stays say-specific.
      const argv = voice ? ["-v", voice, "--", text] : ["--", text];
      let result: MacCommandResult;
      try {
        result = await runner(argv);
      } catch (cause) {
        return { reason: `say spawn failed: ${cause instanceof Error ? cause.message : String(cause)}`, spoke: false };
      }
      if (result.timedOut) {
        return { reason: `say timed out after ${SAY_TIMEOUT_MS.toString()}ms`, spoke: false };
      }
      if (result.exitCode !== 0) {
        return { reason: result.stderr.trim().slice(0, 200) || `say exited with code ${result.exitCode?.toString() ?? "null"}`, spoke: false };
      }
      return { spoke: true, ...(voice ? { voice } : {}) };
    }
  };
}
