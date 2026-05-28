/**
 * `muse recall <query>` — cross-store semantic search.
 *
 * Embeds the query once, then cosine-searches the
 * union of every semantic index Muse has on disk:
 *
 *   - notes-index.json     (built by `muse notes reindex`)
 *   - episodes-index.json  (built by `muse episode reindex`)
 *
 * Each hit carries `{ source, ref, score, snippet }` so the
 * caller knows which store + entity it came from. Top-K (default
 * 5) across the merged ranking; `--source notes|episodes|all`
 * narrows. Missing indices are soft-failed per-source so a user
 * who has notes but not episodes still gets notes results.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { selectByMmr } from "@muse/agent-core";
import { resolveEpisodesFile } from "@muse/autoconfigure";
import { readEpisodes } from "@muse/mcp";
import type { Command } from "commander";

import { closestCommandName } from "./closest-command.js";
import { embed, cosineSimilarity } from "./embed.js";
import { defaultEpisodeIndexFile, loadEpisodeIndex } from "./episode-index.js";
import type { ProgramIO } from "./program.js";

interface RecallOptions {
  readonly limit?: string;
  readonly source?: string;
  readonly embedModel?: string;
  readonly json?: boolean;
  readonly expand?: boolean;
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
 * Pure ranker. Given an already-embedded query vector
 * and both indices' candidate rows, return the top-K hits across
 * the union. Exported so a unit test can drive every branch
 * without touching Ollama or filesystem.
 */
/** Weight of the lexical (keyword-overlap) signal relative to vector cosine in
 * the hybrid score. Small so semantics dominate but an exact keyword hit breaks
 * ties / surfaces a lexically-obvious match the embedding under-ranks. */
const RECALL_LEX_WEIGHT = 0.2;
const RECALL_MMR_LAMBDA = 0.7;

function recallContentTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const t of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (t.length >= 3) out.add(t);
  }
  return out;
}

function lexicalOverlap(queryTokens: ReadonlySet<string>, text: string): number {
  if (queryTokens.size === 0) return 0;
  const docTokens = recallContentTokens(text);
  let hit = 0;
  for (const q of queryTokens) if (docTokens.has(q)) hit += 1;
  return hit / queryTokens.size;
}

/**
 * Hybrid ranker: vector cosine + a lexical keyword-overlap boost (when
 * `queryText` is given). Pure cosine when it isn't (back-compat). The lexical
 * term rescues a lexically-obvious hit the embedding under-ranks and breaks
 * near-ties toward an exact term match.
 */
export function rankRecallCandidates(args: {
  readonly queryVec: readonly number[];
  readonly queryText?: string;
  readonly noteChunks: ReadonlyArray<{ path: string; text: string; embedding: readonly number[] }>;
  readonly episodeEntries: ReadonlyArray<{ id: string; summary: string; embedding: readonly number[] }>;
  readonly limit: number;
  readonly source: "notes" | "episodes" | "all";
}): readonly RecallHit[] {
  const queryTokens = recallContentTokens(args.queryText ?? "");
  const combined = (vec: readonly number[], text: string): number =>
    cosineSimilarity(args.queryVec, vec) + RECALL_LEX_WEIGHT * lexicalOverlap(queryTokens, text);
  const scored: { readonly hit: RecallHit; readonly embedding: readonly number[] }[] = [];
  if (args.source !== "episodes") {
    for (const chunk of args.noteChunks) {
      scored.push({ embedding: chunk.embedding, hit: { score: combined(chunk.embedding, chunk.text), ref: chunk.path, snippet: chunk.text.slice(0, 200), source: "notes" } });
    }
  }
  if (args.source !== "notes") {
    for (const ep of args.episodeEntries) {
      scored.push({ embedding: ep.embedding, hit: { score: combined(ep.embedding, ep.summary), ref: ep.id, snippet: ep.summary.slice(0, 200), source: "episodes" } });
    }
  }
  const limit = Math.max(1, args.limit);
  const positive = scored.filter((s) => s.hit.score > 0).sort((a, b) => b.hit.score - a.hit.score);
  // Diversify the returned set with MMR (Carbonell & Goldstein, SIGIR 1998) so
  // recall / `today --connect` don't surface several near-duplicate passages.
  // Each hit KEEPS its cosine+lexical score (downstream gates like today's
  // `>= 0.5` stay valid — MMR changes WHICH passages return, not their score),
  // and the top pick is still the most relevant, so a single-best query is
  // unaffected. Only engages when there's more than `limit` to choose from.
  if (positive.length <= limit) {
    return positive.map((s) => s.hit);
  }
  const order = selectByMmr(
    positive.map((s, i) => ({ embedding: s.embedding, key: String(i), relevance: s.hit.score })),
    RECALL_MMR_LAMBDA,
    limit
  );
  return order.map((k) => positive[Number(k)]!.hit);
}

// Absent → default 5. A genuine number is truncated + clamped
// to the 50 cap; a non-numeric / non-positive value (unit slip
// like `10x`, `abc`, `0`) rejects instead of silently using 5.
/**
 * Drop indexed note files that no longer exist on disk. The
 * notes-index is a pre-built cache (`muse notes reindex`); a note
 * deleted (`muse notes delete`) or moved since the last reindex is
 * still in the index, so recall would surface a note that's gone —
 * wrong, and a "deleted means deleted" surprise. `exists` is injected
 * so the filter is testable without touching the real filesystem.
 */
export function filterLiveNoteIndexFiles<T extends { readonly path: string }>(
  files: readonly T[],
  exists: (path: string) => boolean
): T[] {
  return files.filter((file) => exists(file.path));
}

/**
 * Drop indexed episodes no longer in the live episode store. Like the
 * notes filter, the episodes-index is a pre-built cache (`muse episode
 * reindex`); an episode dropped by `muse episode remove` since the last
 * reindex is still in the index, so recall would surface a removed
 * episode's summary — wrong, and a "removed means removed" surprise.
 * `liveIds` is the set of ids still in the store (injected for testing).
 */
export function filterLiveEpisodeEntries<T extends { readonly id: string }>(
  entries: readonly T[],
  liveIds: ReadonlySet<string>
): T[] {
  return entries.filter((entry) => liveIds.has(entry.id));
}

export function clampLimit(raw: string | undefined): number {
  if (raw === undefined || raw.trim().length === 0) return 5;
  const parsed = Number(raw.trim());
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`--limit must be a positive number (got '${raw}')`);
  }
  return Math.min(50, Math.trunc(parsed));
}

/**
 * Accepted values for `muse recall --source`. Single
 * source of truth for both the validator and the fuzzy-suggest
 * hint. `all` is the default + acts as the no-restriction value.
 */
export const RECALL_SOURCE_VALUES = ["all", "notes", "episodes"] as const;
export type RecallSource = (typeof RECALL_SOURCE_VALUES)[number];

export type RecallSourceResolution =
  | { readonly kind: "ok"; readonly source: RecallSource }
  | { readonly kind: "invalid"; readonly input: string };

/**
 * Case-insensitive validator. An unknown `--source` used to
 * silently fall back to `"all"`, masking typos like
 * `--source note` (singular). Now the caller can surface a
 * fuzzy-suggest hint instead of running the wrong scope.
 */
export function resolveSource(raw: string | undefined): RecallSourceResolution {
  if (raw === undefined) return { kind: "ok", source: "all" };
  const trimmed = raw.trim().toLowerCase();
  if (trimmed.length === 0) return { kind: "ok", source: "all" };
  if ((RECALL_SOURCE_VALUES as readonly string[]).includes(trimmed)) {
    return { kind: "ok", source: trimmed as RecallSource };
  }
  return { kind: "invalid", input: raw };
}

/**
 * Test-only escape hatch: when
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

/**
 * The recall search pipeline shared by `muse recall` and the in-chat
 * `/recall`: load both indices (soft-fail per source), resolve the query
 * embedding (test hook → live embed; throws if embedding fails), drop
 * notes/episodes gone stale since the last reindex, then rank the union.
 * Per-source diagnostics (missing index, embed-model mismatch) are surfaced
 * through `onWarn` so each caller renders them in its own channel.
 */
export async function searchRecall(opts: {
  readonly query: string;
  readonly source: RecallSource;
  readonly limit: number;
  readonly embedModel: string;
  readonly env?: Record<string, string | undefined>;
  readonly onWarn?: (message: string) => void;
}): Promise<readonly RecallHit[]> {
  const { query, source, limit, embedModel } = opts;
  const env = opts.env ?? (process.env as Record<string, string | undefined>);
  const warn = opts.onWarn ?? ((): void => undefined);

  const [notesIndex, episodeIndex] = await Promise.all([
    source === "episodes" ? Promise.resolve(undefined) : loadNotesIndex(defaultNotesIndexFile()),
    source === "notes" ? Promise.resolve(undefined) : loadEpisodeIndex(defaultEpisodeIndexFile())
  ]);
  if (source !== "episodes" && !notesIndex) {
    warn("(recall: no notes-index.json — run `muse notes reindex` to populate)\n");
  }
  if (source !== "notes" && !episodeIndex) {
    warn("(recall: no episodes-index.json — run `muse episode reindex` to populate)\n");
  }
  const notesMismatch = notesIndex?.model && notesIndex.model !== embedModel ? notesIndex.model : undefined;
  const episodeMismatch = episodeIndex?.model && episodeIndex.model !== embedModel ? episodeIndex.model : undefined;
  if (notesMismatch) {
    warn(
      `(recall: notes-index.json was built with '${notesMismatch}' but querying with '${embedModel}' — ` +
      `cosines across different embedding models are noise. ` +
      `Rerun \`muse notes reindex --model ${embedModel}\` or pass \`--embed-model ${notesMismatch}\`.)\n`
    );
  }
  if (episodeMismatch) {
    warn(
      `(recall: episodes-index.json was built with '${episodeMismatch}' but querying with '${embedModel}' — ` +
      `same issue as above. ` +
      `Rerun \`muse episode reindex --model ${embedModel}\` or pass \`--embed-model ${episodeMismatch}\`.)\n`
    );
  }

  const testVec = maybeReadTestEmbedding();
  const queryVec = testVec ?? await embed(query, embedModel);

  const liveFiles = filterLiveNoteIndexFiles(notesIndex?.files ?? [], existsSync);
  const noteChunks = liveFiles.flatMap((file) =>
    (file.chunks ?? []).map((chunk) => ({ path: file.path, text: chunk.text, embedding: chunk.embedding }))
  );
  let episodeEntries = (episodeIndex?.entries ?? []).map((entry) => ({
    id: entry.id,
    summary: entry.summary,
    embedding: entry.embedding
  }));
  if (episodeEntries.length > 0) {
    const liveIds = new Set((await readEpisodes(resolveEpisodesFile(env))).map((episode) => episode.id));
    episodeEntries = filterLiveEpisodeEntries(episodeEntries, liveIds);
  }

  return rankRecallCandidates({ queryVec, queryText: query, noteChunks, episodeEntries, limit, source });
}

export function registerRecallCommand(program: Command, io: ProgramIO): void {
  program
    .command("recall")
    .description("Semantic search across notes + episodes indices")
    .argument("<query>", "Free-text query to embed + match")
    .option("--limit <n>", "Top-K hits to return (default 5, cap 50)")
    .option("--source <id>", "Restrict to one store: notes | episodes | all (default all)")
    .option("--embed-model <tag>", "Embedding model (default 'nomic-embed-text')")
    .option("--json", "Emit a structured payload")
    .option("--expand", "Also surface notes the top results link to (1-hop [[wiki-links]]) — graph-augmented recall (GraphRAG)")
    .action(async (queryRaw: string, options: RecallOptions) => {
      const query = queryRaw.trim();
      if (query.length === 0) {
        io.stderr("muse recall: query is required\n");
        process.exitCode = 1;
        return;
      }
      const limit = clampLimit(options.limit);
      // Bail on unknown --source so `--source note` doesn't
      // silently widen to "all".
      const sourceResolution = resolveSource(options.source);
      if (sourceResolution.kind === "invalid") {
        const suggestion = closestCommandName(sourceResolution.input.trim().toLowerCase(), RECALL_SOURCE_VALUES);
        io.stderr(`muse recall: invalid --source '${sourceResolution.input}'`);
        if (suggestion) io.stderr(` — did you mean '${suggestion}'?`);
        io.stderr(` (valid: ${RECALL_SOURCE_VALUES.join(", ")})\n`);
        process.exitCode = 1;
        return;
      }
      const source = sourceResolution.source;
      const embedModel = options.embedModel?.trim() && options.embedModel.trim().length > 0
        ? options.embedModel.trim()
        : "nomic-embed-text";

      let hits: readonly RecallHit[];
      try {
        hits = await searchRecall({ query, source, limit, embedModel, env: process.env as Record<string, string | undefined>, onWarn: io.stderr });
      } catch (cause) {
        io.stderr(
          `muse recall: embedding failed — is Ollama running with '${embedModel}' pulled? ` +
          `(underlying: ${cause instanceof Error ? cause.message : String(cause)})\n`
        );
        process.exitCode = 1;
        return;
      }

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

      // Graph-augmented recall: notes the top results link to (1-hop),
      // surfacing structure the embedding ranking misses. Fail-soft.
      if (options.expand) {
        try {
          const { loadNoteLinkGraph } = await import("./commands-notes-rag.js");
          const { linkedFromResults } = await import("./notes-links.js");
          const { resolveNotesDir } = await import("@muse/autoconfigure");
          const noteRefs = hits.filter((h) => h.source === "notes").map((h) => h.ref);
          const graph = await loadNoteLinkGraph(resolveNotesDir(process.env as Record<string, string | undefined>));
          const linked = linkedFromResults(noteRefs, graph, limit);
          if (linked.length > 0) {
            io.stdout("🔗 Linked from results (via [[wiki-links]]):\n");
            for (const id of linked) {
              io.stdout(`  - ${id}\n`);
            }
          }
        } catch {
          // a missing notes dir / unreadable note must not fail recall
        }
      }
    });
}
