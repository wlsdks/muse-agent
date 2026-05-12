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

import { promises as fs } from "node:fs";
import { join, resolve as resolvePath } from "node:path";

import {
  createMuseRuntimeAssembly,
  resolveLocalCalendarFile,
  resolveNotesDir,
  resolveRemindersFile,
  resolveTasksFile
} from "@muse/autoconfigure";
import { LocalCalendarProvider } from "@muse/calendar";
import {
  readReminders,
  readTasks,
  serializeReminder,
  serializeTask,
  type PersistedTask
} from "@muse/mcp";
import {
  TODAY_BRIEF_SYSTEM_PROMPT as BRIEF_SYSTEM_PROMPT,
  buildTodayBriefUserMessage
} from "@muse/prompts";
import type { TextToSpeechProvider } from "@muse/voice";
import type { Command } from "commander";

import { formatLocalDate, formatLocalDateTime as shortDateTimeBrief } from "./human-formatters.js";
import type { ProgramIO } from "./program.js";
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
  readonly lookaheadHours: number;
  readonly tasks?: readonly { readonly id: string; readonly title: string }[];
  readonly events?: readonly { readonly id: string; readonly title: string; readonly startsAtIso: string }[];
  readonly notes?: readonly string[];
  readonly reminders?: readonly { readonly id: string; readonly text: string; readonly dueAt: string }[];
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
    .action(async (
      options: {
        readonly json?: boolean;
        readonly lookaheadHours?: string;
        readonly local?: boolean;
        readonly brief?: boolean;
        readonly model?: string;
        readonly speak?: boolean;
        readonly audioVoice?: string;
        readonly audioFormat?: string;
      },
      command
    ) => {
      if (options.speak && !options.brief) {
        throw new Error("--speak requires --brief (only the brief prose is spoken)");
      }
      let briefing: TodayBriefing;
      let usedLocal = options.local === true;
      if (options.local) {
        briefing = await composeLocalBriefing(parseLookaheadHours(options.lookaheadHours));
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
            briefing = await composeLocalBriefing(parseLookaheadHours(options.lookaheadHours));
            usedLocal = true;
          } else {
            throw cause;
          }
        }
      }

      if (options.brief) {
        const prose = await renderBrief(io, command, helpers, briefing, usedLocal, options.model);
        if (options.json) {
          helpers.writeOutput(io, { ...briefing, brief: prose });
        } else {
          io.stdout(`${prose.trim()}\n`);
        }
        if (options.speak) {
          await speakPlain(io, helpers.shells, prose, options.audioVoice, parseAudioFormat(options.audioFormat));
        }
        return;
      }

      if (options.json) {
        helpers.writeOutput(io, briefing);
        return;
      }

      io.stdout(`Today (${shortDateLabel(briefing.generatedAt)}, next ${briefing.lookaheadHours}h${usedLocal ? ", local" : ""})\n`);
      io.stdout(formatReminders(briefing.reminders, briefing.generatedAt));
      io.stdout(formatTasks(briefing.tasks));
      io.stdout(formatEvents(briefing.events));
      io.stdout(formatNotes(briefing.notes));
    });
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

  if (local) {
    const userBody = `Briefing JSON:\n${JSON.stringify(briefing, null, 2)}\n\nRender this as a short conversational morning brief.`;
    return runLocalBrief(io, userBody, modelOverride);
  }

  const body: Record<string, unknown> = {
    message: remoteMessage,
    metadata: { source: "today.brief" }
  };
  if (modelOverride) {
    body.model = modelOverride;
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

async function runLocalBrief(io: ProgramIO, userMessage: string, modelOverride: string | undefined): Promise<string> {
  const assembly = io.createRuntimeAssembly?.() ?? createMuseRuntimeAssembly();
  if (!assembly.agentRuntime || !(modelOverride ?? assembly.defaultModel)) {
    throw new Error("today --brief --local requires MUSE_MODEL and a configured model provider");
  }
  const result = await assembly.agentRuntime.run({
    messages: [
      { content: BRIEF_SYSTEM_PROMPT, role: "system" },
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
  const now = new Date();
  const horizon = new Date(now.getTime() + lookaheadHours * 3_600_000);

  const [tasks, events, notes, reminders] = await Promise.all([
    readOpenTasks(tasksFile).catch(() => undefined),
    readLocalEvents(calendarFile, now, horizon).catch(() => undefined),
    readRecentNotes(notesDir).catch(() => undefined),
    readDueReminders(remindersFile, horizon).catch(() => undefined)
  ]);

  return {
    events,
    generatedAt: now.toISOString(),
    lookaheadHours,
    notes,
    reminders,
    tasks
  };
}

async function readDueReminders(
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
    .sort((left, right) => left.dueAt.localeCompare(right.dueAt))
    .map((reminder) => {
      const serialized = serializeReminder(reminder);
      return { dueAt: String(serialized.dueAt), id: String(serialized.id), text: String(serialized.text) };
    });
}

async function readLocalEvents(
  file: string,
  from: Date,
  to: Date
): Promise<readonly { id: string; title: string; startsAtIso: string }[]> {
  const provider = new LocalCalendarProvider({ file });
  const events = await provider.listEvents({ from, to });
  return events.map((event) => ({
    id: event.id,
    startsAtIso: event.startsAt.toISOString(),
    title: event.title
  }));
}

async function readOpenTasks(tasksFile: string): Promise<readonly { id: string; title: string }[]> {
  const all = await readTasks(tasksFile);
  return all
    .filter((task: PersistedTask) => task.status === "open")
    .sort((left, right) => (right.createdAt ?? "").localeCompare(left.createdAt ?? ""))
    .slice(0, 50)
    .map((task) => {
      const serialized = serializeTask(task);
      return { id: String(serialized.id), title: String(serialized.title) };
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

function parseLookaheadHours(raw: string | undefined): number {
  if (!raw) {
    return 24;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return 24;
  }
  return Math.min(parsed, 24 * 7);
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
    const overdue = Number.isFinite(dueMs) && Number.isFinite(nowMs) && dueMs < nowMs ? " (overdue)" : "";
    return `  - [${reminder.id.slice(0, 12)}] ${shortDateTimeBrief(reminder.dueAt)}  ${reminder.text}${overdue}`;
  });
  return `\nReminders (${reminders.length}):\n${lines.join("\n")}\n`;
}


function formatTasks(tasks: readonly { readonly id: string; readonly title: string }[] | undefined): string {
  if (!tasks) {
    return "\nTasks: (not configured)\n";
  }
  if (tasks.length === 0) {
    return "\nTasks: (none open)\n";
  }
  const lines = tasks.map((task) => `  - [${task.id.slice(0, 12)}] ${task.title}`);
  return `\nTasks (${tasks.length} open):\n${lines.join("\n")}\n`;
}

function formatEvents(events: readonly { readonly id: string; readonly title: string; readonly startsAtIso: string }[] | undefined): string {
  if (!events) {
    return "\nUpcoming: (calendar not configured)\n";
  }
  if (events.length === 0) {
    return "\nUpcoming: (no calendar events in window)\n";
  }
  const lines = events.map((event) => `  - ${event.startsAtIso.slice(11, 16)} — ${event.title}`);
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
