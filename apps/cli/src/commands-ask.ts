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

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { buildCalendarRegistry, createMuseRuntimeAssembly, resolveNotesDir, resolveRemindersFile, resolveTasksFile, type MuseEnvironment } from "@muse/autoconfigure";
import type { MuseTool } from "@muse/tools";
import type { CalendarEvent } from "@muse/calendar";
import { readReminders, readTasks, type PersistedReminder, type PersistedTask } from "@muse/mcp";
import { classifyTier, type ModelTier } from "@muse/multi-agent";
import type { Command } from "commander";

import { cosine, isNotesIndexStale, reindexNotes } from "./commands-notes-rag.js";
import { embed } from "./embed.js";
import { defaultEpisodeIndexFile, loadEpisodeIndex } from "./episode-index.js";
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
export function rankEpisodeHits(
  queryVec: readonly number[],
  episodes: ReadonlyArray<{ readonly id: string; readonly summary: string; readonly embedding: readonly number[] }>,
  topK: number
): Array<{ id: string; summary: string; score: number }> {
  if (topK <= 0) {
    return [];
  }
  return episodes
    .map((ep) => ({ id: ep.id, score: cosine(queryVec, ep.embedding), summary: ep.summary }))
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
        scored = index.files.flatMap((f) => f.chunks.map((chunk) => ({
          chunk,
          file: f.path,
          score: cosine(queryVec!, chunk.embedding)
        })))
          .sort((a, b) => b.score - a.score)
          .slice(0, topK);
      } catch (cause) {
        notesUnavailable = true;
        const detail = cause instanceof Error ? cause.message : String(cause);
        io.stderr(
          `(notes search unavailable — embedding via '${embedModel}' failed: ${detail}. ` +
          `Answering without notes context. To restore RAG grounding: ` +
          `\`ollama pull ${embedModel}\` (and ensure Ollama is running).)\n`
        );
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
            episodeHits = rankEpisodeHits(queryVec, epIndex.entries, topK);
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

      // Compose RAG context block
      const contextBlock = notesUnavailable
        ? "(notes search unavailable this turn — answer from the other grounding sources)"
        : scored.length === 0
          ? "(no relevant notes found)"
          : scored.map((r, i) => `<<note ${(i + 1).toString()} — ${r.file} (score ${r.score.toFixed(3)})>>\n${r.chunk.text}\n<<end>>`).join("\n\n");

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
        "=== USER NOTES (top relevant chunks) ===",
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
        groundedParts.push(`${scored.length.toString()} note chunk(s) — ${scored.map((r) => r.file.split("/").pop()).join(", ")}`);
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
                { content: systemPrompt, role: "system" },
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
      }
    });
}
