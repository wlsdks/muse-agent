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

import { existsSync, promises as fs } from "node:fs";
import { homedir } from "node:os";
import { readFile as fsReadFile } from "node:fs/promises";
import { join, resolve as resolvePath } from "node:path";

import {
  createMuseRuntimeAssembly,
  resolveFollowupsFile,
  resolveLocalCalendarFile,
  resolveNotesDir,
  resolveRemindersFile,
  resolveEpisodesFile,
  resolveTasksFile
} from "@muse/autoconfigure";
import { LocalCalendarProvider } from "@muse/calendar";
import {
  compareFollowupsByScheduledFor,
  compareRemindersByDueAt,
  compareTasksByDueDate,
  OpenMeteoWeatherProvider,
  readFollowups,
  readReminders,
  readTasks,
  resolveWeatherLine,
  serializeFollowup,
  serializeReminder,
  serializeTask,
  type PersistedTask,
  readEpisodes,
  detectCalendarConflicts,
  type WeatherProvider
} from "@muse/mcp";
import {
  TODAY_BRIEF_SYSTEM_PROMPT as BRIEF_SYSTEM_PROMPT,
  buildTodayBriefUserMessage
} from "@muse/prompts";
import { redactSecretsInText, stripUntrustedTerminalChars } from "@muse/shared";
import type { TextToSpeechProvider } from "@muse/voice";
import type { Command } from "commander";

import { filterLiveEpisodeEntries, filterLiveNoteIndexFiles, rankRecallCandidates, type RecallHit } from "./commands-recall.js";
import { embed } from "./embed.js";
import { defaultEpisodeIndexFile, loadEpisodeIndex } from "./episode-index.js";
import { compareFeedEntriesNewestFirst, defaultFeedsFile, filterRecentFeedEntries, readFeedsStore } from "./feeds-store.js";
import { formatLocalDate, formatLocalDateTime as shortDateTimeBrief } from "./human-formatters.js";
import { loadActivePersonaPreamble } from "./persona-store.js";
import type { ProgramIO } from "./program.js";
import { colorize } from "./tty-color.js";
import {
  loadDefaultTts,
  parseAudioFormat,
  synthesizeAndPlay,
  type AudioFormat,
  type SpeakerShells
} from "./voice-playback.js";

export interface TodayCommandShells {
  readonly tts?: TextToSpeechProvider;
  readonly speaker?: SpeakerShells;
}

const MAX_RECENT_NOTES = 5;
const MAX_NOTES_WALK_DEPTH = 8;

interface TodayBriefing {
  readonly generatedAt: string;
  readonly weather?: string;
  readonly lookaheadHours: number;
  readonly tasks?: readonly { readonly id: string; readonly title: string; readonly dueAt?: string }[];
  readonly events?: readonly { readonly id: string; readonly title: string; readonly startsAtIso: string; readonly endsAtIso?: string }[];
  readonly notes?: readonly string[];
  readonly reminders?: readonly { readonly id: string; readonly text: string; readonly dueAt: string }[];
  readonly followups?: readonly { readonly id: string; readonly summary: string; readonly scheduledFor: string }[];
  readonly headlines?: readonly { readonly feedId: string; readonly title: string; readonly link: string; readonly publishedAt: string }[];
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
            io.stderr("muse: API not reachable — falling back to local briefing.\n");
            briefing = await composeLocalBriefing(lookaheadHours);
            usedLocal = true;
          } else {
            throw cause;
          }
        }
      }

      const weatherLine = await resolveTodayWeatherLine(process.env as Record<string, string | undefined>);
      if (weatherLine) {
        briefing = { ...briefing, weather: weatherLine };
      }

      // Recent feed headlines are resolved CLIENT-side from the local
      // feeds store and merged here — same pattern as weather — so the
      // brief surfaces the user's ambient world-state on BOTH the local
      // and remote paths (the API daemon doesn't compose feeds).
      const headlines = await resolveTodayFeedHeadlines(process.env as Record<string, string | undefined>, lookaheadHours);
      if (headlines && headlines.length > 0) {
        briefing = { ...briefing, headlines };
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
          const due = await collectDueRevisits(resolveNotesDir(process.env as Record<string, string | undefined>));
          revisitSection = formatRevisitSection(due);
        } catch {
          // unreadable notes dir must not fail the brief
        }
      }

      if (options.brief) {
        const prose = await renderBrief(io, command, helpers, briefing, usedLocal, options.model);
        if (options.json) {
          helpers.writeOutput(io, { ...briefing, brief: prose });
        } else {
          io.stdout(`${prose.trim()}\n${connectionsSection}${revisitSection}`);
        }
        if (options.speak) {
          await speakPlain(io, helpers.shells, prose, options.audioVoice, parseAudioFormat(options.audioFormat));
        }
        if (options.saveToNotes && options.saveToNotes.trim().length > 0) {
          // Banner goes to stderr so a piped stdout consumer
          // still gets only the prose.
          const { resolveNotesDir } = await import("@muse/autoconfigure");
          const { LocalDirNotesProvider } = await import("@muse/mcp");
          const notesDir = resolveNotesDir(process.env as Record<string, string | undefined>);
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

      io.stdout(`${formatTodayBrief(briefing, usedLocal)}${connectionsSection}${revisitSection}`);
    });
}

/**
 * Render a composed briefing as the formatted text block (header + every
 * section + empty-state hints). Shared by `muse today` and the in-chat
 * `/today` so both render identically. Each section helper already carries
 * its own trailing newline.
 */
export function formatTodayBrief(briefing: TodayBriefing, local: boolean): string {
  return (
    `Today (${shortDateLabel(briefing.generatedAt)}, next ${briefing.lookaheadHours}h${local ? ", local" : ""})\n`
    + formatWeatherLine(briefing.weather)
    + formatReminders(briefing.reminders, briefing.generatedAt)
    + formatFollowups(briefing.followups, briefing.generatedAt)
    + formatTasks(briefing.tasks, briefingNow(briefing), briefing.lookaheadHours)
    + formatEvents(briefing.events)
    + formatTodayConflicts(briefing.events)
    + formatNotes(briefing.notes)
    + formatHeadlines(briefing.headlines)
    + formatEmptyStateHints(briefing)
  );
}

/**
 * SB/proactive: build a recall query from today's most concrete items (task +
 * event titles, tasks first) so the briefing can surface related past knowledge.
 * Pure — empty when there's nothing concrete to connect from.
 */
export function pickConnectionQuery(briefing: {
  readonly tasks?: readonly { readonly title: string }[];
  readonly events?: readonly { readonly title: string }[];
}): string {
  return [
    ...(briefing.tasks ?? []).map((t) => t.title),
    ...(briefing.events ?? []).map((e) => e.title)
  ]
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .slice(0, 5)
    .join("; ");
}

/**
 * Render the proactive "Worth revisiting" block — notes whose age landed
 * on a spaced-review interval today (spacing effect / Leitner). Empty when
 * nothing's due, so most days it stays silent. Shows the filename + the
 * interval it crossed.
 */
export function formatRevisitSection(due: readonly { readonly path: string; readonly intervalDays: number }[]): string {
  if (due.length === 0) {
    return "";
  }
  const lines = due.map((d) => `  [${d.intervalDays.toString()}d] ${d.path.split("/").pop() ?? d.path}`);
  return `\n📒 Worth revisiting (spaced review):\n${lines.join("\n")}\n`;
}

/** Render the proactive "Related in your brain" block (empty when no hits). */
export function formatConnectionsSection(hits: readonly RecallHit[]): string {
  if (hits.length === 0) {
    return "";
  }
  const lines = hits.map((h) => `  [${h.source}] ${h.ref.split("/").pop() ?? h.ref} — ${h.snippet.replace(/\s+/gu, " ").trim().slice(0, 80)}`);
  return `\n💡 Related in your brain:\n${lines.join("\n")}\n`;
}

/** Search the notes + episode indices for knowledge related to today's items. */
async function findTodayConnections(query: string, embedModel = "nomic-embed-text"): Promise<readonly RecallHit[]> {
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
    const liveIds = new Set((await readEpisodes(resolveEpisodesFile(process.env as Record<string, string | undefined>))).map((e) => e.id));
    episodeEntries = filterLiveEpisodeEntries(episodeEntries, liveIds);
  }
  const queryVec = await embed(query, embedModel);
  return rankRecallCandidates({ episodeEntries, limit: 3, noteChunks, queryVec, source: "all" }).filter((h) => h.score >= 0.5);
}

/**
 * Compose the morning briefing from the LOCAL on-disk sources (tasks, events,
 * notes, reminders, follow-ups) plus weather + feed headlines, and return the
 * formatted text. The in-chat `/today` path — no API daemon, no model — so a
 * small local model never has to chain four tool calls to answer "what's today".
 */
export async function buildLocalTodayText(env: Record<string, string | undefined>, lookaheadHours: number): Promise<string> {
  let briefing = await composeLocalBriefing(lookaheadHours);
  const weather = await resolveTodayWeatherLine(env);
  if (weather) briefing = { ...briefing, weather };
  const headlines = await resolveTodayFeedHeadlines(env, lookaheadHours);
  if (headlines && headlines.length > 0) briefing = { ...briefing, headlines };
  return formatTodayBrief(briefing, true).trimEnd();
}

/**
 * When every section came back empty (fresh install — no tasks, no
 * events, no notes, no reminders, no followups), the briefing
 * collapses to a wall of "(none)" lines with no next step. Surface
 * a few onboarding commands so a first-time user knows where to
 * start. Suppressed the moment any section carries data — once
 * the user has at least one of anything the report is informative
 * on its own.
 */
function formatEmptyStateHints(briefing: TodayBriefing): string {
  const hasContent =
    (briefing.tasks?.length ?? 0) > 0
    || (briefing.events?.length ?? 0) > 0
    || (briefing.notes?.length ?? 0) > 0
    || (briefing.reminders?.length ?? 0) > 0
    || (briefing.followups?.length ?? 0) > 0
    || (briefing.headlines?.length ?? 0) > 0;
  if (hasContent) {
    return "";
  }
  return [
    "",
    "Looks like a fresh start. A few JARVIS-friendly ways to seed today:",
    "  muse tasks add \"Send Q3 memo\" --due tomorrow",
    "  muse remind add \"Call vet\" \"tomorrow at 6pm\"",
    "  muse notes save daily/2026-05-14.md \"Today's plan: ...\"",
    "  muse remember \"I prefer concise Korean replies\"",
    ""
  ].join("\n");
}


async function renderBrief(
  io: ProgramIO,
  command: Command,
  helpers: TodayCommandHelpers,
  briefing: TodayBriefing,
  local: boolean,
  modelOverride: string | undefined
): Promise<string> {
  // /api/chat doesn't take a system message, so the prompt is folded
  // into the single user message via the shared builder. The local
  // path keeps the system role separate via agentRuntime.run.
  const remoteMessage = buildTodayBriefUserMessage(briefing);

  // The morning brief should speak in the active persona's voice
  // (JARVIS / casual / …), same as `muse chat`. Empty (default
  // persona) → unchanged request.
  const personaPreamble = (await loadActivePersonaPreamble().catch(() => "")).trim();

  if (local) {
    const userBody = `Briefing JSON:\n${JSON.stringify(briefing, null, 2)}\n\nRender this as a short conversational morning brief.`;
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
  const response = (await helpers.apiRequest(io, command, "/api/chat", body)) as Record<string, unknown>;
  const content = typeof response.content === "string" ? response.content : "";
  if (!content) {
    throw new Error(
      `today --brief got an empty response from the model${
        typeof response.errorMessage === "string" ? ` (${response.errorMessage})` : ""
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
 * Detect the friendly "API not reachable" / "API host unresolved"
 * error shape `program.ts` raises when the daemon is down.
 * Triggers the local-mode fallback in the morning briefing.
 */
function isApiUnreachable(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const msg = error.message;
  return msg.includes("Muse API not reachable") || msg.includes("Muse API host unresolved");
}

async function composeLocalBriefing(lookaheadHours: number): Promise<TodayBriefing> {
  const env = process.env as Record<string, string | undefined>;
  const tasksFile = resolveTasksFile(env);
  const notesDir = resolveNotesDir(env);
  const calendarFile = resolveLocalCalendarFile(env);
  const remindersFile = resolveRemindersFile(env);
  const followupsFile = resolveFollowupsFile(env);
  const now = new Date();
  const horizon = new Date(now.getTime() + lookaheadHours * 3_600_000);

  const [tasks, events, notes, reminders, followups] = await Promise.all([
    readOpenTasks(tasksFile).catch(() => undefined),
    readLocalEvents(calendarFile, now, horizon).catch(() => undefined),
    readRecentNotes(notesDir).catch(() => undefined),
    readDueReminders(remindersFile, horizon).catch(() => undefined),
    readDueFollowups(followupsFile, horizon).catch(() => undefined)
  ]);

  return {
    events,
    followups,
    generatedAt: now.toISOString(),
    lookaheadHours,
    notes,
    reminders,
    tasks
  };
}

export async function readDueReminders(
  file: string,
  horizon: Date
): Promise<readonly { id: string; text: string; dueAt: string }[]> {
  const all = await readReminders(file);
  return all
    .filter((reminder) => {
      if (reminder.status !== "pending") {
        return false;
      }
      const due = Date.parse(reminder.dueAt);
      if (Number.isNaN(due)) {
        return false;
      }
      return due <= horizon.getTime();
    })
    // Sort by parsed instant, not raw ISO: a lexicographic compare
    // mis-orders mixed-precision / timezone-offset dueAt strings (a
    // hand-edited reminders.json or import need not be canonical), so
    // `muse today` could list a later reminder as more imminent. Reuse
    // the store's canonical comparator (same order as `muse reminders`).
    .slice()
    .sort(compareRemindersByDueAt)
    .map((reminder) => {
      const serialized = serializeReminder(reminder);
      return { dueAt: String(serialized.dueAt), id: String(serialized.id), text: String(serialized.text) };
    });
}

export async function readDueFollowups(
  file: string,
  horizon: Date
): Promise<readonly { id: string; summary: string; scheduledFor: string }[]> {
  const all = await readFollowups(file);
  return all
    .filter((followup) => {
      if (followup.status !== "scheduled") {
        return false;
      }
      const when = Date.parse(followup.scheduledFor);
      if (Number.isNaN(when)) {
        return false;
      }
      return when <= horizon.getTime();
    })
    .slice()
    .sort(compareFollowupsByScheduledFor)
    .map((followup) => {
      const serialized = serializeFollowup(followup);
      return {
        id: String(serialized.id),
        scheduledFor: String(serialized.scheduledFor),
        summary: String(serialized.summary)
      };
    });
}

async function readLocalEvents(
  file: string,
  from: Date,
  to: Date
): Promise<readonly { id: string; title: string; startsAtIso: string; endsAtIso: string }[]> {
  const provider = new LocalCalendarProvider({ file });
  const events = await provider.listEvents({ from, to });
  return events.map((event) => ({
    id: event.id,
    startsAtIso: event.startsAt.toISOString(),
    endsAtIso: event.endsAt.toISOString(),
    title: event.title
  }));
}

async function readOpenTasks(tasksFile: string): Promise<readonly { id: string; title: string }[]> {
  const all = await readTasks(tasksFile);
  return all
    .filter((task: PersistedTask) => task.status === "open")
    // Due-soonest first (same comparator as `muse tasks list`) so the
    // briefing leads with imminent deadlines instead of burying them
    // under recent quick-captures — and the slice keeps the most
    // due-relevant 50, not just the 50 newest.
    .sort(compareTasksByDueDate)
    .slice(0, 50)
    .map((task) => {
      const serialized = serializeTask(task);
      return {
        id: String(serialized.id),
        title: String(serialized.title),
        ...(serialized.dueAt ? { dueAt: String(serialized.dueAt) } : {})
      };
    });
}

async function readRecentNotes(notesDir: string): Promise<readonly string[]> {
  const root = resolvePath(notesDir);
  const collected: { name: string; mtime: number }[] = [];
  await collectNotesRecursive(root, "", collected, 0);
  return collected
    .sort((left, right) => right.mtime - left.mtime)
    .slice(0, MAX_RECENT_NOTES)
    .map((entry) => entry.name);
}

async function collectNotesRecursive(
  absDir: string,
  relPrefix: string,
  out: { name: string; mtime: number }[],
  depth: number
): Promise<void> {
  if (depth > MAX_NOTES_WALK_DEPTH) {
    return;
  }
  let entries: { readonly name: string; isDirectory(): boolean; isFile(): boolean }[];
  try {
    entries = (await fs.readdir(absDir, { withFileTypes: true })) as unknown as {
      readonly name: string;
      isDirectory(): boolean;
      isFile(): boolean;
    }[];
  } catch {
    return;
  }
  const visible = entries.filter((entry) => !entry.name.startsWith("."));
  const fileStats = await Promise.all(
    visible
      .filter((entry) => entry.isFile())
      .map(async (entry) => {
        const rel = relPrefix.length > 0 ? join(relPrefix, entry.name) : entry.name;
        try {
          const stat = await fs.stat(join(absDir, entry.name));
          return { mtime: stat.mtime.getTime(), name: rel };
        } catch {
          return undefined;
        }
      })
  );
  for (const entry of fileStats) {
    if (entry) {
      out.push(entry);
    }
  }
  for (const entry of visible) {
    if (entry.isDirectory()) {
      const childAbs = join(absDir, entry.name);
      const childRel = relPrefix.length > 0 ? join(relPrefix, entry.name) : entry.name;
      await collectNotesRecursive(childAbs, childRel, out, depth + 1);
    }
  }
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

function formatReminders(
  reminders: readonly { readonly id: string; readonly text: string; readonly dueAt: string }[] | undefined,
  generatedAt: string
): string {
  if (!reminders || reminders.length === 0) {
    return "";
  }
  const nowMs = Date.parse(generatedAt);
  const lines = reminders.map((reminder) => {
    const dueMs = Date.parse(reminder.dueAt);
    const overdue = Number.isFinite(dueMs) && Number.isFinite(nowMs) && dueMs < nowMs
      ? ` ${colorize("(overdue)", "red")}`
      : "";
    return `  - [${reminder.id.slice(0, 12)}] ${shortDateTimeBrief(reminder.dueAt)}  ${reminder.text}${overdue}`;
  });
  return `\n${colorize(`Reminders (${reminders.length.toString()}):`, "bold")}\n${lines.join("\n")}\n`;
}


function formatFollowups(
  followups: readonly { readonly id: string; readonly summary: string; readonly scheduledFor: string }[] | undefined,
  generatedAt: string
): string {
  if (!followups || followups.length === 0) {
    return "";
  }
  const nowMs = Date.parse(generatedAt);
  const lines = followups.map((followup) => {
    const dueMs = Date.parse(followup.scheduledFor);
    const overdue = Number.isFinite(dueMs) && Number.isFinite(nowMs) && dueMs < nowMs
      ? ` ${colorize("(overdue)", "red")}`
      : "";
    return `  - [${followup.id.slice(0, 12)}] ${shortDateTimeBrief(followup.scheduledFor)}  ${followup.summary}${overdue}`;
  });
  return `\n${colorize(`Followups (${followups.length.toString()}):`, "bold")}\n${lines.join("\n")}\n`;
}

/**
 * Relative due tag for a task in the daily view — " (overdue)" /
 * " (today)" / " (tomorrow)" / " (in N days)", or "" when undated /
 * unparseable. Calendar-day diff (local midnights) so a dueAt later
 * today still reads "today". Lets `muse today` show urgency instead of
 * a flat list of titles.
 */
function briefingNow(briefing: TodayBriefing): Date {
  const ms = Date.parse(briefing.generatedAt);
  return Number.isFinite(ms) ? new Date(ms) : new Date();
}

/**
 * Current-weather line for `muse today` — keyed on MUSE_WEATHER_LOCATION
 * (the user's home). Fetched by the CLI itself (Open-Meteo, no
 * key) so it shows in BOTH local and remote modes without a server
 * change. Fail-soft: no location configured, or a lookup failure, →
 * undefined (no weather line), never breaks the briefing.
 */
export async function resolveTodayWeatherLine(
  env: Record<string, string | undefined>,
  provider?: WeatherProvider
): Promise<string | undefined> {
  const location = env.MUSE_WEATHER_LOCATION?.trim();
  if (!location || location.length === 0) {
    return undefined;
  }
  return resolveWeatherLine(provider ?? new OpenMeteoWeatherProvider(), location);
}

export function formatWeatherLine(weather: string | undefined): string {
  if (!weather || weather.trim().length === 0) {
    return "";
  }
  return `\nWeather: ${weather.trim()}\n`;
}

export const DEFAULT_TODAY_HEADLINES_CAP = 5;

/**
 * Recent feed headlines for the brief: entries published within the
 * lookahead window (mirrors `muse feeds today`), newest-first, capped.
 * Read client-side from the local feeds store — fail-soft (a missing /
 * unreadable store yields `undefined`, so the brief just omits the
 * section rather than failing). `cap` keeps the brief concise.
 */
export async function resolveTodayFeedHeadlines(
  env: Record<string, string | undefined>,
  lookaheadHours: number,
  cap: number = DEFAULT_TODAY_HEADLINES_CAP
): Promise<readonly { readonly feedId: string; readonly title: string; readonly link: string; readonly publishedAt: string }[] | undefined> {
  const hours = Number.isFinite(lookaheadHours) && lookaheadHours > 0 ? lookaheadHours : 24;
  const effectiveCap = Number.isFinite(cap) && cap > 0 ? Math.trunc(cap) : DEFAULT_TODAY_HEADLINES_CAP;
  const cutoff = new Date(Date.now() - hours * 3_600_000);
  let store;
  try {
    store = await readFeedsStore(env.MUSE_FEEDS_FILE?.trim() || defaultFeedsFile());
  } catch {
    return undefined;
  }
  const recent = store.feeds
    .flatMap((feed) => filterRecentFeedEntries(feed.entries, cutoff).map((entry) => ({ entry, feedId: feed.id })))
    .sort((a, b) => compareFeedEntriesNewestFirst(a.entry, b.entry))
    .slice(0, effectiveCap)
    .map(({ entry, feedId }) => ({ feedId, link: entry.link, publishedAt: entry.publishedAt, title: entry.title }));
  return recent.length > 0 ? recent : undefined;
}

export function formatHeadlines(
  headlines: readonly { readonly feedId: string; readonly title: string; readonly publishedAt: string }[] | undefined
): string {
  if (!headlines || headlines.length === 0) {
    return "";
  }
  // Feed titles are third-party-controlled — strip ESC/C0/C1/DEL like
  // the inbox / feeds / search surfaces before printing to the terminal.
  const clean = (value: string): string => stripUntrustedTerminalChars(value).replace(/\s+/gu, " ").trim();
  const lines = headlines.map((h) => `  - [${clean(h.feedId)}] ${clean(h.title)}`);
  return `\nHeadlines (${headlines.length.toString()}):\n${lines.join("\n")}\n`;
}

export function relativeDueTag(dueAtIso: string | undefined, now: Date): string {
  if (!dueAtIso) {
    return "";
  }
  const ms = Date.parse(dueAtIso);
  if (!Number.isFinite(ms)) {
    return "";
  }
  const due = new Date(ms);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dayDiff = Math.round((new Date(due.getFullYear(), due.getMonth(), due.getDate()).getTime() - today.getTime()) / 86_400_000);
  if (dayDiff < 0) {
    return " (overdue)";
  }
  if (dayDiff === 0) {
    return " (today)";
  }
  if (dayDiff === 1) {
    return " (tomorrow)";
  }
  return ` (in ${dayDiff.toString()} days)`;
}

export function formatTasks(
  tasks: readonly { readonly id: string; readonly title: string; readonly dueAt?: string }[] | undefined,
  now: Date,
  lookaheadHours = 24
): string {
  if (!tasks) {
    return "\nTasks: (not configured)\n";
  }
  if (tasks.length === 0) {
    return "\nTasks: (none open)\n";
  }
  const horizon = now.getTime() + lookaheadHours * 3_600_000;
  // Imminent = dated AND due within the window (overdue included — it is the
  // most pressing). Undated or far-future tasks are the long tail: in the
  // morning brief they are noise, so collapse them to a count + a pointer to
  // the full list rather than dumping every open task.
  const imminent = tasks.filter((task) => {
    if (!task.dueAt) {
      return false;
    }
    const due = Date.parse(task.dueAt);
    return Number.isFinite(due) && due <= horizon;
  });
  const remaining = tasks.length - imminent.length;
  const moreLine = remaining > 0 ? `\n  +${remaining} more open (use \`muse tasks list\`)` : "";
  if (imminent.length === 0) {
    return `\nTasks: ${tasks.length} open, none due within ${lookaheadHours}h (use \`muse tasks list\`)\n`;
  }
  const lines = imminent.map((task) => `  - [${task.id.slice(0, 12)}] ${task.title}${relativeDueTag(task.dueAt, now)}`);
  return `\nTasks due ≤${lookaheadHours}h (${imminent.length}):\n${lines.join("\n")}${moreLine}\n`;
}

/**
 * Proactive double-booking warning for the morning briefing: flag events that
 * overlap in time so the user is told "you're scheduled twice at once" without
 * having to run `muse calendar conflicts`. Only events carrying both start AND
 * end times participate (the local briefing provides them; a remote briefing
 * whose events lack endsAtIso simply yields no warning). Empty when none.
 */
export function formatTodayConflicts(
  events: readonly { readonly title: string; readonly startsAtIso: string; readonly endsAtIso?: string }[] | undefined
): string {
  const timed = (events ?? []).flatMap((e) =>
    e.endsAtIso ? [{ title: e.title, startsAt: new Date(e.startsAtIso), endsAt: new Date(e.endsAtIso) }] : []
  );
  const conflicts = detectCalendarConflicts(timed);
  if (conflicts.length === 0) {
    return "";
  }
  const lines = conflicts.map((c) => {
    const a = stripUntrustedTerminalChars(c.a.title).replace(/\s+/gu, " ").trim();
    const b = stripUntrustedTerminalChars(c.b.title).replace(/\s+/gu, " ").trim();
    return `  - "${a}" overlaps "${b}" (${c.overlapStartsAt.toISOString().slice(11, 16)}–${c.overlapEndsAt.toISOString().slice(11, 16)} UTC)`;
  });
  return `\n⚠️  Double-booked (${conflicts.length.toString()}):\n${lines.join("\n")}\n`;
}

export function formatEvents(events: readonly { readonly id: string; readonly title: string; readonly startsAtIso: string }[] | undefined): string {
  if (!events) {
    return "\nUpcoming: (calendar not configured)\n";
  }
  if (events.length === 0) {
    return "\nUpcoming: (no calendar events in window)\n";
  }
  // A calendar event SUMMARY is set by whoever sent the invite
  // (CalDAV / Google / shared calendars) — third-party-controlled
  // and printed straight to the terminal, so strip ESC/C0/C1/DEL
  // like the inbox / feeds / search surfaces.
  const lines = events.map((event) => {
    const title = stripUntrustedTerminalChars(event.title).replace(/\s+/gu, " ").trim();
    return `  - ${event.startsAtIso.slice(11, 16)} — ${title}`;
  });
  return `\nUpcoming (${events.length}):\n${lines.join("\n")}\n`;
}

function formatNotes(notes: readonly string[] | undefined): string {
  if (!notes) {
    return "\nRecent notes: (notes dir not configured)\n";
  }
  if (notes.length === 0) {
    return "\nRecent notes: (none)\n";
  }
  return `\nRecent notes:\n${notes.map((name) => `  - ${name}`).join("\n")}\n`;
}
