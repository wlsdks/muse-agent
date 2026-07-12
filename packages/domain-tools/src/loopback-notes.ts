import { Buffer } from "node:buffer";
import {
  appendFile as nodeAppendFile,
  mkdir as nodeMkdir,
  readFile as nodeReadFile,
  readdir as nodeReaddir,
  stat as nodeStat,
  unlink as nodeUnlink,
  writeFile as nodeWriteFile
} from "node:fs/promises";
import { resolve as nodePathResolve } from "node:path";

import { assertNoSecretInPersistedFields, type JsonObject, type JsonValue } from "@muse/shared";

import { readString } from "@muse/mcp";
import type { LoopbackMcpServer } from "@muse/mcp";
import {
  createNotesPathResolver,
  deriveMirrorNoteTitle,
  type NoteMirror,
  walkMarkdownFrom
} from "./loopback-notes-helpers.js";
import { runNotesLlmJudge } from "./loopback-notes-judge.js";
import { sliceWithoutLoneSurrogate } from "./notes-providers-local.js";
import type { ProactiveModelProviderLike } from "@muse/proactivity";

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
 *
 * The non-tool-definition helpers (path validation, markdown walk, mirror
 * title, LLM-judge search) live in `loopback-notes-helpers.ts` and
 * `loopback-notes-judge.ts`; `NoteMirror` + `deriveMirrorNoteTitle` are
 * re-exported below so this module's own public surface is unchanged.
 */

export type { NoteMirror };
export { deriveMirrorNoteTitle };

export interface NotesMcpServerOptions {
  readonly notesDir: string;
  readonly defaultSearchLimit?: number;
  readonly maxSearchLimit?: number;
  readonly maxQueryLength?: number;
  readonly maxFileBytes?: number;
  readonly maxListEntries?: number;
  /**
   * Optional model provider for the `search` tool's `mode: "llm-judge"`
   * path. When set with `model`, the search tool gains a paraphrase-
   * recall mode that asks the LLM to pick relevant note paths from
   * a list of (path, first-paragraph-preview) pairs. No vector index
   * needed — at personal scale (≤ a few hundred notes) one extra
   * round-trip is cheaper than running pgvector + embeddings.
   *
   * Two-step retrieval pattern: this tool returns paths; the LLM
   * then `muse.notes.read`s each chosen path for the full content.
   */
  readonly modelProvider?: ProactiveModelProviderLike;
  readonly model?: string;
  /** Cap on preview chars per note in the LLM-judge prompt. Default 200. */
  readonly judgePreviewChars?: number;
  /** Cap on notes considered in a single LLM-judge call. Default 200. */
  readonly judgeMaxCandidates?: number;
  /**
   * Existence probe for the `save` tool's pre-write check. Defaults to a
   * `stat`-based check. Injectable so a test can simulate the TOCTOU window
   * (probe says absent, then a concurrent create lands before the write) and
   * assert the atomic `wx` write refuses to clobber it.
   */
  readonly probeExists?: (absolutePath: string) => Promise<boolean>;
  /**
   * When set, a `save` that CREATES a new note (not an overwrite of an existing
   * one) also mirrors it into Apple Notes (injected — see {@link NoteMirror}).
   * Omitted ⇒ no mirror, behaviour unchanged. Create-only: append / delete /
   * overwrite-in-place never fire it.
   */
  readonly mirror?: NoteMirror;
}

export function createNotesMcpServer(options: NotesMcpServerOptions): LoopbackMcpServer {
  const root = nodePathResolve(options.notesDir);
  const defaultSearchLimit = Math.max(1, Math.trunc(options.defaultSearchLimit ?? 20));
  const maxSearchLimit = Math.max(defaultSearchLimit, Math.trunc(options.maxSearchLimit ?? 100));
  const maxQueryLength = Math.max(16, Math.trunc(options.maxQueryLength ?? 500));
  const maxFileBytes = Math.max(1_024, Math.trunc(options.maxFileBytes ?? 1_048_576));
  const maxListEntries = Math.max(1, Math.trunc(options.maxListEntries ?? 500));
  const probeExists =
    options.probeExists ??
    (async (absolutePath: string): Promise<boolean> => {
      try {
        await nodeStat(absolutePath);
        return true;
      } catch {
        return false;
      }
    });

  const resolveSafe = createNotesPathResolver(root);

  // Thin wrapper over the module-level walker that closes over the
  // server's `root` so callers don't need to keep passing it.
  async function walkMarkdown(dir: string, accept: (relPath: string) => void, visited: Set<string>): Promise<void> {
    await walkMarkdownFrom(root, dir, accept, visited);
  }

  return {
    description: "Personal markdown notes inside a sandboxed directory (loopback MCP).",
    name: "muse.notes",
    tools: [
      {
        description:
          "List entries inside the notes directory (or `subdir` relative to it). " +
          "Returns up to `maxListEntries` items with `name`, `isDirectory`, `sizeBytes` (files), and `modifiedAtIso`. " +
          "Pass `sort: 'recent'` to order newest-modified first — answers 'what did I note recently / my latest notes'. " +
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
            dirents = await nodeReaddir(safe.absolute, { withFileTypes: true });
          } catch (error) {
            return { error: `cannot list directory: ${error instanceof Error ? error.message : String(error)}` };
          }
          const collected: Array<{ row: JsonObject; mtimeMs: number }> = [];
          for (const entry of dirents) {
            if (entry.name.startsWith(".")) {
              continue;
            }
            const isDirectory = entry.isDirectory();
            const childAbs = nodePathResolve(safe.absolute, entry.name);
            let sizeBytes: number | undefined;
            let modifiedAtIso: string | undefined;
            let mtimeMs = 0;
            try {
              const stat = await nodeStat(childAbs);
              mtimeMs = stat.mtimeMs;
              modifiedAtIso = new Date(stat.mtimeMs).toISOString();
              if (!isDirectory) {
                sizeBytes = stat.size;
              }
            } catch {
              modifiedAtIso = undefined;
            }
            collected.push({
              mtimeMs,
              row: {
                isDirectory,
                name: entry.name,
                ...(sizeBytes !== undefined ? { sizeBytes } : {}),
                ...(modifiedAtIso ? { modifiedAtIso } : {})
              }
            });
          }
          if (readString(args, "sort") === "recent") {
            collected.sort((a, b) => b.mtimeMs - a.mtimeMs);
          }
          const truncated = collected.length > maxListEntries;
          return {
            dir: safe.relative,
            entries: collected.slice(0, maxListEntries).map((item) => item.row) as JsonValue,
            truncated
          } satisfies JsonObject;
        },
        inputSchema: {
          additionalProperties: false,
          properties: {
            sort: { description: "Order: omit for directory order, or 'recent' for newest-modified first (answers 'my recent notes').", enum: ["recent"], type: "string" },
            subdir: { description: "Subdirectory relative to the notes root. Defaults to the root.", type: "string" }
          },
          type: "object"
        },
        domain: "notes",
        name: "list",
        keywords: ["notes", "노트", "메모", "list", "목록"],
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
        domain: "notes",
        name: "read",
        keywords: ["notes", "노트", "메모", "read", "읽어"],
        risk: "read"
      },
      {
        description:
          "Search notes. `mode: 'substring'` (default) does case-insensitive grep across markdown files and " +
          `returns up to \`limit\` matches (default ${defaultSearchLimit}, max ${maxSearchLimit}) with path + line + snippet. ` +
          "`mode: 'llm-judge'` asks the model to pick the most relevant note paths from a list of (path, first-paragraph-preview) pairs — " +
          "useful for paraphrase queries (\"the Notion thing\" → matches a note tagged Notion); follow up with " +
          "`muse.notes.read` on each returned path. llm-judge mode requires modelProvider + model wired into createNotesMcpServer.",
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
          const mode = readString(args, "mode") === "llm-judge" ? "llm-judge" : "substring";

          if (mode === "llm-judge") {
            if (!options.modelProvider || !options.model) {
              return { error: "llm-judge mode requires modelProvider + model wired into createNotesMcpServer; re-run with mode: 'substring' or configure the provider" };
            }
            try {
              const judged = await runNotesLlmJudge({
                judgeMaxCandidates: Math.max(1, Math.trunc(options.judgeMaxCandidates ?? 200)),
                judgePreviewChars: Math.max(50, Math.trunc(options.judgePreviewChars ?? 200)),
                limit,
                maxFileBytes,
                model: options.model,
                modelProvider: options.modelProvider,
                query,
                root
              });
              return {
                matches: judged.paths.map((p) => ({ path: p })) as JsonValue,
                mode: "llm-judge",
                query,
                // Count only — non-zero means the model fabricated
                // paths. The path strings are untrusted; never echo.
                ...(judged.hallucinatedDropped > 0 ? { hallucinatedDropped: judged.hallucinatedDropped } : {})
              } satisfies JsonObject;
            } catch (cause) {
              return { error: `llm-judge failed: ${cause instanceof Error ? cause.message : String(cause)}` };
            }
          }

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
                  snippet: line.length > 240 ? `${sliceWithoutLoneSurrogate(line, 240)}...` : line
                });
                if (matches.length >= limit) {
                  break;
                }
              }
            }
          }
          return { matches: matches as JsonValue, mode: "substring" } satisfies JsonObject;
        },
        inputSchema: {
          additionalProperties: false,
          properties: {
            limit: {
              description: `Max matches (substring) or paths (llm-judge) to return. Defaults to ${defaultSearchLimit}; capped at ${maxSearchLimit}.`,
              type: "number"
            },
            mode: {
              description: "'substring' (default) for case-insensitive grep; 'llm-judge' for paraphrase-aware path selection by the model.",
              enum: ["substring", "llm-judge"],
              type: "string"
            },
            query: { description: "Substring (substring mode) or natural-language query (llm-judge mode).", type: "string" }
          },
          required: ["query"],
          type: "object"
        },
        domain: "notes",
        name: "search",
        keywords: ["notes", "노트", "메모", "search", "찾아", "검색"],
        risk: "read"
      },
      {
        description:
          "Write a markdown note to `path` relative to the notes directory. " +
          "Creates parent directories as needed. With `overwrite: false` (default), errors if the file exists; " +
          "with `overwrite: true`, replaces the file in place. Returns `{ path, sizeBytes, created }`. " +
          "Use when CREATING a new note or REPLACING a note's whole contents at a path ('save a note', '노트 새로 만들어 적어줘'). " +
          "NOT when adding a line to an EXISTING note (use muse.notes.append), nor for a to-do (use muse.tasks.add) " +
          "or a timed reminder (use muse.reminders.add) — a note is a markdown FILE, not a scheduled item.",
        execute: async (args): Promise<JsonObject> => {
          const path = readString(args, "path");
          const content = readString(args, "content");
          if (path === undefined) {
            return { error: "path is required" };
          }
          if (content === undefined) {
            return { error: "content is required" };
          }
          const guard = assertNoSecretInPersistedFields({ content });
          if (!guard.safe) {
            return { blocked: true, error: guard.notice, kinds: guard.kinds as JsonValue };
          }
          if (Buffer.byteLength(content, "utf8") > maxFileBytes) {
            return { error: `content exceeds maxFileBytes ${maxFileBytes}` };
          }
          const overwrite = args["overwrite"] === true;
          const safe = resolveSafe(path);
          if (typeof safe === "string") {
            return { error: safe };
          }
          const exists = await probeExists(safe.absolute);
          if (exists && !overwrite) {
            return { error: `note already exists at ${safe.relative}; pass overwrite: true to replace` };
          }
          const parent = nodePathResolve(safe.absolute, "..");
          try {
            await nodeMkdir(parent, { recursive: true });
            // Under !overwrite, write create-exclusive (`wx`): if the probe was
            // stale and a concurrent create landed in the TOCTOU window, the write
            // fails with EEXIST instead of clobbering it.
            await nodeWriteFile(safe.absolute, content, overwrite ? "utf8" : { encoding: "utf8", flag: "wx" });
          } catch (error) {
            if (!overwrite && (error as NodeJS.ErrnoException).code === "EEXIST") {
              return { error: `note already exists at ${safe.relative}; pass overwrite: true to replace` };
            }
            return { error: `cannot write note: ${error instanceof Error ? error.message : String(error)}` };
          }
          // Best-effort Apple-Notes mirror. Create-only: fires ONLY when this
          // write brought a NEW note file into being (`!exists`), never on an
          // overwrite-in-place (that is an edit, and the mirror is one-way). It
          // runs strictly after the note is persisted and can NEVER fail the
          // Muse write — a failure surfaces as a visible `mirrorNote`, nothing
          // more. The Muse-side file is already written and is left untouched.
          let mirrorNote: string | undefined;
          if (options.mirror && !exists) {
            try {
              const outcome = await options.mirror({ body: content, title: deriveMirrorNoteTitle(safe.relative, content) });
              if (outcome.warning) {
                mirrorNote = outcome.warning;
              }
            } catch (error) {
              mirrorNote = `Apple Notes mirror failed: ${error instanceof Error ? error.message : String(error)}`;
            }
          }
          return {
            created: !exists,
            path: safe.relative,
            sizeBytes: Buffer.byteLength(content, "utf8"),
            ...(mirrorNote ? { mirrorNote } : {})
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
        domain: "notes",
        name: "save",
        keywords: ["notes", "노트", "메모", "save", "저장", "적어"],
        risk: "write"
      },
      {
        description:
          "Append `content` to the END of a note at `path`. Creates the file (and parent directories) if missing. " +
          "Useful for daily journals, running task lists, append-only logs. " +
          "Use when ADDING to an EXISTING note ('append to my journal', '일지에 한 줄 덧붙여줘'). " +
          "NOT when creating or replacing a whole note (use muse.notes.save), nor for a to-do " +
          "(use muse.tasks.add) or a timed reminder (use muse.reminders.add).",
        execute: async (args): Promise<JsonObject> => {
          const path = readString(args, "path");
          const content = readString(args, "content");
          if (path === undefined) {
            return { error: "path is required" };
          }
          if (content === undefined) {
            return { error: "content is required" };
          }
          const guard = assertNoSecretInPersistedFields({ content });
          if (!guard.safe) {
            return { blocked: true, error: guard.notice, kinds: guard.kinds as JsonValue };
          }
          const safe = resolveSafe(path);
          if (typeof safe === "string") {
            return { error: safe };
          }
          // Check the RESULTING size BEFORE writing (current bytes + the new bytes),
          // so an append that would blow the cap mutates NOTHING — the oversized bytes
          // never hit disk (no partial side-effect). For a non-existent file the
          // current size is 0; both content and file are UTF-8 so the byte sum is exact.
          const appendBytes = Buffer.byteLength(content, "utf8");
          let currentBytes = 0;
          try {
            currentBytes = (await nodeStat(safe.absolute)).size;
          } catch {
            // the note doesn't exist yet → currentBytes stays 0 (the append creates it)
          }
          if (currentBytes + appendBytes > maxFileBytes) {
            return { error: `note would exceed maxFileBytes ${maxFileBytes} (current=${currentBytes}, append=${appendBytes})`, path: safe.relative };
          }
          const parent = nodePathResolve(safe.absolute, "..");
          try {
            await nodeMkdir(parent, { recursive: true });
            await nodeAppendFile(safe.absolute, content, "utf8");
          } catch (error) {
            return { error: `cannot append to note: ${error instanceof Error ? error.message : String(error)}` };
          }
          return { path: safe.relative, sizeBytes: currentBytes + appendBytes } satisfies JsonObject;
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
        domain: "notes",
        name: "append",
        keywords: ["notes", "노트", "메모", "append", "추가", "적어"],
        risk: "write"
      },
      {
        description:
          "Delete a note at `path`. Use to remove an outdated / wrong / no-longer-needed note so it stops surfacing in search and knowledge. Returns deleted:false when no note matches the path (not an error). Removes one file — not a directory.",
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
          } catch {
            return { deleted: false, path: safe.relative };
          }
          if (stat.isDirectory()) {
            return { error: "path is a directory, not a note file" };
          }
          try {
            await nodeUnlink(safe.absolute);
          } catch (error) {
            return { error: `cannot delete note: ${error instanceof Error ? error.message : String(error)}` };
          }
          return { deleted: true, path: safe.relative } satisfies JsonObject;
        },
        inputSchema: {
          additionalProperties: false,
          properties: {
            path: { description: "Note path relative to the notes directory, e.g. 'meeting-notes.md'.", type: "string" }
          },
          required: ["path"],
          type: "object"
        },
        domain: "notes",
        name: "delete",
        keywords: ["notes", "노트", "메모", "delete", "삭제", "지워"],
        risk: "write"
      }
    ]
  };
}

