/**
 * `muse notes reindex` / `muse notes search` — local vector RAG.
 *
 * Embeds Markdown notes via Ollama (`nomic-embed-text` by default,
 * 270 MB, Apache 2.0). Stores a flat JSON index at
 * `~/.muse/notes-index.json`. Search runs cosine similarity in-
 * process — fast enough for personal-scale corpora (≤ ~10 000 chunks).
 *
 * Pure local + zero recurring cost. No vector DB binary; flat JSON
 * keeps the surface small. When the user's note collection grows
 * past the comfort threshold a follow-up iter can swap in
 * sqlite-vec without changing the CLI contract.
 *
 * Tool surface: also registers `muse.notes.semantic_search` as a
 * loopback MCP tool so the agent can call it during a chat turn
 * ("what did I say about Q3?" → search → context).
 */

import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename as pathBasename, join as pathJoin, relative as pathRelative, resolve as pathResolve, sep as pathSep } from "node:path";

import { annotateNoteChunks } from "@muse/agent-core";
import { createMuseRuntimeAssembly, resolveNotesDir } from "@muse/autoconfigure";
import type { Command } from "commander";

import { chunkText } from "./notes-chunk.js";
import { pluralize } from "./pluralize.js";

export { chunkText } from "./notes-chunk.js";
import { parsePdfBuffer } from "./commands-read.js";
import { embed } from "./embed.js";
import { formatBridges, selectBridges } from "./note-bridges.js";
import { classifyNoteContradiction, formatNoteConflicts, selectConflictCandidatePairs, selectSemanticConflictCandidatePairs, type ConflictNote, type NoteConflict } from "./note-conflicts.js";
import { coreShellRanking, readTrails, resolveTrailsFile, topCoRecalled } from "./recall-trail.js";
import type { ProgramIO } from "./program.js";

import { DEFAULT_EMBED_MODEL } from "./embed-model-default.js";

export { DEFAULT_EMBED_MODEL, LEGACY_EMBED_MODEL, resolveIndexModel } from "./embed-model-default.js";
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
export async function extractDocumentText(path: string): Promise<string> {
  if (/\.pdf$/iu.test(path)) {
    return (await parsePdfBuffer(await readFile(path))).text;
  }
  return readFile(path, "utf8");
}
const DEFAULT_TOP_K = 5;

interface IndexChunk {
  readonly file: string;
  readonly chunkIndex: number;
  readonly text: string;
  readonly embedding: number[];
}

interface FileEntry {
  readonly path: string;
  readonly mtimeMs: number;
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
export const NOTES_INDEX_SCHEMA_VERSION = 1;

interface NotesIndex {
  readonly version: typeof NOTES_INDEX_SCHEMA_VERSION;
  readonly model: string;
  readonly builtAtIso: string;
  readonly files: FileEntry[];
}

export function defaultIndexPath(): string {
  const envHome = process.env.HOME?.trim();
  if (envHome && envHome.length > 0) return pathJoin(envHome, ".muse", "notes-index.json");
  const sysHome = homedir().trim();
  if (sysHome.length > 0) return pathJoin(sysHome, ".muse", "notes-index.json");
  throw new Error("Cannot resolve home directory for notes-index.json — HOME is empty and os.homedir() returned no value");
}

/**
 * Expanding review intervals (days) for spaced revisiting — the spacing
 * effect (Ebbinghaus 1885, "Über das Gedächtnis") operationalised as a
 * Leitner-style expanding schedule: a note resurfaces as its age first
 * crosses each interval, fighting the forgetting curve.
 */
export const REVISIT_INTERVALS_DAYS = [1, 3, 7, 16, 35, 90, 180] as const;

/**
 * The review interval a note's age (in days) lands on TODAY, or undefined
 * when it isn't due. Day-granular: due when `floor(ageDays)` equals an
 * interval, so a daily `muse notes review` surfaces each note once per
 * interval. Negative / non-finite age ⇒ not due.
 */
export function revisitDueInterval(ageDays: number): number | undefined {
  if (!Number.isFinite(ageDays) || ageDays < 0) {
    return undefined;
  }
  const day = Math.floor(ageDays);
  return REVISIT_INTERVALS_DAYS.find((interval) => interval === day);
}

export interface RevisitCandidate {
  readonly path: string;
  readonly ageDays: number;
}

export interface RevisitDue {
  readonly path: string;
  readonly intervalDays: number;
  readonly ageDays: number;
}

/** Notes due for a spaced revisit today, soonest-interval first (path tiebreak). */
export function selectNotesForRevisit(notes: readonly RevisitCandidate[]): RevisitDue[] {
  return notes
    .flatMap((note) => {
      const intervalDays = revisitDueInterval(note.ageDays);
      return intervalDays === undefined ? [] : [{ ageDays: note.ageDays, intervalDays, path: note.path }];
    })
    .sort((a, b) => a.intervalDays - b.intervalDays || a.path.localeCompare(b.path));
}

/**
 * Walk the notes dir and return the notes due for a spaced revisit today.
 * Shared by `muse notes review` and the `muse today` briefing so both
 * surface the same set. Fail-soft: an unreadable dir yields []. */
export async function collectDueRevisits(dir: string, nowMs: number = Date.now()): Promise<RevisitDue[]> {
  const files = await walkMarkdown(dir);
  return selectNotesForRevisit(files.map((file) => ({ ageDays: (nowMs - file.mtimeMs) / 86_400_000, path: file.path })));
}

async function walkMarkdown(dir: string): Promise<readonly { path: string; mtimeMs: number }[]> {
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

/** Recently-edited notes, newest first — "what was I working on?" Pure (over pre-walked files). */
export function selectRecentNotes(
  files: readonly { readonly path: string; readonly mtimeMs: number }[],
  limit = 10
): readonly { readonly path: string; readonly mtimeMs: number }[] {
  return [...files].sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, Math.max(1, limit));
}

/** A coarse PAST-relative age — "just now" / "12m ago" / "3h ago" / "2d ago". Pure. */
export function formatRelativeAge(deltaMs: number): string {
  const mins = Math.round(deltaMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins.toString()}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours.toString()}h ago`;
  const days = Math.round(hours / 24);
  return `${days.toString()}d ago`;
}

/** Human-readable "recently edited" list for `muse notes recent`. Pure. */
export function formatRecentNotes(
  entries: readonly { readonly path: string; readonly mtimeMs: number }[],
  notesDir: string,
  now: Date
): string {
  if (entries.length === 0) {
    return "No notes yet. Capture one with `muse note <thought>` or `muse notes save`.\n";
  }
  const nowMs = now.getTime();
  const lines = entries.map((entry) => `  ${formatRelativeAge(nowMs - entry.mtimeMs)} — ${pathRelative(notesDir, entry.path)}`);
  return `📝 Recently edited:\n${lines.join("\n")}\n`;
}

export interface FolderSummary {
  readonly folder: string;
  readonly count: number;
  /** mtime of the MOST recently edited note in the folder (last activity). */
  readonly newestMs: number;
  /** mtime of the OLDEST note in the folder. */
  readonly oldestMs: number;
}

/**
 * Group notes by their TOP-LEVEL folder under `notesDir` (a root-level note →
 * "(root)") and aggregate the count + the newest/oldest edit time, so the user
 * can see where their knowledge lives and which collections have gone cold.
 * Sorted by note count desc, then folder name. Pure.
 */
export function summarizeNoteFolders(
  files: readonly { readonly path: string; readonly mtimeMs: number }[],
  notesDir: string
): readonly FolderSummary[] {
  const byFolder = new Map<string, { count: number; newestMs: number; oldestMs: number }>();
  for (const file of files) {
    const segments = pathRelative(notesDir, file.path).split(/[/\\]/u);
    const folder = segments.length > 1 ? segments[0]! : "(root)";
    const current = byFolder.get(folder);
    if (current) {
      current.count += 1;
      current.newestMs = Math.max(current.newestMs, file.mtimeMs);
      current.oldestMs = Math.min(current.oldestMs, file.mtimeMs);
    } else {
      byFolder.set(folder, { count: 1, newestMs: file.mtimeMs, oldestMs: file.mtimeMs });
    }
  }
  return [...byFolder.entries()]
    .map(([folder, stats]) => ({ folder, ...stats }))
    .sort((a, b) => b.count - a.count || a.folder.localeCompare(b.folder));
}

/** A note collection whose NEWEST note hasn't changed in this long has gone cold. */
const FOLDER_STALE_MS = 90 * 86_400_000;

/** Human-readable note-collection overview for `muse notes folders`. Pure. */
export function formatNoteFolders(summaries: readonly FolderSummary[], now: Date): string {
  if (summaries.length === 0) {
    return "📁 No notes yet. Capture one with `muse note <thought>` or `muse notes save`.\n";
  }
  const nowMs = now.getTime();
  const totalNotes = summaries.reduce((sum, summary) => sum + summary.count, 0);
  const width = Math.max(...summaries.map((summary) => summary.folder.length));
  const lines = summaries.map((summary) => {
    const cold = nowMs - summary.newestMs > FOLDER_STALE_MS ? "  ⚠ gone cold" : "";
    const noun = summary.count === 1 ? "note " : "notes";
    return `  ${summary.folder.padEnd(width)}  ${summary.count.toString().padStart(3)} ${noun}   last edit ${formatRelativeAge(nowMs - summary.newestMs)}${cold}`;
  });
  const folderWord = summaries.length === 1 ? "collection" : "collections";
  return `📁 Your note ${folderWord} (${summaries.length.toString()} ${pluralize(summaries.length, "folder")}, ${totalNotes.toString()} ${pluralize(totalNotes, "note")}):\n${lines.join("\n")}\n`;
}

export function cosine(a: readonly number[], b: readonly number[]): number {
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
function noteCentroid(chunks: readonly { readonly embedding: readonly number[] }[]): number[] {
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

/** Human-readable related-notes list (score as a %). Pure. */
export function formatRelatedNotes(targetPath: string, related: readonly RelatedNote[], notesDir: string): string {
  const rel = (path: string): string => pathRelative(notesDir, path) || pathBasename(path);
  if (related.length === 0) {
    return `No notes are semantically related to '${rel(targetPath)}' yet (or it stands alone).\n`;
  }
  const lines = [`🔗 Notes related to '${rel(targetPath)}':`];
  for (const note of related) {
    lines.push(`  ${(note.score * 100).toFixed(0).padStart(3)}%  ${rel(note.path)}`);
  }
  return `${lines.join("\n")}\n`;
}

async function loadIndex(path: string): Promise<NotesIndex | undefined> {
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
  // than carrying incompatible entries forward.
  if (!isNotesIndexValid(candidate)) return undefined;
  return candidate as NotesIndex;
}

/**
 * Pure validator for the on-disk `notes-index.json`.
 * Exported so the auto-stale check + tests share the same
 * predicate (no risk of the loader accepting a shape the
 * stale-check rejects).
 */
export function isNotesIndexValid(candidate: { readonly version?: unknown } | null | undefined): boolean {
  if (!candidate || typeof candidate !== "object") return false;
  return (candidate as { version?: unknown }).version === NOTES_INDEX_SCHEMA_VERSION;
}

async function saveIndex(path: string, index: NotesIndex): Promise<void> {
  await mkdir(pathJoin(path, ".."), { recursive: true });
  await writeFile(path, `${JSON.stringify(index, null, 2)}\n`, { mode: 0o600 });
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
    if (prior && prior.mtimeMs === mtimeMs) {
      next.push(prior);
      skipped += 1;
      continue;
    }
    let body: string;
    try {
      body = await extractDocumentText(path);
    } catch (cause) {
      failed += 1;
      options.onProgress?.(`${at}✗ ${path} (could not read — skipped: ${cause instanceof Error ? cause.message : String(cause)})`);
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
        const embedding = await embed(annotated[i]?.embedText ?? chunks[i]!, options.model, options.fetchImpl ? { fetchImpl: options.fetchImpl } : {});
        out.push({ chunkIndex: i, embedding, file: path, text: chunks[i]! });
      } catch (cause) {
        options.onProgress?.(`embed failed for ${path} chunk ${i.toString()}: ${cause instanceof Error ? cause.message : String(cause)}`);
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
    next.push({ chunks: out, mtimeMs, path });
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
 * Returns true when at least one Markdown file under `dir` has an
 * mtime newer than the index's `builtAtIso`. Cheap (stat-only). Use
 * to skip the embed loop when nothing's changed.
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
    const resolvedPath = pathResolve(entry.path);
    const insideDir = resolvedPath === resolvedDir
      || resolvedPath.startsWith(`${resolvedDir}${pathSep}`);
    if (!insideDir) {
      return true;
    }
    try {
      await stat(entry.path);
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

/** Read every note body via the local provider and build the wiki-link graph. Shared by `notes links` / `notes graph` / `recall --expand`. */
export async function loadNoteLinkGraph(dir: string): Promise<import("./notes-links.js").NoteLinkGraph> {
  const { LocalDirNotesProvider } = await import("@muse/mcp");
  const { buildNoteLinkGraph } = await import("./notes-links.js");
  const provider = new LocalDirNotesProvider({ notesDir: dir });
  const entries = await provider.list();
  const docs: { id: string; body: string }[] = [];
  for (const entry of entries) {
    const read = await provider.read(entry.id);
    if (read?.body) {
      docs.push({ body: read.body, id: entry.id });
    }
  }
  return buildNoteLinkGraph(docs);
}

export function registerNotesRagCommands(program: Command, io: ProgramIO): void {
  // `notes` is registered upstream by commands-notes.ts (the API-wrapping
  // surface). Find it instead of recreating so reindex/search land
  // under the same `muse notes ...` namespace alongside list/add/etc.
  const notes = program.commands.find((cmd) => cmd.name() === "notes")
    ?? program.command("notes").description("Markdown notes");

  notes
    .command("reindex")
    .description("Walk MUSE_NOTES_DIR, chunk + embed every Markdown file, write a flat JSON index")
    .option("--dir <path>", "Notes directory (default MUSE_NOTES_DIR or ~/.muse/notes)")
    .option("--model <tag>", `Embedding model on Ollama (default ${DEFAULT_EMBED_MODEL})`, DEFAULT_EMBED_MODEL)
    .option("--chunk-chars <n>", `Approximate chunk size in characters (default ${DEFAULT_CHUNK_CHARS.toString()})`, DEFAULT_CHUNK_CHARS.toString())
    .option("--force", "Re-embed every file even if mtime hasn't changed since last index")
    .action(async (options: {
      readonly dir?: string;
      readonly model: string;
      readonly chunkChars: string;
      readonly force?: boolean;
    }) => {
      const dir = options.dir ?? resolveNotesDir(process.env as Record<string, string | undefined>);
      const model = options.model;
      const chunkChars = parseRagBoundedInt(options.chunkChars, "--chunk-chars", 120, 8000, DEFAULT_CHUNK_CHARS);
      const indexPath = defaultIndexPath();

      io.stdout(`muse notes reindex — dir=${dir} model=${model} chunk=${chunkChars.toString()}\n`);
      const summary = await reindexNotes({
        chunkChars,
        dir,
        ...(options.force === true ? { force: true } : {}),
        indexPath,
        model,
        onProgress: (line) => io.stdout(`  ${line}\n`)
      });
      io.stdout(`\n${formatReindexOutcome(summary, { dir })}\n`);
      if (summary.failed > 0) {
        io.stderr(
          `(${summary.failed.toString()} file(s) failed to embed — is Ollama running with '${model}' pulled? ` +
          `Run \`ollama pull ${model}\` and re-run \`muse notes reindex\`. RAG over those notes is unavailable until then.)\n`
        );
        if (summary.embedded === 0) {
          process.exitCode = 1;
        }
      }
    });

  notes
    .command("conflicts")
    .description("Find places your OWN notes disagree — pairs that assert contradictory facts (two different WiFi passwords, prices, dates) so you can fix them before Muse grounds an answer on the wrong one. Read-only; uses the local model. Use when you suspect stale/duplicated notes; not for finding RELATED notes (that is `notes related`).")
    .option("--dir <path>", "Notes directory (default MUSE_NOTES_DIR or ~/.muse/notes)")
    .option("--max <n>", "Max candidate pairs to check with the model (cost cap)", "12")
    .option("--semantic", "ALSO pair notes by embedding similarity (catches conflicts that share little vocabulary, e.g. 'rent 2000/mo' vs 'monthly housing 1800'). Needs an index (`muse notes reindex`).")
    .option("--model <tag>", "Model override")
    .option("--json", "Print structured conflicts instead of the grouped list")
    .action(async (options: { readonly dir?: string; readonly max: string; readonly semantic?: boolean; readonly model?: string; readonly json?: boolean }) => {
      const dir = options.dir ?? resolveNotesDir(process.env as Record<string, string | undefined>);
      const maxPairs = parseRagBoundedInt(options.max, "--max", 1, 100, 12);

      const noteBodies: ConflictNote[] = [];
      try {
        const rels = await readdir(dir, { recursive: true });
        for (const rel of rels) {
          const name = typeof rel === "string" ? rel : String(rel);
          if (!/\.(md|markdown|txt)$/iu.test(name)) continue;
          const abs = pathJoin(dir, name);
          try {
            const fileStat = await stat(abs);
            if (!fileStat.isFile()) continue;
            const body = await readFile(abs, "utf8");
            if (body.trim().length > 0) noteBodies.push({ body, path: name.split(pathSep).join("/") });
          } catch {
            // unreadable file — skip, never abort the scan
          }
        }
      } catch (cause) {
        io.stderr(`muse: cannot read notes dir ${dir} (${cause instanceof Error ? cause.message : String(cause)})\n`);
        process.exitCode = 1;
        return;
      }

      const candidates: { readonly a: ConflictNote; readonly b: ConflictNote }[] =
        selectConflictCandidatePairs(noteBodies, { maxPairs }).map((p) => ({ a: p.a, b: p.b }));

      if (options.semantic) {
        const index = await loadIndex(defaultIndexPath());
        if (!index) {
          io.stderr("muse notes conflicts --semantic needs a notes index. Run `muse notes reindex` first.\n");
          process.exitCode = 1;
          return;
        }
        const semNotes = index.files
          .filter((file) => file.chunks.length > 0)
          .map((file) => ({
            body: file.chunks.map((chunk) => chunk.text).join("\n"),
            centroid: noteCentroid(file.chunks),
            path: (pathRelative(dir, file.path) || pathBasename(file.path)).split(pathSep).join("/")
          }));
        const pairKey = (a: string, b: string): string => (a < b ? `${a}|${b}` : `${b}|${a}`);
        const seen = new Set(candidates.map((p) => pairKey(p.a.path, p.b.path)));
        for (const pair of selectSemanticConflictCandidatePairs(semNotes, cosine, { maxPairs })) {
          const key = pairKey(pair.a.path, pair.b.path);
          if (seen.has(key) || candidates.length >= maxPairs) continue;
          seen.add(key);
          candidates.push({ a: { body: pair.a.body, path: pair.a.path }, b: { body: pair.b.body, path: pair.b.path } });
        }
      }

      if (candidates.length === 0) {
        io.stdout(options.json ? `${JSON.stringify({ checked: 0, conflicts: [] }, null, 2)}\n` : "✓ No overlapping note pairs to compare.\n");
        return;
      }

      const assembly = createMuseRuntimeAssembly({});
      const model = options.model ?? assembly.defaultModel;
      if (!assembly.modelProvider || !model) {
        io.stderr("muse notes conflicts requires a configured model. Set MUSE_MODEL or pass --model.\n");
        process.exitCode = 2;
        return;
      }

      const conflicts: NoteConflict[] = [];
      for (const pair of candidates) {
        const verdict = await classifyNoteContradiction(pair.a.body, pair.b.body, { model, modelProvider: assembly.modelProvider });
        if (verdict === "contradict") conflicts.push({ a: pair.a.path, b: pair.b.path });
      }

      if (options.json) {
        io.stdout(`${JSON.stringify({ checked: candidates.length, conflicts }, null, 2)}\n`);
        return;
      }
      io.stdout(formatNoteConflicts(conflicts));
    });

  notes
    .command("semantic")
    .description("Semantic search across the notes index — cosine similarity, top-K results (substring `notes search` is the existing literal-text path)")
    .argument("<query...>", "Free-text query")
    .option("--top <k>", `Number of results to return (default ${DEFAULT_TOP_K.toString()})`, DEFAULT_TOP_K.toString())
    .option("--model <tag>", "Embedding model (must match the index)", DEFAULT_EMBED_MODEL)
    .option("--json", "Print JSON instead of formatted text")
    .option(
      "--no-auto-reindex",
      "Skip the auto-stale check before search (default: reindex incrementally when a note's mtime is newer than the index)"
    )
    .action(async (queryParts: readonly string[], options: { readonly top: string; readonly model: string; readonly json?: boolean; readonly autoReindex?: boolean }) => {
      const query = queryParts.join(" ").trim();
      if (query.length === 0) {
        io.stderr("usage: muse notes search <query>\n");
        process.exitCode = 1;
        return;
      }
      const indexPath = defaultIndexPath();
      // Preserve the model the index was built with: a stale
      // refresh must NOT silently re-embed an existing custom-model
      // index with the default just because this search omitted
      // --model. The mismatch is still surfaced by the explicit
      // guard below — consistently, stale or not.
      const existingIndexModel = (await loadIndex(indexPath))?.model;

      // Auto-stale check + incremental reindex (default on). Same
      // JARVIS rule as `muse ask` — semantic search results MUST
      // reflect the current notes dir, not whatever was indexed
      // last time. Failures fall through with a notice so search
      // still works against the stale index.
      if (options.autoReindex !== false) {
        try {
          const notesDir = resolveNotesDir(process.env as Record<string, string | undefined>);
          const stale = await isNotesIndexStale(notesDir, indexPath);
          if (stale) {
            const summary = await reindexNotes({
              dir: notesDir,
              indexPath,
              model: existingIndexModel ?? options.model
            });
            if (summary.embedded > 0 && !options.json) {
              io.stderr(`(auto-refreshed notes index: ${summary.embedded.toString()} embedded, ${summary.skipped.toString()} cached)\n`);
            }
          }
        } catch (cause) {
          if (!options.json) {
            io.stderr(`(auto-reindex skipped: ${cause instanceof Error ? cause.message : String(cause)})\n`);
          }
        }
      }

      const index = await loadIndex(indexPath);
      if (!index) {
        io.stderr(`No index at ${indexPath}. Run 'muse notes reindex' first.\n`);
        process.exitCode = 1;
        return;
      }
      if (index.model !== options.model) {
        io.stderr(`Index built with model '${index.model}', search using '${options.model}'. Re-index or pass --model ${index.model}.\n`);
        process.exitCode = 1;
        return;
      }

      const queryEmbedding = await embed(query, options.model);
      const k = parseRagBoundedInt(options.top, "--top", 1, 50, DEFAULT_TOP_K);

      const scored = index.files.flatMap((f) => f.chunks.map((chunk) => ({
        chunk,
        file: f.path,
        score: cosine(queryEmbedding, chunk.embedding)
      }))).sort((a, b) => b.score - a.score).slice(0, k);

      if (options.json) {
        io.stdout(`${JSON.stringify({ query, results: scored.map((r) => ({ file: r.file, score: r.score, text: r.chunk.text })) }, null, 2)}\n`);
        return;
      }

      io.stdout(`Top ${scored.length.toString()} match(es) for "${query}":\n\n`);
      for (let i = 0; i < scored.length; i += 1) {
        const r = scored[i]!;
        io.stdout(`  ${(i + 1).toString()}. [${r.score.toFixed(3)}] ${r.file}#${r.chunk.chunkIndex.toString()}\n`);
        const snippet = r.chunk.text.length > 200 ? `${r.chunk.text.slice(0, 197)}…` : r.chunk.text;
        io.stdout(`     ${snippet.split("\n").join(" ").trim()}\n\n`);
      }
    });

  notes
    .command("links")
    .description("Show a note's [[wiki-links]] and its backlinks (notes that link to it) — Zettelkasten-style networked notes. Read-only, deterministic.")
    .argument("<query>", "Note id or name, e.g. 'health' or 'inbox/2026-05-01.md'")
    .option("--dir <path>", "Notes directory (default MUSE_NOTES_DIR or ~/.muse/notes)")
    .option("--json", "Print JSON instead of formatted text")
    .action(async (query: string, options: { readonly dir?: string; readonly json?: boolean }) => {
      const { noteLinkView, resolveNoteId } = await import("./notes-links.js");
      const dir = options.dir ?? resolveNotesDir(process.env as Record<string, string | undefined>);
      const graph = await loadNoteLinkGraph(dir);
      const noteId = resolveNoteId(graph, query);
      if (!noteId) {
        io.stderr(`No note matching '${query}' in ${dir}.\n`);
        process.exitCode = 1;
        return;
      }
      const view = noteLinkView(graph, noteId);
      if (options.json) {
        io.stdout(`${JSON.stringify({ note: noteId, ...view }, null, 2)}\n`);
        return;
      }
      io.stdout(`Links for ${noteId}:\n`);
      if (view.outbound.length === 0) {
        io.stdout("  → (no outbound [[links]])\n");
      } else {
        for (const link of view.outbound) {
          io.stdout(`  → ${link.target}${link.resolvedId ? ` (${link.resolvedId})` : " (unresolved)"}\n`);
        }
      }
      if (view.backlinks.length === 0) {
        io.stdout("  ← (no backlinks)\n");
      } else {
        for (const source of view.backlinks) {
          io.stdout(`  ← ${source}\n`);
        }
      }
    });

  notes
    .command("graph")
    .description("Audit the note link graph — orphan notes (no [[links]] in or out), terminal notes (linked-to but linking nowhere — stubs worth expanding), and broken links (targets that don't resolve). Zettelkasten hygiene. Read-only, deterministic.")
    .option("--dir <path>", "Notes directory (default MUSE_NOTES_DIR or ~/.muse/notes)")
    .option("--json", "Print JSON instead of formatted text")
    .action(async (options: { readonly dir?: string; readonly json?: boolean }) => {
      const { auditNoteGraph } = await import("./notes-links.js");
      const dir = options.dir ?? resolveNotesDir(process.env as Record<string, string | undefined>);
      const audit = auditNoteGraph(await loadNoteLinkGraph(dir));
      if (options.json) {
        io.stdout(`${JSON.stringify(audit, null, 2)}\n`);
        return;
      }
      io.stdout(`Note graph audit (${dir}):\n`);
      if (audit.brokenLinks.length === 0) {
        io.stdout("  ✓ no broken links\n");
      } else {
        io.stdout(`  ⚠ ${audit.brokenLinks.length.toString()} broken link(s):\n`);
        for (const broken of audit.brokenLinks) {
          io.stdout(`    ${broken.source} → [[${broken.target}]] (unresolved)\n`);
        }
      }
      if (audit.orphans.length === 0) {
        io.stdout("  ✓ no orphan notes\n");
      } else {
        io.stdout(`  ⚠ ${audit.orphans.length.toString()} orphan note(s) (no links in or out):\n`);
        for (const orphan of audit.orphans) {
          io.stdout(`    ${orphan}\n`);
        }
      }
      if (audit.terminals.length === 0) {
        io.stdout("  ✓ no terminal notes\n");
      } else {
        io.stdout(`  ⚠ ${audit.terminals.length.toString()} terminal note(s) (linked-to but linking nowhere — stubs worth expanding):\n`);
        for (const terminal of audit.terminals) {
          io.stdout(`    ${terminal}\n`);
        }
      }
    });

  notes
    .command("review")
    .description("Resurface notes due for a spaced revisit — the spacing effect (Ebbinghaus) / Leitner expanding intervals (1,3,7,16,35,90,180 days) bring an old note back before you forget it. Read-only, deterministic (uses file mtime; no Ollama).")
    .option("--dir <path>", "Notes directory (default MUSE_NOTES_DIR or ~/.muse/notes)")
    .option("--json", "Print JSON instead of formatted text")
    .action(async (options: { readonly dir?: string; readonly json?: boolean }) => {
      const dir = options.dir ?? resolveNotesDir(process.env as Record<string, string | undefined>);
      const due = await collectDueRevisits(dir);

      if (options.json) {
        io.stdout(`${JSON.stringify(due, null, 2)}\n`);
        return;
      }
      if (due.length === 0) {
        io.stdout("No notes are due for a spaced revisit today.\n");
        return;
      }
      io.stdout("📒 Worth revisiting (spaced review):\n");
      for (const item of due) {
        io.stdout(`  [${item.intervalDays.toString()}d] ${item.path} — last touched ${Math.floor(item.ageDays).toString()}d ago\n`);
      }
    });

  notes
    .command("recent")
    .description("Show your most recently edited notes (newest first) — resume where you left off across all folders. Read-only, deterministic (uses file mtime; no Ollama).")
    .option("--dir <path>", "Notes directory (default MUSE_NOTES_DIR or ~/.muse/notes)")
    .option("--limit <n>", "How many to show (default 10)")
    .option("--json", "Print JSON instead of formatted text")
    .action(async (options: { readonly dir?: string; readonly limit?: string; readonly json?: boolean }) => {
      const dir = options.dir ?? resolveNotesDir(process.env as Record<string, string | undefined>);
      const limit = options.limit !== undefined && Number.isFinite(Number(options.limit))
        ? Math.max(1, Math.trunc(Number(options.limit)))
        : 10;
      const entries = selectRecentNotes(await walkMarkdown(dir), limit);
      if (options.json) {
        io.stdout(`${JSON.stringify(entries.map((entry) => ({ mtimeMs: entry.mtimeMs, path: pathRelative(dir, entry.path) })), null, 2)}\n`);
        return;
      }
      io.stdout(formatRecentNotes(entries, dir, new Date()));
    });

  notes
    .command("folders")
    .description("Show your note COLLECTIONS (top-level folders) with note counts + last-activity age, so you can see where your knowledge lives and which collections have gone cold. Read-only, deterministic (file mtime; no Ollama).")
    .option("--dir <path>", "Notes directory (default MUSE_NOTES_DIR or ~/.muse/notes)")
    .option("--json", "Print JSON instead of formatted text")
    .action(async (options: { readonly dir?: string; readonly json?: boolean }) => {
      const dir = options.dir ?? resolveNotesDir(process.env as Record<string, string | undefined>);
      const summaries = summarizeNoteFolders(await walkMarkdown(dir), dir);
      if (options.json) {
        io.stdout(`${JSON.stringify(summaries, null, 2)}\n`);
        return;
      }
      io.stdout(formatNoteFolders(summaries, new Date()));
    });

  notes
    .command("related")
    .description("Find notes SEMANTICALLY related to a given note (embedding similarity) — discover connections the [[wiki-links]] missed. Needs a built index (run `muse notes reindex` or any `muse ask` first). Read-only.")
    .argument("<note>", "Note id or basename, e.g. 'project-plan' or 'project-plan.md'")
    .option("--limit <n>", "How many related notes to show (default 5)")
    .option("--json", "Print JSON instead of formatted text")
    .action(async (note: string, options: { readonly limit?: string; readonly json?: boolean }) => {
      const dir = resolveNotesDir(process.env as Record<string, string | undefined>);
      const limit = options.limit !== undefined && Number.isFinite(Number(options.limit))
        ? Math.max(1, Math.trunc(Number(options.limit)))
        : 5;
      const index = await loadIndex(defaultIndexPath());
      if (!index) {
        io.stderr("muse notes related: no notes index yet — run `muse notes reindex` (or any `muse ask`) first.\n");
        process.exitCode = 1;
        return;
      }
      const targetPath = resolveIndexNotePath(index, note);
      if (targetPath === undefined) {
        io.stderr(`No indexed note matches '${note}'. Run \`muse notes list\` to see indexed notes (or reindex if it's new).\n`);
        process.exitCode = 1;
        return;
      }
      const related = rankRelatedNotes(index, targetPath, limit);
      if (options.json) {
        io.stdout(`${JSON.stringify(related.map((r) => ({ path: pathRelative(dir, r.path), score: r.score })), null, 2)}\n`);
        return;
      }
      io.stdout(formatRelatedNotes(targetPath, related, dir));
    });

  notes
    .command("trails")
    .description("Show notes most often RECALLED TOGETHER with this one — emergent usage-based relatedness that builds up as you recall (ant-trail stigmergy), complementing typed [[wiki-links]] and the embedding-based `notes related`. Read-only.")
    .argument("<note>", "Note id or basename, e.g. 'project-plan' or 'project-plan.md'")
    .option("--limit <n>", "How many co-recalled notes to show (default 10)")
    .option("--json", "Print JSON instead of formatted text")
    .action(async (note: string, options: { readonly limit?: string; readonly json?: boolean }) => {
      const dir = resolveNotesDir(process.env as Record<string, string | undefined>);
      const limit = options.limit !== undefined && Number.isFinite(Number(options.limit))
        ? Math.max(1, Math.trunc(Number(options.limit)))
        : 10;
      const index = await loadIndex(defaultIndexPath());
      if (!index) {
        io.stderr("muse notes trails: no notes index yet — run `muse notes reindex` (or any `muse ask`) first.\n");
        process.exitCode = 1;
        return;
      }
      const targetPath = resolveIndexNotePath(index, note);
      if (targetPath === undefined) {
        io.stderr(`No indexed note matches '${note}'. Run \`muse notes list\` to see indexed notes.\n`);
        process.exitCode = 1;
        return;
      }
      const partners = topCoRecalled(await readTrails(resolveTrailsFile(process.env as Record<string, string | undefined>)), targetPath, Date.now(), { limit });
      const rel = (path: string): string => pathRelative(dir, path) || pathBasename(path);
      if (options.json) {
        io.stdout(`${JSON.stringify(partners.map((partner) => ({ path: rel(partner.noteId), strength: partner.strength })), null, 2)}\n`);
        return;
      }
      if (partners.length === 0) {
        io.stdout(`No co-recall trails for '${rel(targetPath)}' yet — trails build as you \`muse recall\` notes together.\n`);
        return;
      }
      io.stdout(`Notes recalled together with ${rel(targetPath)}:\n`);
      for (const partner of partners) {
        io.stdout(`  ${rel(partner.noteId)}  (trail ${partner.strength.toFixed(2)})\n`);
      }
    });

  notes
    .command("hubs")
    .description("Show your structural knowledge HUBS — the load-bearing notes at the dense CORE of your co-recall graph (k-shell decomposition; the deepest-core note, not the most-co-recalled, is the real hub). Builds on `notes trails`; read-only. Use to find what your knowledge centres on; not for one note's neighbours (that is `notes trails`).")
    .option("--limit <n>", "How many hub notes to show (default 10)")
    .option("--json", "Print JSON instead of formatted text")
    .action(async (options: { readonly limit?: string; readonly json?: boolean }) => {
      const dir = resolveNotesDir(process.env as Record<string, string | undefined>);
      const limit = options.limit !== undefined && Number.isFinite(Number(options.limit))
        ? Math.max(1, Math.trunc(Number(options.limit)))
        : 10;
      const rel = (path: string): string => pathRelative(dir, path) || pathBasename(path);
      const hubs = coreShellRanking(await readTrails(resolveTrailsFile(process.env as Record<string, string | undefined>)), Date.now(), { limit });
      if (options.json) {
        io.stdout(`${JSON.stringify(hubs.map((hub) => ({ degree: hub.degree, path: rel(hub.noteId), shell: hub.shell })), null, 2)}\n`);
        return;
      }
      if (hubs.length === 0) {
        io.stdout("No co-recall hubs yet — they emerge as you `muse recall` notes together (then `muse notes trails`/`hubs`).\n");
        return;
      }
      io.stdout("Your knowledge hubs (structural core of your co-recall graph):\n");
      for (const hub of hubs) {
        io.stdout(`  ${rel(hub.noteId)}  (core ${hub.shell.toString()}, co-recalled with ${hub.degree.toString()})\n`);
      }
    });

  notes
    .command("bridges")
    .description("Show your BRIDGE notes — the ones whose [[wiki-links]] connect otherwise-separate topic clusters, where cross-domain insight lives (betweenness centrality / brokerage; ecological keystone). Read-only, deterministic, no Ollama. Use to find the notes that link your different interests; not the dense centre (that is `notes hubs`) or one note's neighbours (`notes related`).")
    .option("--limit <n>", "How many bridge notes to show (default 10)")
    .option("--json", "Print JSON instead of formatted text")
    .action(async (options: { readonly limit?: string; readonly json?: boolean }) => {
      const dir = resolveNotesDir(process.env as Record<string, string | undefined>);
      const limit = options.limit !== undefined && Number.isFinite(Number(options.limit))
        ? Math.max(1, Math.trunc(Number(options.limit)))
        : 10;
      const bridges = selectBridges(await loadNoteLinkGraph(dir), limit);
      if (options.json) {
        io.stdout(`${JSON.stringify(bridges, null, 2)}\n`);
        return;
      }
      io.stdout(`${formatBridges(bridges)}\n`);
    });
}
