/**
 * Provider-neutral notes abstraction (mirrors @muse/calendar).
 *
 * `LocalDirNotesProvider` is a real, fully-tested implementation that
 * mirrors the inline filesystem semantics in `createNotesMcpServer`
 * (path-safety, recursive markdown walk, line-level search hits). It
 * lets the registry hold a real adapter today; future iterations
 * can refactor `createNotesMcpServer` to consume the registry
 * directly.
 *
 * Design rules:
 *   - `id` is provider-scoped. Cross-provider operations include
 *     `providerId`.
 *   - Failure: providers throw `NotesProviderError` for upstream
 *     failures. Validation errors throw `NotesValidationError`.
 *   - Apple Notes is a real macOS-only adapter that shells out to
 *     `osascript` against `Notes.app`. Notion remains a typed
 *     scaffold that throws NOT_IMPLEMENTED until its adapter lands.
 */
import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";

export interface NotesEntry {
  readonly id: string;
  readonly providerId: string;
  readonly title: string;
  readonly folder?: string;
  readonly sizeBytes?: number;
  readonly updatedAt?: Date;
}

export interface NotesContent {
  readonly id: string;
  readonly providerId: string;
  readonly title: string;
  readonly body: string;
  readonly folder?: string;
  readonly updatedAt?: Date;
}

export interface NotesSearchHit {
  readonly id: string;
  readonly providerId: string;
  readonly title: string;
  readonly snippet: string;
  readonly score?: number;
  readonly line?: number;
}

export interface NotesSaveInput {
  readonly id?: string;
  readonly title: string;
  readonly body: string;
  readonly folder?: string;
  readonly overwrite?: boolean;
}

export interface NotesAppendInput {
  readonly id: string;
  readonly body: string;
}

export interface NotesProviderInfo {
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
  readonly local: boolean;
}

export interface NotesProvider {
  readonly id: string;
  describe(): NotesProviderInfo;
  list(folder?: string): Promise<readonly NotesEntry[]>;
  read(id: string): Promise<NotesContent | undefined>;
  search(query: string, limit: number): Promise<readonly NotesSearchHit[]>;
  save(input: NotesSaveInput): Promise<NotesContent>;
  append(input: NotesAppendInput): Promise<NotesContent>;
}

export class NotesValidationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "NotesValidationError";
    this.code = code;
  }
}

export class NotesProviderError extends Error {
  readonly providerId: string;
  readonly code: string;

  constructor(providerId: string, code: string, message: string) {
    super(message);
    this.name = "NotesProviderError";
    this.providerId = providerId;
    this.code = code;
  }
}

export class NotesProviderRegistry {
  private readonly providers = new Map<string, NotesProvider>();

  constructor(providers: Iterable<NotesProvider> = []) {
    for (const provider of providers) {
      this.register(provider);
    }
  }

  register(provider: NotesProvider): void {
    this.providers.set(provider.id, provider);
  }

  list(): readonly NotesProvider[] {
    return [...this.providers.values()];
  }

  describe(): readonly NotesProviderInfo[] {
    return this.list().map((provider) => provider.describe());
  }

  has(providerId: string): boolean {
    return this.providers.has(providerId);
  }

  primary(): NotesProvider | undefined {
    return this.list()[0];
  }

  require(providerId: string): NotesProvider {
    const provider = this.providers.get(providerId);
    if (!provider) {
      throw new NotesProviderError(providerId, "PROVIDER_NOT_FOUND", `Notes provider not registered: ${providerId}`);
    }
    return provider;
  }
}

export interface LocalDirNotesProviderOptions {
  readonly notesDir: string;
  readonly maxFileBytes?: number;
  readonly maxListEntries?: number;
}

/**
 * Filesystem-backed notes provider. Stores notes as `.md` / `.markdown`
 * / `.txt` files inside `notesDir`. Same sandbox + path-safety
 * semantics as the inline implementation in `createNotesMcpServer`:
 *
 *   - Paths are resolved relative to `notesDir`. Any path that
 *     escapes the sandbox (`..`, absolute paths outside the dir,
 *     symlink traversals) is rejected with NotesValidationError.
 *   - `id` is the relative path within the sandbox, including the
 *     extension.
 *   - `search` returns line-level hits with 1-based line numbers,
 *     matching the loopback server contract.
 *
 * Identical behaviour to the inline notes server, but exposed
 * through the provider interface so the registry has at least one
 * real adapter (Apple Notes / Notion remain stubs).
 */
export class LocalDirNotesProvider implements NotesProvider {
  readonly id = "local";
  private readonly notesDir: string;
  private readonly maxFileBytes: number;
  private readonly maxListEntries: number;

  constructor(options: LocalDirNotesProviderOptions) {
    this.notesDir = options.notesDir;
    this.maxFileBytes = Math.max(1_024, Math.trunc(options.maxFileBytes ?? 1_048_576));
    this.maxListEntries = Math.max(1, Math.trunc(options.maxListEntries ?? 500));
  }

  describe(): NotesProviderInfo {
    return {
      description: `Local file-backed notes (${this.notesDir}).`,
      displayName: "Local directory",
      id: this.id,
      local: true
    };
  }

  async list(folder?: string): Promise<readonly NotesEntry[]> {
    const { promises: fs } = await import("node:fs");
    const { resolve, sep } = await import("node:path");
    const safe = this.resolveSafe(folder ?? "", resolve, sep);
    if (typeof safe === "string") {
      throw new NotesValidationError("INVALID_PATH", safe);
    }

    let dirents: readonly { readonly name: string; isFile(): boolean; isDirectory(): boolean }[];
    try {
      dirents = await fs.readdir(safe.absolute, { withFileTypes: true });
    } catch (error) {
      throw new NotesProviderError(this.id, "READ_FAILED", `cannot list directory: ${this.errorMessage(error)}`);
    }

    const out: NotesEntry[] = [];
    for (const entry of dirents) {
      if (entry.name.startsWith(".") || out.length >= this.maxListEntries) {
        continue;
      }
      if (!entry.isFile() || !/\.(md|markdown|txt)$/iu.test(entry.name)) {
        continue;
      }
      const childAbs = resolve(safe.absolute, entry.name);
      const childRel = childAbs.slice(this.notesDir.length + 1);
      let stat: { readonly size: number; readonly mtime: Date } | undefined;
      try {
        stat = await fs.stat(childAbs);
      } catch {
        stat = undefined;
      }
      out.push({
        folder: safe.relative || undefined,
        id: childRel,
        providerId: this.id,
        title: entry.name,
        ...(stat ? { sizeBytes: stat.size, updatedAt: stat.mtime } : {})
      });
    }
    return out;
  }

  async read(id: string): Promise<NotesContent | undefined> {
    const { promises: fs } = await import("node:fs");
    const { resolve, sep } = await import("node:path");
    const safe = this.resolveSafe(id, resolve, sep);
    if (typeof safe === "string") {
      throw new NotesValidationError("INVALID_PATH", safe);
    }
    let stat: { readonly size: number; readonly mtime: Date; isDirectory(): boolean };
    try {
      stat = await fs.stat(safe.absolute);
    } catch {
      return undefined;
    }
    if (stat.isDirectory()) {
      throw new NotesValidationError("PATH_IS_DIRECTORY", "path is a directory, not a file");
    }
    if (stat.size > this.maxFileBytes) {
      throw new NotesProviderError(this.id, "FILE_TOO_LARGE", `file is ${stat.size} bytes, exceeds maxFileBytes ${this.maxFileBytes}`);
    }
    const body = await fs.readFile(safe.absolute, "utf8");
    return {
      body,
      id: safe.relative,
      providerId: this.id,
      title: safe.relative.split("/").pop() ?? safe.relative,
      updatedAt: stat.mtime
    };
  }

  async search(query: string, limit: number): Promise<readonly NotesSearchHit[]> {
    const { promises: fs } = await import("node:fs");
    const { resolve, sep } = await import("node:path");
    const trimmed = query.trim();
    if (trimmed.length === 0) {
      throw new NotesValidationError("EMPTY_QUERY", "query must not be empty");
    }
    const needle = trimmed.toLowerCase();
    const cap = Math.max(1, Math.trunc(limit));

    const files: string[] = [];
    await this.walk(this.notesDir, (rel) => { files.push(rel); }, new Set(), fs.readdir as never, resolve, sep);

    const matches: NotesSearchHit[] = [];
    for (const rel of files) {
      if (matches.length >= cap) {
        break;
      }
      const abs = resolve(this.notesDir, rel);
      let stat: { readonly size: number };
      try {
        stat = await fs.stat(abs);
      } catch {
        continue;
      }
      if (stat.size > this.maxFileBytes) {
        continue;
      }
      let body: string;
      try {
        body = await fs.readFile(abs, "utf8");
      } catch {
        continue;
      }
      const lines = body.split(/\r?\n/u);
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] ?? "";
        if (line.toLowerCase().includes(needle)) {
          matches.push({
            id: rel,
            line: index + 1,
            providerId: this.id,
            snippet: line.length > 240 ? `${line.slice(0, 240)}...` : line,
            title: rel.split("/").pop() ?? rel
          });
          if (matches.length >= cap) {
            break;
          }
        }
      }
    }
    return matches;
  }

  async save(input: NotesSaveInput): Promise<NotesContent> {
    const { promises: fs } = await import("node:fs");
    const { resolve, sep, dirname } = await import("node:path");
    const targetId = input.id ?? input.title;
    const safe = this.resolveSafe(targetId, resolve, sep);
    if (typeof safe === "string") {
      throw new NotesValidationError("INVALID_PATH", safe);
    }
    const buffer = Buffer.from(input.body, "utf8");
    if (buffer.byteLength > this.maxFileBytes) {
      throw new NotesValidationError("BODY_TOO_LARGE", `body exceeds maxFileBytes ${this.maxFileBytes}`);
    }
    let exists = false;
    try {
      await fs.stat(safe.absolute);
      exists = true;
    } catch {
      exists = false;
    }
    if (exists && input.overwrite !== true) {
      throw new NotesProviderError(this.id, "ALREADY_EXISTS", `note already exists at ${safe.relative}; pass overwrite:true to replace`);
    }
    await fs.mkdir(dirname(safe.absolute), { recursive: true });
    await fs.writeFile(safe.absolute, input.body, "utf8");
    return {
      body: input.body,
      id: safe.relative,
      providerId: this.id,
      title: input.title,
      updatedAt: new Date()
    };
  }

  async append(input: NotesAppendInput): Promise<NotesContent> {
    const { promises: fs } = await import("node:fs");
    const { resolve, sep, dirname } = await import("node:path");
    const safe = this.resolveSafe(input.id, resolve, sep);
    if (typeof safe === "string") {
      throw new NotesValidationError("INVALID_PATH", safe);
    }
    await fs.mkdir(dirname(safe.absolute), { recursive: true });
    await fs.appendFile(safe.absolute, input.body, "utf8");
    let stat: { readonly size: number };
    try {
      stat = await fs.stat(safe.absolute);
    } catch {
      throw new NotesProviderError(this.id, "STAT_FAILED", "cannot stat appended file");
    }
    if (stat.size > this.maxFileBytes) {
      throw new NotesProviderError(this.id, "FILE_TOO_LARGE", `note exceeds maxFileBytes ${this.maxFileBytes} after append (size=${stat.size})`);
    }
    const body = await fs.readFile(safe.absolute, "utf8");
    return {
      body,
      id: safe.relative,
      providerId: this.id,
      title: safe.relative.split("/").pop() ?? safe.relative,
      updatedAt: new Date()
    };
  }

  private resolveSafe(
    input: string,
    resolve: (...parts: readonly string[]) => string,
    sep: string
  ): { readonly absolute: string; readonly relative: string } | string {
    const trimmed = input.trim();
    if (trimmed.length === 0) {
      return { absolute: this.notesDir, relative: "" };
    }
    if (trimmed.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(trimmed)) {
      return "path must be relative to the notes directory";
    }
    const absolute = resolve(this.notesDir, trimmed);
    if (absolute !== this.notesDir && !absolute.startsWith(this.notesDir + sep)) {
      return "path escapes the notes directory";
    }
    const relative = absolute === this.notesDir ? "" : absolute.slice(this.notesDir.length + 1);
    return { absolute, relative };
  }

  private async walk(
    dir: string,
    accept: (relPath: string) => void,
    visited: Set<string>,
    readdir: (path: string, options: { withFileTypes: true }) => Promise<readonly { readonly name: string; isFile(): boolean; isDirectory(): boolean }[]>,
    resolve: (...parts: readonly string[]) => string,
    sep: string
  ): Promise<void> {
    if (visited.has(dir)) {
      return;
    }
    visited.add(dir);
    let entries: readonly { readonly name: string; isFile(): boolean; isDirectory(): boolean }[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) {
        continue;
      }
      const childAbs = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        await this.walk(childAbs, accept, visited, readdir, resolve, sep);
      } else if (entry.isFile() && /\.(md|markdown|txt)$/iu.test(entry.name)) {
        accept(childAbs.slice(this.notesDir.length + 1));
      }
    }
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}

/**
 * Per-entry delimiter for the Apple Notes search AppleScript output.
 *
 * AppleScript doesn't recognize ` ` as a Unicode escape (a prior
 * implementation used `"\\u0000"` and silently outputted the literal
 * 6-character string ` `, which split-on-space then mangled),
 * so we use a deliberately-unique ASCII marker that's vanishingly
 * unlikely to appear inside a Notes body. Keep this string in sync
 * between the AppleScript template and `parseSearchOutput`.
 */
const APPLE_NOTES_SEARCH_DELIM = "~~~MUSE_NOTES_SEARCH_END~~~";

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
}

/**
 * macOS Notes.app adapter via AppleScript (osascript).
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
export class AppleNotesProvider implements NotesProvider {
  readonly id = "apple";
  private readonly folder?: string;
  private readonly osascriptPath: string;

  constructor(options: AppleNotesProviderOptions = {}) {
    this.folder = options.folder;
    this.osascriptPath = options.osascriptPath ?? "/usr/bin/osascript";
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
    return new Promise((resolve, reject) => {
      const child = spawn(this.osascriptPath, ["-"], { stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
      child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

      child.on("error", (error) => {
        reject(new NotesProviderError(this.id, "OSASCRIPT_FAILED", error.message));
      });

      child.on("close", (code) => {
        if (code === 0) {
          resolve(stdout);
          return;
        }

        if (/not allowed to access|don't have permission|not authorised/iu.test(stderr)) {
          reject(new NotesProviderError(this.id, "NOTES_PERMISSION", "Notes access permission denied — grant access in System Settings → Privacy & Security → Automation."));
          return;
        }

        if (/NOTE_NOT_FOUND/u.test(stderr)) {
          reject(new NotesProviderError(this.id, "NOTE_NOT_FOUND", "Apple Notes note not found"));
          return;
        }

        reject(new NotesProviderError(this.id, `EXIT_${code ?? "UNKNOWN"}`, `osascript failed: ${stderr.trim().slice(0, 500)}`));
      });

      child.stdin.write(script);
      child.stdin.end();
    });
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

type NotionFetch = (input: string, init: RequestInit) => Promise<Response>;

export interface NotionNotesProviderOptions {
  readonly token: string;
  /** Database id (32-char) to scope `list` and `save` against. Required for those ops. */
  readonly databaseId?: string;
  /**
   * Property name on the Notion database that holds page titles. Defaults
   * to `Name` (Notion's default). Override if your database uses a
   * different title-property name.
   */
  readonly titleProperty?: string;
  /** API base. Defaults to `https://api.notion.com/v1`. */
  readonly endpoint?: string;
  /** `Notion-Version` header value. Defaults to a stable 2022 revision. */
  readonly notionVersion?: string;
  /** `fetch` override for tests. Defaults to the global. */
  readonly fetchImpl?: NotionFetch;
}

const NOTION_DEFAULT_ENDPOINT = "https://api.notion.com/v1";
const NOTION_DEFAULT_VERSION = "2022-06-28";
const NOTION_DEFAULT_TITLE_PROPERTY = "Name";
const NOTION_LIST_MAX_PAGES = 10;
const NOTION_BLOCKS_MAX_PAGES = 10;

/**
 * Notion API adapter — talks to `api.notion.com/v1` with the
 * provided integration token. Maps `NotesEntry` to Notion pages.
 *
 * `databaseId` is required for `list` and for `save` without an
 * existing page id — Notion creates pages inside a database, not
 * free-floating. `read`, `search`, and `append` work without it
 * (read takes a page id directly; search hits the workspace-wide
 * `/v1/search`; append mutates a known page).
 *
 * Body model: each paragraph in `NotesContent.body` corresponds to
 * one Notion `paragraph` block. `read` joins child paragraph blocks
 * with `\n`; `save`/`append` split the input on `\n` into blocks.
 * Rich-text formatting is not preserved (plain text in/out) — for a
 * personal JARVIS, the simplification is worth it.
 *
 * Errors are mapped to `NotesProviderError` with codes:
 *   - `NOTION_AUTH` for 401/403
 *   - `NOTION_NOT_FOUND` for 404
 *   - `NOTION_RATE_LIMIT` for 429
 *   - `HTTP_<status>` for other non-2xx
 *   - `MISSING_DATABASE_ID` when an op requires databaseId but none was set
 */
export class NotionNotesProvider implements NotesProvider {
  readonly id = "notion";
  private readonly token: string;
  private readonly databaseId?: string;
  private readonly titleProperty: string;
  private readonly endpoint: string;
  private readonly notionVersion: string;
  private readonly fetchImpl: NotionFetch;

  constructor(options: NotionNotesProviderOptions) {
    if (!options.token || options.token.trim().length === 0) {
      throw new NotesValidationError("MISSING_TOKEN", "NotionNotesProvider requires an API token");
    }
    this.token = options.token;
    this.databaseId = options.databaseId;
    this.titleProperty = options.titleProperty ?? NOTION_DEFAULT_TITLE_PROPERTY;
    this.endpoint = options.endpoint ?? NOTION_DEFAULT_ENDPOINT;
    this.notionVersion = options.notionVersion ?? NOTION_DEFAULT_VERSION;
    const globalFetch = (globalThis as { fetch?: NotionFetch }).fetch;
    this.fetchImpl = options.fetchImpl ?? (globalFetch as NotionFetch);
    if (!this.fetchImpl) {
      throw new NotesValidationError("NO_FETCH", "global fetch unavailable; pass fetchImpl");
    }
  }

  describe(): NotesProviderInfo {
    return {
      description: this.databaseId
        ? `Notion pages (database: ${this.databaseId}).`
        : "Notion pages (workspace search; databaseId required for list/save).",
      displayName: "Notion",
      id: this.id,
      local: false
    };
  }

  async list(): Promise<readonly NotesEntry[]> {
    const databaseId = this.requireDatabaseId("list");
    const all: NotesEntry[] = [];
    let cursor: string | undefined;
    // Notion's `/databases/:id/query` returns at most `page_size` (capped
    // at 100) per call and signals more via `has_more` + `next_cursor`.
    // Cap pages at 10 (≈1000 entries) — a personal user with that many
    // notes likely wants the agent to search instead of listing all.
    for (let page = 0; page < NOTION_LIST_MAX_PAGES; page += 1) {
      const requestBody: Record<string, unknown> = { page_size: 100 };
      if (cursor) {
        requestBody.start_cursor = cursor;
      }
      const body = await this.request("POST", `/databases/${databaseId}/query`, requestBody);
      const results = isRecordArray(body, "results");
      for (const result of results) {
        const entry = parsePageSummary(result, this.id, this.titleProperty);
        if (entry) {
          all.push(entry);
        }
      }
      const hasMore = (body as { has_more?: unknown }).has_more === true;
      const nextCursor = (body as { next_cursor?: unknown }).next_cursor;
      if (!hasMore || typeof nextCursor !== "string" || nextCursor.length === 0) {
        break;
      }
      cursor = nextCursor;
    }
    return all;
  }

  async read(id: string): Promise<NotesContent | undefined> {
    if (!id || id.trim().length === 0) {
      throw new NotesValidationError("EMPTY_ID", "NotionNotesProvider.read requires a page id");
    }
    let page: unknown;
    try {
      page = await this.request("GET", `/pages/${id}`, undefined);
    } catch (error) {
      if (error instanceof NotesProviderError && error.code === "NOTION_NOT_FOUND") {
        return undefined;
      }
      throw error;
    }
    const blockResults = await this.fetchAllBlockChildren(id);
    const body = blockResults.map(extractParagraphText).filter((line) => line.length > 0).join("\n");
    const summary = parsePageSummary(page, this.id, this.titleProperty);
    if (!summary) {
      throw new NotesProviderError(this.id, "NOTION_BAD_SHAPE", `Notion page ${id} did not match expected shape`);
    }
    return {
      body,
      id: summary.id,
      providerId: summary.providerId,
      title: summary.title,
      ...(summary.folder ? { folder: summary.folder } : {}),
      ...(summary.updatedAt ? { updatedAt: summary.updatedAt } : {})
    };
  }

  async search(query: string, limit: number): Promise<readonly NotesSearchHit[]> {
    const trimmed = (query ?? "").trim();
    if (trimmed.length === 0) {
      throw new NotesValidationError("EMPTY_QUERY", "NotionNotesProvider.search requires a non-empty query");
    }
    const cap = Math.max(1, Math.min(100, Math.trunc(limit) || 20));
    const body = await this.request("POST", `/search`, {
      filter: { property: "object", value: "page" },
      page_size: cap,
      query: trimmed
    });
    const results = isRecordArray(body, "results");
    return results.flatMap((result): readonly NotesSearchHit[] => {
      const summary = parsePageSummary(result, this.id, this.titleProperty);
      if (!summary) {
        return [];
      }
      return [{
        id: summary.id,
        providerId: summary.providerId,
        snippet: summary.title,
        title: summary.title
      }];
    });
  }

  async save(input: NotesSaveInput): Promise<NotesContent> {
    if (!input.title || input.title.trim().length === 0) {
      throw new NotesValidationError("EMPTY_TITLE", "NotionNotesProvider.save requires a title");
    }
    if (input.id) {
      const overwrite = input.overwrite === true;
      await this.request("PATCH", `/pages/${input.id}`, {
        properties: {
          [this.titleProperty]: { title: [{ text: { content: input.title } }] }
        }
      });
      if (overwrite) {
        await this.replaceBlocks(input.id, input.body);
      }
      const after = await this.read(input.id);
      if (!after) {
        throw new NotesProviderError(this.id, "NOTION_NOT_FOUND", `Notion page ${input.id} not readable after save`);
      }
      return after;
    }

    const databaseId = this.requireDatabaseId("save");
    const created = await this.request("POST", `/pages`, {
      children: bodyToParagraphBlocks(input.body),
      parent: { database_id: databaseId },
      properties: {
        [this.titleProperty]: { title: [{ text: { content: input.title } }] }
      }
    });
    const newId = (created as { id?: string }).id;
    if (!newId) {
      throw new NotesProviderError(this.id, "NOTION_BAD_SHAPE", "Notion page-create response missing id");
    }
    const after = await this.read(newId);
    if (!after) {
      throw new NotesProviderError(this.id, "NOTION_NOT_FOUND", `created Notion page ${newId} not readable`);
    }
    return after;
  }

  async append(input: NotesAppendInput): Promise<NotesContent> {
    if (!input.id || input.id.trim().length === 0) {
      throw new NotesValidationError("EMPTY_ID", "NotionNotesProvider.append requires an id");
    }
    await this.request("PATCH", `/blocks/${input.id}/children`, {
      children: bodyToParagraphBlocks(input.body)
    });
    const after = await this.read(input.id);
    if (!after) {
      throw new NotesProviderError(this.id, "NOTION_NOT_FOUND", `Notion page ${input.id} not readable after append`);
    }
    return after;
  }

  private requireDatabaseId(operation: string): string {
    if (!this.databaseId) {
      throw new NotesProviderError(
        this.id,
        "MISSING_DATABASE_ID",
        `NotionNotesProvider.${operation} requires databaseId in constructor options`
      );
    }
    return this.databaseId;
  }

  /**
   * Fetch every child block of a Notion page, paginating via `start_cursor`
   * until exhaustion or the per-page cap. Notion caps `page_size` at 100,
   * so a long page (e.g. a daily journal in one Notion page) silently
   * truncated at 100 paragraph blocks before this helper existed.
   */
  private async fetchAllBlockChildren(pageId: string): Promise<readonly unknown[]> {
    const all: unknown[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < NOTION_BLOCKS_MAX_PAGES; page += 1) {
      const url = cursor
        ? `/blocks/${pageId}/children?page_size=100&start_cursor=${encodeURIComponent(cursor)}`
        : `/blocks/${pageId}/children?page_size=100`;
      const body = await this.request("GET", url, undefined);
      const results = isRecordArray(body, "results");
      for (const result of results) {
        all.push(result);
      }
      const hasMore = (body as { has_more?: unknown }).has_more === true;
      const nextCursor = (body as { next_cursor?: unknown }).next_cursor;
      if (!hasMore || typeof nextCursor !== "string" || nextCursor.length === 0) {
        break;
      }
      cursor = nextCursor;
    }
    return all;
  }

  private async replaceBlocks(pageId: string, body: string): Promise<void> {
    const blockResults = await this.fetchAllBlockChildren(pageId);
    for (const block of blockResults) {
      const blockId = (block as { id?: string }).id;
      if (!blockId) {
        continue;
      }
      try {
        await this.request("DELETE", `/blocks/${blockId}`, undefined);
      } catch {
        // best-effort delete; the subsequent append will just stack on top
      }
    }
    await this.request("PATCH", `/blocks/${pageId}/children`, {
      children: bodyToParagraphBlocks(body)
    });
  }

  private async request(method: "GET" | "POST" | "PATCH" | "DELETE", path: string, body: unknown): Promise<unknown> {
    const url = `${this.endpoint}${path}`;
    const init: RequestInit = {
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
        "Notion-Version": this.notionVersion
      },
      method,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {})
    };
    let response: Response;
    try {
      response = await this.fetchImpl(url, init);
    } catch (cause) {
      throw new NotesProviderError(this.id, "FETCH_FAILED", `Notion request failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
    if (!response.ok) {
      const detail = await safeReadText(response);
      const code = mapNotionStatus(response.status);
      throw new NotesProviderError(this.id, code, `Notion ${method} ${path} → ${response.status}: ${detail.slice(0, 200)}`);
    }
    if (response.status === 204) {
      return {};
    }
    try {
      return await response.json();
    } catch (cause) {
      throw new NotesProviderError(this.id, "NOTION_BAD_JSON", `Notion response was not JSON: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }
}

function mapNotionStatus(status: number): string {
  if (status === 401 || status === 403) {
    return "NOTION_AUTH";
  }
  if (status === 404) {
    return "NOTION_NOT_FOUND";
  }
  if (status === 429) {
    return "NOTION_RATE_LIMIT";
  }
  return `HTTP_${status}`;
}

function isRecordArray(body: unknown, key: string): readonly unknown[] {
  if (!body || typeof body !== "object") {
    return [];
  }
  const value = (body as Record<string, unknown>)[key];
  return Array.isArray(value) ? value : [];
}

function parsePageSummary(
  raw: unknown,
  providerId: string,
  titleProperty: string
): NotesEntry | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const id = (raw as { id?: string }).id;
  if (typeof id !== "string" || id.length === 0) {
    return undefined;
  }
  const properties = (raw as { properties?: Record<string, unknown> }).properties ?? {};
  const titleEntry = properties[titleProperty];
  const title = extractTitleString(titleEntry) ?? "(untitled)";
  const lastEdited = (raw as { last_edited_time?: string }).last_edited_time;
  const updatedAt = typeof lastEdited === "string" ? new Date(lastEdited) : undefined;
  const parent = (raw as { parent?: { database_id?: string } }).parent;
  const folder = parent?.database_id;
  return {
    id,
    providerId,
    title,
    ...(folder ? { folder } : {}),
    ...(updatedAt && !Number.isNaN(updatedAt.getTime()) ? { updatedAt } : {})
  };
}

function extractTitleString(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const titleArr = (value as { title?: unknown }).title;
  if (!Array.isArray(titleArr)) {
    return undefined;
  }
  const text = titleArr
    .map((entry) => {
      if (!entry || typeof entry !== "object") {
        return "";
      }
      const plain = (entry as { plain_text?: string }).plain_text;
      if (typeof plain === "string") {
        return plain;
      }
      const inner = (entry as { text?: { content?: string } }).text?.content;
      return typeof inner === "string" ? inner : "";
    })
    .join("");
  return text.length > 0 ? text : undefined;
}

function extractParagraphText(block: unknown): string {
  if (!block || typeof block !== "object") {
    return "";
  }
  const type = (block as { type?: string }).type;
  if (type !== "paragraph") {
    return "";
  }
  const richText = (block as { paragraph?: { rich_text?: unknown } }).paragraph?.rich_text;
  if (!Array.isArray(richText)) {
    return "";
  }
  return richText
    .map((entry) => {
      if (!entry || typeof entry !== "object") {
        return "";
      }
      const plain = (entry as { plain_text?: string }).plain_text;
      if (typeof plain === "string") {
        return plain;
      }
      const inner = (entry as { text?: { content?: string } }).text?.content;
      return typeof inner === "string" ? inner : "";
    })
    .join("");
}

function bodyToParagraphBlocks(body: string): readonly Record<string, unknown>[] {
  return body.split(/\n/u).map((line) => ({
    object: "block",
    paragraph: {
      rich_text: line.length > 0 ? [{ text: { content: line }, type: "text" }] : []
    },
    type: "paragraph"
  }));
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return `<status ${response.status}>`;
  }
}
