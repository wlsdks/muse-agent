import { createHash } from "node:crypto";
import { constants as fsConstants, promises as fs } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

import {
  NOTES_CHUNKER_VERSION,
  NOTES_INDEX_SCHEMA_VERSION,
  type NoteSourceIndexViewV1
} from "@muse/recall";

import type { NoteRelationsPathSnapshot } from "./note-relations-store.js";

const MAX_INDEX_BYTES = 64 * 1_024 * 1_024;
const MAX_SOURCE_BYTES = 4 * 1_024 * 1_024;
const MAX_FILES = 4_096;
const MAX_CHUNKS_PER_FILE = 4_096;
const MAX_TOTAL_CHUNKS = 65_536;
const SHA256_RE = /^[0-9a-f]{64}$/u;
const TEXT_NOTE_PATH_RE = /\.(?:md|markdown|mkd|mdown|mdx|txt|text|org|rst|adoc|asciidoc)$/iu;
const FATAL_UTF8 = new TextDecoder("utf-8", { fatal: true });

export type NoteRelationsContextErrorCode = "INDEX_MISSING" | "INDEX_UNSAFE" | "INDEX_CORRUPT";

export class NoteRelationsContextError extends Error {
  readonly code: NoteRelationsContextErrorCode;

  constructor(code: NoteRelationsContextErrorCode) {
    super("Note relation source context is unavailable.");
    this.name = "NoteRelationsContextError";
    this.code = code;
    this.stack = `${this.name}: ${this.message}`;
  }
}

interface BoundedIndexChunk {
  readonly chunkIndex: number;
  readonly text: string;
}

export interface BoundedNotesIndexEntry {
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly sourceHash?: string;
  readonly chunkerVersion?: typeof NOTES_CHUNKER_VERSION;
  readonly chunks: readonly BoundedIndexChunk[];
}

export interface BoundedNotesIndexSnapshot {
  readonly rawDigest: string;
  readonly notesRoot: string;
  readonly notesRootIdentity: Readonly<{ dev: number; ino: number; uid: number; realpath: string }>;
  readonly entries: readonly BoundedNotesIndexEntry[];
}

export type IndexedNoteSourceResult =
  | {
      readonly status: "resolved";
      readonly sourceBytes: Uint8Array;
      readonly sourceIdentity: Readonly<{ dev: number; ino: number; uid: number; size: number; mtimeMs: number }>;
      readonly sourceIndex: NoteSourceIndexViewV1;
    }
  | {
      readonly status: "unavailable";
      readonly reason: "not_indexed" | "legacy_or_pdf" | "stale_source" | "unsafe_source" | "invalid_index";
    };

function exactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function owned(stats: Awaited<ReturnType<typeof fs.lstat>>): boolean {
  const uid = process.getuid?.();
  return uid === undefined || Number(stats.uid) === uid;
}

interface VerifiedFileRead {
  readonly bytes: Uint8Array;
  readonly identity: Readonly<{ dev: number; ino: number; uid: number; size: number; mtimeMs: number }>;
}

async function readAtMost(handle: Awaited<ReturnType<typeof fs.open>>, maxBytes: number): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let total = 0;
  while (total <= maxBytes) {
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1_024, maxBytes + 1 - total));
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, null);
    if (bytesRead === 0) break;
    chunks.push(buffer.subarray(0, bytesRead));
    total += bytesRead;
  }
  return new Uint8Array(Buffer.concat(chunks, total));
}

async function readBoundedRegularFile(
  path: string,
  maxBytes: number,
  code: NoteRelationsContextErrorCode,
  beforeRead?: () => void | Promise<void>
): Promise<VerifiedFileRead> {
  let before: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    before = await fs.lstat(path);
  } catch (cause) {
    throw new NoteRelationsContextError((cause as NodeJS.ErrnoException).code === "ENOENT" ? "INDEX_MISSING" : code);
  }
  if (!before.isFile() || before.isSymbolicLink() || !owned(before) || Number(before.size) > maxBytes) {
    throw new NoteRelationsContextError(code);
  }
  let handle: Awaited<ReturnType<typeof fs.open>>;
  try {
    handle = await fs.open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  } catch {
    throw new NoteRelationsContextError(code);
  }
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || !owned(opened as Awaited<ReturnType<typeof fs.lstat>>)
      || opened.dev !== before.dev || opened.ino !== before.ino || Number(opened.size) > maxBytes) {
      throw new NoteRelationsContextError(code);
    }
    await beforeRead?.();
    const bytes = await readAtMost(handle, maxBytes);
    if (bytes.byteLength > maxBytes) throw new NoteRelationsContextError(code);
    const after = await handle.stat();
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) {
      throw new NoteRelationsContextError(code);
    }
    return Object.freeze({
      bytes: new Uint8Array(bytes),
      identity: Object.freeze({
        dev: Number(opened.dev), ino: Number(opened.ino), uid: Number(opened.uid),
        size: Number(opened.size), mtimeMs: opened.mtimeMs
      })
    });
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function canonicalRelative(root: string, candidate: string): string | undefined {
  if (!isAbsolute(candidate)) return undefined;
  const rel = relative(root, resolve(candidate));
  if (rel.length === 0 || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return undefined;
  const canonical = rel.split(sep).join("/");
  if (canonical.includes("\\") || canonical.split("/").some((part) => part.length === 0 || part === "." || part === "..")) return undefined;
  return canonical;
}

export async function loadBoundedNotesIndex(paths: NoteRelationsPathSnapshot): Promise<BoundedNotesIndexSnapshot> {
  let rootStats: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    rootStats = await fs.lstat(paths.notesDir);
  } catch {
    throw new NoteRelationsContextError("INDEX_UNSAFE");
  }
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink() || !owned(rootStats)) {
    throw new NoteRelationsContextError("INDEX_UNSAFE");
  }
  const rootHandle = await fs.open(paths.notesDir, fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0) | (fsConstants.O_NOFOLLOW ?? 0)).catch(() => {
    throw new NoteRelationsContextError("INDEX_UNSAFE");
  });
  let notesRootRealpath: string;
  try {
    const opened = await rootHandle.stat();
    if (!opened.isDirectory() || opened.dev !== rootStats.dev || opened.ino !== rootStats.ino) {
      throw new NoteRelationsContextError("INDEX_UNSAFE");
    }
    notesRootRealpath = await fs.realpath(paths.notesDir);
  } finally {
    await rootHandle.close().catch(() => undefined);
  }

  const indexRead = await readBoundedRegularFile(paths.notesIndexFile, MAX_INDEX_BYTES, "INDEX_UNSAFE");
  const bytes = indexRead.bytes;
  let parsed: unknown;
  try {
    parsed = JSON.parse(FATAL_UTF8.decode(bytes)) as unknown;
  } catch {
    throw new NoteRelationsContextError("INDEX_CORRUPT");
  }
  if (!exactObject(parsed, ["version", "model", "builtAtIso", "embeddingCount", "embeddingDim", "files"])
    || parsed.version !== NOTES_INDEX_SCHEMA_VERSION
    || typeof parsed.model !== "string"
    || typeof parsed.builtAtIso !== "string"
    || !Number.isSafeInteger(parsed.embeddingCount) || (parsed.embeddingCount as number) < 0
    || !Number.isSafeInteger(parsed.embeddingDim) || (parsed.embeddingDim as number) < 0
    || !Array.isArray(parsed.files) || parsed.files.length > MAX_FILES) {
    throw new NoteRelationsContextError("INDEX_CORRUPT");
  }
  const entries: BoundedNotesIndexEntry[] = [];
  const relativePaths = new Set<string>();
  let totalChunks = 0;
  for (const rawFile of parsed.files) {
    const legacyKeys = ["path", "mtimeMs", "chunks"];
    const currentKeys = ["path", "mtimeMs", "sourceHash", "chunkerVersion", "chunks"];
    if ((!exactObject(rawFile, legacyKeys) && !exactObject(rawFile, currentKeys))
      || typeof rawFile.path !== "string" || typeof rawFile.mtimeMs !== "number" || !Number.isFinite(rawFile.mtimeMs)
      || !Array.isArray(rawFile.chunks) || rawFile.chunks.length > MAX_CHUNKS_PER_FILE) {
      throw new NoteRelationsContextError("INDEX_CORRUPT");
    }
    const relativePath = canonicalRelative(resolve(paths.notesDir), rawFile.path);
    if (!relativePath || relativePaths.has(relativePath)) throw new NoteRelationsContextError("INDEX_CORRUPT");
    relativePaths.add(relativePath);
    const current = Object.hasOwn(rawFile, "sourceHash") || Object.hasOwn(rawFile, "chunkerVersion");
    if (current && (typeof rawFile.sourceHash !== "string" || !SHA256_RE.test(rawFile.sourceHash)
      || rawFile.chunkerVersion !== NOTES_CHUNKER_VERSION)) {
      throw new NoteRelationsContextError("INDEX_CORRUPT");
    }
    const chunks: BoundedIndexChunk[] = [];
    const chunkIndices = new Set<number>();
    for (const rawChunk of rawFile.chunks) {
      if (!exactObject(rawChunk, ["file", "chunkIndex", "text"])
        || rawChunk.file !== rawFile.path
        || !Number.isSafeInteger(rawChunk.chunkIndex) || (rawChunk.chunkIndex as number) < 0
        || chunkIndices.has(rawChunk.chunkIndex as number)
        || typeof rawChunk.text !== "string") {
        throw new NoteRelationsContextError("INDEX_CORRUPT");
      }
      chunkIndices.add(rawChunk.chunkIndex as number);
      chunks.push(Object.freeze({ chunkIndex: rawChunk.chunkIndex as number, text: rawChunk.text }));
    }
    totalChunks += chunks.length;
    if (totalChunks > MAX_TOTAL_CHUNKS) throw new NoteRelationsContextError("INDEX_CORRUPT");
    entries.push(Object.freeze({
      absolutePath: resolve(rawFile.path),
      relativePath,
      ...(current ? {
        chunkerVersion: NOTES_CHUNKER_VERSION,
        sourceHash: rawFile.sourceHash as string
      } : {}),
      chunks: Object.freeze(chunks)
    }));
  }
  if (parsed.embeddingCount !== totalChunks || (totalChunks > 0 && (parsed.embeddingDim as number) <= 0)) {
    throw new NoteRelationsContextError("INDEX_CORRUPT");
  }
  return Object.freeze({
    entries: Object.freeze(entries),
    notesRoot: notesRootRealpath,
    notesRootIdentity: Object.freeze({
      dev: Number(rootStats.dev), ino: Number(rootStats.ino), uid: Number(rootStats.uid), realpath: notesRootRealpath
    }),
    rawDigest: createHash("sha256").update(bytes).digest("hex")
  });
}

export async function loadIndexedNoteSource(
  index: BoundedNotesIndexSnapshot,
  relativePath: string,
  options: {
    readonly beforeBoundedRead?: () => void | Promise<void>;
    readonly afterVerifiedRead?: () => void | Promise<void>;
  } = {}
): Promise<IndexedNoteSourceResult> {
  const entry = index.entries.find((candidate) => candidate.relativePath === relativePath);
  if (!entry) return Object.freeze({ reason: "not_indexed", status: "unavailable" });
  if (!entry.sourceHash || entry.chunkerVersion !== NOTES_CHUNKER_VERSION || !TEXT_NOTE_PATH_RE.test(relativePath)) {
    return Object.freeze({ reason: "legacy_or_pdf", status: "unavailable" });
  }
  let sourceRead: VerifiedFileRead;
  try {
    sourceRead = await readBoundedRegularFile(entry.absolutePath, MAX_SOURCE_BYTES, "INDEX_UNSAFE", options.beforeBoundedRead);
    await options.afterVerifiedRead?.();
  } catch {
    return Object.freeze({ reason: "unsafe_source", status: "unavailable" });
  }
  let realpath: string;
  let pathStats: Awaited<ReturnType<typeof fs.lstat>>;
  let rootStats: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    [realpath, pathStats, rootStats] = await Promise.all([
      fs.realpath(entry.absolutePath),
      fs.lstat(entry.absolutePath),
      fs.lstat(index.notesRoot)
    ]);
  } catch {
    return Object.freeze({ reason: "unsafe_source", status: "unavailable" });
  }
  if (canonicalRelative(index.notesRoot, realpath) !== relativePath
    || !pathStats.isFile() || pathStats.isSymbolicLink() || !owned(pathStats)
    || Number(pathStats.dev) !== sourceRead.identity.dev || Number(pathStats.ino) !== sourceRead.identity.ino
    || Number(pathStats.uid) !== sourceRead.identity.uid || Number(pathStats.size) !== sourceRead.identity.size
    || pathStats.mtimeMs !== sourceRead.identity.mtimeMs
    || !rootStats.isDirectory() || rootStats.isSymbolicLink()
    || Number(rootStats.dev) !== index.notesRootIdentity.dev || Number(rootStats.ino) !== index.notesRootIdentity.ino
    || Number(rootStats.uid) !== index.notesRootIdentity.uid) {
    return Object.freeze({ reason: "unsafe_source", status: "unavailable" });
  }
  try {
    FATAL_UTF8.decode(sourceRead.bytes);
  } catch {
    return Object.freeze({ reason: "unsafe_source", status: "unavailable" });
  }
  if (createHash("sha256").update(sourceRead.bytes).digest("hex") !== entry.sourceHash) {
    return Object.freeze({ reason: "stale_source", status: "unavailable" });
  }
  const chunks = Object.freeze(entry.chunks.map((chunk) => Object.freeze({ ...chunk })));
  const sourceIndex: NoteSourceIndexViewV1 = Object.freeze({
    chunkerVersion: NOTES_CHUNKER_VERSION,
    chunks,
    notesIndexSchema: NOTES_INDEX_SCHEMA_VERSION,
    sourceHash: entry.sourceHash,
    sourcePath: relativePath
  });
  return Object.freeze({
    sourceBytes: new Uint8Array(sourceRead.bytes),
    sourceIdentity: sourceRead.identity,
    sourceIndex,
    status: "resolved"
  });
}
