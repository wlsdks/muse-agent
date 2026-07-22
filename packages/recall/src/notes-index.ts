/**
 * Pure local vector RAG core for `muse notes` — index build, load/save,
 * staleness, and cosine-based ranking over a flat JSON index at
 * `~/.muse/notes-index.json`. Framework-free; the CLI wiring lives in
 * `commands-notes-rag.ts`, chat-grounding lazy-imports these by name.
 */

import { createHash } from "node:crypto";
import { readdir, readFile, realpath, rm, stat } from "node:fs/promises";
import { errorMessage, parseStrictJson } from "@muse/shared";

import { atomicWriteFile, withFileLock, withFileMutationQueue, withRequiredProcessLock } from "@muse/stores";
import { homedir } from "node:os";
import { basename as pathBasename, dirname as pathDirname, isAbsolute, join as pathJoin, relative as pathRelative, resolve as pathResolve, sep as pathSep } from "node:path";

import { annotateNoteChunks } from "@muse/agent-core";

import { parsePdfBuffer } from "./document-reader.js";
import { embed, EmbedAbortedError } from "./embed.js";
import { chunkText, NOTES_CHUNKER_VERSION } from "./notes-chunk.js";
import { backupVersionMismatchedStore } from "./store-version-backup.js";

const DEFAULT_CHUNK_CHARS = 600;
const NOTES_ANNOTATION_VERSION = 1;
const REINDEX_CHECKPOINT_VERSION = 1;
const REINDEX_CHECKPOINT_MAX_BYTES = 64 * 1024 * 1024;
const REINDEX_CHECKPOINT_MAX_CHUNKS = 4_096;

export type NotesIndexCommitPhase =
  | "before-checkpoint-commit"
  | "after-checkpoint-commit"
  | "before-sidecar-write"
  | "after-sidecar-write"
  | "before-json-commit"
  | "after-json-commit"
  | "before-checkpoint-delete"
  | "after-checkpoint-delete";

class NotesIndexFaultInjectionError extends Error {
  constructor(readonly phase: NotesIndexCommitPhase, cause: unknown) {
    super(`injected notes-index interruption at ${phase}`, { cause });
    this.name = "NotesIndexFaultInjectionError";
  }
}

function invokeCommitPhaseForTesting(
  options: Pick<ReindexOptions, "onCommitPhaseForTesting"> | undefined,
  phase: NotesIndexCommitPhase
): void {
  try {
    options?.onCommitPhaseForTesting?.(phase);
  } catch (cause) {
    throw new NotesIndexFaultInjectionError(phase, cause);
  }
}

/**
 * Note-corpus file formats the index includes. PDFs are special-cased in
 * `extractDocumentText`; every other match is read as UTF-8, so ANY prose
 * format works once it passes this gate. Deliberately wide — beyond `.md`/`.txt`
 * to org-mode (`.org`), reStructuredText (`.rst`), AsciiDoc, MDX, and markdown
 * variants — so a power-user's non-markdown notes aren't silently invisible.
 * The single source of truth shared by the indexer + the corpus inventory/count.
 */
export const NOTE_FILE_RE = /\.(md|markdown|mkd|mdown|mdx|txt|text|org|rst|adoc|asciidoc|pdf)$/iu;

/**
 * Read a note source to plain text. PDFs go through `pdf-parse` (the
 * same path as `muse read`) so a PDF dropped in the notes dir is
 * indexed + retrievable like a markdown note; everything else is read
 * as UTF-8.
 */
export async function extractNoteText(path: string): Promise<string> {
  if (/\.pdf$/iu.test(path)) {
    return (await parsePdfBuffer(await readFile(path))).text;
  }
  return readFile(path, "utf8");
}

export interface IndexChunk {
  readonly file: string;
  readonly chunkIndex: number;
  readonly text: string;
  readonly embedding: number[] | Float32Array;
}

export interface FileEntry {
  readonly path: string;
  readonly mtimeMs: number;
  /** Exact raw source-byte digest at index time; absent on legacy v2 and PDFs. */
  readonly sourceHash?: string;
  /** Stored-text chunker identity at index time; absent on legacy v2 and PDFs. */
  readonly chunkerVersion?: typeof NOTES_CHUNKER_VERSION;
  readonly chunks: readonly IndexChunk[];
}

/**
 * Schema version for `~/.muse/notes-index.json`.
 * Bumped when fields are renamed / removed or the embedding
 * layout changes. `loadIndex` treats a mismatch as "stale" so
 * the next `reindexNotes` rebuilds from scratch instead of
 * carrying stale (incompatible) entries forward. Exported for
 * direct unit-test coverage + future bumpers.
 */
export const NOTES_INDEX_SCHEMA_VERSION = 2;

/** The Float32 binary sidecar holding every chunk embedding in traversal order — JSON stores metadata only. */
export function embeddingsSidecarPath(indexPath: string): string {
  return `${indexPath.replace(/\.json$/u, "")}.embeddings.bin`;
}

export interface NotesIndex {
  readonly version: typeof NOTES_INDEX_SCHEMA_VERSION;
  readonly model: string;
  readonly builtAtIso: string;
  readonly files: FileEntry[];
}

interface PersistedNotesIndex extends NotesIndex {
  readonly embeddingCount?: number;
  readonly embeddingDim?: number;
  readonly embeddingFile?: string;
  readonly embeddingSha256?: string;
}

function hashSourceBytes(sourceBytes: Uint8Array): string {
  return createHash("sha256").update(sourceBytes).digest("hex");
}

export function defaultIndexPath(): string {
  const envHome = process.env.HOME?.trim();
  if (envHome && envHome.length > 0) return pathJoin(envHome, ".muse", "notes-index.json");
  const sysHome = homedir().trim();
  if (sysHome.length > 0) return pathJoin(sysHome, ".muse", "notes-index.json");
  throw new Error("Cannot resolve home directory for notes-index.json — HOME is empty and os.homedir() returned no value");
}

export async function walkMarkdown(dir: string): Promise<readonly { path: string; mtimeMs: number }[]> {
  const out: { path: string; mtimeMs: number }[] = [];
  const stack: string[] = [dir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = pathJoin(current, entry.name);
      if (entry.name.startsWith(".")) continue;
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && NOTE_FILE_RE.test(entry.name)) {
        const s = await stat(full);
        out.push({ mtimeMs: s.mtimeMs, path: full });
      }
    }
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  const result = dot / Math.sqrt(na * nb);
  return Number.isFinite(result) ? result : 0;
}

/** A note's centroid embedding — the component-wise mean of its chunk embeddings. Pure. */
export function noteCentroid(chunks: readonly { readonly embedding: ArrayLike<number> }[]): number[] {
  if (chunks.length === 0) {
    return [];
  }
  const dim = chunks[0]!.embedding.length;
  const sum = new Array<number>(dim).fill(0);
  for (const chunk of chunks) {
    for (let i = 0; i < dim; i += 1) {
      sum[i]! += chunk.embedding[i] ?? 0;
    }
  }
  return sum.map((value) => value / chunks.length);
}

export interface RelatedNote {
  readonly path: string;
  readonly score: number;
}

/**
 * Rank the notes most SEMANTICALLY related to `targetPath` by cosine between
 * note centroid embeddings — the embedding complement to the [[wiki-link]] graph
 * (it surfaces connections the explicit links missed; GraphRAG / HippoRAG
 * sibling). The target itself and any note with no embedding overlap are
 * excluded; top `limit` by score. Pure (operates on the prebuilt index).
 */
export function rankRelatedNotes(index: NotesIndex, targetPath: string, limit = 5): readonly RelatedNote[] {
  const target = index.files.find((file) => file.path === targetPath);
  if (!target) {
    return [];
  }
  const targetVec = noteCentroid(target.chunks);
  if (targetVec.length === 0) {
    return [];
  }
  return index.files
    .filter((file) => file.path !== targetPath && file.chunks.length > 0)
    .map((file) => ({ path: file.path, score: cosine(targetVec, noteCentroid(file.chunks)) }))
    .filter((related) => related.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, limit));
}

/** Resolve a user note query (exact path / basename / unique stem-substring) to an indexed file path. */
export function resolveIndexNotePath(index: NotesIndex, query: string): string | undefined {
  const trimmed = query.trim();
  const exact = index.files.find((file) => file.path === trimmed);
  if (exact) {
    return exact.path;
  }
  const stem = (path: string): string => pathBasename(path).replace(/\.[^.]+$/u, "").toLowerCase();
  const needle = stem(trimmed);
  const byStem = index.files.filter((file) => stem(file.path) === needle);
  if (byStem.length === 1) {
    return byStem[0]!.path;
  }
  const bySubstring = index.files.filter((file) => stem(file.path).includes(needle));
  return bySubstring.length === 1 ? bySubstring[0]!.path : undefined;
}

export async function loadIndex(path: string): Promise<NotesIndex | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw cause;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Malformed JSON → discard so the next reindex rebuilds.
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const candidate = parsed as Partial<NotesIndex>;
  // Version mismatch → discard so reindex rebuilds clean rather
  // than carrying incompatible entries forward — but back the prior
  // file up first (see store-version-backup.ts): reindexNotes writes
  // back on the next run, so an undiscarded mismatch would otherwise
  // be silently overwritten with zero trace.
  if ((candidate as { version?: unknown }).version === 1 && isV1NotesIndex(candidate)) {
    // Keep loaders read-only. The next explicit/automatic reindex publish
    // upgrades this verified inline v1 snapshot to the generation layout.
    const v1 = candidate as unknown as NotesIndex;
    if (Array.isArray(v1.files)) {
      return { builtAtIso: v1.builtAtIso, files: v1.files, model: v1.model, version: NOTES_INDEX_SCHEMA_VERSION };
    }
  }
  if (!isNotesIndexValid(candidate)) {
    return undefined;
  }
  const inlineFiles = (candidate as NotesIndex).files;
  if (!Array.isArray(inlineFiles)) {
    return candidate as NotesIndex;
  }
  // Accept verified inline v2 fixtures without mutating disk. A reader must
  // never bypass the reindex writer transaction.
  const firstChunk = inlineFiles.flatMap((file) => file.chunks)[0];
  if (firstChunk && Array.isArray((firstChunk as { embedding?: unknown }).embedding)) {
    return { builtAtIso: (candidate as NotesIndex).builtAtIso, files: inlineFiles, model: (candidate as NotesIndex).model, version: NOTES_INDEX_SCHEMA_VERSION };
  }
  if (inlineFiles.length === 0 || inlineFiles.every((file) => file.chunks.length === 0)) {
    return candidate as NotesIndex;
  }
  const meta = candidate as unknown as PersistedNotesIndex & { readonly files?: readonly { readonly path: string; readonly mtimeMs?: number; readonly chunks: readonly { readonly file: string; readonly chunkIndex: number; readonly text: string }[] }[] };
  const dim = meta.embeddingDim ?? 0;
  const count = meta.embeddingCount ?? 0;
  let bin: Buffer;
  try {
    let sidecar = embeddingsSidecarPath(path);
    if (meta.embeddingFile !== undefined || meta.embeddingSha256 !== undefined) {
      const stem = pathBasename(path).replace(/\.json$/u, "");
      if (
        typeof meta.embeddingFile !== "string"
        || typeof meta.embeddingSha256 !== "string"
        || !/^[0-9a-f]{64}$/u.test(meta.embeddingSha256)
        || isAbsolute(meta.embeddingFile)
        || pathBasename(meta.embeddingFile) !== meta.embeddingFile
        || !meta.embeddingFile.startsWith(`${stem}.embeddings.`)
      ) return undefined;
      sidecar = pathJoin(pathDirname(path), meta.embeddingFile);
    }
    bin = await readFile(sidecar);
    if (meta.embeddingSha256 !== undefined && hashSourceBytes(bin) !== meta.embeddingSha256) return undefined;
  } catch {
    return undefined;
  }
  const chunkCount = meta.files?.reduce((total, file) => total + file.chunks.length, 0) ?? 0;
  const expectedBytes = count * dim * Float32Array.BYTES_PER_ELEMENT;
  if (
    !Number.isSafeInteger(dim)
    || dim <= 0
    || !Number.isSafeInteger(count)
    || count !== chunkCount
    || !Number.isSafeInteger(expectedBytes)
    || !Array.isArray(meta.files)
    || bin.byteLength !== expectedBytes
  ) {
    return undefined;
  }
  const all = new Float32Array(bin.buffer, bin.byteOffset, count * dim);
  let at = 0;
  const files = meta.files.map((file) => ({
    ...file,
    chunks: file.chunks.map((chunk: { readonly file: string; readonly chunkIndex: number; readonly text: string }) => {
      const embedding = all.subarray(at * dim, (at + 1) * dim);
      at += 1;
      return { ...chunk, embedding };
    })
  }));
  return { builtAtIso: (candidate as NotesIndex).builtAtIso, files, model: (candidate as NotesIndex).model, version: NOTES_INDEX_SCHEMA_VERSION } as NotesIndex;
}

/**
 * Pure validator for the on-disk `notes-index.json`.
 * Exported so the auto-stale check + tests share the same
 * predicate (no risk of the loader accepting a shape the
 * stale-check rejects).
 */
export function isNotesIndexValid(candidate: unknown): boolean {
  return isRecord(candidate)
    && candidate.version === NOTES_INDEX_SCHEMA_VERSION
    && typeof candidate.model === "string"
    && typeof candidate.builtAtIso === "string"
    && Array.isArray(candidate.files)
    && candidate.files.every((file) => isPersistedIndexFile(file));
}

async function saveIndex(path: string, index: NotesIndex, options?: Pick<ReindexOptions, "onCommitPhaseForTesting" | "signal">): Promise<boolean> {
  // v2 layout: embeddings live in a Float32 binary sidecar, JSON keeps metadata.
  // JSON-encoded float arrays cost ~19 bytes per number — measured 464MB /
  // 659ms parse / 2.9GB RSS at 10k notes, vs 92MB / ~ms / ~10% RSS as float32.
  // Write order matters: sidecar first, JSON last — the JSON is the commit
  // point, and a crash between the two leaves a v2 JSON whose byte-length
  // check fails on load (treated as stale, reindexed) rather than silently
  // mismatched vectors. Both writes are atomic (tmp + fsync + rename).
  let expectedDim: number | undefined;
  for (const file of index.files) {
    for (const chunk of file.chunks) {
      const embedding = Array.from(chunk.embedding);
      if (embedding.length === 0 || embedding.some((value) => !Number.isFinite(value))) {
        throw new Error(`invalid embedding vector for ${chunk.file}`);
      }
      expectedDim ??= embedding.length;
      if (embedding.length !== expectedDim) {
        throw new Error(`embedding dimension mismatch for ${chunk.file}: expected ${expectedDim.toString()}, received ${embedding.length.toString()}`);
      }
    }
  }
  if (options?.signal?.aborted) return false;
  let committed = false;
  await withFileMutationQueue(path, () => withFileLock(path, async () => {
    if (options?.signal?.aborted) return;
    let dim = 0;
    let count = 0;
    for (const file of index.files) {
      for (const chunk of file.chunks) {
        if (dim === 0) dim = chunk.embedding.length;
        count += 1;
      }
    }
    const bin = new Float32Array(count * dim);
    let at = 0;
    const metaFiles = index.files.map((file) => ({
      ...file,
      chunks: file.chunks.map((chunk) => {
        bin.set(chunk.embedding, at * dim);
        at += 1;
        const { embedding: _embedding, ...rest } = chunk;
        return rest;
      })
    }));
    const embeddingBytes = new Uint8Array(bin.buffer, 0, count * dim * Float32Array.BYTES_PER_ELEMENT);
    const embeddingSha256 = hashSourceBytes(embeddingBytes);
    const stem = pathBasename(path).replace(/\.json$/u, "");
    const embeddingFile = `${stem}.embeddings.${embeddingSha256}.bin`;
    // Immutable generation first, metadata pointer last. Lock-free readers
    // always have a durable target for whichever committed JSON they saw.
    invokeCommitPhaseForTesting(options, "before-sidecar-write");
    await atomicWriteFile(pathJoin(pathDirname(path), embeddingFile), embeddingBytes);
    invokeCommitPhaseForTesting(options, "after-sidecar-write");
    if (options?.signal?.aborted) return;
    invokeCommitPhaseForTesting(options, "before-json-commit");
    if (options?.signal?.aborted) return;
    await atomicWriteFile(path, `${JSON.stringify({ ...index, embeddingCount: count, embeddingDim: dim, embeddingFile, embeddingSha256, files: metaFiles }, null, 2)}\n`);
    committed = true;
    invokeCommitPhaseForTesting(options, "after-json-commit");
  }));
  return committed;
}

function isV1NotesIndex(value: unknown): value is NotesIndex {
  return isRecord(value)
    && value.version === 1
    && typeof value.model === "string"
    && typeof value.builtAtIso === "string"
    && Array.isArray(value.files)
    && value.files.every((file) => isPersistedIndexFile(file, true));
}

function isPersistedIndexFile(value: unknown, requireEmbedding = false): boolean {
  const hasNoTextProvenance = isRecord(value)
    && value.sourceHash === undefined
    && value.chunkerVersion === undefined;
  const hasValidTextProvenance = isRecord(value)
    && typeof value.sourceHash === "string"
    && /^[0-9a-f]{64}$/u.test(value.sourceHash)
    && value.chunkerVersion === NOTES_CHUNKER_VERSION;
  return isRecord(value)
    && typeof value.path === "string"
    && typeof value.mtimeMs === "number"
    && Number.isFinite(value.mtimeMs)
    && (hasNoTextProvenance || hasValidTextProvenance)
    && Array.isArray(value.chunks)
    && value.chunks.every((chunk) => isPersistedIndexChunk(chunk, requireEmbedding));
}

function isPersistedIndexChunk(value: unknown, requireEmbedding: boolean): boolean {
  if (!isRecord(value)
    || typeof value.file !== "string"
    || typeof value.chunkIndex !== "number"
    || !Number.isSafeInteger(value.chunkIndex)
    || value.chunkIndex < 0
    || typeof value.text !== "string") {
    return false;
  }
  if (value.embedding === undefined) {
    return !requireEmbedding;
  }
  return Array.isArray(value.embedding) && value.embedding.every((number) => typeof number === "number" && Number.isFinite(number));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

interface CorpusIdentity {
  readonly realpath: string;
  readonly dev: number;
  readonly ino: number;
  readonly uid: number;
}

interface CheckpointFileIdentity {
  readonly relativePath: string;
  readonly realpath: string;
  readonly dev: number;
  readonly ino: number;
  readonly uid: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly sourceSha256: string;
}

interface ReindexCheckpointBase {
  readonly version: typeof REINDEX_CHECKPOINT_VERSION;
  readonly baseGeneration: string;
  readonly corpus: CorpusIdentity;
  readonly model: string;
  readonly chunkChars: number;
  readonly overlap: number;
  readonly chunkerVersion: typeof NOTES_CHUNKER_VERSION;
  readonly annotationVersion: typeof NOTES_ANNOTATION_VERSION;
  readonly file: CheckpointFileIdentity;
}

interface ReindexProgressCheckpoint extends ReindexCheckpointBase {
  readonly kind: "progress";
  readonly nextChunkIndex: number;
  readonly chunks: readonly IndexChunk[];
  readonly embeddingDim: number;
}

interface ReindexRequiresFullCheckpoint extends ReindexCheckpointBase {
  readonly kind: "requires-full";
  readonly reason: "checkpoint-too-large";
}

type ReindexCheckpoint = ReindexProgressCheckpoint | ReindexRequiresFullCheckpoint;

export function reindexCheckpointPath(indexPath: string): string {
  return `${indexPath}.reindex-checkpoint.json`;
}

type FileStats = NonNullable<Awaited<ReturnType<typeof stat>>>;

function ownerUid(stats: FileStats): number {
  return Number(stats.uid);
}

function ownedByCurrentUser(stats: FileStats): boolean {
  const uid = process.getuid?.();
  return uid === undefined || Number(stats.uid) === uid;
}

async function corpusIdentity(dir: string): Promise<CorpusIdentity> {
  const canonical = await realpath(dir);
  const stats = await stat(canonical);
  if (!stats.isDirectory() || !ownedByCurrentUser(stats)) throw new Error("notes corpus must be an owner-controlled directory");
  return { dev: Number(stats.dev), ino: Number(stats.ino), realpath: canonical, uid: ownerUid(stats) };
}

async function checkpointFileIdentity(path: string, corpus: CorpusIdentity): Promise<{ readonly bytes: Buffer; readonly identity: CheckpointFileIdentity }> {
  const canonical = await realpath(path);
  const relativePath = pathRelative(corpus.realpath, canonical);
  if (relativePath.length === 0 || isAbsolute(relativePath) || relativePath === ".." || relativePath.startsWith(`..${pathSep}`)) {
    throw new Error("note source escapes the canonical notes corpus");
  }
  const stats = await stat(canonical);
  if (!stats.isFile() || !ownedByCurrentUser(stats)) throw new Error("note source must be an owner-controlled regular file");
  const bytes = await readFile(canonical);
  return {
    bytes,
    identity: {
      dev: Number(stats.dev),
      ino: Number(stats.ino),
      mtimeMs: stats.mtimeMs,
      realpath: canonical,
      relativePath,
      size: stats.size,
      sourceSha256: hashSourceBytes(bytes),
      uid: ownerUid(stats)
    }
  };
}

function sameIdentity(left: CorpusIdentity | CheckpointFileIdentity, right: CorpusIdentity | CheckpointFileIdentity): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function currentLiveGeneration(indexPath: string): Promise<string> {
  try {
    return hashSourceBytes(await readFile(indexPath));
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return "none";
    throw cause;
  }
}

function finiteEmbedding(value: unknown): value is number[] {
  return Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "number" && Number.isFinite(item));
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function checkpointFromUnknown(value: unknown): ReindexCheckpoint | undefined {
  if (!isRecord(value) || value.version !== REINDEX_CHECKPOINT_VERSION || (value.kind !== "progress" && value.kind !== "requires-full")) return undefined;
  const commonKeys = ["version", "baseGeneration", "corpus", "model", "chunkChars", "overlap", "chunkerVersion", "annotationVersion", "file", "kind"] as const;
  if (!hasExactKeys(value, value.kind === "progress" ? [...commonKeys, "nextChunkIndex", "chunks", "embeddingDim"] : [...commonKeys, "reason"])) return undefined;
  if (typeof value.baseGeneration !== "string" || typeof value.model !== "string" || value.chunkerVersion !== NOTES_CHUNKER_VERSION || value.annotationVersion !== NOTES_ANNOTATION_VERSION) return undefined;
  if (!Number.isSafeInteger(value.chunkChars) || (value.chunkChars as number) < 120 || !Number.isSafeInteger(value.overlap) || (value.overlap as number) < 0) return undefined;
  if (!isRecord(value.corpus) || !hasExactKeys(value.corpus, ["realpath", "dev", "ino", "uid"]) || typeof value.corpus.realpath !== "string" || !Number.isFinite(value.corpus.dev) || !Number.isFinite(value.corpus.ino) || !Number.isFinite(value.corpus.uid)) return undefined;
  if (!isRecord(value.file) || typeof value.file.relativePath !== "string" || value.file.relativePath.length === 0 || isAbsolute(value.file.relativePath) || value.file.relativePath === ".." || value.file.relativePath.startsWith(`..${pathSep}`)) return undefined;
  if (!hasExactKeys(value.file, ["relativePath", "realpath", "dev", "ino", "uid", "size", "mtimeMs", "sourceSha256"])) return undefined;
  if (typeof value.file.realpath !== "string" || !Number.isFinite(value.file.dev) || !Number.isFinite(value.file.ino) || !Number.isFinite(value.file.uid) || !Number.isFinite(value.file.size) || !Number.isFinite(value.file.mtimeMs) || typeof value.file.sourceSha256 !== "string" || !/^[0-9a-f]{64}$/u.test(value.file.sourceSha256)) return undefined;
  const base = value as unknown as ReindexCheckpointBase;
  if (value.kind === "requires-full") return value.reason === "checkpoint-too-large" ? { ...base, kind: "requires-full", reason: "checkpoint-too-large" } : undefined;
  if (!Number.isSafeInteger(value.nextChunkIndex) || (value.nextChunkIndex as number) < 0 || !Number.isSafeInteger(value.embeddingDim) || (value.embeddingDim as number) <= 0 || !Array.isArray(value.chunks) || value.chunks.length > REINDEX_CHECKPOINT_MAX_CHUNKS) return undefined;
  const chunks: IndexChunk[] = [];
  for (const chunk of value.chunks) {
    if (!isRecord(chunk) || !hasExactKeys(chunk, ["chunkIndex", "embedding", "file", "text"]) || !Number.isSafeInteger(chunk.chunkIndex) || typeof chunk.file !== "string" || typeof chunk.text !== "string" || !finiteEmbedding(chunk.embedding) || chunk.embedding.length !== value.embeddingDim) return undefined;
    chunks.push({ chunkIndex: chunk.chunkIndex as number, embedding: chunk.embedding, file: chunk.file, text: chunk.text });
  }
  if (chunks.length !== value.nextChunkIndex) return undefined;
  return { ...base, chunks, embeddingDim: value.embeddingDim as number, kind: "progress", nextChunkIndex: value.nextChunkIndex as number };
}

async function loadCheckpoint(indexPath: string): Promise<ReindexCheckpoint | undefined> {
  const path = reindexCheckpointPath(indexPath);
  try {
    const stats = await stat(path);
    if (!stats.isFile() || !ownedByCurrentUser(stats) || stats.size > REINDEX_CHECKPOINT_MAX_BYTES) return undefined;
    return checkpointFromUnknown(parseStrictJson(await readFile(path, "utf8"), {
      maxArrayItems: REINDEX_CHECKPOINT_MAX_CHUNKS,
      maxDepth: 16,
      // 64 MiB is the primary bound. Allow normal 768/1024-dimension vectors
      // across thousands of chunks without treating a valid checkpoint as corrupt.
      maxNodes: 8_388_608,
      maxObjectMembers: REINDEX_CHECKPOINT_MAX_CHUNKS * 8
    }));
  } catch {
    return undefined;
  }
}

async function checkpointFilePresent(indexPath: string): Promise<boolean> {
  try {
    await stat(reindexCheckpointPath(indexPath));
    return true;
  } catch {
    return false;
  }
}

async function writeCheckpoint(
  indexPath: string,
  checkpoint: ReindexCheckpoint,
  options?: Pick<ReindexOptions, "onCommitPhaseForTesting">
): Promise<"written" | "too-large"> {
  if (!checkpointFromUnknown(checkpoint)) throw new Error("refusing to persist an invalid reindex checkpoint");
  const serialized = `${JSON.stringify(checkpoint)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > REINDEX_CHECKPOINT_MAX_BYTES) return "too-large";
  invokeCommitPhaseForTesting(options, "before-checkpoint-commit");
  await atomicWriteFile(reindexCheckpointPath(indexPath), serialized);
  invokeCommitPhaseForTesting(options, "after-checkpoint-commit");
  return "written";
}

async function clearCheckpoint(
  indexPath: string,
  options?: Pick<ReindexOptions, "onCommitPhaseForTesting">
): Promise<void> {
  invokeCommitPhaseForTesting(options, "before-checkpoint-delete");
  await rm(reindexCheckpointPath(indexPath), { force: true });
  invokeCommitPhaseForTesting(options, "after-checkpoint-delete");
}

/**
 * Reusable reindex routine — used by `muse notes reindex` AND by
 * `muse ask` for auto-reindex when stale. Returns a summary so the
 * caller can decide whether to log progress (CLI) or stay silent
 * (auto-mode).
 */
interface ReindexWorkCounters {
  readonly indexPath: string;
  /** Markdown files found under the notes dir (0 ⇒ nothing to index). */
  readonly totalFiles: number;
  readonly embedded: number;
  readonly skipped: number;
  readonly failed: number;
  readonly totalChunks: number;
  readonly index: NotesIndex | undefined;
  readonly attemptedEmbeddings: number;
  readonly pendingFiles: number;
}

export type ReindexWorkSummary =
  | (ReindexWorkCounters & { readonly status: "complete" })
  | (ReindexWorkCounters & { readonly status: "pending"; readonly pendingReason: "budget" | "embedding-error" | "checkpoint-too-large" });

export type ReindexSummary =
  | ReindexWorkSummary
  | { readonly status: "busy"; readonly pendingReason: "writer-active"; readonly indexPath: string; readonly attemptedEmbeddings: 0 }
  | { readonly status: "aborted"; readonly pendingReason: "caller-abort"; readonly indexPath: string; readonly attemptedEmbeddings: number; readonly index?: NotesIndex; readonly progress?: Omit<ReindexWorkCounters, "index" | "indexPath" | "attemptedEmbeddings"> };

export type FullReindexSummary =
  | (Omit<ReindexWorkCounters, "index"> & { readonly index: NotesIndex; readonly status: "complete" })
  | (Omit<ReindexWorkCounters, "index"> & { readonly index: NotesIndex; readonly status: "pending"; readonly pendingReason: "embedding-error" });

/**
 * The line(s) `muse notes reindex` prints after a run. When ZERO markdown
 * files were found (fresh install, mistyped `--dir`, or an unset
 * `MUSE_NOTES_DIR`), a bare `Done. 0 embedded, 0 cached, 0 failed` reads as a
 * silent failure — so emit a distinct, action-bearing empty-state that says
 * what was searched and how to fix it. Every suggested command/env var is
 * real; all counts come from the filesystem walk (fabrication 0). Pure +
 * exported for direct test coverage.
 */
export function formatReindexOutcome(
  summary: Pick<Extract<ReindexSummary, { readonly status: "complete" | "pending" }>, "totalFiles" | "embedded" | "skipped" | "failed" | "totalChunks" | "indexPath"> & { readonly status?: "complete" | "pending" },
  context: { readonly dir: string }
): string {
  if (summary.totalFiles === 0) {
    return [
      `No notes to index — found 0 Markdown files under ${context.dir}.`,
      `  • Capture one now:        muse note "remember this"`,
      `  • Or point at your vault: export MUSE_NOTES_DIR=/path/to/notes   (or muse notes reindex --dir <path>)`,
      `Once you have notes, \`muse ask\` / \`muse recall\` will ground answers on them.`
    ].join("\n");
  }
  const prefix = summary.status === "pending" ? "Incomplete." : "Done.";
  return `${prefix} ${summary.embedded.toString()} embedded, ${summary.skipped.toString()} cached, ${summary.failed.toString()} failed. ${summary.totalChunks.toString()} chunks total in ${summary.indexPath}`;
}

export interface ReindexOptions {
    readonly dir: string;
    readonly model: string;
    readonly chunkChars?: number;
    readonly force?: boolean;
    readonly indexPath?: string;
    readonly onProgress?: (line: string) => void;
    /** Override the embeddings fetch in tests; defaults to global fetch. */
    readonly fetchImpl?: typeof globalThis.fetch;
    /** Resolve the Ollama base URL; defaults to `OLLAMA_BASE_URL` or localhost. */
    readonly baseUrlResolver?: () => string;
    /** Automatic paths bound attempted embedding fetches; undefined is an explicit full run. */
    readonly maxEmbeddingAttempts?: number;
    /** Per-embedding timeout override used by bounded automatic paths. */
    readonly embedTimeoutMs?: number;
  readonly signal?: AbortSignal;
  /** Deterministic fault seam for serialized checkpoint-cap tests only. */
  readonly checkpointMaxBytesForTesting?: number;
  /** Test-only: runs once immediately after acquiring the required writer lock, before any mutation. */
  readonly onWriterLockAcquiredForTesting?: () => void;
  /** Test-only: injects a deterministic interruption at an exact durable commit boundary. */
  readonly onCommitPhaseForTesting?: (phase: NotesIndexCommitPhase) => void;
}

export function reindexNotes(options: ReindexOptions & { readonly maxEmbeddingAttempts?: undefined }): Promise<FullReindexSummary>;
export function reindexNotes(options: ReindexOptions): Promise<ReindexSummary>;
export async function reindexNotes(options: ReindexOptions): Promise<ReindexSummary> {
  const chunkChars = Math.max(120, options.chunkChars ?? DEFAULT_CHUNK_CHARS);
  const indexPath = options.indexPath ?? defaultIndexPath();
  const earlyAborted = (): Extract<ReindexSummary, { readonly status: "aborted" }> => ({ attemptedEmbeddings: 0, indexPath, pendingReason: "caller-abort", status: "aborted" });
  if (options.signal?.aborted) return earlyAborted();
  const outcome = await withRequiredProcessLock(`${indexPath}.reindex.lock`, async () => {
    options.onWriterLockAcquiredForTesting?.();
    if (options.signal?.aborted) return earlyAborted();
    // Readers never mutate. Preserve only a schema-mismatched store here,
    // after the required writer lock has been acquired and before rebuilding.
    try {
      const raw = JSON.parse(await readFile(indexPath, "utf8")) as unknown;
      if (isRecord(raw) && raw.version !== 1 && raw.version !== NOTES_INDEX_SCHEMA_VERSION) {
        await backupVersionMismatchedStore(indexPath, raw.version);
      }
    } catch {
      // Missing/malformed stores are rebuilt in place; loadIndex remains pure.
    }
    const bounded = options.maxEmbeddingAttempts !== undefined;
    if (!bounded || options.force === true) await clearCheckpoint(indexPath);
    else if (await checkpointFilePresent(indexPath) && !(await loadCheckpoint(indexPath))) await clearCheckpoint(indexPath);
    const found = await walkMarkdown(options.dir);
    let liveIndex = options.force === true ? undefined : await loadIndex(indexPath);
    const stagingPath = bounded && liveIndex !== undefined && liveIndex.model !== options.model
      ? `${indexPath}.reindex-staging.json`
      : indexPath;
    let index = options.force === true ? undefined : await loadIndex(stagingPath);
    if (index?.model !== options.model) index = undefined;
    let currentFiles = index?.files.slice() ?? [];
    const foundPaths = new Set(found.map((entry) => entry.path));
    let embedded = 0;
    let skipped = 0;
    let failed = 0;
    let attemptedEmbeddings = 0;
    let pendingFiles = 0;
    const counters = (status: "complete" | "pending", pendingReason?: "budget" | "embedding-error" | "checkpoint-too-large"): Extract<ReindexSummary, { readonly status: "complete" | "pending" }> => ({
      attemptedEmbeddings,
      embedded,
      failed,
      index: stagingPath === indexPath ? index : liveIndex,
      indexPath,
      pendingFiles,
      skipped,
      status,
      ...(status === "pending" ? { pendingReason: pendingReason! } : {}),
      totalChunks: (stagingPath === indexPath ? index : liveIndex)?.files.reduce((sum, file) => sum + file.chunks.length, 0) ?? 0,
      totalFiles: found.length
    } as Extract<ReindexSummary, { readonly status: "complete" | "pending" }>);
    const aborted = (): Extract<ReindexSummary, { readonly status: "aborted" }> => ({
      attemptedEmbeddings,
      ...(stagingPath === indexPath && index ? { index } : liveIndex ? { index: liveIndex } : {}),
      indexPath,
      pendingReason: "caller-abort",
      progress: { embedded, failed, pendingFiles, skipped, totalChunks: index?.files.reduce((sum, file) => sum + file.chunks.length, 0) ?? 0, totalFiles: found.length },
      status: "aborted"
    });
    if (options.signal?.aborted) return aborted();

    if (stagingPath !== indexPath && liveIndex) {
      const retainedLive = liveIndex.files.filter((entry) => foundPaths.has(entry.path));
      if (retainedLive.length !== liveIndex.files.length) {
        if (options.signal?.aborted) return aborted();
        liveIndex = { ...liveIndex, builtAtIso: new Date().toISOString(), files: retainedLive };
        if (!(await saveIndex(indexPath, liveIndex, options))) return aborted();
      }
    }

    // Deletions are a complete local fact and need no embedding. Commit them
    // before a bounded file can become pending, so ghost entries disappear.
    const retained = currentFiles.filter((entry) => foundPaths.has(entry.path));
    if (retained.length !== currentFiles.length && stagingPath === indexPath) {
      if (options.signal?.aborted) return aborted();
      index = { builtAtIso: new Date().toISOString(), files: retained, model: options.model, version: NOTES_INDEX_SCHEMA_VERSION };
      if (!(await saveIndex(indexPath, index, options))) return aborted();
      currentFiles = retained;
    }
    if (found.length === 0) {
      if (stagingPath !== indexPath || !index) {
        if (options.signal?.aborted) return aborted();
        index = { builtAtIso: new Date().toISOString(), files: [], model: options.model, version: NOTES_INDEX_SCHEMA_VERSION };
        if (!(await saveIndex(indexPath, index, options))) return aborted();
        liveIndex = index;
      }
      if (options.signal?.aborted) return aborted();
      await clearCheckpoint(indexPath);
      return counters("complete");
    }
    const corpus = await corpusIdentity(options.dir);
    const overlap = Math.min(200, Math.max(0, Math.floor(chunkChars / 20)));

    for (let position = 0; position < found.length; position += 1) {
      if (options.signal?.aborted) return aborted();
      const { path, mtimeMs } = found[position]!;
      const at = `[${(position + 1).toString()}/${found.length.toString()}] `;
      const known = new Map(currentFiles.map((entry) => [entry.path, entry]));
      const prior = known.get(path);
      const isPdf = /\.pdf$/iu.test(path);
      let captured: Awaited<ReturnType<typeof checkpointFileIdentity>>;
      try {
        captured = await checkpointFileIdentity(path, corpus);
      } catch (cause) {
        failed += 1;
        pendingFiles += 1;
        options.onProgress?.(`${at}✗ ${path} (could not read — skipped: ${errorMessage(cause)})`);
        continue;
      }
      const sourceHash = captured.identity.sourceSha256;
      if (prior && prior.mtimeMs === mtimeMs && (isPdf || (prior.chunkerVersion === NOTES_CHUNKER_VERSION && prior.sourceHash === sourceHash))) {
        const cachedCheckpoint = bounded ? await loadCheckpoint(indexPath) : undefined;
        // A post-JSON crash may leave a stale checkpoint for THIS file even
        // though its source identity is already committed. Never clear a
        // checkpoint owned by a later file: sorted cached predecessors must
        // not erase resumable work for the changed file that follows them.
        if (cachedCheckpoint && sameIdentity(cachedCheckpoint.file, captured.identity)) {
          await clearCheckpoint(indexPath);
        }
        skipped += 1;
        continue;
      }
      let body: string;
      try {
        body = isPdf ? await extractNoteText(path) : captured.bytes.toString("utf8");
      } catch (cause) {
        failed += 1;
        pendingFiles += 1;
        options.onProgress?.(`${at}✗ ${path} (could not read — skipped: ${errorMessage(cause)})`);
        continue;
      }
      const chunks = chunkText(body, chunkChars, overlap);
      const annotated = annotateNoteChunks(pathBasename(path), body, chunks);
      const baseGeneration = await currentLiveGeneration(stagingPath);
      const checkpointBase: ReindexCheckpointBase = {
        annotationVersion: NOTES_ANNOTATION_VERSION,
        baseGeneration,
        chunkChars,
        chunkerVersion: NOTES_CHUNKER_VERSION,
        corpus,
        file: captured.identity,
        model: options.model,
        overlap,
        version: REINDEX_CHECKPOINT_VERSION
      };
      let checkpoint = bounded ? await loadCheckpoint(indexPath) : undefined;
      const committedDim = currentFiles.flatMap((file) => file.chunks)[0]?.embedding.length;
      if (checkpoint && (
        checkpoint.baseGeneration !== baseGeneration
        || checkpoint.model !== options.model
        || checkpoint.chunkChars !== chunkChars
        || checkpoint.overlap !== overlap
        || checkpoint.annotationVersion !== NOTES_ANNOTATION_VERSION
        || !sameIdentity(checkpoint.corpus, corpus)
        || !sameIdentity(checkpoint.file, captured.identity)
      )) {
        await clearCheckpoint(indexPath);
        checkpoint = undefined;
      }
      if (checkpoint?.kind === "progress" && committedDim !== undefined && checkpoint.embeddingDim !== committedDim) {
        await clearCheckpoint(indexPath);
        checkpoint = undefined;
      }
      if (checkpoint?.kind === "progress" && checkpoint.chunks.some((chunk, chunkIndex) => (
        chunk.chunkIndex !== chunkIndex
        || chunk.file !== path
        || chunk.text !== chunks[chunkIndex]
      ))) {
        await clearCheckpoint(indexPath);
        checkpoint = undefined;
      }
      if (checkpoint?.kind === "requires-full") {
        pendingFiles += found.length - position;
        return counters("pending", "checkpoint-too-large");
      }
      if (bounded && chunks.length > REINDEX_CHECKPOINT_MAX_CHUNKS) {
        await writeCheckpoint(indexPath, { ...checkpointBase, kind: "requires-full", reason: "checkpoint-too-large" });
        pendingFiles += found.length - position;
        return counters("pending", "checkpoint-too-large");
      }
      const out: IndexChunk[] = checkpoint?.kind === "progress" ? checkpoint.chunks.map((chunk) => ({ ...chunk, embedding: [...chunk.embedding] })) : [];
      let fileFailed = false;
      for (let i = out.length; i < chunks.length; i += 1) {
        if (options.signal?.aborted) return aborted();
        if (bounded && attemptedEmbeddings >= options.maxEmbeddingAttempts!) {
          pendingFiles += found.length - position;
          return counters("pending", "budget");
        }
        attemptedEmbeddings += 1;
        try {
          const embedding = await embed(annotated[i]?.embedText ?? chunks[i]!, options.model, {
            ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
            ...(options.baseUrlResolver ? { baseUrlResolver: options.baseUrlResolver } : {}),
            ...(options.embedTimeoutMs !== undefined ? { timeoutMs: options.embedTimeoutMs } : {}),
            ...(options.signal ? { signal: options.signal } : {})
          });
          if (options.signal?.aborted) return aborted();
          const currentIdentity = await checkpointFileIdentity(path, corpus);
          if (!sameIdentity(currentIdentity.identity, captured.identity)) {
            if (options.signal?.aborted) return aborted();
            await clearCheckpoint(indexPath);
            failed += 1;
            pendingFiles += found.length - position;
            return counters("pending", "embedding-error");
          }
          if (options.signal?.aborted) return aborted();
          const expectedDim = out[0]?.embedding.length
            ?? currentFiles.flatMap((file) => file.chunks)[0]?.embedding.length;
          if (!finiteEmbedding(embedding) || (expectedDim !== undefined && embedding.length !== expectedDim)) {
            throw new Error(`embedding dimension mismatch for ${path}`);
          }
          out.push({ chunkIndex: i, embedding, file: path, text: chunks[i]! });
          if (bounded) {
            const progress: ReindexProgressCheckpoint = { ...checkpointBase, chunks: out, embeddingDim: embedding.length, kind: "progress", nextChunkIndex: out.length };
            if (options.signal?.aborted) return aborted();
            const progressBytes = `${JSON.stringify(progress)}\n`;
            const checkpointCap = options.checkpointMaxBytesForTesting ?? REINDEX_CHECKPOINT_MAX_BYTES;
            if (Buffer.byteLength(progressBytes, "utf8") > checkpointCap || await writeCheckpoint(indexPath, progress, options) === "too-large") {
              if (options.signal?.aborted) return aborted();
              await writeCheckpoint(indexPath, { ...checkpointBase, kind: "requires-full", reason: "checkpoint-too-large" });
              pendingFiles += found.length - position;
              return counters("pending", "checkpoint-too-large");
            }
          }
        } catch (cause) {
          if (cause instanceof NotesIndexFaultInjectionError) throw cause;
          if (cause instanceof EmbedAbortedError || options.signal?.aborted) return aborted();
          options.onProgress?.(`embed failed for ${path} chunk ${i.toString()}: ${errorMessage(cause)}`);
          fileFailed = true;
          if (bounded) {
            failed += 1;
            pendingFiles += found.length - position;
            return counters("pending", "embedding-error");
          }
        }
      }
      if (fileFailed || out.length !== chunks.length) {
        failed += 1;
        pendingFiles += 1;
        options.onProgress?.(`${at}✗ ${path} (embedding failed — kept ${prior ? "previous index entry" : "nothing"})`);
        continue;
      }
      const finalIdentity = await checkpointFileIdentity(path, corpus);
      if (options.signal?.aborted) return aborted();
      if (!sameIdentity(finalIdentity.identity, captured.identity)) {
        await clearCheckpoint(indexPath);
        failed += 1;
        pendingFiles += 1;
        continue;
      }
      const completed: FileEntry = {
        chunks: out,
        ...(!isPdf ? { chunkerVersion: NOTES_CHUNKER_VERSION, sourceHash } : {}),
        mtimeMs,
        path
      };
      currentFiles = [...currentFiles.filter((entry) => entry.path !== path && foundPaths.has(entry.path)), completed]
        .sort((left, right) => left.path.localeCompare(right.path));
      index = { builtAtIso: new Date().toISOString(), files: currentFiles, model: options.model, version: NOTES_INDEX_SCHEMA_VERSION };
      if (options.signal?.aborted) return aborted();
      if (!(await saveIndex(stagingPath, index, options))) return aborted();
      if (options.signal?.aborted) return aborted();
      await clearCheckpoint(indexPath, options);
      embedded += 1;
      options.onProgress?.(`${at}+ ${path} (${out.length.toString()}/${chunks.length.toString()} chunk${chunks.length === 1 ? "" : "s"} embedded)`);
    }
    if (!bounded && !index) {
      if (options.signal?.aborted) return aborted();
      index = { builtAtIso: new Date().toISOString(), files: currentFiles, model: options.model, version: NOTES_INDEX_SCHEMA_VERSION };
      if (!(await saveIndex(indexPath, index, options))) return aborted();
    }
    if (pendingFiles > 0 || failed > 0) return counters("pending", "embedding-error");
    if (stagingPath !== indexPath) {
      if (!index || index.files.length !== found.length) {
        pendingFiles = Math.max(1, found.length - (index?.files.length ?? 0));
        return counters("pending", "budget");
      }
      if (options.signal?.aborted) return aborted();
      if (!(await saveIndex(indexPath, index, options))) return aborted();
      liveIndex = index;
      if (options.signal?.aborted) return aborted();
      await rm(stagingPath, { force: true });
      await clearCheckpoint(indexPath);
    }
    return counters("complete");
  });
  if (outcome.kind === "lock-held") return { attemptedEmbeddings: 0, indexPath, pendingReason: "writer-active", status: "busy" };
  if (outcome.kind === "lock-error") throw new Error(`notes reindex lock failed: ${outcome.error}`);
  return outcome.value;
}

/**
 * Returns true when the indexed notes corpus no longer matches disk.
 * Text notes are read and hashed so preserved mtimes cannot hide source-byte
 * changes; PDFs and newly discovered files retain the existing mtime check.
 */
export async function isNotesIndexStale(dir: string, indexPath?: string): Promise<boolean> {
  const index = await loadIndex(indexPath ?? defaultIndexPath());
  if (!index) return true;
  const builtMs = new Date(index.builtAtIso).getTime();
  if (!Number.isFinite(builtMs)) return true;
  const files = await walkMarkdown(dir);
  const indexedPaths = new Set(index.files.map((entry) => pathResolve(entry.path)));
  const currentPaths = new Set(files.map((entry) => pathResolve(entry.path)));
  if (indexedPaths.size !== currentPaths.size || [...indexedPaths].some((path) => !currentPaths.has(path))) return true;
  // Dogfood-found case: a previous test run built the index against
  // a tmp NOTES_DIR (e.g. /var/folders/.../tmp.XYZ/notes/n.md) and the
  // index file remained under ~/.muse/. Subsequent `muse ask` loaded
  // the stale index because no file in the *current* notesDir had a
  // newer mtime than the build — so the agent grounded on a file
  // whose path no longer existed on disk. Detect both shapes:
  //   - indexed file lives outside the current dir → wrong-corpus stale
  //   - indexed file no longer exists on disk     → ghost stale
  const resolvedDir = pathResolve(dir);
  for (const entry of index.files) {
    const isPdf = /\.pdf$/iu.test(entry.path);
    if (!isPdf && (entry.sourceHash === undefined || entry.chunkerVersion !== NOTES_CHUNKER_VERSION)) {
      return true;
    }
    const resolvedPath = pathResolve(entry.path);
    const insideDir = resolvedPath === resolvedDir
      || resolvedPath.startsWith(`${resolvedDir}${pathSep}`);
    if (!insideDir) {
      return true;
    }
    try {
      await stat(entry.path);
      if (!isPdf && hashSourceBytes(await readFile(entry.path)) !== entry.sourceHash) {
        return true;
      }
    } catch {
      return true;
    }
  }
  for (const { mtimeMs } of files) {
    if (mtimeMs > builtMs) return true;
  }
  return false;
}

// Absent flag → fallback. A genuine number is truncated and
// clamped to max; a non-numeric / below-min value (typo, unit
// slip like `5x`, `abc`, `0`) rejects with a clear message
// instead of silently using the default — the strict-numeric
// line. `Number()` not `parseInt` so `600x` rejects, not 600.
export function parseRagBoundedInt(
  raw: string | undefined,
  flag: string,
  min: number,
  max: number,
  fallback: number
): number {
  if (raw === undefined || raw.trim().length === 0) {
    return fallback;
  }
  const parsed = Number(raw.trim());
  if (!Number.isFinite(parsed) || parsed < min) {
    throw new Error(`${flag} must be an integer in [${min.toString()}, ${max.toString()}] (got '${raw}')`);
  }
  return Math.min(max, Math.trunc(parsed));
}
