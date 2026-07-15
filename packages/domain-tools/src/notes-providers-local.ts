/**
 * Filesystem-backed notes provider.
 *
 * Each upstream adapter (Local, Notion, Apple) lives in its own
 * file. The shared abstraction layer — `NotesProvider` interface,
 * `NotesValidationError`, `NotesProviderError`, and the common
 * payload types — stays in `notes-providers.ts`.
 *
 * Stores notes as `.md` / `.markdown` / `.txt` files inside
 * `notesDir`. Same sandbox + path-safety semantics as the inline
 * implementation in `createNotesMcpServer`:
 *
 *   - Paths are resolved relative to `notesDir`. Any path that
 *     escapes the sandbox (`..`, absolute paths outside the dir,
 *     symlink traversals) is rejected with NotesValidationError.
 *   - `id` is the relative path within the sandbox, including the
 *     extension.
 *   - `search` returns line-level hits with 1-based line numbers,
 *     matching the loopback server contract.
 */

import { Buffer } from "node:buffer";
import { resolve as resolveNativePath, sep as nativeSep } from "node:path";

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

export interface LocalDirNotesProviderOptions {
  readonly notesDir: string;
  readonly maxFileBytes?: number;
  readonly maxListEntries?: number;
}

export class LocalDirNotesProvider implements NotesProvider {
  readonly id = "local";
  private readonly notesDir: string;
  private readonly maxFileBytes: number;
  private readonly maxListEntries: number;

  constructor(options: LocalDirNotesProviderOptions) {
    // Normalize once: a mixed-separator or trailing-sep notesDir would defeat
    // the prefix containment check in resolveSafe on win32.
    this.notesDir = resolveNativePath(options.notesDir);
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

  async delete(id: string): Promise<boolean> {
    const { promises: fs } = await import("node:fs");
    const { resolve, sep } = await import("node:path");
    const safe = this.resolveSafe(id, resolve, sep);
    if (typeof safe === "string") {
      throw new NotesValidationError("INVALID_PATH", safe);
    }
    let stat: { isDirectory(): boolean };
    try {
      stat = await fs.stat(safe.absolute);
    } catch {
      return false;
    }
    if (stat.isDirectory()) {
      throw new NotesValidationError("PATH_IS_DIRECTORY", "path is a directory, not a file");
    }
    await fs.unlink(safe.absolute);
    return true;
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
            snippet: line.length > 240 ? `${sliceWithoutLoneSurrogate(line, 240)}...` : line,
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
    let exists: boolean;
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
    // Note ids are portable: always forward-slash, whatever the OS separator.
    const relative = absolute === this.notesDir ? "" : absolute.slice(this.notesDir.length + 1).split(sep).join("/");
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
        accept(childAbs.slice(this.notesDir.length + 1).split(nativeSep).join("/"));
      }
    }
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}

export function sliceWithoutLoneSurrogate(value: string, cap: number): string {
  const head = value.slice(0, cap);
  if (head.length === 0) return head;
  const last = head.charCodeAt(head.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? head.slice(0, -1) : head;
}
