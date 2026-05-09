import { Buffer } from "node:buffer";
import {
  appendFile as nodeAppendFile,
  mkdir as nodeMkdir,
  readFile as nodeReadFile,
  readdir as nodeReaddir,
  stat as nodeStat,
  writeFile as nodeWriteFile
} from "node:fs/promises";
import { resolve as nodePathResolve, sep as nodePathSep } from "node:path";

import type { JsonObject, JsonValue } from "@muse/shared";

import type { LoopbackMcpServer } from "./loopback.js";

/**
 * `muse.notes` loopback MCP server.
 *
 * Lifted out of `loopback.ts` (which had grown past 2,300 LOC) to
 * keep the notes-specific path-resolution and markdown-walk helpers
 * close to the tool definitions that use them. Same public surface
 * as before: `NotesMcpServerOptions` + `createNotesMcpServer`. Both
 * symbols are re-exported from `loopback.ts` so consumers
 * (`packages/mcp/src/index.ts`, the autoconfigure entry point, and
 * the existing tests) keep working without import-site edits.
 */

export interface NotesMcpServerOptions {
  readonly notesDir: string;
  readonly defaultSearchLimit?: number;
  readonly maxSearchLimit?: number;
  readonly maxQueryLength?: number;
  readonly maxFileBytes?: number;
  readonly maxListEntries?: number;
}

interface NotesPathSafe {
  readonly absolute: string;
  readonly relative: string;
}

function readString(args: JsonObject, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" ? value : undefined;
}

export function createNotesMcpServer(options: NotesMcpServerOptions): LoopbackMcpServer {
  const root = nodePathResolve(options.notesDir);
  const defaultSearchLimit = Math.max(1, Math.trunc(options.defaultSearchLimit ?? 20));
  const maxSearchLimit = Math.max(defaultSearchLimit, Math.trunc(options.maxSearchLimit ?? 100));
  const maxQueryLength = Math.max(16, Math.trunc(options.maxQueryLength ?? 500));
  const maxFileBytes = Math.max(1_024, Math.trunc(options.maxFileBytes ?? 1_048_576));
  const maxListEntries = Math.max(1, Math.trunc(options.maxListEntries ?? 500));

  function resolveSafe(input: string): NotesPathSafe | string {
    const trimmed = input.trim();
    if (trimmed.length === 0) {
      return "path must not be empty";
    }
    if (trimmed.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(trimmed)) {
      return "path must be relative to the notes directory";
    }
    const absolute = nodePathResolve(root, trimmed);
    if (absolute !== root && !absolute.startsWith(root + nodePathSep)) {
      return "path escapes the notes directory";
    }
    const relative = absolute === root ? "" : absolute.slice(root.length + 1);
    return { absolute, relative };
  }

  async function walkMarkdown(dir: string, accept: (relPath: string) => void, visited: Set<string>): Promise<void> {
    if (visited.has(dir)) {
      return;
    }
    visited.add(dir);
    let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
    try {
      entries = (await nodeReaddir(dir, { withFileTypes: true })) as unknown as Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) {
        continue;
      }
      const childAbs = nodePathResolve(dir, entry.name);
      if (entry.isDirectory()) {
        await walkMarkdown(childAbs, accept, visited);
      } else if (entry.isFile() && /\.(md|markdown|txt)$/iu.test(entry.name)) {
        accept(childAbs.slice(root.length + 1));
      }
    }
  }

  return {
    description: "Personal markdown notes inside a sandboxed directory (loopback MCP).",
    name: "muse.notes",
    tools: [
      {
        description:
          "List entries inside the notes directory (or `subdir` relative to it). " +
          "Returns up to `maxListEntries` items with `name`, `isDirectory`, and `sizeBytes` for files. " +
          "Hidden entries (dotfiles) are skipped. Non-recursive — pass deeper subdirs explicitly.",
        execute: async (args): Promise<JsonObject> => {
          const subdirInput = readString(args, "subdir");
          const target = subdirInput && subdirInput.trim().length > 0 ? subdirInput : "";
          const safe = target.length === 0 ? { absolute: root, relative: "" } : resolveSafe(target);
          if (typeof safe === "string") {
            return { error: safe };
          }
          let dirents: Array<{ name: string; isDirectory(): boolean }>;
          try {
            dirents = (await nodeReaddir(safe.absolute, { withFileTypes: true })) as unknown as Array<{ name: string; isDirectory(): boolean }>;
          } catch (error) {
            return { error: `cannot list directory: ${error instanceof Error ? error.message : String(error)}` };
          }
          const entries: JsonObject[] = [];
          for (const entry of dirents) {
            if (entry.name.startsWith(".")) {
              continue;
            }
            if (entries.length >= maxListEntries) {
              break;
            }
            const isDirectory = entry.isDirectory();
            const childAbs = nodePathResolve(safe.absolute, entry.name);
            let sizeBytes: number | undefined;
            if (!isDirectory) {
              try {
                const stat = await nodeStat(childAbs);
                sizeBytes = stat.size;
              } catch {
                sizeBytes = undefined;
              }
            }
            entries.push({
              isDirectory,
              name: entry.name,
              ...(sizeBytes !== undefined ? { sizeBytes } : {})
            });
          }
          return {
            dir: safe.relative,
            entries: entries as JsonValue,
            truncated: entries.length >= maxListEntries
          } satisfies JsonObject;
        },
        inputSchema: {
          additionalProperties: false,
          properties: {
            subdir: { description: "Subdirectory relative to the notes root. Defaults to the root.", type: "string" }
          },
          type: "object"
        },
        name: "list",
        risk: "read"
      },
      {
        description: "Read a markdown / text note as UTF-8. Bounded at `maxFileBytes`; returns an error for binary or oversized files.",
        execute: async (args): Promise<JsonObject> => {
          const path = readString(args, "path");
          if (path === undefined) {
            return { error: "path is required" };
          }
          const safe = resolveSafe(path);
          if (typeof safe === "string") {
            return { error: safe };
          }
          let stat: Awaited<ReturnType<typeof nodeStat>>;
          try {
            stat = await nodeStat(safe.absolute);
          } catch (error) {
            return { error: `cannot read note: ${error instanceof Error ? error.message : String(error)}` };
          }
          if (stat.isDirectory()) {
            return { error: "path is a directory, not a file" };
          }
          if (stat.size > maxFileBytes) {
            return { error: `file is ${stat.size} bytes, exceeds maxFileBytes ${maxFileBytes}` };
          }
          let content: string;
          try {
            content = await nodeReadFile(safe.absolute, "utf8");
          } catch (error) {
            return { error: `cannot read note: ${error instanceof Error ? error.message : String(error)}` };
          }
          return { content, path: safe.relative, sizeBytes: stat.size } satisfies JsonObject;
        },
        inputSchema: {
          additionalProperties: false,
          properties: {
            path: { description: "Note path relative to the notes directory (e.g. `daily/2026-05-09.md`).", type: "string" }
          },
          required: ["path"],
          type: "object"
        },
        name: "read",
        risk: "read"
      },
      {
        description:
          "Case-insensitive substring search across markdown / text files in the notes directory. " +
          `Returns up to \`limit\` matches (default ${defaultSearchLimit}, max ${maxSearchLimit}) with file path, ` +
          "1-based line number, and the matching line text. Skips hidden files and binary extensions.",
        execute: async (args): Promise<JsonObject> => {
          const query = readString(args, "query")?.trim();
          if (!query) {
            return { error: "query is required" };
          }
          if (query.length > maxQueryLength) {
            return { error: `query must be at most ${maxQueryLength} characters` };
          }
          const limitArg = args["limit"];
          const limit = typeof limitArg === "number" && Number.isFinite(limitArg)
            ? Math.max(1, Math.min(maxSearchLimit, Math.trunc(limitArg)))
            : defaultSearchLimit;
          const needle = query.toLowerCase();
          const files: string[] = [];
          await walkMarkdown(root, (rel) => { files.push(rel); }, new Set());
          const matches: JsonObject[] = [];
          for (const rel of files) {
            if (matches.length >= limit) {
              break;
            }
            const abs = nodePathResolve(root, rel);
            let stat: Awaited<ReturnType<typeof nodeStat>>;
            try {
              stat = await nodeStat(abs);
            } catch {
              continue;
            }
            if (stat.size > maxFileBytes) {
              continue;
            }
            let body: string;
            try {
              body = await nodeReadFile(abs, "utf8");
            } catch {
              continue;
            }
            const lines = body.split(/\r?\n/u);
            for (let index = 0; index < lines.length; index += 1) {
              const line = lines[index] ?? "";
              if (line.toLowerCase().includes(needle)) {
                matches.push({
                  line: index + 1,
                  path: rel,
                  snippet: line.length > 240 ? `${line.slice(0, 240)}...` : line
                });
                if (matches.length >= limit) {
                  break;
                }
              }
            }
          }
          return { matches: matches as JsonValue } satisfies JsonObject;
        },
        inputSchema: {
          additionalProperties: false,
          properties: {
            limit: {
              description: `Max matches to return. Defaults to ${defaultSearchLimit}; capped at ${maxSearchLimit}.`,
              type: "number"
            },
            query: { description: "Substring to grep for (case-insensitive).", type: "string" }
          },
          required: ["query"],
          type: "object"
        },
        name: "search",
        risk: "read"
      },
      {
        description:
          "Write a markdown note to `path` relative to the notes directory. " +
          "Creates parent directories as needed. With `overwrite: false` (default), errors if the file exists; " +
          "with `overwrite: true`, replaces the file in place. Returns `{ path, sizeBytes, created }`.",
        execute: async (args): Promise<JsonObject> => {
          const path = readString(args, "path");
          const content = readString(args, "content");
          if (path === undefined) {
            return { error: "path is required" };
          }
          if (content === undefined) {
            return { error: "content is required" };
          }
          if (Buffer.byteLength(content, "utf8") > maxFileBytes) {
            return { error: `content exceeds maxFileBytes ${maxFileBytes}` };
          }
          const overwrite = args["overwrite"] === true;
          const safe = resolveSafe(path);
          if (typeof safe === "string") {
            return { error: safe };
          }
          let exists = false;
          try {
            await nodeStat(safe.absolute);
            exists = true;
          } catch {
            exists = false;
          }
          if (exists && !overwrite) {
            return { error: `note already exists at ${safe.relative}; pass overwrite: true to replace` };
          }
          const parent = nodePathResolve(safe.absolute, "..");
          try {
            await nodeMkdir(parent, { recursive: true });
            await nodeWriteFile(safe.absolute, content, "utf8");
          } catch (error) {
            return { error: `cannot write note: ${error instanceof Error ? error.message : String(error)}` };
          }
          return {
            created: !exists,
            path: safe.relative,
            sizeBytes: Buffer.byteLength(content, "utf8")
          } satisfies JsonObject;
        },
        inputSchema: {
          additionalProperties: false,
          properties: {
            content: { description: "UTF-8 file contents.", type: "string" },
            overwrite: { description: "If true, replace an existing file. Defaults to false.", type: "boolean" },
            path: { description: "Note path relative to the notes directory.", type: "string" }
          },
          required: ["content", "path"],
          type: "object"
        },
        name: "save",
        risk: "write"
      },
      {
        description:
          "Append `content` to a note at `path`. Creates the file (and parent directories) if missing. " +
          "Useful for daily journals, running task lists, append-only logs.",
        execute: async (args): Promise<JsonObject> => {
          const path = readString(args, "path");
          const content = readString(args, "content");
          if (path === undefined) {
            return { error: "path is required" };
          }
          if (content === undefined) {
            return { error: "content is required" };
          }
          const safe = resolveSafe(path);
          if (typeof safe === "string") {
            return { error: safe };
          }
          const parent = nodePathResolve(safe.absolute, "..");
          try {
            await nodeMkdir(parent, { recursive: true });
            await nodeAppendFile(safe.absolute, content, "utf8");
          } catch (error) {
            return { error: `cannot append to note: ${error instanceof Error ? error.message : String(error)}` };
          }
          let stat: Awaited<ReturnType<typeof nodeStat>>;
          try {
            stat = await nodeStat(safe.absolute);
          } catch {
            return { path: safe.relative };
          }
          if (stat.size > maxFileBytes) {
            return { error: `note exceeds maxFileBytes ${maxFileBytes} after append (size=${stat.size})`, path: safe.relative, sizeBytes: stat.size };
          }
          return { path: safe.relative, sizeBytes: stat.size } satisfies JsonObject;
        },
        inputSchema: {
          additionalProperties: false,
          properties: {
            content: { description: "UTF-8 text to append.", type: "string" },
            path: { description: "Note path relative to the notes directory.", type: "string" }
          },
          required: ["content", "path"],
          type: "object"
        },
        name: "append",
        risk: "write"
      }
    ]
  };
}
