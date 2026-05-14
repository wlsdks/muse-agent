/**
 * `muse recall <query>` — cross-store semantic search.
 *
 * Goal 091 — embeds the query once, then cosine-searches the
 * union of every semantic index Muse has on disk:
 *
 *   - notes-index.json     (existing, built by `muse notes reindex`)
 *   - episodes-index.json  (goal 090, built by `muse episode reindex`)
 *
 * Each hit carries `{ source, ref, score, snippet }` so the
 * caller knows which store + entity it came from. Top-K (default
 * 5) across the merged ranking; `--source notes|episodes|all`
 * narrows. Missing indices are soft-failed per-source so a user
 * who has notes but not episodes still gets notes results.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { Command } from "commander";

import { embed, cosineSimilarity } from "./embed.js";
import { defaultEpisodeIndexFile, loadEpisodeIndex } from "./episode-index.js";
import type { ProgramIO } from "./program.js";

interface RecallOptions {
  readonly limit?: string;
  readonly source?: string;
  readonly embedModel?: string;
  readonly json?: boolean;
}

export interface RecallHit {
  readonly source: "notes" | "episodes";
  readonly ref: string;
  readonly score: number;
  readonly snippet: string;
}

function defaultNotesIndexFile(): string {
  const fromEnv = process.env.MUSE_NOTES_INDEX_FILE?.trim();
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  return join(homedir(), ".muse", "notes-index.json");
}

interface NotesIndexShape {
  readonly version?: number;
  readonly model?: string;
  readonly files?: ReadonlyArray<{
    readonly path: string;
    readonly chunks?: ReadonlyArray<{
      readonly chunkIndex: number;
      readonly text: string;
      readonly embedding: readonly number[];
    }>;
  }>;
}

async function loadNotesIndex(file: string): Promise<NotesIndexShape | undefined> {
  try {
    const raw = await readFile(file, "utf8");
    return JSON.parse(raw) as NotesIndexShape;
  } catch {
    return undefined;
  }
}

/**
 * Goal 091 — pure ranker. Given an already-embedded query vector
 * and both indices' candidate rows, return the top-K hits across
 * the union. Exported so a unit test can drive every branch
 * without touching Ollama or filesystem.
 */
export function rankRecallCandidates(args: {
  readonly queryVec: readonly number[];
  readonly noteChunks: ReadonlyArray<{ path: string; text: string; embedding: readonly number[] }>;
  readonly episodeEntries: ReadonlyArray<{ id: string; summary: string; embedding: readonly number[] }>;
  readonly limit: number;
  readonly source: "notes" | "episodes" | "all";
}): readonly RecallHit[] {
  const hits: RecallHit[] = [];
  if (args.source !== "episodes") {
    for (const chunk of args.noteChunks) {
      hits.push({
        source: "notes",
        ref: chunk.path,
        score: cosineSimilarity(args.queryVec, chunk.embedding),
        snippet: chunk.text.slice(0, 200)
      });
    }
  }
  if (args.source !== "notes") {
    for (const ep of args.episodeEntries) {
      hits.push({
        source: "episodes",
        ref: ep.id,
        score: cosineSimilarity(args.queryVec, ep.embedding),
        snippet: ep.summary.slice(0, 200)
      });
    }
  }
  return hits
    .filter((h) => h.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, args.limit));
}

function clampLimit(raw: string | undefined): number {
  if (!raw) return 5;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 5;
  return Math.min(50, parsed);
}

function resolveSource(raw: string | undefined): "notes" | "episodes" | "all" {
  const trimmed = raw?.trim().toLowerCase();
  if (trimmed === "notes" || trimmed === "episodes") return trimmed;
  return "all";
}

/**
 * Goal 091 — test-only escape hatch: when
 * `MUSE_RECALL_TEST_QUERY_EMBEDDING` is set (CSV of numbers),
 * skip the live embed call and use that vector instead. Lets
 * the dogfood seed a fixture index and assert ranking without
 * needing Ollama.
 */
function maybeReadTestEmbedding(): number[] | undefined {
  const raw = process.env.MUSE_RECALL_TEST_QUERY_EMBEDDING?.trim();
  if (!raw) return undefined;
  const parsed = raw.split(",").map((s) => Number.parseFloat(s.trim()));
  if (parsed.some((n) => !Number.isFinite(n))) return undefined;
  return parsed;
}

export function registerRecallCommand(program: Command, io: ProgramIO): void {
  program
    .command("recall")
    .description("Semantic search across notes + episodes indices (goal 091)")
    .argument("<query>", "Free-text query to embed + match")
    .option("--limit <n>", "Top-K hits to return (default 5, cap 50)")
    .option("--source <id>", "Restrict to one store: notes | episodes | all (default all)")
    .option("--embed-model <tag>", "Embedding model (default 'nomic-embed-text')")
    .option("--json", "Emit a structured payload")
    .action(async (queryRaw: string, options: RecallOptions) => {
      const query = queryRaw.trim();
      if (query.length === 0) {
        io.stderr("muse recall: query is required\n");
        process.exitCode = 1;
        return;
      }
      const limit = clampLimit(options.limit);
      const source = resolveSource(options.source);
      const embedModel = options.embedModel?.trim() && options.embedModel.trim().length > 0
        ? options.embedModel.trim()
        : "nomic-embed-text";

      // Load indices (soft-fail per source).
      const [notesIndex, episodeIndex] = await Promise.all([
        source === "episodes" ? Promise.resolve(undefined) : loadNotesIndex(defaultNotesIndexFile()),
        source === "notes" ? Promise.resolve(undefined) : loadEpisodeIndex(defaultEpisodeIndexFile())
      ]);
      if (source !== "episodes" && !notesIndex) {
        io.stderr("(recall: no notes-index.json — run `muse notes reindex` to populate)\n");
      }
      if (source !== "notes" && !episodeIndex) {
        io.stderr("(recall: no episodes-index.json — run `muse episode reindex` to populate)\n");
      }

      // Resolve query embedding — test hook first, else live embed.
      let queryVec: number[];
      const testVec = maybeReadTestEmbedding();
      if (testVec) {
        queryVec = testVec;
      } else {
        try {
          queryVec = await embed(query, embedModel);
        } catch (cause) {
          io.stderr(
            `muse recall: embedding failed — is Ollama running with '${embedModel}' pulled? ` +
            `(underlying: ${cause instanceof Error ? cause.message : String(cause)})\n`
          );
          process.exitCode = 1;
          return;
        }
      }

      // Flatten chunks.
      const noteChunks = (notesIndex?.files ?? []).flatMap((file) =>
        (file.chunks ?? []).map((chunk) => ({
          path: file.path,
          text: chunk.text,
          embedding: chunk.embedding
        }))
      );
      const episodeEntries = (episodeIndex?.entries ?? []).map((entry) => ({
        id: entry.id,
        summary: entry.summary,
        embedding: entry.embedding
      }));

      const hits = rankRecallCandidates({ queryVec, noteChunks, episodeEntries, limit, source });

      if (options.json) {
        io.stdout(`${JSON.stringify({ query, source, hits }, null, 2)}\n`);
        return;
      }
      if (hits.length === 0) {
        io.stdout(`(no semantic hits for "${query}" — try '--source notes' or 'muse notes reindex')\n`);
        return;
      }
      io.stdout(`Recall hits for "${query}" (${hits.length.toString()}):\n\n`);
      for (const hit of hits) {
        io.stdout(`  [${hit.source}] ${hit.ref} (score ${hit.score.toFixed(3)})\n`);
        io.stdout(`    ${hit.snippet.replace(/\s+/gu, " ").trim().slice(0, 140)}\n\n`);
      }
    });
}
