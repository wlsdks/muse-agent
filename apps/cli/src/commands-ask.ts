/**
 * `muse ask <query>` — RAG-grounded one-shot question.
 *
 * The natural JARVIS surface: "what did I say about Q3 last week?"
 * Combines three layers Muse already owns:
 *   1. Persona snapshot from `~/.muse/user-memory.json`
 *      (so the reply is in the user's preferred language + style)
 *   2. Semantic search over `~/.muse/notes-index.json`
 *      (top-K chunks with cosine similarity, embedded with
 *      nomic-embed-text)
 *   3. Local Qwen via `OllamaProvider` (think:false fast path)
 *
 * Streams the answer to stdout. Returns 1 when no index exists
 * (caller is told to run `muse notes reindex` first).
 *
 * Differs from `muse chat <prompt>` by:
 *   - Always runs RAG retrieval first
 *   - Includes hit citations in the system prompt
 *   - Prompts the model to answer FROM the notes (with a "I don't
 *     see anything about that in your notes" fallback)
 *
 * Zero recurring cost — all local.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { classifyRetrievalConfidence, rankPlaybookStrategies, renderPlaybookSection, reorderForLongContext, selectByMmr, type RetrievalConfidence } from "@muse/agent-core";
import { buildCalendarRegistry, createMuseRuntimeAssembly, resolveEpisodesFile, resolveNotesDir, resolveRemindersFile, resolveTasksFile, type MuseEnvironment } from "@muse/autoconfigure";
import type { MuseTool } from "@muse/tools";
import type { CalendarEvent } from "@muse/calendar";
import { readEpisodes, readReminders, readTasks, type PersistedReminder, type PersistedTask } from "@muse/mcp";
import { classifyTier, type ModelTier } from "@muse/multi-agent";
import type { Command } from "commander";

import { cosine, isNotesIndexStale, reindexNotes } from "./commands-notes-rag.js";
import { filterLiveEpisodeEntries, filterLiveNoteIndexFiles, type RecallHit } from "./commands-recall.js";
import { formatConnectionsSection } from "./commands-today.js";
import { embed } from "./embed.js";
import { buildEpisodeIndex, defaultEpisodeIndexFile, episodeIndexStale, loadEpisodeIndex, saveEpisodeIndex } from "./episode-index.js";
import { defaultFeedsFile, readFeedsStore } from "./feeds-store.js";
import { resolvePersona } from "./program-helpers.js";
import { buildMusePersona, formatCurrentContextLine, readPipedStdin } from "./program.js";
import type { ProgramIO } from "./program.js";
import { withSigintAbort } from "./sigint-abort.js";
import { resolveDefaultUserKey } from "./user-id.js";

/**
 * SB-1: rank past-session episode summaries against the query so `muse ask`
 * grounds on the user's own history, not just notes. Pure + cosine-based;
 * caller supplies the already-embedded query vector. Top-K, descending score.
 */
const EPISODE_IMPORTANCE_WEIGHT = 0.15;
const EPISODE_RECENCY_WEIGHT = 0.15;
const EPISODE_RECENCY_HALF_LIFE_DAYS = 7;
const MS_PER_DAY = 86_400_000;

/**
 * Recency component of the Generative Agents retrieval score (arXiv
 * 2304.03442): an exponential decay over the episode's age, 1.0 for a
 * just-ended session and halving every `EPISODE_RECENCY_HALF_LIFE_DAYS`.
 * Returns 0 when there's no usable timestamp (backward-compatible: an
 * episode with no `endedAt` adds no recency bump). A future timestamp is
 * clamped to age 0 so a skewed clock can't inflate the score past 1.
 */
function episodeRecencyScore(endedAt: string | undefined, nowMs: number): number {
  if (!endedAt) {
    return 0;
  }
  const t = Date.parse(endedAt);
  if (!Number.isFinite(t)) {
    return 0;
  }
  const ageDays = Math.max(0, (nowMs - t) / MS_PER_DAY);
  return Math.pow(0.5, ageDays / EPISODE_RECENCY_HALF_LIFE_DAYS);
}

export function rankEpisodeHits(
  queryVec: readonly number[],
  episodes: ReadonlyArray<{ readonly id: string; readonly summary: string; readonly embedding: readonly number[]; readonly importance?: number; readonly endedAt?: string }>,
  topK: number,
  nowMs: number = Date.now()
): Array<{ id: string; summary: string; score: number }> {
  if (topK <= 0) {
    return [];
  }
  // Generative Agents (arXiv 2304.03442) ranks memories by relevance +
  // importance + RECENCY. Relevance is the cosine; importance and recency are
  // small bounded ADDITIVE bumps, so among similar-relevance episodes the more
  // important / more recent one wins, while an unscored, timestamp-less corpus
  // still ranks exactly by cosine as before (both bumps are 0).
  return episodes
    .map((ep) => {
      const importance = typeof ep.importance === "number" && Number.isFinite(ep.importance)
        ? Math.min(10, Math.max(1, ep.importance))
        : 0;
      const importanceBump = importance === 0 ? 0 : EPISODE_IMPORTANCE_WEIGHT * (importance / 10);
      const recencyBump = EPISODE_RECENCY_WEIGHT * episodeRecencyScore(ep.endedAt, nowMs);
      return { id: ep.id, score: cosine(queryVec, ep.embedding) + importanceBump + recencyBump, summary: ep.summary };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

/**
 * SB-1/G2: the most-recent watched-feed headlines across ALL feeds, newest
 * first, capped at `limit`. Feeds are time-ordered world-state (not embedded),
 * so we surface recent items directly — the second brain reaches your
 * subscribed knowledge ("what's new in X?"). Pure; unparseable dates sort last.
 */
export function recentFeedHeadlines(
  feeds: ReadonlyArray<{ readonly name: string; readonly entries: ReadonlyArray<{ readonly title: string; readonly publishedAt: string; readonly summary: string }> }>,
  limit: number
): Array<{ feedName: string; title: string; publishedAt: string; summary: string }> {
  if (limit <= 0) {
    return [];
  }
  return feeds
    .flatMap((feed) => feed.entries.map((e) => ({ feedName: feed.name, publishedAt: e.publishedAt, summary: e.summary, title: e.title })))
    .sort((a, b) => (Date.parse(b.publishedAt) || 0) - (Date.parse(a.publishedAt) || 0))
    .slice(0, limit);
}

interface AskOptions {
  readonly user?: string;
  readonly persona?: string;
  readonly model?: string;
  readonly top?: string;
  readonly embedModel?: string;
  readonly autoReindex?: boolean;
  readonly tasks?: boolean;
  readonly calendar?: boolean;
  readonly calendarDays?: string;
  readonly reminders?: boolean;
  readonly json?: boolean;
  readonly withTools?: boolean;
  readonly actuators?: boolean;
  readonly tiered?: boolean;
  readonly connect?: boolean;
  /**
   * Clamps the answer to notes + local-memory grounding only.
   * Disables native web_search on every provider path and, when
   * `--with-tools` is also set, allowlists the agent runtime to
   * muse.notes / muse.notes-multi / muse.context only.
   */
  readonly notesOnly?: boolean;
}

/**
 * The allowlist consumed via `metadata.allowedToolNames` when
 * `muse ask --notes-only` runs in `--with-tools` mode. Notes +
 * notes-multi cover both inline and registry-aware paths; context
 * is the persona / memory accessor so the model can still reach
 * for "what did the user tell me about X". Web/fetch tools and
 * everything else stay off.
 */
export const NOTES_ONLY_TOOL_ALLOWLIST = ["muse.notes", "muse.notes-multi", "muse.context"] as const;

export interface AskTierModels {
  readonly fast: string;
  readonly heavy: string;
}

// Tier models come from env (parallel to MUSE_MODEL / MUSE_VISION_MODEL);
// either unset falls back to the configured default model, so --tiered
// with no tier env still answers (on the default for both tiers).
export function resolveAskTierModels(defaultModel: string, env: NodeJS.ProcessEnv): AskTierModels {
  const fast = env.MUSE_FAST_MODEL?.trim();
  const heavy = env.MUSE_HEAVY_MODEL?.trim();
  return {
    fast: fast && fast.length > 0 ? fast : defaultModel,
    heavy: heavy && heavy.length > 0 ? heavy : defaultModel
  };
}

export function routeAskTierModel(
  query: string,
  defaultModel: string,
  env: NodeJS.ProcessEnv
): { readonly model: string; readonly tier: ModelTier } {
  const tier = classifyTier(query);
  const models = resolveAskTierModels(defaultModel, env);
  return { model: tier === "fast" ? models.fast : models.heavy, tier };
}

/**
 * SB-3 proactive connection for `muse ask --connect`: turn the grounding
 * the answer already computed (top note chunks + past-session episodes)
 * into a readable "💡 Related in your brain" footer — provenance the user
 * can scan and trust, consistent with `muse today --connect`. Pure: reuses
 * the already-ranked hits (no extra search), keeps only those at/above the
 * relevance floor, ranks across both sources, and caps the list. Same
 * RecallHit shape + formatter as today, so the surfaces stay consistent.
 */
export function buildAskConnections(params: {
  readonly notes: ReadonlyArray<{ readonly file: string; readonly score: number; readonly text: string }>;
  readonly episodes: ReadonlyArray<{ readonly id: string; readonly score: number; readonly summary: string }>;
  readonly minScore?: number;
  readonly limit?: number;
}): RecallHit[] {
  const floor = params.minScore ?? 0.5;
  const limit = Math.max(1, params.limit ?? 4);
  const hits: RecallHit[] = [
    ...params.notes.map((n) => ({ ref: n.file, score: n.score, snippet: n.text, source: "notes" as const })),
    ...params.episodes.map((e) => ({ ref: e.id, score: e.score, snippet: e.summary, source: "episodes" as const }))
  ];
  return hits
    .filter((h) => Number.isFinite(h.score) && h.score >= floor)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

interface IndexChunk {
  readonly file: string;
  readonly chunkIndex: number;
  readonly text: string;
  readonly embedding: number[];
}

interface FileEntry {
  readonly path: string;
  readonly chunks: readonly IndexChunk[];
}

interface ScoredChunk {
  readonly chunk: IndexChunk;
  readonly file: string;
  readonly score: number;
}

const ASK_MMR_LAMBDA = 0.7;

/**
 * Pick the top-K note chunks to ground on with Maximal Marginal Relevance
 * (Carbonell & Goldstein, SIGIR 1998) instead of pure cosine. On a small
 * local context window, three near-duplicate chunks (the same fact echoed
 * across daily-inbox notes) crowd out diverse grounding; MMR penalises a
 * candidate that merely repeats an already-picked one. Reuses the shared
 * `selectByMmr`. When there's nothing to trim (candidates ≤ K) it's just
 * the cosine sort, so behaviour only changes when diversification matters.
 */
export function diversifyAskChunks(candidates: readonly ScoredChunk[], topK: number, lambda = ASK_MMR_LAMBDA): ScoredChunk[] {
  const sorted = [...candidates].sort((a, b) => b.score - a.score);
  if (topK <= 0 || sorted.length <= topK) {
    return sorted.slice(0, Math.max(0, topK));
  }
  const order = selectByMmr(
    sorted.map((c, i) => ({ key: String(i), relevance: c.score, embedding: c.chunk.embedding })),
    lambda,
    topK
  );
  return order.map((k) => sorted[Number(k)]!);
}

/**
 * CRAG confidence gate for `muse ask`'s notes grounding — the headline-surface
 * embodiment of Muse's identity ("says I'm not sure instead of making things
 * up"). The chunk score IS the absolute cosine, so we grade the top match: a
 * CONFIDENT hit is framed for citation; a merely AMBIGUOUS (weak near-miss) set
 * is flagged LOW-confidence so the small model is told NOT to cite it as fact;
 * `none` keeps the plain header (the "no relevant notes" block already shows).
 * Pure + exported for direct unit coverage.
 */
export function notesGroundingFraming(scored: readonly ScoredChunk[]): { readonly verdict: RetrievalConfidence; readonly header: string; readonly guidance?: string } {
  const verdict = scored.length === 0
    ? "none"
    : classifyRetrievalConfidence(scored.map((s) => ({ cosine: s.score, score: s.score, source: s.file, text: s.chunk.text })));
  if (verdict === "ambiguous") {
    return {
      guidance: "The USER NOTES below are only WEAK matches (low retrieval confidence). Do NOT present them as established fact; if they do not clearly answer the question, say you are not sure rather than cite a weak match.",
      header: "=== USER NOTES (LOW confidence — weak matches; verify, do not cite as fact) ===",
      verdict
    };
  }
  return { header: "=== USER NOTES (top relevant chunks) ===", verdict };
}


interface NotesIndex {
  readonly version: 1;
  readonly model: string;
  readonly files: readonly FileEntry[];
}

function notesIndexPath(): string {
  return join(homedir(), ".muse", "notes-index.json");
}

function defaultUserKey(user: string | undefined, persona: string | undefined): string {
  const base = resolveDefaultUserKey({ override: user });
  const resolved = resolvePersona(persona);
  return resolved ? `${base}@${resolved}` : base;
}

/**
 * Absent flag → fallback. A genuine number is truncated and
 * clamped to [min, max]. A non-numeric / out-of-low-bound value
 * (unit slip like `5x`, `abc`, `0`) rejects with a clear
 * message instead of silently using the default.
 */
export function parseBoundedInt(
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

export interface AskStreamEvent {
  readonly type: string;
  readonly text?: string;
  readonly error?: { readonly message?: string };
}

export interface AskStreamResult {
  readonly answer: string;
  readonly error?: string;
}

/**
 * Prepend the ACE `[Learned Strategies]` block (when present) to the
 * chat-only fast-path system prompt, so the default `muse ask` applies
 * learned feedback that otherwise only reaches the --with-tools agent
 * runtime. Empty / absent block ⇒ the prompt is unchanged.
 */
export function composeChatSystemContent(systemPrompt: string, playbookSection: string | undefined): string {
  return playbookSection && playbookSection.trim().length > 0 ? `${playbookSection}\n\n${systemPrompt}` : systemPrompt;
}

/**
 * ReasoningBank (arXiv 2509.25140): rank the playbook entries by relevance to
 * the current question and render only the top-K as `[Learned Strategies]`,
 * instead of dumping the whole bank at the small local model. Deterministic;
 * empty bank ⇒ undefined (no block).
 */
export function selectPlaybookSection(
  entries: readonly { readonly text: string; readonly tag?: string }[],
  queryText: string,
  topK?: number
): string | undefined {
  const ranked = rankPlaybookStrategies(
    entries.map((entry) => (entry.tag ? { tag: entry.tag, text: entry.text } : { text: entry.text })),
    queryText,
    topK === undefined ? undefined : { topK }
  );
  return renderPlaybookSection(ranked);
}

/**
 * Drain the chat-only fast-path model stream. A provider `error`
 * event (Ollama not running, model not pulled with an actionable
 * hint, a 5xx) must surface, not be silently dropped while the
 * command prints a blank answer and exits 0.
 */
export async function consumeAskStream(
  events: AsyncIterable<AskStreamEvent>,
  onDelta: (text: string) => void,
  isAborted: () => boolean
): Promise<AskStreamResult> {
  let answer = "";
  for await (const event of events) {
    if (isAborted()) break;
    if (event.type === "error") {
      return { answer, error: event.error?.message ?? "model request failed" };
    }
    if (event.type === "text-delta" && typeof event.text === "string") {
      answer += event.text;
      onDelta(event.text);
    }
  }
  return { answer };
}

/**
 * Render a chat-only stream failure. `--json` must stay a
 * parseable contract even on error — emit a structured object
 * on stdout (with any partial answer) so `muse ask --json | jq`
 * can detect it, rather than empty stdout + a human-only stderr
 * line. Pure so the unit test can pin the contract directly.
 */
export function renderAskStreamError(params: {
  readonly json: boolean;
  readonly query: string;
  readonly model: string;
  readonly answer: string;
  readonly error: string;
}): { readonly stdout?: string; readonly stderr?: string } {
  if (params.json) {
    return {
      stdout: `${JSON.stringify(
        { query: params.query, model: params.model, answer: params.answer, error: params.error },
        null,
        2
      )}\n`
    };
  }
  return { stderr: `\n(error: ${params.error})\n` };
}

export function registerAskCommand(program: Command, io: ProgramIO): void {
  program
    .command("ask")
    .description("Ask a question with your notes as context — RAG-grounded one-shot via local Qwen. Reads piped stdin too: `cat doc.md | muse ask 'summarize this'`")
    .argument("[query...]", "Free-text question (omit to read entire query from stdin)")
    .option("--user <id>", "User identity")
    .option("--persona <slot>", "Persona slot")
    .option("--model <tag>", "Chat model override")
    .option("--top <k>", "Top-K notes chunks to inject as context (default 3)", "3")
    .option("--embed-model <tag>", "Embedding model (must match the index)", "nomic-embed-text")
    .option(
      "--no-auto-reindex",
      "Skip the auto-stale check before search (default: reindex incrementally when a note's mtime is newer than the index)"
    )
    .option(
      "--no-tasks",
      "Skip injecting open tasks as grounding context (default: include open tasks alongside notes so 'what should I focus on?' answers correctly)"
    )
    .option(
      "--no-calendar",
      "Skip injecting upcoming calendar events as grounding context (default: include events from the configured providers)"
    )
    .option(
      "--calendar-days <n>",
      "Window (in days from now) to pull calendar events into context (default 7)",
      "7"
    )
    .option(
      "--no-reminders",
      "Skip injecting pending reminders as grounding context (default: include pending reminders sorted by due date)"
    )
    .option(
      "--json",
      "Emit a single JSON object on stdout with {query, model, answer, grounded:{...}} (suppresses streaming)"
    )
    .option(
      "--with-tools",
      "Run through the agent runtime so the model can call MCP tools (muse.search, muse.notes.*, muse.tasks.*, etc.). Default off — the chat-only fast path streams ~2x faster but can't fetch fresh web data."
    )
    .option(
      "--actuators",
      "With --with-tools, expose the gated state-changing actuators (email_send, web_action, home_action) so the conversation can trigger them. Each action shows the exact draft and fires only after you confirm. Off by default; providers resolve from env (MUSE_GMAIL_TOKEN, MUSE_HOMEASSISTANT_URL/TOKEN)."
    )
    .option(
      "--notes-only",
      "Clamp grounding to local notes + memory only — disables native web_search on every provider path and, when combined with --with-tools, allowlists the agent runtime to muse.notes / muse.notes-multi / muse.context only."
    )
    .option(
      "--connect",
      "After the answer, surface a '💡 Related in your brain' footer of the strongest related notes / past sessions (second-brain connection, same as `muse today --connect`). Off by default; ignored with --json."
    )
    .option(
      "--tiered",
      "Route this ask to a fast or high-capability model by classifying the question (lookups → fast, reasoning → heavy; defaults to heavy when unsure). Tier models come from MUSE_FAST_MODEL / MUSE_HEAVY_MODEL (each defaults to the configured model). An explicit --model overrides tiering. Off by default."
    )
    .action(async (queryParts: readonly string[], options: AskOptions) => {
      const argQuery = queryParts.join(" ").trim();
      const piped = await (io.readPipedStdin ?? readPipedStdin)();

      // Composition follows the same idiom as `muse chat`:
      //   args + stdin → instruction first, content after
      //   args only     → use args
      //   stdin only    → treat stdin as the question
      //   neither       → usage error
      // Lets `cat doc.md | muse ask "summarize this"` work, plus
      // `echo "question?" | muse ask` for headless pipelines.
      let query: string;
      if (argQuery.length > 0 && piped.length > 0) {
        query = `${argQuery}\n\n${piped}`;
      } else if (argQuery.length > 0) {
        query = argQuery;
      } else if (piped.length > 0) {
        query = piped;
      } else {
        io.stderr("usage: muse ask <query>   |   cat content | muse ask [optional-instruction]\n");
        process.exitCode = 1;
        return;
      }
      const userKey = defaultUserKey(options.user, options.persona);
      const topK = parseBoundedInt(options.top, "--top", 1, 20, 3);
      const embedModel = options.embedModel ?? "nomic-embed-text";

      // Auto-stale check + incremental reindex (default on). JARVIS
      // shouldn't make the user remember to run reindex; if a note
      // file is newer than the index, just refresh before search.
      const notesDir = resolveNotesDir(process.env as Record<string, string | undefined>);
      // Preserve the model the index was built with: a stale
      // refresh must NOT silently re-embed a custom-model index
      // with the default just because --embed-model was omitted.
      // The mismatch is still surfaced by the explicit guard below.
      let existingIndexModel: string | undefined;
      try {
        existingIndexModel = (JSON.parse(await readFile(notesIndexPath(), "utf8")) as NotesIndex).model;
      } catch {
        existingIndexModel = undefined;
      }
      if (options.autoReindex !== false) {
        try {
          const stale = await isNotesIndexStale(notesDir, notesIndexPath());
          if (stale) {
            const summary = await reindexNotes({
              dir: notesDir,
              indexPath: notesIndexPath(),
              model: existingIndexModel ?? embedModel
            });
            if (summary.embedded > 0) {
              io.stderr(`(auto-refreshed notes index: ${summary.embedded.toString()} embedded, ${summary.skipped.toString()} cached)\n`);
            }
          }
        } catch (cause) {
          io.stderr(`(auto-reindex skipped: ${cause instanceof Error ? cause.message : String(cause)})\n`);
        }
      }

      // Load notes index — soft-fail with hint if missing
      let index: NotesIndex | undefined;
      try {
        const raw = await readFile(notesIndexPath(), "utf8");
        index = JSON.parse(raw) as NotesIndex;
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
          io.stderr("No notes index at ~/.muse/notes-index.json. Run `muse notes reindex` first.\n");
          process.exitCode = 1;
          return;
        }
        throw cause;
      }
      if (index.model !== embedModel) {
        io.stderr(`Index was built with embed model '${index.model}', not '${embedModel}'. Re-index or pass --embed-model ${index.model}.\n`);
        process.exitCode = 1;
        return;
      }

      // Embed query + rank chunks. A personal assistant shouldn't
      // refuse to answer just because the embedding endpoint is
      // down — degrade to "no notes grounding" and still answer
      // from tasks + calendar + memory + general knowledge.
      let scored: Array<{ chunk: IndexChunk; file: string; score: number }> = [];
      let notesUnavailable = false;
      let queryVec: number[] | undefined;
      try {
        queryVec = await embed(query, embedModel);
        // Skip index entries whose note file was deleted since the last
        // reindex — otherwise `ask` grounds on (and cites) a note that no
        // longer exists. recall / today --connect already guard this.
        const allScored = filterLiveNoteIndexFiles(index.files, existsSync).flatMap((f) => f.chunks.map((chunk) => ({
          chunk,
          file: f.path,
          score: cosine(queryVec!, chunk.embedding)
        })));
        // MMR over the candidates (not a plain top-K cosine slice) so the
        // grounding fed to the small local model is diverse, not three
        // near-duplicate chunks of the same note.
        scored = diversifyAskChunks(allScored, topK);
      } catch (cause) {
        notesUnavailable = true;
        const detail = cause instanceof Error ? cause.message : String(cause);
        io.stderr(
          `(notes search unavailable — embedding via '${embedModel}' failed: ${detail}. ` +
          `Answering without notes context. To restore RAG grounding: ` +
          `\`ollama pull ${embedModel}\` (and ensure Ollama is running).)\n`
        );
      }

      // Auto-refresh the episode index (mirrors the notes auto-reindex above)
      // so past sessions stay groundable without a manual `muse episode
      // reindex` — incremental (only new/changed summaries re-embed), gated by
      // --no-auto-reindex, fail-soft. Without this the episode grounding below
      // silently saw a stale/empty index for anyone who hadn't reindexed.
      if (options.autoReindex !== false && queryVec) {
        try {
          const sourceEpisodes = await readEpisodes(resolveEpisodesFile(process.env as Record<string, string | undefined>));
          const prevIndex = await loadEpisodeIndex(defaultEpisodeIndexFile());
          if (episodeIndexStale(prevIndex, sourceEpisodes, embedModel)) {
            const built = await buildEpisodeIndex({
              embedFn: (text) => embed(text, embedModel),
              episodes: sourceEpisodes,
              model: embedModel,
              nowIso: new Date().toISOString(),
              previous: prevIndex
            });
            await saveEpisodeIndex(defaultEpisodeIndexFile(), built.index);
            if (built.embedded > 0) {
              io.stderr(`(auto-refreshed episode index: ${built.embedded.toString()} embedded, ${built.skipped.toString()} cached)\n`);
            }
          }
        } catch {
          // episode-index refresh failed — grounding still works on whatever index exists
        }
      }

      // SB-1 (second brain): also ground on past-session episode summaries
      // so `muse ask "what did I decide about X?"` reaches your prior
      // conversations, not just notes. Same embed model only (a cross-model
      // cosine is meaningless); optional + fail-soft.
      let episodeHits: Array<{ id: string; summary: string; score: number }> = [];
      if (queryVec) {
        try {
          const epIndex = await loadEpisodeIndex(defaultEpisodeIndexFile());
          if (epIndex && epIndex.model === embedModel && epIndex.entries.length > 0) {
            // Drop episodes vacuumed/deleted from the source since indexing.
            const liveIds = new Set((await readEpisodes(resolveEpisodesFile(process.env as Record<string, string | undefined>))).map((e) => e.id));
            episodeHits = rankEpisodeHits(queryVec, filterLiveEpisodeEntries(epIndex.entries, liveIds), topK);
          }
        } catch {
          // episodes index missing / unreadable — grounding still works
        }
      }
      const episodeBlock = episodeHits.length === 0
        ? "(no relevant past sessions)"
        : episodeHits
          .map((e, i) => `<<session ${(i + 1).toString()} — ${e.id} (score ${e.score.toFixed(3)})>>\n${e.summary}\n<<end>>`)
          .join("\n\n");

      // SB-1/G2: recent watched-feed headlines as world-state knowledge, so
      // "what's new in X?" reaches the user's subscribed feeds. Time-ordered
      // (not embedded); capped to keep the prompt tight. Optional + fail-soft.
      let feedHeadlines: Array<{ feedName: string; title: string; publishedAt: string; summary: string }> = [];
      try {
        const store = await readFeedsStore(defaultFeedsFile());
        feedHeadlines = recentFeedHeadlines(store.feeds, 8);
      } catch {
        // feeds store missing / unreadable — grounding still works
      }
      const feedBlock = feedHeadlines.length === 0
        ? "(no recent feed headlines)"
        : feedHeadlines
          .map((h, i) => `<<feed ${(i + 1).toString()} — ${h.feedName} (${h.publishedAt})>>\n${h.title}${h.summary ? `\n${h.summary}` : ""}\n<<end>>`)
          .join("\n\n");

      // Build assembly + chat-only fast path. `--actuators` (only
      // meaningful with --with-tools) injects the gated state-changing
      // actuator tools, each carrying a clack confirm as its
      // fail-closed gate.
      const useActuators = options.actuators === true && options.withTools === true;
      if (options.actuators === true && options.withTools !== true) {
        io.stderr("(--actuators has no effect without --with-tools)\n");
      }
      let extraTools: MuseTool[] | undefined;
      if (useActuators) {
        const actuatorMod = await import("./actuator-tools.js");
        const actuatorEnv = process.env as MuseEnvironment;
        io.stderr(actuatorMod.formatActuatorBanner(actuatorMod.summarizeActuators(actuatorEnv)));
        extraTools = actuatorMod.buildActuatorTools({ env: actuatorEnv, io, userId: userKey });
      }
      const assembly = createMuseRuntimeAssembly(extraTools ? { extraTools } : {});
      if (!assembly.modelProvider || !(options.model ?? assembly.defaultModel)) {
        io.stderr("muse ask requires a configured model. Set MUSE_MODEL or pass --model.\n");
        process.exitCode = 2;
        return;
      }
      const baseModel = options.model ?? assembly.defaultModel!;
      const tierRoute = options.tiered && options.model === undefined
        ? routeAskTierModel(query, baseModel, process.env)
        : undefined;
      const model = tierRoute?.model ?? baseModel;
      if (tierRoute) {
        io.stderr(`(tier: ${tierRoute.tier} → ${model})\n`);
      }

      const userMemory = await Promise.resolve(assembly.userMemoryStore.findByUserId(userKey));
      const personaPrompt = userMemory ? buildMusePersona(userMemory, userKey) : undefined;
      const { loadActivePersonaPreamble } = await import("./persona-store.js");
      const personaTemplatePreamble = await loadActivePersonaPreamble();

      // Compose RAG context block. Edge-place the chunks (most relevant at
      // the start + end, least in the middle) per "Lost in the Middle" so the
      // small local model actually attends to the strongest grounding.
      const contextChunks = reorderForLongContext(scored);
      // CRAG: grade the notes' retrieval confidence so a weak near-miss isn't
      // presented to the small model as something to cite as fact.
      const notesFraming = notesGroundingFraming(scored);
      const contextBlock = notesUnavailable
        ? "(notes search unavailable this turn — answer from the other grounding sources)"
        : contextChunks.length === 0
          ? "(no relevant notes found)"
          : contextChunks.map((r, i) => `<<note ${(i + 1).toString()} — ${r.file} (score ${r.score.toFixed(3)})>>\n${r.chunk.text}\n<<end>>`).join("\n\n");

      // Pull open tasks as a second grounding source. Real JARVIS
      // questions ("what should I focus on today?", "what's left
      // for the wedding?") hit tasks, not notes — and we have a
      // task store already. Sort by due date so the most imminent
      // are first; cap the dump to keep the prompt tight.
      let openTasks: readonly PersistedTask[] = [];
      if (options.tasks !== false) {
        try {
          const tasksFile = resolveTasksFile(process.env as Record<string, string | undefined>);
          const all = await readTasks(tasksFile);
          openTasks = all
            .filter((t) => t.status === "open")
            .sort((a, b) => {
              const ad = a.dueAt ? new Date(a.dueAt).getTime() : Number.POSITIVE_INFINITY;
              const bd = b.dueAt ? new Date(b.dueAt).getTime() : Number.POSITIVE_INFINITY;
              return ad - bd;
            })
            .slice(0, 20);
        } catch {
          // tasks file missing or unreadable — silently skip, notes
          // grounding still works
        }
      }
      const taskBlock = openTasks.length === 0
        ? "(no open tasks)"
        : openTasks
          .map((t, i) => {
            const due = t.dueAt ? ` (due ${t.dueAt})` : "";
            const urgent = t.urgent ? " [URGENT]" : "";
            return `<<task ${(i + 1).toString()} — ${t.id}${urgent}>>\n${t.title}${due}\n<<end>>`;
          })
          .join("\n\n");

      // Pull upcoming calendar events as a third grounding source.
      // "What's on my schedule this week?", "any meetings tomorrow?",
      // "when am I free?" — questions the LLM can only answer if it
      // sees the events. Iterate over all registered providers
      // (local + gcal + caldav + macos) so users with mixed setups
      // get one merged view.
      let upcomingEvents: readonly CalendarEvent[] = [];
      if (options.calendar !== false) {
        const days = parseBoundedInt(options.calendarDays, "--calendar-days", 1, 30, 7);
        const from = new Date();
        const to = new Date(from.getTime() + days * 24 * 60 * 60 * 1000);
        try {
          const registry = buildCalendarRegistry(process.env as Record<string, string | undefined>);
          const providers = registry.list();
          const collected: CalendarEvent[] = [];
          for (const provider of providers) {
            try {
              const events = await provider.listEvents({ from, to });
              collected.push(...events);
            } catch {
              // single provider failed (auth lapsed, network) —
              // keep going with whatever we got
            }
          }
          upcomingEvents = collected
            .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())
            .slice(0, 20);
        } catch {
          // registry assembly failed — skip calendar grounding
        }
      }
      const calendarBlock = upcomingEvents.length === 0
        ? "(no upcoming events)"
        : upcomingEvents
          .map((e, i) => {
            const when = e.allDay
              ? `${e.startsAt.toISOString().slice(0, 10)} (all-day)`
              : `${e.startsAt.toISOString()} → ${e.endsAt.toISOString()}`;
            const loc = e.location ? ` @ ${e.location}` : "";
            const provider = `[${e.providerId}]`;
            return `<<event ${(i + 1).toString()} — ${provider}>>\n${e.title}${loc}\n${when}\n<<end>>`;
          })
          .join("\n\n");

      // Pull pending reminders as a fourth grounding source.
      // Reminders are fire-once notifications ("ping me in 2 hours"),
      // distinct from tasks (general TODOs) and events (timed
      // meetings). "What reminders did I set?" / "anything I asked
      // you to remind me of?" lands here.
      let pendingReminders: readonly PersistedReminder[] = [];
      if (options.reminders !== false) {
        try {
          const file = resolveRemindersFile(process.env as Record<string, string | undefined>);
          const all = await readReminders(file);
          pendingReminders = all
            .filter((r) => r.status === "pending")
            .sort((a, b) => new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime())
            .slice(0, 20);
        } catch {
          // file missing — silently skip
        }
      }
      const reminderBlock = pendingReminders.length === 0
        ? "(no pending reminders)"
        : pendingReminders
          .map((r, i) => `<<reminder ${(i + 1).toString()} — ${r.id} (due ${r.dueAt})>>\n${r.text}\n<<end>>`)
          .join("\n\n");

      // Phase 2 (runtime self-tuning): the ACE playbook's [Learned
      // Strategies] reach the agent-runtime (--with-tools) path via the
      // runtime's playbookProvider, but NOT this chat-only fast path. Pull
      // them in for the chat-only stream below so past feedback shapes the
      // default `muse ask` answer too. Fail-soft; zero strategies ⇒ no block.
      let playbookSection: string | undefined;
      try {
        const { queryPlaybook } = await import("@muse/mcp");
        const { resolvePlaybookFile } = await import("@muse/autoconfigure");
        const envTopK = Number(process.env.MUSE_PLAYBOOK_INJECT_TOPK);
        playbookSection = selectPlaybookSection(
          await queryPlaybook(resolvePlaybookFile(process.env as Record<string, string | undefined>), userKey),
          query,
          Number.isFinite(envTopK) && envTopK >= 1 ? envTopK : undefined
        );
      } catch {
        playbookSection = undefined;
      }

      const systemPrompt = [
        ...(personaTemplatePreamble.length > 0 ? [personaTemplatePreamble, ""] : []),
        ...(personaPrompt ? [personaPrompt, ""] : []),
        // Date/time line is ALWAYS present, even with no persona —
        // questions like "anything due today?" / "is the dentist
        // tomorrow?" require the model to know `now`, regardless of
        // whether any facts have been remembered. When a persona is
        // injected, this duplicates the line buildMusePersona
        // emits; that's harmless. When persona is absent, this is
        // the only path that grounds the model in time.
        formatCurrentContextLine(),
        "",
        "You are Muse, the user's JARVIS-style personal AI conductor.",
        "Answer the user's question USING ONLY the notes, open tasks, upcoming events, pending reminders, past session summaries, and recent feed headlines provided below as context.",
        "If none of the provided context contains enough information, say so directly — do not invent facts.",
        ...(notesFraming.guidance ? [notesFraming.guidance] : []),
        "Reply in the user's preferred language (from persona prefs).",
        "Keep it concise — 2–4 sentences unless the question explicitly needs more.",
        "Do NOT include the raw '<<note N — ...>>' / '<<task N>>' / '<<event N>>' / '<<reminder N>>' wrapper markers in your answer; speak naturally.",
        // Smaller models (2B Qwen, etc.) echo angle-bracket placeholders
        // literally — a `<file>` placeholder ended up in user-visible
        // output. Show the substitution worked example so the model
        // copies the SHAPE, not the placeholder name.
        "Cite sources inline by substituting the actual value (NEVER keep angle-bracket placeholders):",
        "  - for notes:     [from journal/2026-05-12.md]",
        "  - for tasks:     [task: Q3 budget memo]",
        "  - for events:    [event: Standup]",
        "  - for reminders: [reminder: pick up milk]",
        "  - for past sessions: [session: reviewed the API contract]",
        "  - for feed headlines: [feed: Hacker News]",
        "Use only the filename (not the full path or score) when citing a note.",
        "",
        notesFraming.header,
        contextBlock,
        "=== END NOTES ===",
        "",
        "=== USER OPEN TASKS (sorted by due date, most imminent first) ===",
        taskBlock,
        "=== END TASKS ===",
        "",
        "=== UPCOMING CALENDAR EVENTS (sorted chronologically) ===",
        calendarBlock,
        "=== END CALENDAR ===",
        "",
        "=== PENDING REMINDERS (sorted by due date) ===",
        reminderBlock,
        "=== END REMINDERS ===",
        "",
        "=== PAST SESSION SUMMARIES (your prior conversations) ===",
        episodeBlock,
        "=== END PAST SESSIONS ===",
        "",
        "=== RECENT FEED HEADLINES (your watched RSS/Atom feeds, newest first) ===",
        feedBlock,
        "=== END FEED HEADLINES ==="
      ].join("\n");

      // Show citation header before streaming the answer so the user
      // sees what's being grounded against, then the model output.
      const groundedParts: string[] = [];
      if (scored.length > 0) {
        const conf = notesFraming.verdict === "ambiguous" ? " ⚠ LOW confidence — verify, may not be in your notes" : "";
        groundedParts.push(`${scored.length.toString()} note chunk(s) — ${scored.map((r) => r.file.split("/").pop()).join(", ")}${conf}`);
      }
      if (openTasks.length > 0) {
        groundedParts.push(`${openTasks.length.toString()} open task(s)`);
      }
      if (upcomingEvents.length > 0) {
        groundedParts.push(`${upcomingEvents.length.toString()} upcoming event(s)`);
      }
      if (pendingReminders.length > 0) {
        groundedParts.push(`${pendingReminders.length.toString()} pending reminder(s)`);
      }
      if (episodeHits.length > 0) {
        groundedParts.push(`${episodeHits.length.toString()} past session(s)`);
      }
      if (feedHeadlines.length > 0) {
        groundedParts.push(`${feedHeadlines.length.toString()} feed headline(s)`);
      }
      // Grounding diagnostic goes to stderr so `muse ask "?" > answer.txt`
      // and `| jq` style pipelines get a clean stdout. Same convention
      // as the auto-reindex banner above. The blank line separating
      // header from answer body stays out of stdout entirely.
      if (groundedParts.length > 0) {
        io.stderr(`(grounded on ${groundedParts.join("; ")})\n`);
      } else {
        io.stderr("(no matching notes, tasks, events, or reminders — answering from persona + general knowledge)\n");
      }

      // --notes-only hard-disables native web_search (the adapters
      // honour enabled:false and skip the upstream tool request)
      // and clamps the tool registry (allowedToolNames below).
      const webSearchPolicy = options.notesOnly
        ? { enabled: false, maxUses: 0 }
        : undefined;

      let collectedAnswer = "";
      let toolsUsed: readonly string[] = [];
      if (options.withTools) {
        // Agent-runtime path — tools (muse.search, muse.notes.*,
        // muse.tasks.*, etc.) are exposed to the model and tool calls
        // get full round-trip execution. Slower (every tool round is
        // an extra request) but unlocks fresh-web answers + side-
        // effecting actions from a single `muse ask` shot.
        if (!assembly.agentRuntime) {
          io.stderr("(--with-tools requires a configured agent runtime — set MUSE_MODEL or provider key and re-run)\n");
          process.exitCode = 1;
          return;
        }
        try {
          const result = await assembly.agentRuntime.run({
            messages: [
              { content: systemPrompt, role: "system" },
              { content: query, role: "user" }
            ],
            metadata: {
              userId: userKey,
              ...(useActuators ? { localMode: true } : {}),
              ...(options.notesOnly ? { allowedToolNames: [...NOTES_ONLY_TOOL_ALLOWLIST] } : {}),
              ...(webSearchPolicy ? { webSearchPolicy } : {})
            },
            model
          });
          collectedAnswer = result.response.output ?? "";
          toolsUsed = result.toolsUsed ?? [];
        } catch (cause) {
          // Same --json contract as the chat-only path: an agent
          // failure must be a parseable stdout object, not an
          // uncaught throw that leaves stdout empty.
          const rendered = renderAskStreamError({
            answer: collectedAnswer,
            error: cause instanceof Error ? cause.message : String(cause),
            json: options.json ?? false,
            model,
            query
          });
          if (rendered.stdout !== undefined) io.stdout(rendered.stdout);
          if (rendered.stderr !== undefined) io.stderr(rendered.stderr);
          process.exitCode = 1;
          return;
        }
        if (!options.json) {
          if (toolsUsed.length > 0) {
            io.stderr(`(tools used: ${toolsUsed.join(", ")})\n`);
          }
          io.stdout(collectedAnswer);
        }
      } else {
        // Chat-only fast path — direct modelProvider.stream, no tool
        // registry. Suitable for "explain this", "summarise that"
        // queries that don't need fresh external data.
        // withSigintAbort so Ctrl-C exits 130 instead of leaving
        // the stream pump dangling on the adapter side.
        let streamError: string | undefined;
        await withSigintAbort(async (signal) => {
          const res = await consumeAskStream(
            assembly.modelProvider!.stream({
              messages: [
                { content: composeChatSystemContent(systemPrompt, playbookSection), role: "system" },
                { content: query, role: "user" }
              ],
              ...(webSearchPolicy ? { metadata: { webSearchPolicy } } : {}),
              model
            }) as AsyncIterable<AskStreamEvent>,
            (text) => { if (!options.json) io.stdout(text); },
            () => signal.aborted
          );
          collectedAnswer = res.answer;
          streamError = res.error;
        }, { onSigint: () => { if (!options.json) io.stderr("\n(Ctrl-C — aborting…)\n"); } });
        if (streamError !== undefined) {
          const rendered = renderAskStreamError({
            answer: collectedAnswer,
            error: streamError,
            json: options.json ?? false,
            model,
            query
          });
          if (rendered.stdout !== undefined) io.stdout(rendered.stdout);
          if (rendered.stderr !== undefined) io.stderr(rendered.stderr);
          process.exitCode = 1;
          return;
        }
      }

      if (options.json) {
        // Emit a single JSON object on stdout — consumers can pipe
        // through `jq` to extract the answer, grounded sources, or
        // both. The grounded banner on stderr already announced what
        // was injected; the JSON repeats it in structured form so
        // downstream scripts don't have to parse the banner.
        const payload = {
          query,
          model,
          answer: collectedAnswer,
          ...(options.withTools ? { toolsUsed } : {}),
          grounded: {
            noteChunks: scored.map((r) => ({ file: r.file, score: r.score, text: r.chunk.text })),
            openTasks: openTasks.map((t) => ({
              id: t.id,
              title: t.title,
              ...(t.dueAt ? { dueAt: t.dueAt } : {}),
              ...(t.urgent ? { urgent: true } : {})
            })),
            upcomingEvents: upcomingEvents.map((e) => ({
              id: e.id,
              providerId: e.providerId,
              title: e.title,
              startsAt: e.startsAt.toISOString(),
              endsAt: e.endsAt.toISOString(),
              allDay: e.allDay,
              ...(e.location ? { location: e.location } : {})
            })),
            pendingReminders: pendingReminders.map((r) => ({
              id: r.id,
              text: r.text,
              dueAt: r.dueAt
            }))
          }
        };
        io.stdout(`${JSON.stringify(payload, null, 2)}\n`);
      } else {
        io.stdout("\n");
        // SB-3: a readable second-brain provenance footer the user can
        // scan — reuses the grounding already ranked this turn (no extra
        // search), only the strongest hits, shared formatter with `today`.
        if (options.connect) {
          const section = formatConnectionsSection(buildAskConnections({
            episodes: episodeHits,
            notes: scored.map((r) => ({ file: r.file, score: r.score, text: r.chunk.text }))
          }));
          if (section.length > 0) {
            io.stdout(section);
          }
        }
      }
    });
}
