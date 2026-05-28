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
import { join as pathJoin, resolve as pathResolve, sep as pathSep } from "node:path";

import { applyOverlap } from "@muse/agent-core";
import { resolveNotesDir } from "@muse/autoconfigure";
import type { Command } from "commander";

import { parsePdfBuffer } from "./commands-read.js";
import { embed } from "./embed.js";
import type { ProgramIO } from "./program.js";

export const DEFAULT_EMBED_MODEL = "nomic-embed-text";
const DEFAULT_CHUNK_CHARS = 600;

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
 * Paragraph-ish chunking — split by blank lines, then pack into
 * <= chunkChars so each chunk is a coherent embedding target.
 * Tiny enough that re-chunking on schema change is cheap.
 *
 * A single paragraph longer than `chunkChars` (a wall of text, a code
 * block, a minified blob) is hard-wrapped first, so NO chunk exceeds
 * `chunkChars` — an oversized chunk would overflow the embedding
 * model's context and be silently truncated, dropping retrieval recall
 * for everything past the cutoff.
 */
export function chunkText(text: string, chunkChars: number, overlapChars: number = 0): string[] {
  const paras = text
    .split(/\n\s*\n/)
    .flatMap((p) => hardWrap(p.trim(), chunkChars))
    .filter((p) => p.length > 0);
  const chunks: string[] = [];
  let buf = "";
  for (const para of paras) {
    if (buf.length === 0) {
      buf = para;
    } else if (buf.length + 2 + para.length <= chunkChars) {
      buf = `${buf}\n\n${para}`;
    } else {
      chunks.push(buf);
      buf = para;
    }
  }
  if (buf.length > 0) chunks.push(buf);
  // Overlapping window (default 0 = back-compat): keep a fact straddling a
  // chunk boundary whole in chunk i so the notes-index `muse ask` reads
  // stays retrievable across boundaries. Reuses the shared applyOverlap so
  // both chunkers (this + the knowledge corpus) behave identically.
  return applyOverlap(chunks, overlapChars);
}

/**
 * Break a paragraph longer than `max` into <= `max`-char pieces,
 * preferring the last whitespace in the window so words aren't cut
 * mid-token; an unbreakable run (e.g. a long URL or base64 blob) is
 * cut hard at `max`. Paragraphs already within `max` pass through.
 */
function hardWrap(paragraph: string, max: number): string[] {
  if (paragraph.length <= max) {
    return paragraph.length > 0 ? [paragraph] : [];
  }
  const pieces: string[] = [];
  let rest = paragraph;
  while (rest.length > max) {
    const window = rest.slice(0, max);
    const ws = Math.max(window.lastIndexOf(" "), window.lastIndexOf("\n"), window.lastIndexOf("\t"));
    const cut = ws >= Math.floor(max * 0.6) ? ws : max;
    pieces.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest.length > 0) {
    pieces.push(rest);
  }
  return pieces.filter((p) => p.length > 0);
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
      } else if (entry.isFile() && /\.(md|markdown|txt|pdf)$/i.test(entry.name)) {
        const s = await stat(full);
        out.push({ mtimeMs: s.mtimeMs, path: full });
      }
    }
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
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
  readonly embedded: number;
  readonly skipped: number;
  readonly failed: number;
  readonly totalChunks: number;
  readonly index: NotesIndex;
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
  for (const { path, mtimeMs } of found) {
    const prior = known.get(path);
    if (prior && prior.mtimeMs === mtimeMs) {
      next.push(prior);
      skipped += 1;
      continue;
    }
    let body: string;
    try {
      body = await extractDocumentText(path);
    } catch {
      failed += 1;
      continue;
    }
    const overlap = Math.min(200, Math.max(0, Math.floor(chunkChars / 20)));
    const chunks = chunkText(body, chunkChars, overlap);
    const out: IndexChunk[] = [];
    for (let i = 0; i < chunks.length; i += 1) {
      try {
        const embedding = await embed(chunks[i]!, options.model, options.fetchImpl ? { fetchImpl: options.fetchImpl } : {});
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
      options.onProgress?.(`✗ ${path} (embedding failed — kept ${priorEntry ? "previous index entry" : "nothing"})`);
      continue;
    }
    next.push({ chunks: out, mtimeMs, path });
    embedded += 1;
    options.onProgress?.(`+ ${path} (${out.length.toString()}/${chunks.length.toString()} chunk${chunks.length === 1 ? "" : "s"} embedded)`);
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
    .option("--model <tag>", "Embedding model on Ollama (default nomic-embed-text)", DEFAULT_EMBED_MODEL)
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
      io.stdout(`\nDone. ${summary.embedded.toString()} embedded, ${summary.skipped.toString()} cached, ${summary.failed.toString()} failed. ${summary.totalChunks.toString()} chunks total in ${summary.indexPath}\n`);
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
    .description("Audit the note link graph — orphan notes (no [[links]] in or out) and broken links (targets that don't resolve). Zettelkasten hygiene. Read-only, deterministic.")
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
}
