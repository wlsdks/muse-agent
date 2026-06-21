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
  resolveContactsFile,
  resolveNotesDir,
  resolveProactiveHistoryFile,
  resolveRemindersFile,
  resolveTasksFile
} from "@muse/autoconfigure";
import type { CalendarEvent } from "@muse/calendar";
import { detectCalendarConflicts, formatBirthdayBriefLine, readCheckins, readContacts, readProactiveHistory, readReflections, readReminders, resolveUpcomingBirthdays, selectDueCheckins, type PersistedCheckin, type PersistedReminder } from "@muse/mcp";
import { projectRecentlyLearned } from "@muse/memory";

import { briefFocusBeat } from "./calendar-focus.js";
import { collectDatedNotes, formatOnThisDayBrief, selectOnThisDay } from "./on-this-day.js";
import { formatBriefConflicts } from "./brief-conflicts.js";
import { formatBriefFeedLines, selectBriefFeedHeadlines } from "./brief-feeds.js";
import { formatBriefLearnedLine } from "./brief-learned.js";
import { formatBriefReflectionLine, selectBriefReflection } from "./brief-reflection.js";
import { resolveReflectionsFile } from "./commands-reflections.js";
import { defaultFeedsFile, readFeedsStore } from "./feeds-store.js";

import { resolveTodayWeatherLine } from "./commands-today.js";
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

/** Clock times in `text` as minutes-since-midnight + their raw form. Handles
 *  12-hour ("3pm", "3:30 p.m.") and 24-hour ("15:00") — the two forms the model
 *  and the fact sheet use — so a faithful time matches regardless of format. */
function clockTimesToMinutes(text: string): Array<{ readonly raw: string; readonly minutes: number }> {
  const out: Array<{ readonly raw: string; readonly minutes: number }> = [];
  for (const m of text.matchAll(/\b(\d{1,2})(?::([0-5]\d))?\s*([ap])\.?\s?m\.?\b/giu)) {
    const h = Number(m[1]);
    const min = m[2] ? Number(m[2]) : 0;
    if (h < 1 || h > 12) continue;
    const pm = (m[3] ?? "").toLowerCase() === "p";
    const hour24 = pm ? (h === 12 ? 12 : h + 12) : (h === 12 ? 0 : h);
    out.push({ minutes: hour24 * 60 + min, raw: m[0].trim() });
  }
  // 24-hour HH:MM NOT followed by am/pm (so "3:30 pm" isn't double-counted as 03:30).
  for (const m of text.matchAll(/\b([01]?\d|2[0-3]):([0-5]\d)\b(?!\s*[ap]\.?\s?m)/giu)) {
    out.push({ minutes: Number(m[1]) * 60 + Number(m[2]), raw: m[0].trim() });
  }
  return out;
}

/**
 * The clock times the brief ASSERTS that are on neither the fact sheet nor the
 * current clock — i.e. a meeting/appointment time the model invented or drifted.
 * The brief is model-composed prose over a deterministic fact sheet (the only
 * `muse ask`-style surface with no grounding gate); this is its fabrication
 * check, scoped to TIMES (the most dangerous, most verifiable claim — a wrong
 * time makes you miss or mis-attend). Format-robust (both sides normalised) and
 * conservative: a time it can't parse is never flagged, so it stays fail-open
 * (the caller WARNS, never blocks). Pure + exported.
 */
export function unscheduledTimesInBrief(briefProse: string, factSheet: string, nowMinutes?: number): readonly string[] {
  const allowed = new Set(clockTimesToMinutes(factSheet).map((t) => t.minutes));
  if (nowMinutes !== undefined && Number.isFinite(nowMinutes)) {
    allowed.add(Math.trunc(nowMinutes));
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of clockTimesToMinutes(briefProse)) {
    if (allowed.has(t.minutes)) continue;
    const key = t.raw.toLowerCase().replace(/\s+/gu, "");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t.raw);
  }
  return out;
}

/**
 * The OVERDUE slice of the morning brief: open tasks + pending reminders whose
 * due moment is ALREADY PAST. Surfaced because the morning is when these are
 * still ACTIONABLE — the user can act today — whereas the prospective "due in
 * next 24h" list excludes anything past `now` and the evening recap flags them
 * too late to act. Pure (no IO, no model) so the deterministic fact sheet stays
 * testable. Each list is sorted most-overdue-first.
 */
export function selectBriefOverdue(
  tasks: readonly PersistedTask[],
  reminders: readonly PersistedReminder[],
  now: Date
): { readonly tasks: readonly PersistedTask[]; readonly reminders: readonly PersistedReminder[] } {
  const nowMs = now.getTime();
  const pastDue = (iso: string | undefined): boolean => {
    if (!iso) return false;
    const ms = new Date(iso).getTime();
    return Number.isFinite(ms) && ms < nowMs;
  };
  return {
    reminders: reminders
      .filter((r) => r.status === "pending" && pastDue(r.dueAt))
      .sort((a, b) => new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime()),
    tasks: tasks
      .filter((t) => t.status === "open" && pastDue(t.dueAt))
      .sort((a, b) => new Date(a.dueAt!).getTime() - new Date(b.dueAt!).getTime())
  };
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
      let allReminders: readonly PersistedReminder[] = [];
      try {
        const remindersFile = resolveRemindersFile(process.env as Record<string, string | undefined>);
        allReminders = await readReminders(remindersFile);
        dueReminders = allReminders
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

      // OVERDUE — past their due moment but still open/pending. The morning is
      // when these are still ACTIONABLE; lead with them.
      const overdue = selectBriefOverdue(tasks, allReminders, now);

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

      // Upcoming birthdays in the next week — a morning JARVIS that lets you
      // forget your friend's birthday tomorrow is a broken one. A few days'
      // notice is enough to actually act (a gift, a call); the brief LEADS with
      // a today/tomorrow one. Deterministic from the contacts' stored birthday
      // (no fabricated date — `resolveUpcomingBirthdays` skips a malformed one).
      let birthdayLine: string | undefined;
      try {
        const contacts = await readContacts(resolveContactsFile(process.env as Record<string, string | undefined>));
        birthdayLine = formatBirthdayBriefLine(resolveUpcomingBirthdays(contacts, { now, withinDays: 7 }));
      } catch {
        // contacts file missing or unreadable — brief still works
      }

      // Weather for the user's configured home — a morning JARVIS that doesn't
      // tell you it's about to rain is incomplete. OPT-IN (MUSE_WEATHER_LOCATION):
      // no location ⇒ no lookup ⇒ no egress, so a strict-local user is unaffected.
      // Open-Meteo (free, no key — a public weather DATA api, not a cloud LLM, like
      // `muse search`); fail-soft (a lookup blip never breaks the brief). Same
      // helper `muse today` uses, so the two surfaces agree.
      const weatherLine = await resolveTodayWeatherLine(process.env as Record<string, string | undefined>);

      const nowIso = now.toISOString();
      const factSheet = [
        `Today: ${formatLocalDate(nowIso)} ${now.toLocaleDateString("en-US", { weekday: "long" })} ${formatLocalTime(nowIso)} local`,
        `OVERDUE — past due, still open, act today (${(overdue.tasks.length + overdue.reminders.length).toString()}):`,
        ...overdue.tasks.slice(0, 5).map((t) => `  ⚠ ${t.title} (was due ${t.dueAt ? formatLocalDateTime(t.dueAt) : "?"})`),
        ...overdue.reminders.slice(0, 5).map((r) => `  ⚠ ${r.text} (was due ${formatLocalDateTime(r.dueAt)})`),
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
        ...(birthdayLine ? [`Upcoming birthdays (next 7 days): ${birthdayLine}`] : []),
        ...(weatherLine ? [`Weather (your area): ${weatherLine}`] : []),
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
        "If there are OVERDUE items (past their due date), LEAD with them — they are the most time-sensitive AND the user can still act on them today; do not bury them under upcoming items.",
        "Otherwise lead with the most imminent thing (a task due soon, or a noteworthy recent notice).",
        "If there are follow-ups the user is due on (things they said they'd do), gently surface one — a time-sensitive personal commitment matters more than a routine task.",
        "If a contact's birthday is TODAY or TOMORROW (see 'Upcoming birthdays'), mention it warmly — a birthday you can still act on matters; only the named people in the fact sheet, never invent one.",
        "If a 'Weather (your area)' line is present, work it in briefly — and if rain/snow is coming, suggest preparing (an umbrella, leave early); never invent weather not in the fact sheet.",
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

      // Grounding check for the brief surface: the summary is model-composed prose,
      // so it could assert a meeting time that isn't on your schedule. Warn (never
      // block — fail-open) if it mentions a clock time absent from the fact sheet
      // and the current clock, so a fabricated/drifted appointment time can't pass
      // unflagged on the morning briefing.
      const fabricatedTimes = unscheduledTimesInBrief(composed, factSheet, now.getHours() * 60 + now.getMinutes());
      if (fabricatedTimes.length > 0) {
        io.stderr(`\n⚠️  This summary mentions a time not on your schedule (${fabricatedTimes.join(", ")}) — double-check it against your calendar before relying on it.\n`);
      }

      // A double-booking is the single thing you most want flagged in the morning,
      // and the model prose can't be trusted to spot the overlap — surface it
      // deterministically over the same next-24h events the brief already gathered.
      io.stdout(formatBriefConflicts(detectCalendarConflicts(upcomingEvents)));

      // Proactive deep-work heads-up: when the rest of today is fragmented into
      // slivers (no block long enough for focus), say so — the FELT sibling of
      // `muse calendar focus`. Silent on a day that already has room for focus.
      const focusBeat = briefFocusBeat(upcomingEvents, now);
      if (focusBeat) io.stdout(`${focusBeat}\n`);

      // "On this day": a date-cued autobiographical beat — surface notes written on
      // today's date in earlier years. Rare (only real anniversaries), so it is
      // never noise; silent on a day with no past-year note. Best-effort.
      try {
        const onThisDay = selectOnThisDay(await collectDatedNotes(resolveNotesDir(process.env as Record<string, string | undefined>)), now);
        const beat = formatOnThisDayBrief(onThisDay);
        if (beat) io.stdout(beat);
      } catch {
        // notes dir missing/unreadable — the brief stands on its own
      }

      try {
        const surfaced = selectBriefReflection(await readReflections(resolveReflectionsFile()), now.getTime());
        if (surfaced) io.stdout(formatBriefReflectionLine(surfaced));
      } catch {
        // reflections store missing/corrupt — the brief stands on its own
      }

      // "Lately about you": the morning sibling of the evening recap's
      // recently-learned section — one cited line of what Muse learned about you
      // in the last 30 days, from the user-memory already read above.
      try {
        const learned = userMemory
          ? formatBriefLearnedLine(projectRecentlyLearned(userMemory, { sinceMs: now.getTime() - 30 * 86_400_000 }))
          : undefined;
        if (learned) io.stdout(learned);
      } catch {
        // user-memory unreadable — the brief stands on its own
      }

      try {
        const headlines = selectBriefFeedHeadlines(await readFeedsStore(defaultFeedsFile()), now.getTime());
        if (headlines.length > 0) io.stdout(formatBriefFeedLines(headlines));
      } catch {
        // feeds store missing/corrupt — the brief stands on its own
      }

      if (options.speak) {
        await speakAloud(io, composed.trim());
      }
    });
}
