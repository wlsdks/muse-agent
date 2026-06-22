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

import { readdir, readFile, stat } from "node:fs/promises";
import { basename as pathBasename, join as pathJoin, relative as pathRelative, sep as pathSep } from "node:path";

import { createMuseRuntimeAssembly, resolveNotesDir } from "@muse/autoconfigure";
import type { Command } from "commander";

export { chunkText } from "./notes-chunk.js";
import { embed } from "./embed.js";
import { formatBridges, selectBridges } from "./note-bridges.js";
import { classifyNoteContradiction, formatNoteConflicts, selectConflictCandidatePairs, selectSemanticConflictCandidatePairs, type ConflictNote, type NoteConflict } from "./note-conflicts.js";
import {
  cosine,
  defaultIndexPath,
  formatReindexOutcome,
  isNotesIndexStale,
  loadIndex,
  noteCentroid,
  parseRagBoundedInt,
  rankRelatedNotes,
  reindexNotes,
  resolveIndexNotePath,
  walkMarkdown,
  type RelatedNote
} from "./notes-index.js";
import {
  collectDueRevisits,
  formatNoteFolders,
  formatRecentNotes,
  selectRecentNotes,
  summarizeNoteFolders
} from "./notes-spaced-revisit.js";
import { coreShellRanking, readTrails, resolveTrailsFile, topCoRecalled } from "./recall-trail.js";
import type { ProgramIO } from "./program.js";

import { DEFAULT_EMBED_MODEL } from "./embed-model-default.js";

export { DEFAULT_EMBED_MODEL, LEGACY_EMBED_MODEL, resolveIndexModel } from "./embed-model-default.js";

export {
  NOTE_FILE_RE,
  NOTES_INDEX_SCHEMA_VERSION,
  cosine,
  defaultIndexPath,
  extractDocumentText,
  formatReindexOutcome,
  isNotesIndexStale,
  isNotesIndexValid,
  loadIndex,
  noteCentroid,
  parseRagBoundedInt,
  rankRelatedNotes,
  reindexNotes,
  resolveIndexNotePath,
  walkMarkdown
} from "./notes-index.js";
export type { RelatedNote, ReindexSummary } from "./notes-index.js";

export {
  REVISIT_INTERVALS_DAYS,
  collectDueRevisits,
  formatNoteFolders,
  formatRecentNotes,
  formatRelativeAge,
  revisitDueInterval,
  selectNotesForRevisit,
  selectRecentNotes,
  summarizeNoteFolders
} from "./notes-spaced-revisit.js";
export type { FolderSummary, RevisitCandidate, RevisitDue } from "./notes-spaced-revisit.js";

const DEFAULT_CHUNK_CHARS = 600;
const DEFAULT_TOP_K = 5;

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
