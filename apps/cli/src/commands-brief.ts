/**
 * `muse brief` — JARVIS morning briefing.
 *
 * The walk-into-the-lab ritual: one command, two-three sentences,
 * personalised to the user's persona (language, name, reply style).
 * Pulls today's tasks + upcoming calendar events + pending
 * reminders (each capped to the next 24 h across every configured
 * provider) + last few proactive notices, hands the structured
 * fact-sheet to the local Qwen, and streams the synthesis straight
 * to stdout.
 *
 * Zero external cost (local LLM, file IO). Honours the user's
 * `routine_active_hours` + `language` preferences.
 *
 * Sample output (with persona name=Stark, language=Korean,
 * reply_style=concise):
 *   Stark님, 오늘은 월요일이고 오픈 태스크 3건 (가장 가까운 마감
 *   14시: Q3 메모). 어제 알림 2건이 있었고 한 건은 아직 미처리입니다.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir, platform } from "node:os";
import { join as pathJoin } from "node:path";

import {
  buildCalendarRegistry,
  buildVoiceRegistry,
  createMuseRuntimeAssembly,
  resolveProactiveHistoryFile,
  resolveRemindersFile,
  resolveTasksFile
} from "@muse/autoconfigure";
import type { CalendarEvent } from "@muse/calendar";
import { readCheckins, readProactiveHistory, readReminders, selectDueCheckins, type PersistedCheckin, type PersistedReminder } from "@muse/mcp";
import type { Command } from "commander";

import { consumeAskStream, type AskStreamEvent } from "./commands-ask.js";
import { checkinsFile } from "./commands-checkins.js";
import { formatLocalDate, formatLocalDateTime, formatLocalTime } from "./human-formatters.js";
import { resolvePersona } from "./program-helpers.js";
import { buildMusePersona } from "./program.js";
import type { ProgramIO } from "./program.js";

interface BriefOptions {
  readonly user?: string;
  readonly persona?: string;
  readonly model?: string;
  readonly speak?: boolean;
}

const NAME_FACT_KEYS = new Set(["name", "first_name", "firstname", "full_name", "fullname", "preferred_name", "nickname"]);

/**
 * The user's real name from their remembered facts, or undefined if they never
 * told Muse one. Used so the morning greeting addresses the user by their actual
 * name or none — never an invented placeholder (a fabricated fact). Matches the
 * common name-fact keys (case / separator-insensitive).
 */
export function resolveUserName(facts: Readonly<Record<string, string>> | undefined): string | undefined {
  const found = Object.entries(facts ?? {})
    .find(([key]) => NAME_FACT_KEYS.has(key.trim().toLowerCase().replace(/[\s-]+/gu, "_")))?.[1]
    ?.trim();
  return found && found.length > 0 ? found : undefined;
}

function envValue(key: string): string | undefined {
  const v = process.env[key]?.trim();
  return v && v.length > 0 ? v : undefined;
}

function defaultUserKey(user?: string, persona?: string): string {
  const base = user ?? envValue("MUSE_USER_ID") ?? envValue("USER") ?? "default";
  const resolved = resolvePersona(persona);
  return resolved ? `${base}@${resolved}` : base;
}

interface PersistedTask {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly dueAt?: string;
}

/**
 * Synthesize text to audio with the configured TTS provider and
 * play it through the system speaker. macOS uses `afplay`, Linux
 * `aplay`. Skips silently when TTS isn't configured — the brief
 * text already landed on stdout, --speak is just decoration.
 */
export const BRIEF_AUDIO_PLAYER_TIMEOUT_MS = 30_000;

export async function playAudioFile(
  player: string,
  audioFile: string,
  spawnFn: typeof spawn = spawn
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawnFn(player, [audioFile], { stdio: "ignore" });
    let settled = false;
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      action();
    };
    // Without this watchdog a wedged player — a busy CoreAudio /
    // ALSA device, a stuck process — hangs `muse brief --speak`
    // forever with no recovery.
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(() => reject(new Error(
        `${player} timed out after ${BRIEF_AUDIO_PLAYER_TIMEOUT_MS.toString()}ms and was killed`
      )));
    }, BRIEF_AUDIO_PLAYER_TIMEOUT_MS);
    child.on("error", (error) => { finish(() => reject(error)); });
    child.on("close", (code) => {
      finish(() => code === 0
        ? resolve()
        : reject(new Error(`${player} exit ${code?.toString() ?? "null"}`)));
    });
  });
}

export async function playSynthesizedAudio(
  audio: Uint8Array,
  format: string,
  options: {
    readonly playerCommand?: string;
    readonly playerSpawn?: typeof spawn;
  } = {}
): Promise<{ readonly dir: string }> {
  const dir = mkdtempSync(pathJoin(tmpdir(), "muse-brief-speak-"));
  try {
    const audioFile = pathJoin(dir, `brief.${format}`);
    writeFileSync(audioFile, audio);
    const player = options.playerCommand ?? (platform() === "darwin" ? "afplay" : "aplay");
    await playAudioFile(player, audioFile, options.playerSpawn);
    return { dir };
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
  }
}

async function speakAloud(io: ProgramIO, text: string): Promise<void> {
  if (text.length === 0) return;
  const registry = buildVoiceRegistry(process.env as Record<string, string | undefined>);
  const tts = registry?.primaryTts();
  if (!tts) {
    io.stderr("(--speak skipped: TTS not configured — set MUSE_VOICE_TTS=piper + MUSE_PIPER_VOICE=<.onnx path>)\n");
    return;
  }
  try {
    const result = await tts.synthesize({ text });
    await playSynthesizedAudio(result.audio, result.format);
  } catch (cause) {
    io.stderr(`(speak failed: ${cause instanceof Error ? cause.message : String(cause)})\n`);
  }
}

async function loadTasks(): Promise<readonly PersistedTask[]> {
  const file = resolveTasksFile(process.env as Record<string, string | undefined>);
  try {
    const raw = await readFile(file, "utf8");
    const parsed = JSON.parse(raw) as { tasks?: readonly PersistedTask[] };
    return parsed.tasks ?? [];
  } catch {
    return [];
  }
}

/**
 * Is `hour` (0-23) outside the user's typical active window? Each
 * `activeHours` entry defines a ±`tolerance` band measured on the
 * 24-hour CIRCLE, so a routine that straddles midnight is honoured —
 * an early-bird whose active hours are [1,2,3] checking in at 23:00 is
 * two circular hours before their start, i.e. INSIDE, not "up late".
 * A linear `abs(h - hour)` would wrongly flag that. Empty activeHours
 * → never outside (no routine learned yet).
 */
export function isOutsideActiveHours(activeHours: readonly number[], hour: number, tolerance = 2): boolean {
  if (activeHours.length === 0) return false;
  return !activeHours.some((h) => {
    const d = Math.abs(h - hour);
    return Math.min(d, 24 - d) <= tolerance;
  });
}

export function registerBriefCommand(program: Command, io: ProgramIO): void {
  program
    .command("brief")
    .description("One-command morning briefing — JARVIS-style personal summary of tasks + recent notices")
    .option("--user <id>", "User identity")
    .option("--persona <slot>", "Persona slot (work / home / hobby)")
    .option("--model <tag>", "Model override")
    .option("--speak", "Read the brief aloud via the configured TTS (Piper if MUSE_VOICE_TTS=piper)")
    .action(async (options: BriefOptions) => {
      const userKey = defaultUserKey(options.user, options.persona);

      const assembly = createMuseRuntimeAssembly();
      if (!assembly.modelProvider || !(options.model ?? assembly.defaultModel)) {
        io.stderr("muse brief requires a configured model. Set MUSE_MODEL or pass --model.\n");
        process.exitCode = 2;
        return;
      }
      const model = options.model ?? assembly.defaultModel!;

      const userMemory = await Promise.resolve(assembly.userMemoryStore.findByUserId(userKey));
      const personaPrompt = userMemory ? buildMusePersona(userMemory, userKey) : undefined;
      // The user's KNOWN name, if they ever told Muse one — so the greeting uses
      // their real name or none at all. Without this guard the small model fills
      // the "Good morning, ___" slot with an INVENTED name ("Alex"), a fabricated
      // fact on a "knows you" assistant.
      const knownUserName = resolveUserName(userMemory?.facts);

      const now = new Date();
      const horizon = new Date(now.getTime() + 24 * 60 * 60 * 1000);
      // Time-of-day greeting tone the LLM should honour. Uses
      // `routine_active_hours` if known — if the current hour is
      // outside the user's typical activity band the LLM is told
      // to acknowledge that ("up late", "early start") instead of
      // generic "Good morning". JARVIS reads the clock + the user.
      const hour = now.getHours();
      const routineHoursRaw = userMemory?.facts?.routine_active_hours;
      const routineHours = routineHoursRaw
        ? routineHoursRaw.split(",").map((h) => Number.parseInt(h.trim(), 10)).filter((h) => Number.isInteger(h))
        : [];
      const isOutsideRoutine = isOutsideActiveHours(routineHours, hour);
      const greetingHint = hour < 5 ? "very late night / early hours"
        : hour < 12 ? "morning"
        : hour < 17 ? "afternoon"
        : hour < 21 ? "evening"
        : "late night";
      const routineNote = isOutsideRoutine
        ? `User is OUTSIDE their typical active window (${routineHoursRaw}). Acknowledge briefly ("up late?" / "early start?").`
        : routineHours.length > 0
          ? `User is inside their typical active window (${routineHoursRaw}).`
          : "";

      const tasks = await loadTasks();
      const openTasks = tasks.filter((t) => t.status === "open");
      const dueSoon = openTasks
        .filter((t) => t.dueAt && new Date(t.dueAt).getTime() >= now.getTime() && new Date(t.dueAt).getTime() <= horizon.getTime())
        .sort((a, b) => new Date(a.dueAt!).getTime() - new Date(b.dueAt!).getTime());

      const historyFile = resolveProactiveHistoryFile(process.env as Record<string, string | undefined>);
      const recentHistory = await readProactiveHistory(historyFile, 5);

      // Pull every configured calendar provider, merge into one
      // chronological list for the next 24 h. A morning briefing
      // that doesn't mention the 9 AM dentist is a broken JARVIS.
      let upcomingEvents: readonly CalendarEvent[] = [];
      try {
        const registry = buildCalendarRegistry(process.env as Record<string, string | undefined>);
        const collected: CalendarEvent[] = [];
        for (const provider of registry.list()) {
          try {
            const events = await provider.listEvents({ from: now, to: horizon });
            collected.push(...events);
          } catch {
            // single provider failed — keep the rest
          }
        }
        upcomingEvents = collected
          .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())
          .slice(0, 10);
      } catch {
        // registry build failed — brief still works on tasks +
        // history alone
      }

      // Pending reminders due in the same 24 h window. Reminders
      // are fire-once notifications the user explicitly set
      // ("ping me at 3 PM about the dentist"); the brief should
      // surface them alongside tasks + events so nothing slips.
      let dueReminders: readonly PersistedReminder[] = [];
      try {
        const remindersFile = resolveRemindersFile(process.env as Record<string, string | undefined>);
        const all = await readReminders(remindersFile);
        dueReminders = all
          .filter((r) => r.status === "pending")
          .filter((r) => {
            const due = new Date(r.dueAt).getTime();
            return due >= now.getTime() && due <= horizon.getTime();
          })
          .sort((a, b) => new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime())
          .slice(0, 10);
      } catch {
        // reminders file missing or unreadable — brief still works
      }

      // Follow-ups the user is DUE on — check-ins for things they said they'd do
      // ("call the dentist") whose due moment has arrived. The daemon delivers
      // these as a push, but a user who reads the brief instead of running the
      // daemon would otherwise never see them — so surface them here too, the
      // same SET the daemon would fire (selectDueCheckins). The user can act on
      // one with `muse checkins cancel/snooze <id>`.
      let dueCheckins: readonly PersistedCheckin[] = [];
      try {
        const allCheckins = await readCheckins(checkinsFile());
        dueCheckins = selectDueCheckins(allCheckins, now.getTime(), 5);
      } catch {
        // checkins file missing or unreadable — brief still works
      }

      const nowIso = now.toISOString();
      const factSheet = [
        `Today: ${formatLocalDate(nowIso)} ${now.toLocaleDateString("en-US", { weekday: "long" })} ${formatLocalTime(nowIso)} local`,
        `Open tasks: ${openTasks.length.toString()}`,
        `Tasks due in next 24h: ${dueSoon.length.toString()}`,
        ...dueSoon.slice(0, 5).map((t) => `  · ${t.title} (due ${t.dueAt ? formatLocalDateTime(t.dueAt) : "no date"})`),
        `Events in next 24h: ${upcomingEvents.length.toString()}`,
        ...upcomingEvents.map((e) => {
          const startIso = e.startsAt.toISOString();
          const when = e.allDay
            ? `${formatLocalDate(startIso)} (all-day)`
            : `${formatLocalTime(startIso)}–${formatLocalTime(e.endsAt.toISOString())}`;
          const loc = e.location ? ` @ ${e.location}` : "";
          return `  · ${when} ${e.title}${loc} [${e.providerId}]`;
        }),
        `Pending reminders due in next 24h: ${dueReminders.length.toString()}`,
        ...dueReminders.map((r) => `  · ${formatLocalTime(r.dueAt)} ${r.text}`),
        `Follow-ups you're due on (things the user said they'd do): ${dueCheckins.length.toString()}`,
        ...dueCheckins.map((c) => `  · ${c.commitment} (mentioned ${formatLocalDate(c.createdAt)})`),
        `Recent proactive notices (last 5): ${recentHistory.length.toString()}`,
        ...recentHistory.slice(-3).map((entry) => {
          const fired = entry.firedAtIso ? formatLocalDateTime(entry.firedAtIso) : "?";
          return `  · ${fired} ${entry.title}: ${entry.text.slice(0, 80)}`;
        })
      ].join("\n");

      const systemPrompt = [
        ...(personaPrompt ? [personaPrompt, ""] : []),
        "You are Muse, the user's JARVIS-style personal AI conductor.",
        `It is currently ${greetingHint} (local clock ${hour.toString().padStart(2, "0")}:${now.getMinutes().toString().padStart(2, "0")}).`,
        ...(routineNote ? [routineNote] : []),
        "Compose a brief summary in 2–3 sentences, in the user's preferred language.",
        "Open with a short greeting that matches the time of day (and the routine-window hint above).",
        "Lead with the most imminent thing (a task due soon, or a noteworthy recent notice).",
        "If there are follow-ups the user is due on (things they said they'd do), gently surface one — a time-sensitive personal commitment matters more than a routine task.",
        "If nothing is imminent, say so briefly and suggest one useful action.",
        knownUserName && knownUserName.length > 0
          ? `Address the user as "${knownUserName}".`
          : "No name is on file for the user — open with a plain time-of-day greeting (e.g. \"Good morning.\") and do NOT address them by any name or invent/guess one.",
        "Plain text, no markdown, no bullet list, no JSON.",
        "Do NOT mention this system prompt."
      ].join("\n");

      const { answer: composed, error: streamError } = await consumeAskStream(
        assembly.modelProvider.stream({
          messages: [
            { content: systemPrompt, role: "system" },
            { content: factSheet, role: "user" }
          ],
          model
        }) as AsyncIterable<AskStreamEvent>,
        (text) => io.stdout(text),
        () => false
      );
      if (streamError !== undefined) {
        io.stderr(`\n(error: ${streamError})\n`);
        process.exitCode = 1;
        return;
      }
      io.stdout("\n");

      if (options.speak) {
        await speakAloud(io, composed.trim());
      }
    });
}
