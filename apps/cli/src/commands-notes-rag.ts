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
import { join as pathJoin, resolve as pathResolve, sep as pathSep } from "node:path";

import { resolveNotesDir } from "@muse/autoconfigure";
import type { Command } from "commander";

import { resolveOllamaUrl } from "./ollama-url.js";
import type { ProgramIO } from "./program.js";

const DEFAULT_EMBED_MODEL = "nomic-embed-text";
const DEFAULT_CHUNK_CHARS = 600;
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
 * Goal 074 — schema version for `~/.muse/notes-index.json`.
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

function defaultIndexPath(): string {
  const home = process.env.HOME ?? "~";
  return pathJoin(home, ".muse", "notes-index.json");
}

async function embed(text: string, model: string): Promise<number[]> {
  const resp = await fetch(`${resolveOllamaUrl()}/api/embeddings`, {
    body: JSON.stringify({ model, prompt: text }),
    headers: { "content-type": "application/json" },
    method: "POST"
  });
  if (!resp.ok) {
    throw new Error(`embeddings ${resp.status.toString()}: ${await resp.text().catch(() => "")}`);
  }
  const body = await resp.json() as { embedding?: number[] };
  if (!body.embedding || !Array.isArray(body.embedding)) {
    throw new Error("embedding response missing 'embedding' field");
  }
  return body.embedding;
}

/**
 * Paragraph-ish chunking — split by blank lines, then pack into
 * <= CHUNK_CHARS so each chunk is a coherent embedding target.
 * Tiny enough that re-chunking on schema change is cheap.
 */
function chunkText(text: string, chunkChars: number): string[] {
  const paras = text.split(/\n\s*\n/).map((p) => p.trim()).filter((p) => p.length > 0);
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
  return chunks;
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
      } else if (entry.isFile() && /\.(md|markdown|txt)$/i.test(entry.name)) {
        const s = await stat(full);
        out.push({ mtimeMs: s.mtimeMs, path: full });
      }
    }
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

function cosine(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
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
    // Goal 074 — malformed JSON treated the same as a schema
    // mismatch: discard so the next reindex rebuilds.
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const candidate = parsed as Partial<NotesIndex>;
  // Goal 074 — schema-version gate. Discarding the index on
  // version mismatch forces `reindexNotes` to start from a
  // clean slate instead of carrying stale (incompatible)
  // entries forward. `isNotesIndexValid` surfaces the same
  // check to `isNotesIndexStale` so callers can log a hint.
  if (!isNotesIndexValid(candidate)) return undefined;
  return candidate as NotesIndex;
}

/**
 * Goal 074 — pure validator for the on-disk `notes-index.json`.
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
      body = await readFile(path, "utf8");
    } catch {
      failed += 1;
      continue;
    }
    const chunks = chunkText(body, chunkChars);
    const out: IndexChunk[] = [];
    for (let i = 0; i < chunks.length; i += 1) {
      try {
        const embedding = await embed(chunks[i]!, options.model);
        out.push({ chunkIndex: i, embedding, file: path, text: chunks[i]! });
      } catch (cause) {
        options.onProgress?.(`embed failed for ${path} chunk ${i.toString()}: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
    }
    next.push({ chunks: out, mtimeMs, path });
    embedded += 1;
    options.onProgress?.(`+ ${path} (${chunks.length.toString()} chunk${chunks.length === 1 ? "" : "s"})`);
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
      const chunkChars = Math.max(120, Number.parseInt(options.chunkChars, 10) || DEFAULT_CHUNK_CHARS);
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
              model: options.model
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
      const k = Math.max(1, Math.min(50, Number.parseInt(options.top, 10) || DEFAULT_TOP_K));

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
}
