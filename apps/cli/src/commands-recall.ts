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
import { relativizeNoteSource, type RecallHit, filterLiveEpisodeEntries, filterLiveNoteIndexFiles } from "@muse/recall";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { selectByMarginalValue, selectByMmr } from "@muse/agent-core";

import { depositCoRecall, readTrails, resolveTrailsFile, writeTrails } from "./recall-trail.js";
import { resolveEpisodesFile, resolveNoteProvenanceFile, resolveNotesDir } from "@muse/autoconfigure";
import { readEpisodes } from "@muse/stores";
import { readNoteProvenance, untrustedNotePaths } from "./note-provenance.js";
import type { Command } from "commander";

import { closestCommandName } from "./closest-command.js";
import { embed, cosineSimilarity } from "./embed.js";
import { defaultEpisodeIndexFile, loadEpisodeIndex } from "./episode-index.js";
import type { ProgramIO } from "./program.js";
import { DEFAULT_EMBED_MODEL } from "./embed-model-default.js";

interface RecallOptions {
  readonly limit?: string;
  readonly source?: string;
  readonly embedModel?: string;
  readonly json?: boolean;
  readonly expand?: boolean;
  readonly adaptive?: boolean;
}

export type { RecallHit };

export function defaultNotesIndexFile(): string {
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
 * The snippet to PREVIEW for a recall hit: the chunk LINE most relevant to the
 * query, not the chunk's opening — a multi-line note whose match sits further
 * down would otherwise preview a non-sequitur ("# Q3 board deck …" instead of
 * the line that actually matched). Markdown headings are skipped (structure, not
 * content). No query overlap (or a single-line chunk) ⇒ the opening, so it's
 * never worse than the old `slice(0, max)`.
 */
export function relevantExcerpt(text: string, queryTokens: ReadonlySet<string>, max = 200): string {
  const lines = text.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line.length > 0);
  if (lines.length === 0) {
    return text.replace(/\s+/gu, " ").trim().slice(0, max);
  }
  const content = lines.filter((line) => !/^#{1,6}(\s|$)/u.test(line));
  const candidates = content.length > 0 ? content : lines;
  // A note that fits the budget is returned WHOLE. Excerpting a short multi-fact
  // note down to its single best-overlap line can DROP the very fact the question
  // asks about: observed live, a "회의" query token matched "회의실" in one line,
  // so that line won and the "전사 회의" answer in the next line was discarded —
  // `chat` then answered the wrong fact while `ask` (which grounds on the full
  // chunk) was correct. Within budget, more context never hurts grounding.
  const joined = candidates.join(" ");
  if (joined.length <= max) return joined;
  if (queryTokens.size > 0) {
    let best = candidates[0]!;
    let bestScore = 0;
    for (const line of candidates) {
      const score = lexicalOverlap(queryTokens, line);
      if (score > bestScore) {
        bestScore = score;
        best = line;
      }
    }
    if (bestScore > 0) {
      return best.slice(0, max);
    }
  }
  return candidates[0]!.slice(0, max);
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
  readonly noteChunks: ReadonlyArray<{ path: string; text: string; embedding: readonly number[]; trusted?: false }>;
  readonly episodeEntries: ReadonlyArray<{ id: string; summary: string; embedding: readonly number[] }>;
  readonly limit: number;
  readonly source: "notes" | "episodes" | "all";
  readonly adaptive?: boolean;
  /** Episode ids whose session rested on untrusted sources — their hits are tagged
   *  `trusted:false` (EP-3 episode-laundering defense). Absent ⇒ all trusted. */
  readonly untrustedEpisodeIds?: ReadonlySet<string>;
}): readonly RecallHit[] {
  const queryTokens = recallContentTokens(args.queryText ?? "");
  const combined = (vec: readonly number[], text: string): number =>
    cosineSimilarity(args.queryVec, vec) + RECALL_LEX_WEIGHT * lexicalOverlap(queryTokens, text);
  const scored: { readonly hit: RecallHit; readonly embedding: readonly number[] }[] = [];
  if (args.source !== "episodes") {
    for (const chunk of args.noteChunks) {
      scored.push({ embedding: chunk.embedding, hit: { score: combined(chunk.embedding, chunk.text), ref: chunk.path, snippet: relevantExcerpt(chunk.text, queryTokens), source: "notes", ...(chunk.trusted === false ? { trusted: false } : {}) } });
    }
  }
  if (args.source !== "notes") {
    for (const ep of args.episodeEntries) {
      scored.push({ embedding: ep.embedding, hit: { score: combined(ep.embedding, ep.summary), ref: ep.id, snippet: relevantExcerpt(ep.summary, queryTokens), source: "episodes", ...(args.untrustedEpisodeIds?.has(ep.id) ? { trusted: false } : {}) } });
    }
  }
  const limit = Math.max(1, args.limit);
  const positive = scored.filter((s) => s.hit.score > 0).sort((a, b) => b.hit.score - a.hit.score);
  // MVT (Charnov 1976): when --adaptive, let the score distribution choose the
  // cutoff — stop adding sources once the marginal relevance falls below the
  // running return rate — instead of always the fixed top-N. Bounded by `limit`.
  const effectiveLimit = args.adaptive
    ? Math.min(limit, selectByMarginalValue(positive.map((s) => s.hit.score), { max: limit, min: 1 }))
    : limit;
  // Diversify the returned set with MMR (Carbonell & Goldstein, SIGIR 1998) so
  // recall / `today --connect` don't surface several near-duplicate passages.
  // Each hit KEEPS its cosine+lexical score (downstream gates like today's
  // `>= 0.5` stay valid — MMR changes WHICH passages return, not their score),
  // and the top pick is still the most relevant, so a single-best query is
  // unaffected. Only engages when there's more than `limit` to choose from.
  if (positive.length <= effectiveLimit) {
    return positive.map((s) => s.hit);
  }
  const order = selectByMmr(
    positive.map((s, i) => ({ embedding: s.embedding, key: String(i), relevance: s.hit.score })),
    RECALL_MMR_LAMBDA,
    effectiveLimit
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
export { filterLiveNoteIndexFiles } from "@muse/recall";

/**
 * Drop indexed episodes no longer in the live episode store. Like the
 * notes filter, the episodes-index is a pre-built cache (`muse episode
 * reindex`); an episode dropped by `muse episode remove` since the last
 * reindex is still in the index, so recall would surface a removed
 * episode's summary — wrong, and a "removed means removed" surprise.
 * `liveIds` is the set of ids still in the store (injected for testing).
 */
export { filterLiveEpisodeEntries } from "@muse/recall";

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
const RECALL_SOURCE_SET = new Set<string>(RECALL_SOURCE_VALUES);

function isRecallSource(value: string): value is RecallSource {
  return RECALL_SOURCE_SET.has(value);
}

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
  if (isRecallSource(trimmed)) {
    return { kind: "ok", source: trimmed };
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
  readonly adaptive?: boolean;
}): Promise<readonly RecallHit[]> {
  const { query, source, limit, embedModel } = opts;
  const env = opts.env ?? (process.env);
  const warn = opts.onWarn ?? ((): void => undefined);

  const [notesIndex, episodeIndex] = await Promise.all([
    source === "episodes" ? undefined : loadNotesIndex(defaultNotesIndexFile()),
    source === "notes" ? undefined : loadEpisodeIndex(defaultEpisodeIndexFile())
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

  // Notes ingested from an external URL (muse notes ingest --url) are third-party
  // content — tag their chunks trusted:false so the chat untrusted-only cue fires on
  // a poisoned ingested note (NP-chat parity with the ask path). Keyed by the note's
  // relativized path, the same form provenance records (see note-provenance.ts).
  const untrustedNotes = untrustedNotePaths(await readNoteProvenance(resolveNoteProvenanceFile(env)));
  const notesDir = resolveNotesDir(env);
  const liveFiles = filterLiveNoteIndexFiles(notesIndex?.files ?? [], existsSync);
  const noteChunks = liveFiles.flatMap((file) => {
    const untrusted = untrustedNotes.has(relativizeNoteSource(file.path, notesDir));
    return (file.chunks ?? []).map((chunk) => ({ path: file.path, text: chunk.text, embedding: chunk.embedding, ...(untrusted ? { trusted: false as const } : {}) }));
  });
  let episodeEntries = (episodeIndex?.entries ?? []).map((entry) => ({
    id: entry.id,
    summary: entry.summary,
    embedding: entry.embedding
  }));
  // Episodes whose session rested on untrusted sources (trusted:false) — their
  // recall hits are tagged untrusted so the chat untrusted-only cue fires on a
  // poisoned episode instead of laundering it as "your own history" (EP-3 /
  // MemoryGraft). Built from the SAME store read that already computes liveIds.
  let untrustedEpisodeIds = new Set<string>();
  if (episodeEntries.length > 0) {
    const sourceEpisodes = await readEpisodes(resolveEpisodesFile(env));
    const liveIds = new Set(sourceEpisodes.map((episode) => episode.id));
    untrustedEpisodeIds = new Set(sourceEpisodes.filter((episode) => episode.trusted === false).map((episode) => episode.id));
    episodeEntries = filterLiveEpisodeEntries(episodeEntries, liveIds);
  }

  return rankRecallCandidates({ adaptive: opts.adaptive, episodeEntries, limit, noteChunks, queryText: query, queryVec, source, untrustedEpisodeIds });
}

export function registerRecallCommand(program: Command, io: ProgramIO): void {
  program
    .command("recall")
    .description("Semantic search across notes + episodes indices")
    .argument("<query>", "Free-text query to embed + match")
    .option("--limit <n>", "Top-K hits to return (default 5, cap 50)")
    .option("--source <id>", "Restrict to one store: notes | episodes | all (default all)")
    .option("--embed-model <tag>", `Embedding model (default ${DEFAULT_EMBED_MODEL})`)
    .option("--json", "Emit a structured payload")
    .option("--expand", "Also surface notes the top results link to (1-hop [[wiki-links]]) — graph-augmented recall (GraphRAG)")
    .option("--adaptive", "Let the evidence pick how many sources to return (optimal-foraging / marginal-value stopping rule) — fewer when one source dominates, more when the field is rich — instead of a fixed --limit")
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
        : DEFAULT_EMBED_MODEL;

      let hits: readonly RecallHit[];
      try {
        hits = await searchRecall({ adaptive: options.adaptive, embedModel, env: process.env, limit, onWarn: io.stderr, query, source });
      } catch (cause) {
        io.stderr(
          `muse recall: embedding failed — is Ollama running with '${embedModel}' pulled? ` +
          `(underlying: ${cause instanceof Error ? cause.message : String(cause)})\n`
        );
        process.exitCode = 1;
        return;
      }

      // Stigmergy: notes recalled TOGETHER deposit a co-recall "pheromone" trail
      // (evaporating, usage-based relatedness surfaced by `muse notes trails`).
      // Best-effort — a trail write must never break recall.
      try {
        const noteRefs = hits.filter((hit) => hit.source === "notes").map((hit) => hit.ref);
        if (noteRefs.length >= 2) {
          const trailsFile = resolveTrailsFile(process.env);
          await writeTrails(trailsFile, depositCoRecall(await readTrails(trailsFile), noteRefs, Date.now()));
        }
      } catch {
        // trail deposit is best-effort
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
          const graph = await loadNoteLinkGraph(resolveNotesDir(process.env));
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
