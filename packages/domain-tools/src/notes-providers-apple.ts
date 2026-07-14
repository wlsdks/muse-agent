/**
 * macOS Notes.app adapter via AppleScript (osascript).
 *
 * Each upstream adapter (Local, Notion, Apple) lives in its own
 * file. The shared abstraction layer — `NotesProvider` interface,
 * `NotesValidationError`, `NotesProviderError`, and the common
 * payload types — stays in `notes-providers.ts`.
 *
 * Same shape as `MacOsCalendarProvider` in `@muse/calendar`: each
 * operation generates an AppleScript snippet, pipes it to `osascript`,
 * and parses the structured output. Tab-separated lines are used so
 * note titles and bodies (which can contain commas, newlines, HTML)
 * never have to be parsed out of free-form text.
 *
 * Apple Notes uses HTML for the `body` attribute. We pass it through
 * as-is in `read()` / save / append so callers can choose whether to
 * strip tags. Plain text written to `save()` becomes a paragraph in
 * Notes.app — that's the AppleScript convention.
 *
 * Permissions: the first call triggers the system "Allow Notes
 * access" prompt. Until granted, every script fails — we map that to
 * a typed `NOTES_PERMISSION` error so a CLI wizard can guide the user.
 */

import { runCommandWithTimeout } from "@muse/shared";

import {
  NotesProviderError,
  NotesValidationError,
  type NotesAppendInput,
  type NotesContent,
  type NotesEntry,
  type NotesProvider,
  type NotesProviderInfo,
  type NotesSaveInput,
  type NotesSearchHit
} from "./notes-providers.js";

export interface AppleNotesProviderOptions {
  /**
   * Notes.app folder name to scope reads / writes against. When omitted,
   * the adapter operates against every note (read/search) and saves into
   * the default Notes folder.
   */
  readonly folder?: string;
  /**
   * `osascript` binary path. Defaults to `/usr/bin/osascript`. Override
   * in tests with a stub that produces canned output.
   */
  readonly osascriptPath?: string;
  /** osascript watchdog timeout (ms). Defaults to 30_000. */
  readonly timeoutMs?: number;
}

/**
 * Per-entry delimiter for the Apple Notes search AppleScript output.
 *
 * AppleScript doesn't recognize ` ` as a Unicode escape (a prior
 * implementation used `"\\u0000"` and silently outputted the literal
 * 6-character string ` `, which split-on-space then mangled),
 * so we use a deliberately-unique ASCII marker that's vanishingly
 * unlikely to appear inside a Notes body. Keep this string in sync
 * between the AppleScript template and `parseSearchOutput`.
 */
const APPLE_NOTES_SEARCH_DELIM = "~~~MUSE_NOTES_SEARCH_END~~~";
const APPLE_NOTES_OSASCRIPT_TIMEOUT_MS = 30_000;

export class AppleNotesProvider implements NotesProvider {
  readonly id = "apple";
  private readonly folder?: string;
  private readonly osascriptPath: string;
  private readonly timeoutMs: number;

  constructor(options: AppleNotesProviderOptions = {}) {
    this.folder = options.folder;
    this.osascriptPath = options.osascriptPath ?? "/usr/bin/osascript";
    this.timeoutMs =
      typeof options.timeoutMs === "number" && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
        ? options.timeoutMs
        : APPLE_NOTES_OSASCRIPT_TIMEOUT_MS;
  }

  describe(): NotesProviderInfo {
    return {
      description: this.folder
        ? `Apple Notes via AppleScript (folder: ${this.folder}).`
        : "Apple Notes via AppleScript.",
      displayName: "Apple Notes",
      id: this.id,
      local: true
    };
  }

  async list(folder?: string): Promise<readonly NotesEntry[]> {
    const folderName = folder ?? this.folder;
    const target = folderName
      ? `every note of folder ${quote(folderName)}`
      : `every note`;
    const script = `
      set output to ""
      tell application "Notes"
        repeat with n in (${target})
          set noteId to (id of n as string)
          set noteName to (name of n as string)
          set noteFolder to (name of container of n as string)
          set noteMod to (modification date of n)
          set output to output & noteId & tab & noteName & tab & noteFolder & tab & (noteMod as «class isot» as string) & linefeed
        end repeat
      end tell
      return output
    `;
    const stdout = await this.runScript(script);
    return parseListOutput(stdout, this.id);
  }

  async read(id: string): Promise<NotesContent | undefined> {
    if (!id || id.trim().length === 0) {
      throw new NotesValidationError("EMPTY_ID", "AppleNotesProvider.read requires a non-empty id");
    }
    const script = `
      tell application "Notes"
        set matches to (every note whose id is ${quote(id)})
        if (count of matches) is 0 then
          return ""
        end if
        set n to first item of matches
        set noteName to (name of n as string)
        set noteBody to (body of n as string)
        set noteFolder to (name of container of n as string)
        set noteMod to (modification date of n)
        return noteName & tab & noteFolder & tab & (noteMod as «class isot» as string) & linefeed & noteBody
      end tell
    `;
    const stdout = await this.runScript(script);
    if (stdout.trim().length === 0) {
      return undefined;
    }
    return parseReadOutput(stdout, id, this.id);
  }

  async search(query: string, limit: number): Promise<readonly NotesSearchHit[]> {
    const trimmed = (query ?? "").trim();
    if (trimmed.length === 0) {
      throw new NotesValidationError("EMPTY_QUERY", "AppleNotesProvider.search requires a non-empty query");
    }
    const cap = Math.max(1, Math.min(200, Math.trunc(limit) || 20));
    const folderClause = this.folder
      ? `every note of folder ${quote(this.folder)} whose body contains ${quote(trimmed)} or name contains ${quote(trimmed)}`
      : `every note whose body contains ${quote(trimmed)} or name contains ${quote(trimmed)}`;
    const script = `
      set output to ""
      set hitCount to 0
      tell application "Notes"
        repeat with n in (${folderClause})
          if hitCount >= ${cap} then exit repeat
          set noteId to (id of n as string)
          set noteName to (name of n as string)
          set noteBody to (body of n as string)
          set output to output & noteId & tab & noteName & tab & noteBody & "${APPLE_NOTES_SEARCH_DELIM}"
          set hitCount to hitCount + 1
        end repeat
      end tell
      return output
    `;
    const stdout = await this.runScript(script);
    return parseSearchOutput(stdout, trimmed, this.id);
  }

  async save(input: NotesSaveInput): Promise<NotesContent> {
    if (!input.title || input.title.trim().length === 0) {
      throw new NotesValidationError("EMPTY_TITLE", "AppleNotesProvider.save requires a title");
    }
    const folder = input.folder ?? this.folder;
    if (input.id) {
      const overwrite = input.overwrite === true;
      const updates = [
        `set name of n to ${quote(input.title)}`,
        overwrite ? `set body of n to ${quote(input.body)}` : null
      ].filter((fragment): fragment is string => Boolean(fragment));
      const script = `
        tell application "Notes"
          set matches to (every note whose id is ${quote(input.id)})
          if (count of matches) is 0 then
            error "NOTE_NOT_FOUND"
          end if
          set n to first item of matches
          ${updates.join("\n          ")}
          return id of n as string
        end tell
      `;
      const id = (await this.runScript(script)).trim();
      const after = await this.read(id);
      if (!after) {
        throw new NotesProviderError(this.id, "NOTE_NOT_FOUND", `note ${id} not found after save`);
      }
      return after;
    }

    // AppleScript Notes.app: notes live inside `folder`, not directly
    // inside `account`. When no folder is specified, omit the `at`
    // clause so Notes.app uses the default folder of the default
    // account. The previous `at default account` form was invalid
    // AppleScript and would error at runtime — silent CI bug because
    // the real-osascript path stays untested.
    const atClause = folder ? ` at folder ${quote(folder)}` : "";
    const script = `
      tell application "Notes"
        set newNote to make new note${atClause} with properties {name:${quote(input.title)}, body:${quote(input.body)}}
        return id of newNote as string
      end tell
    `;
    const newId = (await this.runScript(script)).trim();
    const created = await this.read(newId);
    if (!created) {
      throw new NotesProviderError(this.id, "NOTE_NOT_FOUND", `created note ${newId} not readable`);
    }
    return created;
  }

  async append(input: NotesAppendInput): Promise<NotesContent> {
    if (!input.id || input.id.trim().length === 0) {
      throw new NotesValidationError("EMPTY_ID", "AppleNotesProvider.append requires an id");
    }
    const script = `
      tell application "Notes"
        set matches to (every note whose id is ${quote(input.id)})
        if (count of matches) is 0 then
          error "NOTE_NOT_FOUND"
        end if
        set n to first item of matches
        set existing to (body of n as string)
        set body of n to existing & ${quote(input.body)}
        return id of n as string
      end tell
    `;
    await this.runScript(script);
    const after = await this.read(input.id);
    if (!after) {
      throw new NotesProviderError(this.id, "NOTE_NOT_FOUND", `note ${input.id} not readable after append`);
    }
    return after;
  }

  private async runScript(script: string): Promise<string> {
    const result = await runCommandWithTimeout({
      command: this.osascriptPath,
      args: ["-"],
      stdin: script,
      timeoutMs: this.timeoutMs
    });

    if (result.timedOut) {
      throw new NotesProviderError(
        this.id,
        "OSASCRIPT_TIMEOUT",
        `osascript timed out after ${this.timeoutMs.toString()}ms and was killed (unanswered Notes Automation prompt or a wedged Notes.app?)`
      );
    }

    if (result.exitCode === 0) {
      return result.stdout;
    }

    if (/not allowed to access|don't have permission|not authorised/iu.test(result.stderr)) {
      throw new NotesProviderError(this.id, "NOTES_PERMISSION", "Notes access permission denied — grant access in System Settings → Privacy & Security → Automation.");
    }

    if (/NOTE_NOT_FOUND/u.test(result.stderr)) {
      throw new NotesProviderError(this.id, "NOTE_NOT_FOUND", "Apple Notes note not found");
    }

    throw new NotesProviderError(this.id, `EXIT_${result.exitCode ?? "UNKNOWN"}`, `osascript failed: ${result.stderr.trim().slice(0, 500)}`);
  }
}

function parseListOutput(output: string, providerId: string): readonly NotesEntry[] {
  return output
    .split(/\r?\n/u)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .flatMap((line): readonly NotesEntry[] => {
      const [id, title, folder, modIso] = line.split("\t");
      if (!id || !title) {
        return [];
      }
      const updatedAt = modIso ? toDateOrUndefined(modIso) : undefined;
      return [{
        id,
        providerId,
        title,
        ...(folder && folder.length > 0 ? { folder } : {}),
        ...(updatedAt ? { updatedAt } : {})
      }];
    });
}

function parseReadOutput(output: string, id: string, providerId: string): NotesContent {
  const newlineIdx = output.indexOf("\n");
  const headerLine = newlineIdx >= 0 ? output.slice(0, newlineIdx).trimEnd() : output.trimEnd();
  const body = newlineIdx >= 0 ? output.slice(newlineIdx + 1) : "";
  const [title = "", folder = "", modIso = ""] = headerLine.split("\t");
  const updatedAt = modIso ? toDateOrUndefined(modIso) : undefined;
  return {
    body,
    id,
    providerId,
    title,
    ...(folder.length > 0 ? { folder } : {}),
    ...(updatedAt ? { updatedAt } : {})
  };
}

function parseSearchOutput(output: string, query: string, providerId: string): readonly NotesSearchHit[] {
  const needle = query.toLowerCase();
  return output
    .split(APPLE_NOTES_SEARCH_DELIM)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .flatMap((entry): readonly NotesSearchHit[] => {
      const [id, title, ...rest] = entry.split("\t");
      const body = rest.join("\t");
      if (!id || !title) {
        return [];
      }
      const idx = body.toLowerCase().indexOf(needle);
      const snippet = idx >= 0
        ? body.slice(Math.max(0, idx - 40), Math.min(body.length, idx + 200))
        : body.slice(0, 200);
      return [{
        id,
        providerId,
        snippet,
        title
      }];
    });
}

function toDateOrUndefined(iso: string): Date | undefined {
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function quote(value: string): string {
  return `"${value.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"').replace(/\n/gu, "\\n")}"`;
}
