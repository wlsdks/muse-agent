/**
 * Pure local vector RAG core for `muse notes` — index build, load/save,
 * staleness, and cosine-based ranking over a flat JSON index at
 * `~/.muse/notes-index.json`. Framework-free; the CLI wiring lives in
 * `commands-notes-rag.ts`, chat-grounding lazy-imports these by name.
 */

import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { errorMessage } from "@muse/shared";

import { atomicWriteFile, withFileLock, withFileMutationQueue } from "@muse/stores";
import { homedir } from "node:os";
import { basename as pathBasename, join as pathJoin, resolve as pathResolve, sep as pathSep } from "node:path";

import { annotateNoteChunks } from "@muse/agent-core";

import { parsePdfBuffer } from "./document-reader.js";
import { embed } from "./embed.js";
import { chunkText, NOTES_CHUNKER_VERSION } from "./notes-chunk.js";
import { backupVersionMismatchedStore } from "./store-version-backup.js";

const DEFAULT_CHUNK_CHARS = 600;

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
    // v1 stored embeddings inline in the JSON — migrate losslessly (no
    // re-embedding): the same vectors are rewritten into the v2 sidecar.
    const v1 = candidate as unknown as NotesIndex;
    if (Array.isArray(v1.files)) {
      const migrated: NotesIndex = { builtAtIso: v1.builtAtIso, files: v1.files, model: v1.model, version: NOTES_INDEX_SCHEMA_VERSION };
      await saveIndex(path, migrated);
      return loadIndex(path);
    }
  }
  if (!isNotesIndexValid(candidate)) {
    await backupVersionMismatchedStore(path, candidate.version);
    return undefined;
  }
  const inlineFiles = (candidate as NotesIndex).files;
  if (!Array.isArray(inlineFiles)) {
    return candidate as NotesIndex;
  }
  // Self-heal: a v2 JSON still carrying inline embedding arrays (hand-written
  // index, test fixture, or interrupted save) is accepted and rewritten into
  // the sidecar layout instead of being discarded.
  const firstChunk = inlineFiles.flatMap((file) => file.chunks)[0];
  if (firstChunk && Array.isArray((firstChunk as { embedding?: unknown }).embedding)) {
    // Reload from the healed sidecar so EVERY load returns the same
    // representation (Float32Array views) — a first-load/second-load
    // representation split breaks byte-identical parity guarantees.
    const healed: NotesIndex = { builtAtIso: (candidate as NotesIndex).builtAtIso, files: inlineFiles, model: (candidate as NotesIndex).model, version: NOTES_INDEX_SCHEMA_VERSION };
    await saveIndex(path, healed);
    return loadIndex(path);
  }
  if (inlineFiles.length === 0 || inlineFiles.every((file) => file.chunks.length === 0)) {
    return candidate as NotesIndex;
  }
  const meta = candidate as unknown as { readonly embeddingDim?: number; readonly embeddingCount?: number; readonly files?: readonly { readonly path: string; readonly mtimeMs?: number; readonly chunks: readonly { readonly file: string; readonly chunkIndex: number; readonly text: string }[] }[] };
  const dim = meta.embeddingDim ?? 0;
  const count = meta.embeddingCount ?? 0;
  let bin: Buffer;
  try {
    bin = await readFile(embeddingsSidecarPath(path));
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
    await backupVersionMismatchedStore(path, candidate.version);
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

async function saveIndex(path: string, index: NotesIndex): Promise<void> {
  // v2 layout: embeddings live in a Float32 binary sidecar, JSON keeps metadata.
  // JSON-encoded float arrays cost ~19 bytes per number — measured 464MB /
  // 659ms parse / 2.9GB RSS at 10k notes, vs 92MB / ~ms / ~10% RSS as float32.
  // Write order matters: sidecar first, JSON last — the JSON is the commit
  // point, and a crash between the two leaves a v2 JSON whose byte-length
  // check fails on load (treated as stale, reindexed) rather than silently
  // mismatched vectors. Both writes are atomic (tmp + fsync + rename).
  await withFileMutationQueue(path, () => withFileLock(path, async () => {
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
        if (chunk.embedding.length === dim) {
          bin.set(chunk.embedding, at * dim);
        }
        at += 1;
        const { embedding: _embedding, ...rest } = chunk;
        return rest;
      })
    }));
    await atomicWriteFile(embeddingsSidecarPath(path), new Uint8Array(bin.buffer, 0, count * dim * Float32Array.BYTES_PER_ELEMENT));
    await atomicWriteFile(path, `${JSON.stringify({ ...index, embeddingCount: count, embeddingDim: dim, files: metaFiles }, null, 2)}\n`);
  }));
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

/**
 * Reusable reindex routine — used by `muse notes reindex` AND by
 * `muse ask` for auto-reindex when stale. Returns a summary so the
 * caller can decide whether to log progress (CLI) or stay silent
 * (auto-mode).
 */
export interface ReindexSummary {
  readonly indexPath: string;
  /** Markdown files found under the notes dir (0 ⇒ nothing to index). */
  readonly totalFiles: number;
  readonly embedded: number;
  readonly skipped: number;
  readonly failed: number;
  readonly totalChunks: number;
  readonly index: NotesIndex;
}

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
  summary: Pick<ReindexSummary, "totalFiles" | "embedded" | "skipped" | "failed" | "totalChunks" | "indexPath">,
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
  return `Done. ${summary.embedded.toString()} embedded, ${summary.skipped.toString()} cached, ${summary.failed.toString()} failed. ${summary.totalChunks.toString()} chunks total in ${summary.indexPath}`;
}

export async function reindexNotes(
  options: {
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
  }
): Promise<ReindexSummary> {
  const chunkChars = Math.max(120, options.chunkChars ?? DEFAULT_CHUNK_CHARS);
  const indexPath = options.indexPath ?? defaultIndexPath();
  const existing = options.force ? undefined : await loadIndex(indexPath);
  const known = new Map<string, FileEntry>();
  if (existing && existing.model === options.model) {
    for (const entry of existing.files) known.set(entry.path, entry);
  }
  const found = await walkMarkdown(options.dir);
  const next: FileEntry[] = [];
  let embedded = 0, skipped = 0, failed = 0;
  let position = 0;
  // `[i/N]` position so a long reindex shows progress, not a silent stall.
  // Cached files stay quiet (they're instant); embedded/failed files report
  // their position among the N found.
  for (const { path, mtimeMs } of found) {
    position += 1;
    const at = `[${position.toString()}/${found.length.toString()}] `;
    const prior = known.get(path);
    const isPdf = /\.pdf$/iu.test(path);
    let sourceBytes: Buffer | undefined;
    let sourceHash: string | undefined;
    if (!isPdf) {
      try {
        sourceBytes = await readFile(path);
        sourceHash = hashSourceBytes(sourceBytes);
      } catch (cause) {
        failed += 1;
        options.onProgress?.(`${at}✗ ${path} (could not read — skipped: ${errorMessage(cause)})`);
        continue;
      }
    }
    if (prior && prior.mtimeMs === mtimeMs) {
      if (
        isPdf
        || (
          prior.chunkerVersion === NOTES_CHUNKER_VERSION
          && prior.sourceHash === sourceHash
        )
      ) {
        next.push(prior);
        skipped += 1;
        continue;
      }
    }
    let body: string;
    let chunkerVersion: typeof NOTES_CHUNKER_VERSION | undefined;
    try {
      if (isPdf) {
        body = await extractNoteText(path);
      } else {
        body = sourceBytes!.toString("utf8");
        chunkerVersion = NOTES_CHUNKER_VERSION;
      }
    } catch (cause) {
      failed += 1;
      options.onProgress?.(`${at}✗ ${path} (could not read — skipped: ${errorMessage(cause)})`);
      continue;
    }
    const overlap = Math.min(200, Math.max(0, Math.floor(chunkChars / 20)));
    const chunks = chunkText(body, chunkChars, overlap);
    // Contextual annotation (measured: bare-value chunks 5/6 → 6/6): the
    // EMBEDDED text carries "[<file> · <nearest heading>]" so a chunk that is
    // meaningless alone keeps its referent; the STORED text stays raw so the
    // gate, citations, and receipts are unchanged.
    const annotated = annotateNoteChunks(pathBasename(path), body, chunks);
    const out: IndexChunk[] = [];
    for (let i = 0; i < chunks.length; i += 1) {
      try {
        const embedding = await embed(annotated[i]?.embedText ?? chunks[i]!, options.model, {
          ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
          ...(options.baseUrlResolver ? { baseUrlResolver: options.baseUrlResolver } : {})
        });
        out.push({ chunkIndex: i, embedding, file: path, text: chunks[i]! });
      } catch (cause) {
        options.onProgress?.(`embed failed for ${path} chunk ${i.toString()}: ${errorMessage(cause)}`);
      }
    }
    // A file with no successfully-embedded chunks is NOT "embedded" — count it
    // as failed and don't store a hollow entry (which would report false
    // success and then return zero recall hits). Carry forward any prior good
    // index entry for this file so a transient embed outage doesn't wipe it.
    if (out.length === 0) {
      failed += 1;
      const priorEntry = known.get(path);
      if (priorEntry) {
        next.push(priorEntry);
      }
      options.onProgress?.(`${at}✗ ${path} (embedding failed — kept ${priorEntry ? "previous index entry" : "nothing"})`);
      continue;
    }
    next.push({
      chunks: out,
      ...(chunkerVersion !== undefined && sourceHash !== undefined ? { chunkerVersion, sourceHash } : {}),
      mtimeMs,
      path
    });
    embedded += 1;
    options.onProgress?.(`${at}+ ${path} (${out.length.toString()}/${chunks.length.toString()} chunk${chunks.length === 1 ? "" : "s"} embedded)`);
  }
  const index: NotesIndex = {
    builtAtIso: new Date().toISOString(),
    files: next,
    model: options.model,
    version: NOTES_INDEX_SCHEMA_VERSION
  };
  await saveIndex(indexPath, index);
  return {
    embedded,
    failed,
    index,
    indexPath,
    skipped,
    totalFiles: found.length,
    totalChunks: next.reduce((sum, f) => sum + f.chunks.length, 0)
  };
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
  const files = await walkMarkdown(dir);
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
