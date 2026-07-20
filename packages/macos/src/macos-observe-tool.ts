/**
 * `mac_observe` — one call that answers "what is happening on my Mac right
 * now", including the two things nothing else could answer.
 *
 * It exists alongside `mac_app_read` rather than replacing it, deliberately:
 * `mac_app_read` carries 27 cases in the tool-selection eval, and renaming a
 * tool a local model already picks correctly is the fastest way to regress
 * selection accuracy. So this adds capability instead of moving it.
 *
 * Two capabilities are genuinely new, not a re-skin:
 *
 *   1. WINDOW GEOMETRY. AppleScript cannot answer it — `System Events` gives a
 *      process list and nothing about position or size. Measured here: 18
 *      windows with titles and geometry in ~230 ms / 1.7 KB, versus the 1.9 MB
 *      screenshot that was previously the only way to know what is on screen.
 *   2. MULTIPLE SOURCES IN ONE CALL. `tool-calling.md` notes a small local
 *      model's coherence degrades after 2-3 steps, and per-call cost is process
 *      spawn rather than script complexity (10 statements batched: 54 ms; the
 *      same ten separately: ~380 ms). Asking for three things should be one
 *      call, not three round-trips the model has to chain.
 *
 * Read-only. Every source is a native framework read through
 * `muse-mac-helper`; there is no branch here that changes anything.
 */

import type { JsonObject, JsonValue } from "@muse/shared";
import type { MuseTool } from "@muse/tools";

import { readMacHelper, type MacHelperDeps, type MacHelperRead } from "./macos-helper.js";

/** What a caller may ask for. Each maps 1:1 to a helper read. */
export const MAC_OBSERVE_SOURCES = ["windows", "focus", "apps", "permissions"] as const;
export type MacObserveSource = (typeof MAC_OBSERVE_SOURCES)[number];

export interface MacObserveToolDeps extends MacHelperDeps {}

function normalizeSources(raw: JsonValue | undefined): readonly MacObserveSource[] | { readonly error: string } {
  // A single string is accepted as well as an array: a local model asked for
  // "what app am I in" will often produce the scalar form, and rejecting it
  // would trade a correct intent for a schema quibble.
  const requested = typeof raw === "string"
    ? [raw]
    : Array.isArray(raw)
      ? raw.filter((entry): entry is string => typeof entry === "string")
      : [];

  if (requested.length === 0) {
    return { error: `include must name at least one of: ${MAC_OBSERVE_SOURCES.join(", ")}` };
  }

  const unknown = requested.filter((entry) => !MAC_OBSERVE_SOURCES.includes(entry as MacObserveSource));
  if (unknown.length > 0) {
    return { error: `unknown source(s) ${unknown.join(", ")} — expected: ${MAC_OBSERVE_SOURCES.join(", ")}` };
  }

  // De-duplicate while preserving the caller's order, so asking twice costs one
  // read and the response order stays predictable.
  return [...new Set(requested)] as readonly MacObserveSource[];
}

export function createMacObserveTool(deps: MacObserveToolDeps = {}): MuseTool {
  return {
    definition: {
      description:
        "Read the WINDOW LAYOUT of this Mac: which app and window are in focus, and the position and " +
        "size of every open window. This is the only tool that knows where windows ARE on screen. " +
        "Use when the user asks about window arrangement or what they are focused on — e.g. " +
        "'which window am I in?', 'how are my windows arranged?', '창 배치 어떻게 돼 있어?', " +
        "'지금 어느 창 보고 있지?'. Read-only: it changes nothing. Do NOT use it for the plain list of " +
        "running apps (use mac_app_read), NOT to read the CONTENTS of a document, page, or clipboard " +
        "(use mac_app_read), and NOT to describe a chart or image on screen (use mac_screen_read, " +
        "which looks at pixels).",
      domain: "macos",
      inputSchema: {
        additionalProperties: false,
        properties: {
          include: {
            description:
              "Which state to read, e.g. ['focus'] for the active app and window title, ['windows'] " +
              "for every window with its position and size, ['permissions'] to check whether Muse may " +
              "read window state at all. Combine freely: ['focus','windows']. ('apps' also exists but " +
              "mac_app_read is the tool for a plain running-app list.)",
            items: { enum: [...MAC_OBSERVE_SOURCES], type: "string" },
            type: "array"
          }
        },
        required: ["include"],
        type: "object"
      },
      // Deliberately NOT "apps"/"실행"/"running": those belong to mac_app_read, which the
      // golden eval set already routes "what apps are open" to. Keywords decide which
      // tools the model even SEES, so overlapping here is how a working selection regresses.
      keywords: [
        "window", "창", "windows", "layout", "배치", "arrangement", "정렬",
        "focus", "포커스", "focused", "arranged", "position", "위치", "size", "크기"
      ],
      name: "mac_observe",
      risk: "read"
    },
    execute: async (args): Promise<JsonObject> => {
      const sources = normalizeSources(args["include"] as JsonValue | undefined);
      if ("error" in sources) {
        return { error: sources.error };
      }

      const observed: Record<string, JsonValue> = {};
      const failures: Record<string, JsonValue> = {};

      // Sequential rather than parallel: each read is a fresh process spawn and
      // the whole point is that one call replaces several. Firing four spawns at
      // once to save ~200 ms would trade the predictable cost this tool exists
      // to bound for a burst of concurrent processes.
      for (const source of sources) {
        const result = await readMacHelper(source as MacHelperRead, deps);
        if (result.ok) {
          const { ok: _ok, ...payload } = result.data;
          observed[source] = payload as JsonValue;
        } else {
          // A partial answer is reported as partial. Silently omitting a failed
          // source would let the model narrate "you have no windows open" when
          // the truth is "I could not read them".
          failures[source] = { code: result.code, message: result.message };
        }
      }

      const anySucceeded = Object.keys(observed).length > 0;
      if (!anySucceeded) {
        const first = Object.values(failures)[0] as { code?: string; message?: string } | undefined;
        return {
          error: first?.message ?? "could not read any requested source",
          ...(first?.code ? { code: first.code } : {}),
          unavailable: failures
        };
      }

      return {
        ...observed,
        ...(Object.keys(failures).length > 0 ? { unavailable: failures } : {})
      };
    }
  };
}
