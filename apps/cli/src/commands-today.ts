/**
 * `muse today` — personal-JARVIS morning briefing.
 *
 * Remote mode: GET /api/today?lookaheadHours=N (one round-trip).
 * Local mode (--local): compose the same shape from the on-disk
 * tasks file, notes dir, and the local calendar file without an API
 * server. OAuth (Google) and CalDAV calendar providers stay
 * API-only — they need credential bootstrapping that's owned by the
 * runtime assembly, so `--local` only sees events written to
 * `~/.muse/calendar.json`.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { readFile as fsReadFile } from "node:fs/promises";
import { join, resolve as resolvePath } from "node:path";

import {
  createMuseRuntimeAssembly,
  resolveContactsFile,
  resolveEpisodesFile,
  resolveTasksFile,
  type MuseEnvironment
} from "@muse/autoconfigure";
import { queryContacts, readTasks, readEpisodes } from "@muse/stores";
import {
  TODAY_BRIEF_SYSTEM_PROMPT as BRIEF_SYSTEM_PROMPT,
  buildTodayBriefUserMessage
} from "@muse/prompts";
import { redactSecretsInText } from "@muse/shared";
import type { TextToSpeechProvider } from "@muse/voice";
import type { Command } from "commander";

import { filterLiveEpisodeEntries, filterLiveNoteIndexFiles, rankRecallCandidates, type RecallHit } from "./commands-recall.js";
import { embed } from "./embed.js";
import { defaultEpisodeIndexFile, loadEpisodeIndex } from "./episode-index.js";
import { formatLocalDate, formatLocalDateTime as shortDateTimeBrief } from "./human-formatters.js";
import { isApiUnreachable } from "./program-helpers.js";
import { withBestEffort } from "./async-promises.js";
export { formatHeadlines, formatWeatherLine, resolveTodayFeedHeadlines, resolveTodayWeatherLine } from "./commands-today-feeds.js";
import { resolveTodayFeedHeadlines, resolveTodayWeatherLine } from "./commands-today-feeds.js";
import { formatEpisodeRevisitLine, formatStaleTasksSection, selectEpisodeToRevisit, selectStaleTasks } from "./today-stale-revisit.js";
export { formatEpisodeRevisitLine, formatStaleTasksSection, selectEpisodeToRevisit, selectStaleTasks } from "./today-stale-revisit.js";
import { formatNoteFocusSection, selectNoteFocus, type NoteMtime } from "./note-focus.js";
import {
  annotateEventTitle,
  formatConnectionsSection,
  formatRevisitSection,
  formatTodayBrief,
  pickConnectionQuery,
  relativeDueTag,
  type TodayBriefing,
} from "./today-format.js";
export {
  annotateEventTitle,
  formatConnectionsSection,
  formatEvents,
  formatLargestBreak,
  formatNextEvent,
  formatOverdue,
  formatRevisitSection,
  formatTasks,
  formatTodayBrief,
  formatTodayConflicts,
  largestBreakBetweenEvents,
  pickConnectionQuery,
  relativeDueTag,
  selectTodayOverdue,
} from "./today-format.js";
import { collectNotesRecursive, composeLocalBriefing } from "./today-local-sources.js";
export {
  buildLocalTodayText,
  readDueFollowups,
  readDueReminders,
  readLocalEvents,
  readUpcomingBirthdays,
} from "./today-local-sources.js";
import { loadActivePersonaPreamble } from "./persona-store.js";
import type { ProgramIO } from "./program.js";
import { DEFAULT_EMBED_MODEL } from "./embed-model-default.js";
import {
  loadDefaultTts,
  parseAudioFormat,
  synthesizeAndPlay,
  type AudioFormat,
  type SpeakerShells
} from "./voice-playback.js";

function environment(): MuseEnvironment {
  return process.env;
}

export interface TodayCommandShells {
  readonly tts?: TextToSpeechProvider;
  readonly speaker?: SpeakerShells;
}

export interface TodayCommandHelpers {
  readonly apiRequest: (
    io: ProgramIO,
    command: Command,
    path: string,
    body?: Record<string, unknown>,
    method?: "GET" | "POST" | "PUT" | "DELETE"
  ) => Promise<unknown>;
  readonly writeOutput: (io: ProgramIO, value: unknown, textField?: string) => void;
  /**
   * Optional injection point for the `--speak` flow. Tests pass a
   * fake TTS + speaker shells; default lazily loads the configured
   * voice registry.
   */
  readonly shells?: TodayCommandShells;
}


export function registerTodayCommands(program: Command, io: ProgramIO, helpers: TodayCommandHelpers): void {
  program
    .command("today")
    .description("Personal morning briefing — open tasks, next 24h calendar, recent notes")
    .addHelpText("after", `
Examples:
  $ muse today            # your morning briefing — tasks, next 24h, recent notes
  $ muse today --brief    # a 2-3 sentence natural-language summary
  $ muse today --speak    # read the brief aloud through your speakers`)
    .option("--json", "Print machine-readable JSON instead of the formatted summary")
    .option("--lookahead-hours <n>", "Hours of calendar look-ahead (default 24)")
    .option("--local", "Compose locally without the API (calendar limited to the local file)")
    .option("--brief", "Render the briefing as a 2-3 sentence natural-language summary via the configured model")
    .option("--model <name>", "Model id to use for --brief (defaults to MUSE_MODEL)")
    .option("--speak", "After printing the brief, synthesize via TTS and play through the speakers")
    .option("--audio-voice <name>", "TTS voice id (provider-specific, e.g. 'alloy' for OpenAI)")
    .option("--audio-format <type>", "TTS output format: mp3 | wav | opus | aac | flac (default mp3)")
    .option("--save-to-notes <path>", "Persist the --brief narrative to a markdown note (relative to MUSE_NOTES_DIR). Requires --brief.")
    .option("--connect", "Surface related past notes/sessions for today's items (second-brain connection)")
    .action(async (
      options: {
        readonly json?: boolean;
        readonly lookaheadHours?: string;
        readonly local?: boolean;
        readonly brief?: boolean;
        readonly connect?: boolean;
        readonly model?: string;
        readonly speak?: boolean;
        readonly audioVoice?: string;
        readonly audioFormat?: string;
        readonly saveToNotes?: string;
      },
      command
    ) => {
      if (options.speak && !options.brief) {
        throw new Error("--speak requires --brief (only the brief prose is spoken)");
      }
      if (options.saveToNotes && !options.brief) {
        throw new Error("--save-to-notes requires --brief (only the brief narrative is saved)");
      }
      // Validate once up front (throws on a bad flag, same as the
      // --speak / --save-to-notes guards above) so a typo is
      // rejected before any local or remote work.
      const lookaheadHours = parseLookaheadHours(options.lookaheadHours);
      let briefing: TodayBriefing;
      let usedLocal = options.local === true;
      if (options.local) {
        briefing = await composeLocalBriefing(lookaheadHours);
      } else {
        try {
          briefing = await fetchRemoteBriefing(io, command, helpers, options.lookaheadHours);
        } catch (cause) {
          // JARVIS UX: a personal user without the API daemon up
          // should still get a useful morning briefing. The
          // apiRequest helper raises a friendly one-line error
          // when ECONNREFUSED / ENOTFOUND hits, but the briefing
          // itself is reconstructible from the same on-disk
          // sources used by `--local`. Surface the fall-back
          // explicitly on stderr so the user knows what's
          // happening, but never fail the command.
          if (isApiUnreachable(cause)) {
              // Only warn when the user EXPLICITLY pointed Muse at an API
              // (--api-url / MUSE_API_URL). The default is local-first with no
              // daemon, so "API not reachable" on every plain `muse today` reads
              // as broken to the CLI-only user the product targets — silently use
              // the on-disk briefing instead.
            const globals = command.optsWithGlobals<{ readonly apiUrl?: string }>();
            const configuredApiUrl = typeof globals.apiUrl === "string" && globals.apiUrl.trim().length > 0 ? globals.apiUrl : undefined;
            if (apiWasExplicitlyConfigured(configuredApiUrl, process.env.MUSE_API_URL)) {
              io.stderr("muse: API not reachable — falling back to local briefing.\n");
            }
            briefing = await composeLocalBriefing(lookaheadHours);
            usedLocal = true;
          } else {
            throw cause;
          }
        }
      }

      const env = environment();
      const weatherLine = await resolveTodayWeatherLine(env);
      if (weatherLine) {
        briefing = { ...briefing, weather: weatherLine };
      }

      // Recent feed headlines are resolved CLIENT-side from the local
      // feeds store and merged here — same pattern as weather — so the
      // brief surfaces the user's ambient world-state on BOTH the local
      // and remote paths (the API daemon doesn't compose feeds).
      const headlines = await resolveTodayFeedHeadlines(env, lookaheadHours);
      if (headlines && headlines.length > 0) {
        briefing = { ...briefing, headlines };
      }

      // Annotate an event whose title names a known contact with that person's
      // relationship to the user ("Lunch with Dana (your manager)") — the
      // relationship graph surfaced in the day view. Client-side like weather /
      // feeds, so it works on both the local and remote briefing paths. Fail-soft.
      if (briefing.events && briefing.events.length > 0) {
        try {
          const contacts = await queryContacts(resolveContactsFile(env));
          if (contacts.length > 0) {
            briefing = {
              ...briefing,
              events: briefing.events.map((e) => ({ ...e, title: `${e.title}${annotateEventTitle(e.title, contacts)}` }))
            };
          }
        } catch {
          // contacts unreadable — show events without the relationship annotation
        }
      }

      // SB/proactive: related past knowledge for today's items (opt-in). One
      // search, reused by both output paths; fail-soft — never blocks the brief.
      let connectionsSection = "";
      if (options.connect && !options.json) {
        try {
          const hits = await findTodayConnections(pickConnectionQuery(briefing));
          connectionsSection = formatConnectionsSection(hits);
        } catch {
          // a down embedding endpoint / missing index must not fail the brief
        }
      }

      // Proactive spaced-revisit: surface notes whose age crossed a review
      // interval today (spacing effect). CLI-side like --connect, default-on
      // but silent when nothing's due; never blocks the brief. Skipped under
      // --json (the structured payload comes from the API briefing shape).
      let revisitSection = "";
      if (!options.json) {
        try {
          const { collectDueRevisits } = await import("./commands-notes-rag.js");
          const { resolveNotesDir } = await import("@muse/autoconfigure");
          const due = await collectDueRevisits(resolveNotesDir(env));
          revisitSection = formatRevisitSection(due);
        } catch {
          // unreadable notes dir must not fail the brief
        }
      }

      // Proactive GTD nudge: open + undated tasks that have rotted past the
      // staleness threshold — today's due-based view never resurfaces them.
      // CLI-side, default-on, silent when none, skipped under --json, fail-soft.
      let staleTasksSection = "";
      if (!options.json) {
        try {
          const all = await readTasks(resolveTasksFile(env));
          staleTasksSection = formatStaleTasksSection(selectStaleTasks(all, Date.now()));
        } catch {
          // unreadable tasks file must not fail the brief
        }
      }

      // "What you've been focused on": the note FAMILY the user has edited most
      // this week (mtime only — writes, never opens). A grounded felt beat (B2
      // S7); default-on, silent on a quiet week, --json-skipped, fail-soft.
      let focusSection = "";
      if (!options.json) {
        try {
          const { resolveNotesDir } = await import("@muse/autoconfigure");
          const mtimes = await collectNoteMtimes(resolveNotesDir(env));
          focusSection = formatNoteFocusSection(selectNoteFocus(mtimes, Date.now()));
        } catch {
          // unreadable notes dir must not fail the brief
        }
      }

      // "Remember when": one past session whose age crossed a spaced-revisit
      // interval today. CLI-side, default-on, silent when none, --json-skipped.
      let episodeRevisitLine = "";
      if (!options.json) {
        try {
          const episodes = await readEpisodes(resolveEpisodesFile(env));
          episodeRevisitLine = formatEpisodeRevisitLine(selectEpisodeToRevisit(episodes, Date.now()));
        } catch {
          // unreadable episodes file must not fail the brief
        }
      }

      if (options.brief) {
        const prose = await renderBrief(io, command, helpers, briefing, usedLocal, options.model);
        if (options.json) {
          helpers.writeOutput(io, { ...briefing, brief: prose });
        } else {
          io.stdout(`${prose.trim()}\n${connectionsSection}${revisitSection}${staleTasksSection}${focusSection}${episodeRevisitLine}`);
        }
        if (options.speak) {
          await speakPlain(io, helpers.shells, prose, options.audioVoice, parseAudioFormat(options.audioFormat));
        }
        if (options.saveToNotes && options.saveToNotes.trim().length > 0) {
          // Banner goes to stderr so a piped stdout consumer
          // still gets only the prose.
          const { resolveNotesDir } = await import("@muse/autoconfigure");
          const { LocalDirNotesProvider } = await import("@muse/domain-tools");
          const notesDir = resolveNotesDir(env);
          const provider = new LocalDirNotesProvider({ notesDir });
          const title = `Today brief — ${shortDateLabel(briefing.generatedAt)}`;
          // Scrub the LLM brief before it persists — a task/event
          // title may quote a credential and the note is long-lived
          // and may sync to a third-party store.
          const body = [
            `# ${title}`,
            "",
            redactSecretsInText(prose.trim()),
            ""
          ].join("\n");
          try {
            await provider.save({
              body,
              id: options.saveToNotes.trim(),
              overwrite: true,
              title: title.slice(0, 120)
            });
            io.stderr(`(saved brief to ${options.saveToNotes.trim()} in ${notesDir})\n`);
          } catch (cause) {
            const msg = cause instanceof Error ? cause.message : String(cause);
            io.stderr(`(failed to save brief: ${msg})\n`);
            process.exitCode = 1;
          }
        }
        return;
      }

      if (options.json) {
        helpers.writeOutput(io, briefing);
        return;
      }

      io.stdout(`${formatTodayBrief(briefing, usedLocal)}${connectionsSection}${revisitSection}${staleTasksSection}${focusSection}${episodeRevisitLine}`);
    });
}

/** Search the notes + episode indices for knowledge related to today's items. */
async function findTodayConnections(query: string, embedModel = DEFAULT_EMBED_MODEL): Promise<readonly RecallHit[]> {
  if (query.trim().length === 0) {
    return [];
  }
  interface NotesIdx { readonly model: string; readonly files: ReadonlyArray<{ readonly path: string; readonly chunks: ReadonlyArray<{ readonly text: string; readonly embedding: readonly number[] }> }> }
  let notesIndex: NotesIdx | undefined;
  try {
    notesIndex = JSON.parse(await fsReadFile(join(homedir(), ".muse", "notes-index.json"), "utf8")) as NotesIdx;
  } catch {
    notesIndex = undefined;
  }
  if (!notesIndex || notesIndex.model !== embedModel) {
    return [];
  }
  // Drop index entries whose source was deleted/vacuumed since the last
  // reindex — otherwise `today --connect` surfaces "ghost" notes/sessions that
  // no longer exist (recall already guards this; today must match).
  const liveFiles = filterLiveNoteIndexFiles(notesIndex.files, existsSync);
  const noteChunks = liveFiles.flatMap((f) => f.chunks.map((c) => ({ embedding: c.embedding, path: f.path, text: c.text })));
  const epIndex = await loadEpisodeIndex(defaultEpisodeIndexFile());
  let episodeEntries = epIndex && epIndex.model === embedModel ? epIndex.entries : [];
  if (episodeEntries.length > 0) {
    const liveIds = new Set((await readEpisodes(resolveEpisodesFile(environment()))).map((e) => e.id));
    episodeEntries = filterLiveEpisodeEntries(episodeEntries, liveIds);
  }
  const queryVec = await embed(query, embedModel);
  return rankRecallCandidates({ episodeEntries, limit: 3, noteChunks, queryText: query, queryVec, source: "all" }).filter((h) => h.score >= 0.5);
}

/**
 * Replace every ISO timestamp in the briefing with a PRE-FORMATTED local
 * clock string before it reaches the model. The local 8B mis-converts raw
 * ISO/offset timestamps (it narrated a 15:00 task as "6 AM"); handing it the
 * already-correct local time (the same string the structured `today` prints)
 * turns the model's job into copy-not-compute. Same principle as the cited-
 * recall fix: never make the small model do the arithmetic.
 */
function humanizeBriefingForModel(briefing: TodayBriefing): Record<string, unknown> {
  const now = new Date();
  return {
    ...briefing,
    ...(briefing.tasks ? {
      tasks: briefing.tasks.map((t) => ({
        id: t.id,
        title: t.title,
        ...(t.dueAt ? { due: `${shortDateTimeBrief(t.dueAt)}${relativeDueTag(t.dueAt, now)}` } : {})
      }))
    } : {}),
    ...(briefing.events ? {
      events: briefing.events.map((e) => ({
        id: e.id,
        title: e.title,
        starts: shortDateTimeBrief(e.startsAtIso),
        ...(e.endsAtIso ? { ends: shortDateTimeBrief(e.endsAtIso) } : {})
      }))
    } : {}),
    ...(briefing.reminders ? {
      reminders: briefing.reminders.map((r) => ({ id: r.id, text: r.text, due: shortDateTimeBrief(r.dueAt) }))
    } : {}),
    ...(briefing.followups ? {
      followups: briefing.followups.map((f) => ({ id: f.id, summary: f.summary, due: shortDateTimeBrief(f.scheduledFor) }))
    } : {})
  };
}

async function renderBrief(
  io: ProgramIO,
  command: Command,
  helpers: TodayCommandHelpers,
  briefing: TodayBriefing,
  local: boolean,
  modelOverride: string | undefined
): Promise<string> {
  // Hand the model pre-formatted local times (see humanizeBriefingForModel) so
  // it never mis-converts a raw ISO timestamp.
  const modelBriefing = humanizeBriefingForModel(briefing);
  // /api/chat doesn't take a system message, so the prompt is folded
  // into the single user message via the shared builder. The local
  // path keeps the system role separate via agentRuntime.run.
  const remoteMessage = buildTodayBriefUserMessage(modelBriefing);

  // The morning brief should speak in the active persona's voice
  // (JARVIS / casual / …), same as `muse chat`. Empty (default
  // persona) → unchanged request.
  const personaPreamble = (await withBestEffort(loadActivePersonaPreamble(), "")).trim();

  if (local) {
    const userBody = `Briefing JSON:\n${JSON.stringify(modelBriefing, null, 2)}\n\nRender this as a short conversational morning brief.`;
    return runLocalBrief(io, userBody, modelOverride, personaPreamble);
  }

  const body: Record<string, unknown> = {
    message: remoteMessage,
    metadata: { source: "today.brief" }
  };
  if (modelOverride) {
    body.model = modelOverride;
  }
  if (personaPreamble.length > 0) {
    body.systemPrompt = personaPreamble;
  }
  const response = await helpers.apiRequest(io, command, "/api/chat", body);
  const responseRecord: Record<string, unknown> = {};
  if (response && typeof response === "object" && !Array.isArray(response)) {
    for (const [key, value] of Object.entries(response)) {
      if (typeof key === "string") {
        responseRecord[key] = value;
      }
    }
  }
  const content = typeof responseRecord.content === "string" ? responseRecord.content : "";
  if (!content) {
    throw new Error(
      `today --brief got an empty response from the model${
        typeof responseRecord.errorMessage === "string" ? ` (${responseRecord.errorMessage})` : ""
      }`
    );
  }
  return content;
}

async function speakPlain(
  io: ProgramIO,
  shells: TodayCommandShells | undefined,
  text: string,
  voice: string | undefined,
  format: AudioFormat
): Promise<void> {
  const tts = shells?.tts ?? loadDefaultTts();
  if (!tts) {
    io.stderr(
      "today --speak: no TTS provider configured. Set OPENAI_API_KEY (or MUSE_VOICE_OPENAI_API_KEY) to enable.\n"
    );
    return;
  }
  await synthesizeAndPlay(
    tts,
    { text, format, ...(voice ? { voice } : {}) },
    shells?.speaker
  );
}

async function runLocalBrief(
  io: ProgramIO,
  userMessage: string,
  modelOverride: string | undefined,
  personaPreamble: string
): Promise<string> {
  const assembly = io.createRuntimeAssembly?.() ?? createMuseRuntimeAssembly();
  if (!assembly.agentRuntime || !(modelOverride ?? assembly.defaultModel)) {
    throw new Error("today --brief --local requires MUSE_MODEL and a configured model provider");
  }
  const systemContent = personaPreamble.length > 0
    ? `${personaPreamble}\n\n${BRIEF_SYSTEM_PROMPT}`
    : BRIEF_SYSTEM_PROMPT;
  const result = await assembly.agentRuntime.run({
    // Machine-authored brief input — not a conversational turn.
    metadata: { internalTurn: true },
    messages: [
      { content: systemContent, role: "system" },
      { content: userMessage, role: "user" }
    ],
    model: modelOverride ?? assembly.defaultModel ?? "default"
  });
  const text = result.response.output;
  if (!text || text.trim().length === 0) {
    throw new Error("today --brief --local: model returned an empty response");
  }
  return text;
}

async function fetchRemoteBriefing(
  io: ProgramIO,
  command: Command,
  helpers: TodayCommandHelpers,
  lookaheadHoursFlag: string | undefined
): Promise<TodayBriefing> {
  const lookaheadParam = lookaheadHoursFlag
    ? `?lookaheadHours=${encodeURIComponent(lookaheadHoursFlag)}`
    : "";
  return (await helpers.apiRequest(io, command, `/api/today${lookaheadParam}`)) as TodayBriefing;
}

/**
 * True only when the user EXPLICITLY pointed Muse at an API endpoint
 * (`--api-url` flag or `MUSE_API_URL`). Local-first is the default and runs with
 * no daemon, so a plain `muse today` falling back to the on-disk briefing is the
 * EXPECTED path — warning "API not reachable" there reads as broken. Pure +
 * exported for direct coverage.
 */
export function apiWasExplicitlyConfigured(apiUrlFlag: string | undefined, apiUrlEnv: string | undefined): boolean {
  return ((apiUrlFlag ?? apiUrlEnv) ?? "").trim().length > 0;
}


async function collectNoteMtimes(notesDir: string): Promise<readonly NoteMtime[]> {
  const root = resolvePath(notesDir);
  const collected: { name: string; mtime: number }[] = [];
  await collectNotesRecursive(root, "", collected, 0);
  return collected.map((entry) => ({ mtimeMs: entry.mtime, relPath: entry.name }));
}

// Absent → 24. A genuine number is truncated and clamped to
// the 168h max; a non-numeric / unit-slip / below-1 value
// rejects with an actionable message instead of silently
// using 24 — `Number()` not `parseInt` so `48abc` rejects.
export function parseLookaheadHours(raw: string | undefined): number {
  if (raw === undefined || raw.trim().length === 0) {
    return 24;
  }
  const parsed = Number(raw.trim());
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error(`--lookahead-hours must be an integer in [1, 168] (got '${raw}')`);
  }
  return Math.min(Math.trunc(parsed), 24 * 7);
}

function shortDateLabel(generatedAt: string): string {
  return formatLocalDate(generatedAt);
}
