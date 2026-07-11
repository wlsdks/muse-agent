/**
 * One-way mirror of a Muse-created note into Apple Notes.app so it shows up
 * across the user's Apple ecosystem (Mac / iPhone / iPad). Muse's own markdown
 * corpus under `~/.muse/notes` stays the source of truth (recall/grounding
 * keeps reading it); Apple gets a best-effort, create-only copy.
 *
 * Opt-in and fail-soft by construction — the sibling of {@link mirrorReminderToApple}:
 *   - `MUSE_APPLE_NOTES_MIRROR` (parseBoolean, default OFF) gates every
 *     osascript call. Absent/false ⇒ ZERO exec, behaviour byte-identical to a
 *     build without this module.
 *   - Create-only: a Muse note CREATE maps to one `make new note`. Editing or
 *     deleting a Muse note does NOT sync, and the mirror NEVER touches the
 *     Muse-side file.
 *   - A mirror failure (osascript error, missing Automation permission,
 *     timeout) NEVER throws — it returns a `warning` the caller surfaces. The
 *     Muse write must never roll back because Apple was unreachable.
 *
 * THE KEY DELTA over the reminder mirror — multiline bodies. Apple Notes' `body`
 * property is HTML, whereas a reminder title is one plain line. So the note body
 * goes through TWO escaping layers:
 *   1. HTML-escape (`&` `<` `>` `"`) so hostile markup can't inject into the
 *      note, THEN convert real newlines to `<br>` so multi-line notes render as
 *      multiple lines (a plain `escapeAppleScript` would flatten them to spaces).
 *   2. AppleScript-escape the resulting single-line HTML so it can't break out
 *      of the `body:"…"` string literal in the generated script.
 * The title takes the plain single-line `escapeAppleScript` path (like a
 * reminder title). Both layers are injection-tested with hostile payloads.
 */

import {
  defaultOsascriptRunner,
  escapeAppleScript,
  type MacOsascriptRunner
} from "./macos-exec.js";
import { isMirrorEnvEnabled, runMirrorScript } from "./mirror-shared.js";

export const APPLE_NOTES_MIRROR_ENV = "MUSE_APPLE_NOTES_MIRROR";

/**
 * Cap on the mirrored body length (characters of the ORIGINAL note text, before
 * HTML/AppleScript escaping). A huge ingested note should not ship megabytes
 * through osascript — 20k chars is generous for a hand-written note yet keeps
 * the generated script well-bounded. Over the cap, the body is truncated and a
 * marker points back at the untouched Muse-side file.
 */
export const DEFAULT_MAX_NOTE_BODY_CHARS = 20_000;

const TRUNCATION_MARKER = "\n\n[truncated by Muse — full note in ~/.muse/notes]";

export interface MirrorableNote {
  readonly title: string;
  /** The note body (markdown / plain text). Multi-line is preserved as `<br>`. */
  readonly body: string;
}

export interface MirrorNoteOptions {
  /** Environment to read the opt-in switch from. Defaults to `process.env`. */
  readonly env?: Record<string, string | undefined>;
  /** osascript runner (injected in tests). Defaults to the real spawn. */
  readonly exec?: MacOsascriptRunner;
  /** Optional Notes.app folder name. Omitted ⇒ the default folder. */
  readonly folder?: string;
  /** Override the body-length cap. Defaults to {@link DEFAULT_MAX_NOTE_BODY_CHARS}. */
  readonly maxBodyChars?: number;
}

export interface MirrorNoteResult {
  /** True only when Notes.app confirmed the create (exit 0). */
  readonly mirrored: boolean;
  /** True when the opt-in switch is off — no osascript was spawned. */
  readonly skipped: boolean;
  /** Fail-soft, human-readable reason the mirror did not land. Never thrown. */
  readonly warning?: string;
  /** The generated AppleScript (present whenever a script was built). */
  readonly script?: string;
}

/** Whether the Apple-Notes mirror is opted in via `MUSE_APPLE_NOTES_MIRROR`. */
export function isAppleNotesMirrorEnabled(
  env: Record<string, string | undefined> = process.env
): boolean {
  return isMirrorEnvEnabled(env, APPLE_NOTES_MIRROR_ENV);
}

/**
 * HTML-escape note-body text: `&` `<` `>` `"` become entities so a hostile note
 * (e.g. `</body><script>…`) is shown as literal text, never live markup, inside
 * the HTML `body` of the Apple note. `&` MUST be replaced first — otherwise the
 * `&` of a later-inserted entity would be double-escaped.
 */
export function escapeNoteBodyHtml(text: string): string {
  return text
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;");
}

/**
 * Turn note-body text into the single-line HTML string Apple Notes stores.
 * Escapes the special chars FIRST (so a user-typed `<br>` shows literally), THEN
 * converts REAL newlines to `<br>` so the multi-line note renders as multiple
 * lines. The result carries no raw `"` (→ `&quot;`) and no raw newline.
 */
export function noteBodyToHtml(text: string): string {
  return escapeNoteBodyHtml(text).replace(/\r\n|\r|\n/gu, "<br>");
}

function capBody(body: string, maxChars: number): string {
  if (body.length <= maxChars) {
    return body;
  }
  return body.slice(0, maxChars) + TRUNCATION_MARKER;
}

/**
 * Build the `make new note` AppleScript for one note. The title goes through the
 * plain single-line escaper; the body is HTML-escaped + newline-to-`<br>` and
 * THEN AppleScript-escaped so neither markup nor a quote/newline can break out
 * of the `body:"…"` literal. When a folder is given the note is created inside
 * it — Apple Notes puts notes in a folder, not directly in an account.
 */
export function buildMirrorNoteScript(note: MirrorableNote, folder?: string): string {
  const name = escapeAppleScript(note.title);
  const bodyHtml = escapeAppleScript(noteBodyToHtml(note.body));
  const folderClause = folder && folder.trim().length > 0
    ? ` at folder "${escapeAppleScript(folder)}"`
    : "";
  return (
    `tell application "Notes"\n`
    + `  make new note${folderClause} with properties {name:"${name}", body:"${bodyHtml}"}\n`
    + `end tell`
  );
}

/**
 * Mirror one newly-created Muse note into Apple Notes.app. Never throws: returns
 * `{ skipped: true }` when the opt-in switch is off (zero exec), `{ mirrored:
 * true }` on a confirmed create, or `{ warning }` on any failure so the caller
 * can surface it without failing the Muse write.
 */
export async function mirrorNoteToApple(
  note: MirrorableNote,
  options: MirrorNoteOptions = {}
): Promise<MirrorNoteResult> {
  const env = options.env ?? process.env;
  if (!isAppleNotesMirrorEnabled(env)) {
    return { mirrored: false, skipped: true };
  }
  const title = note.title.trim();
  if (title.length === 0) {
    return { mirrored: false, skipped: false, warning: "Apple Notes mirror skipped: empty note title" };
  }
  const maxBodyChars = typeof options.maxBodyChars === "number" && Number.isFinite(options.maxBodyChars) && options.maxBodyChars > 0
    ? Math.trunc(options.maxBodyChars)
    : DEFAULT_MAX_NOTE_BODY_CHARS;
  const exec = options.exec ?? defaultOsascriptRunner;
  const script = buildMirrorNoteScript({ body: capBody(note.body ?? "", maxBodyChars), title }, options.folder);
  const outcome = await runMirrorScript(exec, script, { app: "Apple Notes", permissionTarget: "Notes" });
  return { mirrored: outcome.mirrored, skipped: false, warning: outcome.warning, script };
}
