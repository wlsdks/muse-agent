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
  resolveContactsFile,
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
  queryContacts,
  readFollowups,
  readReminders,
  readTasks,
  resolveUpcomingBirthdays,
  serializeFollowup,
  serializeReminder,
  serializeTask,
  type PersistedTask,
  readEpisodes,
  detectCalendarConflicts,
  computeAvailability,
  type AvailabilityEventLike,
  type Contact,
} from "@muse/mcp";
import {
  TODAY_BRIEF_SYSTEM_PROMPT as BRIEF_SYSTEM_PROMPT,
  buildTodayBriefUserMessage
} from "@muse/prompts";
import { redactSecretsInText, stripUntrustedTerminalChars } from "@muse/shared";
import type { TextToSpeechProvider } from "@muse/voice";
import type { Command } from "commander";

import { filterLiveEpisodeEntries, filterLiveNoteIndexFiles, rankRecallCandidates, type RecallHit } from "./commands-recall.js";
import { revisitDueInterval } from "./commands-notes-rag.js";
import { embed } from "./embed.js";
import { defaultEpisodeIndexFile, loadEpisodeIndex } from "./episode-index.js";
import { formatLocalDate, formatLocalDateTime as shortDateTimeBrief } from "./human-formatters.js";
import { formatHeadlines, formatWeatherLine, resolveTodayFeedHeadlines, resolveTodayWeatherLine } from "./commands-today-feeds.js";
export { DEFAULT_TODAY_HEADLINES_CAP, formatHeadlines, formatWeatherLine, resolveTodayFeedHeadlines, resolveTodayWeatherLine } from "./commands-today-feeds.js";
import { formatNoteFocusSection, selectNoteFocus, type NoteMtime } from "./note-focus.js";
import { loadActivePersonaPreamble } from "./persona-store.js";
import type { ProgramIO } from "./program.js";
import { colorize } from "./tty-color.js";
import { DEFAULT_EMBED_MODEL } from "./embed-model-default.js";
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
  readonly birthdays?: readonly { readonly name: string; readonly daysUntil: number }[];
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
            // Only warn when the user EXPLICITLY pointed Muse at an API
            // (--api-url / MUSE_API_URL). The default is local-first with no
            // daemon, so "API not reachable" on every plain `muse today` reads
            // as broken to the CLI-only user the product targets — silently use
            // the on-disk briefing instead.
            const globals = command.optsWithGlobals() as { readonly apiUrl?: string };
            if (apiWasExplicitlyConfigured(globals.apiUrl, process.env.MUSE_API_URL)) {
              io.stderr("muse: API not reachable — falling back to local briefing.\n");
            }
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

      // Annotate an event whose title names a known contact with that person's
      // relationship to the user ("Lunch with Dana (your manager)") — the
      // relationship graph surfaced in the day view. Client-side like weather /
      // feeds, so it works on both the local and remote briefing paths. Fail-soft.
      if (briefing.events && briefing.events.length > 0) {
        try {
          const contacts = await queryContacts(resolveContactsFile(process.env as Record<string, string | undefined>));
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
          const due = await collectDueRevisits(resolveNotesDir(process.env as Record<string, string | undefined>));
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
          const all = await readTasks(resolveTasksFile(process.env as Record<string, string | undefined>));
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
          const mtimes = await collectNoteMtimes(resolveNotesDir(process.env as Record<string, string | undefined>));
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
          const episodes = await readEpisodes(resolveEpisodesFile(process.env as Record<string, string | undefined>));
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

      io.stdout(`${formatTodayBrief(briefing, usedLocal)}${connectionsSection}${revisitSection}${staleTasksSection}${focusSection}${episodeRevisitLine}`);
    });
}

/**
 * Render a composed briefing as the formatted text block (header + every
 * section + empty-state hints). Shared by `muse today` and the in-chat
 * `/today` so both render identically. Each section helper already carries
 * its own trailing newline.
 */
export function formatTodayBrief(briefing: TodayBriefing, local: boolean): string {
  const now = briefingNow(briefing);
  // Lead with what's already past due, then DROP those same items from the
  // prospective sections so each overdue item is surfaced ONCE (in the led
  // heads-up), not buried-and-duplicated below.
  const overdue = selectTodayOverdue(briefing.tasks, briefing.reminders, now);
  const overdueTaskIds = new Set(overdue.tasks.map((t) => t.id));
  const overdueReminderIds = new Set(overdue.reminders.map((r) => r.id));
  const futureTasks = briefing.tasks?.filter((t) => !overdueTaskIds.has(t.id));
  const futureReminders = briefing.reminders?.filter((r) => !overdueReminderIds.has(r.id));
  // When every open task was overdue, the led section already shows them —
  // suppress the prospective Tasks section rather than misreport "(none open)".
  const taskSection =
    futureTasks && futureTasks.length === 0 && overdue.tasks.length > 0
      ? ""
      : formatTasks(futureTasks, now, briefing.lookaheadHours);
  return (
    `Today (${shortDateLabel(briefing.generatedAt)}, next ${briefing.lookaheadHours}h${local ? ", local" : ""})\n`
    + formatOverdue(overdue)
    + formatNextEvent(briefing.events, now)
    + formatWeatherLine(briefing.weather)
    + formatReminders(futureReminders, briefing.generatedAt)
    + formatFollowups(briefing.followups, briefing.generatedAt)
    + taskSection
    + formatEvents(briefing.events)
    + formatTodayConflicts(briefing.events)
    + formatLargestBreak(largestBreakBetweenEvents(briefing.events, now))
    + formatBirthdays(briefing.birthdays)
    + formatNotes(briefing.notes)
    + formatHeadlines(briefing.headlines)
    + formatEmptyStateHints(briefing)
  );
}

/**
 * The OVERDUE slice of the on-demand `muse today` digest — open tasks +
 * pending reminders whose due moment is ALREADY PAST. The on-demand twin of
 * the morning brief's `selectBriefOverdue`: the brief LEADS with these (most
 * time-sensitive, still actionable today) while `muse today` only tagged them
 * "(overdue)" buried inside the per-category lists. Operates on the briefing's
 * already-serialized shapes (the readers pre-filter to open tasks / pending
 * reminders), so it only filters past-due. Pure; most-overdue-first.
 */
export function selectTodayOverdue(
  tasks: TodayBriefing["tasks"],
  reminders: TodayBriefing["reminders"],
  now: Date
): {
  readonly tasks: readonly { readonly id: string; readonly title: string; readonly dueAt: string }[];
  readonly reminders: readonly { readonly id: string; readonly text: string; readonly dueAt: string }[];
} {
  const nowMs = now.getTime();
  const pastDue = (iso: string | undefined): boolean => {
    if (!iso) return false;
    const ms = Date.parse(iso);
    return Number.isFinite(ms) && ms < nowMs;
  };
  return {
    reminders: (reminders ?? [])
      .filter((r) => pastDue(r.dueAt))
      .map((r) => ({ dueAt: r.dueAt, id: r.id, text: r.text }))
      .sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt)),
    tasks: (tasks ?? [])
      .filter((t) => pastDue(t.dueAt))
      .map((t) => ({ dueAt: t.dueAt as string, id: t.id, title: t.title }))
      .sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt))
  };
}

/**
 * The LED "act today" heads-up for `muse today` — open tasks + pending
 * reminders already past their due moment, surfaced ABOVE the prospective
 * sections so they aren't buried (the on-demand twin of the morning brief's
 * OVERDUE lead). Empty when nothing is overdue.
 */
export function formatOverdue(overdue: ReturnType<typeof selectTodayOverdue>): string {
  const count = overdue.tasks.length + overdue.reminders.length;
  if (count === 0) {
    return "";
  }
  const lines = [
    ...overdue.tasks.map((t) => `  ${colorize("⚠", "red")} ${t.title} (was due ${shortDateTimeBrief(t.dueAt)})`),
    ...overdue.reminders.map((r) => `  ${colorize("⚠", "red")} ${r.text} (was due ${shortDateTimeBrief(r.dueAt)})`)
  ];
  return `\n${colorize(`⚠ Overdue — past due, still open, act today (${count.toString()}):`, "bold")}\n${lines.join("\n")}\n`;
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

const STALE_TASK_DAYS = 14;
const STALE_TASK_MAX = 5;

export interface StaleTask {
  readonly id: string;
  readonly title: string;
  readonly ageDays: number;
}

/**
 * Open + UNDATED tasks older than `thresholdDays` (by createdAt), oldest
 * first, capped — a GTD review nudge (Allen 2001, "Getting Things Done")
 * for "stuff" that silently rots. DATED tasks are excluded: today's
 * imminent view already surfaces those, so this is complementary, not a
 * double-listing. Unparseable createdAt is skipped.
 */
export function selectStaleTasks(
  tasks: readonly { readonly id: string; readonly title: string; readonly status: string; readonly createdAt: string; readonly dueAt?: string }[],
  nowMs: number,
  thresholdDays: number = STALE_TASK_DAYS
): StaleTask[] {
  const threshold = Number.isFinite(thresholdDays) && thresholdDays > 0 ? thresholdDays : STALE_TASK_DAYS;
  return tasks
    .flatMap((task) => {
      if (task.status !== "open" || task.dueAt !== undefined) {
        return [];
      }
      const created = Date.parse(task.createdAt);
      if (!Number.isFinite(created)) {
        return [];
      }
      const ageDays = (nowMs - created) / 86_400_000;
      return ageDays >= threshold ? [{ ageDays, id: task.id, title: task.title }] : [];
    })
    .sort((a, b) => b.ageDays - a.ageDays)
    .slice(0, STALE_TASK_MAX);
}

export interface DueEpisode {
  readonly summary: string;
  readonly intervalDays: number;
  readonly ageDays: number;
}

/**
 * The single most evocative past session due for a spaced revisit today —
 * an episode whose age (by endedAt) crossed a review interval, the
 * "remember when" half of the spacing effect applied to conversations
 * (the same schedule notes use). Picks the largest interval crossed
 * (oldest memory), most-recent endedAt as the tiebreak. Undefined when
 * none is due. Unparseable endedAt is skipped.
 */
export function selectEpisodeToRevisit(
  episodes: readonly { readonly summary: string; readonly endedAt: string }[],
  nowMs: number
): DueEpisode | undefined {
  const due = episodes.flatMap((ep) => {
    const ended = Date.parse(ep.endedAt);
    if (!Number.isFinite(ended)) {
      return [];
    }
    const ageDays = (nowMs - ended) / 86_400_000;
    const intervalDays = revisitDueInterval(ageDays);
    return intervalDays === undefined ? [] : [{ ageDays, intervalDays, summary: ep.summary }];
  });
  due.sort((a, b) => b.intervalDays - a.intervalDays || a.ageDays - b.ageDays);
  return due[0];
}

/** Render the one-line "💭 N days ago" past-session resurface (empty when none). */
export function formatEpisodeRevisitLine(episode: DueEpisode | undefined): string {
  if (!episode) {
    return "";
  }
  const oneLine = episode.summary.replace(/\s+/gu, " ").trim().slice(0, 100);
  const days = Math.floor(episode.ageDays);
  return `\n💭 ${days.toString()} day${days === 1 ? "" : "s"} ago: ${oneLine}\n`;
}

/** Render the proactive "Open a while — still relevant?" nudge (empty when none). */
export function formatStaleTasksSection(stale: readonly StaleTask[]): string {
  if (stale.length === 0) {
    return "";
  }
  const lines = stale.map((task) => `  [${Math.floor(task.ageDays).toString()}d] ${task.title}`);
  return `\n🗂 Open a while — still relevant?\n${lines.join("\n")}\n`;
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
    const liveIds = new Set((await readEpisodes(resolveEpisodesFile(process.env as Record<string, string | undefined>))).map((e) => e.id));
    episodeEntries = filterLiveEpisodeEntries(episodeEntries, liveIds);
  }
  const queryVec = await embed(query, embedModel);
  return rankRecallCandidates({ episodeEntries, limit: 3, noteChunks, queryText: query, queryVec, source: "all" }).filter((h) => h.score >= 0.5);
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
  const personaPreamble = (await loadActivePersonaPreamble().catch(() => "")).trim();

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
 * True only when the user EXPLICITLY pointed Muse at an API endpoint
 * (`--api-url` flag or `MUSE_API_URL`). Local-first is the default and runs with
 * no daemon, so a plain `muse today` falling back to the on-disk briefing is the
 * EXPECTED path — warning "API not reachable" there reads as broken. Pure +
 * exported for direct coverage.
 */
export function apiWasExplicitlyConfigured(apiUrlFlag: string | undefined, apiUrlEnv: string | undefined): boolean {
  return ((apiUrlFlag ?? apiUrlEnv) ?? "").trim().length > 0;
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
  const contactsFile = resolveContactsFile(env);
  const now = new Date();
  const horizon = new Date(now.getTime() + lookaheadHours * 3_600_000);

  const [tasks, events, notes, reminders, followups, birthdays] = await Promise.all([
    readOpenTasks(tasksFile).catch(() => undefined),
    readLocalEvents(calendarFile, now, horizon).catch(() => undefined),
    readRecentNotes(notesDir).catch(() => undefined),
    readDueReminders(remindersFile, horizon).catch(() => undefined),
    readDueFollowups(followupsFile, horizon).catch(() => undefined),
    readUpcomingBirthdays(contactsFile, now).catch(() => undefined)
  ]);

  return {
    birthdays,
    events,
    followups,
    generatedAt: now.toISOString(),
    lookaheadHours,
    notes,
    reminders,
    tasks
  };
}

/**
 * Upcoming birthdays within a week — the same machinery the morning brief uses,
 * surfaced in the on-demand `muse today` digest so a user checking their day
 * doesn't miss "Zelda's birthday is today" just because they didn't wait for the
 * morning brief. Empty when no contact has a birthday in the window.
 */
export async function readUpcomingBirthdays(
  file: string,
  now: Date
): Promise<readonly { name: string; daysUntil: number }[]> {
  const contacts = await queryContacts(file);
  return resolveUpcomingBirthdays(contacts, { now, withinDays: 7 })
    .map((upcoming) => ({ daysUntil: upcoming.daysUntil, name: upcoming.contact.name }));
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

export async function readLocalEvents(
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

async function collectNoteMtimes(notesDir: string): Promise<readonly NoteMtime[]> {
  const root = resolvePath(notesDir);
  const collected: { name: string; mtime: number }[] = [];
  await collectNotesRecursive(root, "", collected, 0);
  return collected.map((entry) => ({ mtimeMs: entry.mtime, relPath: entry.name }));
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

function formatBirthdays(birthdays: TodayBriefing["birthdays"]): string {
  if (!birthdays || birthdays.length === 0) {
    return "";
  }
  const when = (days: number): string => days === 0 ? "today" : days === 1 ? "tomorrow" : `in ${days.toString()} days`;
  const lines = birthdays.map((birthday) => `  🎂 ${birthday.name} — ${when(birthday.daysUntil)}`);
  return `\n${colorize(`Birthdays (${birthdays.length.toString()}):`, "bold")}\n${lines.join("\n")}\n`;
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

const NAME_TOKEN = /[^\p{L}\p{N}]+/u;

/**
 * When a calendar event's title names a known contact who has a RELATIONSHIP to
 * the user, return the annotation to append — "Lunch with Dana" → " (your
 * manager)" — surfacing the relationship graph in the day view.
 * Matches a contact's name/alias TOKEN as a whole word in the title (so "Dana"
 * matches "Lunch with Dana"); only relationship-bearing contacts annotate (a
 * bare name adds nothing). Empty when nothing matches. Pure.
 */
export function annotateEventTitle(title: string, contacts: readonly Contact[]): string {
  const words = new Set(title.toLowerCase().split(NAME_TOKEN).filter((w) => w.length >= 2));
  if (words.size === 0) {
    return "";
  }
  const matched: { readonly first: string; readonly relationship: string }[] = [];
  const seen = new Set<string>();
  for (const contact of contacts) {
    const relationship = contact.relationship?.trim();
    if (!relationship || seen.has(contact.id)) {
      continue;
    }
    const names = [contact.name, ...(contact.aliases ?? [])];
    const hit = names.some((name) =>
      name.toLowerCase().split(NAME_TOKEN).some((token) => token.length >= 2 && words.has(token))
    );
    if (hit) {
      seen.add(contact.id);
      matched.push({ first: contact.name.split(/\s+/u)[0] ?? contact.name, relationship });
    }
  }
  if (matched.length === 0) {
    return "";
  }
  if (matched.length === 1) {
    return ` (your ${matched[0]!.relationship})`;
  }
  return ` (${matched.map((m) => `${m.first}: your ${m.relationship}`).join("; ")})`;
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

/** Relative countdown to the next event — "in 25 min" / "in 2h 10m" / "in 3 days". */
function formatTimeUntil(deltaMs: number): string {
  const mins = Math.round(deltaMs / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `in ${mins.toString()} min`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  if (hours < 24) return remMins > 0 ? `in ${hours.toString()}h ${remMins.toString()}m` : `in ${hours.toString()}h`;
  const days = Math.round(hours / 24);
  return `in ${days.toString()} day${days === 1 ? "" : "s"}`;
}

const MIN_BREAK_MS = 45 * 60_000; // a gap shorter than this isn't worth flagging as a "free block"

function formatBreakDuration(ms: number): string {
  const mins = Math.round(ms / 60_000);
  const hours = Math.floor(mins / 60);
  const rem = mins % 60;
  if (hours === 0) return `${rem.toString()}m`;
  if (rem === 0) return `${hours.toString()}h`;
  return `${hours.toString()}h ${rem.toString()}m`;
}

/**
 * The largest open gap BETWEEN today's meetings (events merged into busy blocks
 * first, so back-to-back events don't count as a gap) — your longest focus
 * window. ONLY gaps bounded by a meeting on both sides count, so the open-ended
 * trailing/overnight stretch after your last event is never reported. Bounded to
 * the rest of TODAY (local). Null when there's no ≥45-min between-meeting gap. Pure.
 */
export function largestBreakBetweenEvents(
  events: readonly { readonly startsAtIso: string; readonly endsAtIso?: string }[] | undefined,
  now: Date
): { readonly startsAt: Date; readonly endsAt: Date } | null {
  if (!events || events.length === 0) {
    return null;
  }
  const endOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);
  const eventLikes: AvailabilityEventLike[] = events
    .map((event) => {
      const startsAt = new Date(event.startsAtIso);
      const endsAt = event.endsAtIso ? new Date(event.endsAtIso) : new Date(startsAt.getTime() + 3_600_000);
      return { allDay: false, endsAt, startsAt, title: "" };
    })
    .filter((event) => Number.isFinite(event.startsAt.getTime()) && Number.isFinite(event.endsAt.getTime()) && event.endsAt.getTime() > event.startsAt.getTime());
  const { busy } = computeAvailability(eventLikes, { from: now, to: endOfToday });
  let best: { startsAt: Date; endsAt: Date } | null = null;
  for (let i = 0; i < busy.length - 1; i += 1) {
    const startsAt = busy[i]!.endsAt;
    const endsAt = busy[i + 1]!.startsAt;
    const length = endsAt.getTime() - startsAt.getTime();
    if (length >= MIN_BREAK_MS && (best === null || length > best.endsAt.getTime() - best.startsAt.getTime())) {
      best = { endsAt, startsAt };
    }
  }
  return best;
}

/** The "🟢 Biggest free block …" line for `muse today`, or empty when there's no meaningful gap. Pure. */
export function formatLargestBreak(slot: { readonly startsAt: Date; readonly endsAt: Date } | null): string {
  if (!slot) {
    return "";
  }
  const clock = (date: Date): string => date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  return `\n🟢 Biggest free block: ${clock(slot.startsAt)}–${clock(slot.endsAt)} (${formatBreakDuration(slot.endsAt.getTime() - slot.startsAt.getTime())}) — your longest open stretch between today's events.\n`;
}

/**
 * The soonest FUTURE event as a time-aware lead — "⏰ Next: Standup in 25 min" —
 * so `muse today` tells you what's imminent at a glance instead of leaving you to
 * subtract the clock from a flat list of start times. Events that already started
 * are skipped; empty when nothing upcoming remains in the window (end of day), so
 * it never adds noise. Pure.
 */
export function formatNextEvent(
  events: readonly { readonly title: string; readonly startsAtIso: string }[] | undefined,
  now: Date
): string {
  if (!events || events.length === 0) {
    return "";
  }
  const nowMs = now.getTime();
  const next = events
    .map((event) => ({ startMs: Date.parse(event.startsAtIso), title: event.title }))
    .filter((event) => Number.isFinite(event.startMs) && event.startMs > nowMs)
    .sort((a, b) => a.startMs - b.startMs)[0];
  if (!next) {
    return "";
  }
  const title = stripUntrustedTerminalChars(next.title).replace(/\s+/gu, " ").trim();
  return `⏰ Next: ${title} ${formatTimeUntil(next.startMs - nowMs)}\n`;
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
