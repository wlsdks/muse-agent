import { lstat as nodeLstat,
  readFile as nodeReadFile,
  readdir as nodeReaddir,
  realpath as nodeRealpath,
  stat as nodeStat
} from "node:fs/promises";
import { resolve as nodePathResolve, sep as nodePathSep } from "node:path";
import type { Buffer } from "node:buffer";

import type { JsonObject, JsonValue } from "@muse/shared";
import { errorMessage } from "@muse/shared";

import { readString } from "@muse/mcp";
import type { LoopbackMcpServer } from "@muse/mcp";

const DEFAULT_MAX_BODY_BYTES = 65_536;
const DEFAULT_MAX_LIST_ENTRIES = 256;

/**
 * `muse.fs` loopback MCP server — bounded filesystem reader.
 *
 * Lifted out of `loopback.ts` to keep the path-allowlist policy and
 * the small fs/path injection seams co-located. Same public surface
 * as before: `FilesystemMcpServerOptions` + `createFilesystemMcpServer`.
 * Re-exported from `loopback.ts` so the `@muse/mcp` barrel and
 * existing tests stay byte-identical without import-site edits.
 */

export interface FilesystemMcpServerOptions {
  /**
   * Absolute paths the filesystem reader is permitted to access. Empty by
   * default — opt-in required. Each root is resolved to an absolute path; a
   * call is allowed only when the requested path resolves to the root itself
   * or a descendant (with a path-separator boundary, so "/etc" never matches
   * "/etc-passwd").
   */
  readonly allowedRoots: readonly string[];
  /** Cap on bytes returned by `read`. Default 65,536 (64KB). */
  readonly maxBodyBytes?: number;
  /** Cap on entries returned by `list`. Default 256. */
  readonly maxListEntries?: number;
  /** Optional fs override (used in tests). Must implement readFile/readdir/stat with the node:fs/promises shape. Provide realpath to enable symlink-escape detection; omitting it disables the realpath guard (use only in tests that have no symlinks). */
  readonly fs?: {
    readFile(path: string): Promise<Buffer>;
    readdir(path: string, options: { withFileTypes: true }): Promise<readonly { name: string; isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean }[]>;
    stat(path: string): Promise<{ size: number; mtime: Date; isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean }>;
    /** Like `stat` but does NOT follow a symlink — lets `stat` honor its "symlinks reported as kind=symlink without following" contract. Falls back to `stat` when absent. */
    lstat?(path: string): Promise<{ size: number; mtime: Date; isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean }>;
    realpath?(path: string): Promise<string>;
  };
  /** Optional path module override (used in tests). */
  readonly path?: { resolve(...segments: string[]): string; sep: string };
}

/** Invalid runtime caps retain the bounded filesystem-reader defaults. */
export function normalizeFilesystemBodyBytes(value: number | undefined): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : DEFAULT_MAX_BODY_BYTES;
}

/** Invalid runtime caps retain the bounded directory-listing default. */
export function normalizeFilesystemListEntries(value: number | undefined): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : DEFAULT_MAX_LIST_ENTRIES;
}

/**
 * Trim a UTF-8 buffer to at most `maxBytes` WITHOUT splitting a multi-byte
 * character. A raw `subarray(0, maxBytes).toString("utf8")` emits U+FFFD at the
 * cut whenever `maxBytes` lands inside a code point (e.g. a 3-byte Korean
 * syllable — ~2/3 of the time for Korean text), corrupting the truncation tail.
 * Back the end off to the previous character boundary; the result is ≤ maxBytes
 * (the cap is a maximum) and decodes cleanly.
 */
export function utf8SafeSliceEnd(buffer: Buffer, maxBytes: number): Buffer {
  if (maxBytes <= 0) return buffer.subarray(0, 0);
  if (buffer.byteLength <= maxBytes) return buffer;
  let end = maxBytes;
  // A UTF-8 continuation byte is 10xxxxxx. While the FIRST excluded byte is a
  // continuation byte we're mid-character — walk the cut back to its lead byte.
  while (end > 0) {
    const b = buffer[end];
    if (b === undefined || (b & 0xc0) !== 0x80) break;
    end -= 1;
  }
  return buffer.subarray(0, end);
}

/**
 * Reference loopback server: bounded filesystem reader. Opt-in,
 * allowlist-rooted, body-capped, read-only. Lets Muse inspect files inside
 * an operator-defined workspace without giving it free disk access.
 *
 * NOT included in `createDefaultLoopbackMcpServers` — operators who want
 * filesystem access must construct it explicitly with the roots they trust.
 */
export function createFilesystemMcpServer(options: FilesystemMcpServerOptions): LoopbackMcpServer {
  const pathLib = options.path ?? { resolve: nodePathResolve, sep: nodePathSep };
  const fsLib: NonNullable<FilesystemMcpServerOptions["fs"]> = options.fs ?? {
    readFile: (path) => nodeReadFile(path),
    readdir: (path, opts) => nodeReaddir(path, opts) as ReturnType<NonNullable<FilesystemMcpServerOptions["fs"]>["readdir"]>,
    lstat: (path) => nodeLstat(path),
    realpath: (path) => nodeRealpath(path),
    stat: (path) => nodeStat(path)
  };
  const maxBodyBytes = normalizeFilesystemBodyBytes(options.maxBodyBytes);
  const maxListEntries = normalizeFilesystemListEntries(options.maxListEntries);
  const roots = options.allowedRoots.map((root) => pathLib.resolve(root));

  async function checkAllowed(rawPath: string): Promise<{ readonly allowed: true; readonly resolved: string } | { readonly allowed: false; readonly error: string }> {
    if (typeof rawPath !== "string" || rawPath.length === 0) {
      return { allowed: false, error: "path is required" };
    }
    const resolved = pathLib.resolve(rawPath);
    const lexicallyAllowed = roots.some((root) => resolved === root || resolved.startsWith(`${root}${pathLib.sep}`));
    if (!lexicallyAllowed) {
      return { allowed: false, error: `path '${rawPath}' is not under any configured allowlist root` };
    }
    if (fsLib.realpath !== undefined) {
      let real: string;
      try {
        real = await fsLib.realpath(resolved);
      } catch {
        return { allowed: false, error: `path '${rawPath}' could not be resolved (dangling symlink or missing path)` };
      }
      const realRoots = await Promise.all(
        roots.map(async (root) => {
          try {
            return fsLib.realpath !== undefined ? await fsLib.realpath(root) : root;
          } catch {
            return root;
          }
        })
      );
      const realAllowed = realRoots.some((root) => real === root || real.startsWith(`${root}${pathLib.sep}`));
      if (!realAllowed) {
        return { allowed: false, error: `path '${rawPath}' resolves outside the configured allowlist roots (symlink escape)` };
      }
    }
    return { allowed: true, resolved };
  }

  function entryKind(entry: { isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean }): "directory" | "file" | "symlink" | "other" {
    if (entry.isDirectory()) {
      return "directory";
    }
    if (entry.isFile()) {
      return "file";
    }
    if (entry.isSymbolicLink()) {
      return "symlink";
    }
    return "other";
  }

  return {
    description: "Built-in filesystem reader (loopback MCP, allowlist-rooted, read-only).",
    name: "muse.fs",
    tools: [
      {
        description:
          "Reads a UTF-8 text file inside the configured allowlist and returns { content, bytes, truncated }. Output is truncated at maxBodyBytes (default 64KB). Binary files may produce replacement characters.",
        execute: async (args): Promise<JsonObject> => {
          const decision = await checkAllowed(readString(args, "path") ?? "");
          if (!decision.allowed) {
            return { error: decision.error };
          }
          try {
            const buffer = await fsLib.readFile(decision.resolved);
            const truncated = buffer.byteLength > maxBodyBytes;
            const slice = truncated ? utf8SafeSliceEnd(buffer, maxBodyBytes) : buffer;
            return {
              bytes: buffer.byteLength,
              content: slice.toString("utf8"),
              truncated
            } satisfies JsonObject;
          } catch (error) {
            return { error: `read failed: ${errorMessage(error)}` };
          }
        },
        inputSchema: {
          additionalProperties: false,
          properties: { path: { type: "string" } },
          required: ["path"],
          type: "object"
        },
        name: "read",
        risk: "read"
      },
      {
        description:
          "Lists the immediate entries of a directory inside the configured allowlist. Returns { entries: [{ name, kind }] } where kind is directory|file|symlink|other. Capped at maxListEntries (default 256).",
        execute: async (args): Promise<JsonObject> => {
          const decision = await checkAllowed(readString(args, "path") ?? "");
          if (!decision.allowed) {
            return { error: decision.error };
          }
          try {
            const dirents = await fsLib.readdir(decision.resolved, { withFileTypes: true });
            const truncated = dirents.length > maxListEntries;
            const limited = truncated ? dirents.slice(0, maxListEntries) : dirents;
            return {
              entries: limited.map((entry) => ({ kind: entryKind(entry), name: entry.name })) as JsonValue,
              total: dirents.length,
              truncated
            } satisfies JsonObject;
          } catch (error) {
            return { error: `list failed: ${errorMessage(error)}` };
          }
        },
        inputSchema: {
          additionalProperties: false,
          properties: { path: { type: "string" } },
          required: ["path"],
          type: "object"
        },
        name: "list",
        risk: "read"
      },
      {
        description:
          "Returns metadata for a path inside the configured allowlist: { kind, size, mtime }. mtime is an ISO-8601 string. Symlinks are reported as kind=symlink without following.",
        execute: async (args): Promise<JsonObject> => {
          const decision = await checkAllowed(readString(args, "path") ?? "");
          if (!decision.allowed) {
            return { error: decision.error };
          }
          try {
            // lstat (not stat) so a symlink is reported as kind=symlink, NOT silently
            // followed to its target's kind — the documented contract. Falls back to
            // stat for a test fs seam that doesn't implement lstat.
            const stats = await (fsLib.lstat ?? fsLib.stat)(decision.resolved);
            return {
              kind: entryKind(stats),
              mtime: stats.mtime.toISOString(),
              size: stats.size
            } satisfies JsonObject;
          } catch (error) {
            return { error: `stat failed: ${errorMessage(error)}` };
          }
        },
        inputSchema: {
          additionalProperties: false,
          properties: { path: { type: "string" } },
          required: ["path"],
          type: "object"
        },
        name: "stat",
        risk: "read"
      }
    ]
  };
}
