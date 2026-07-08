/**
 * `muse companion-line` — ONE short opener for the desktop companion's speech
 * bubble, emitted as JSON `{ line, grounded }`.
 *
 * The companion shows a canned placeholder instantly, then swaps in this line
 * when it arrives. The point is variety WITHOUT fabrication:
 *
 *   - When a genuinely-relevant grounded item exists (the next calendar event,
 *     a due/overdue reminder or task, today's birthday, an owed follow-up /
 *     check-in, a recently-touched note) we phrase ONE of them warmly. The line
 *     is composed DETERMINISTICALLY from the real store fields — no model — so
 *     it can never assert an event/count/name that isn't in the stores
 *     (fabrication = 0 by construction). `grounded: true`.
 *   - When nothing grounded is relevant (or every candidate is vetoed / it's
 *     quiet hours) we fall back to a VARIED, content-free greeting that asserts
 *     nothing. `grounded: false`.
 *
 * Gates mirror the proactive loops: a source the user VETOED
 * (`muse proactive veto`) is never surfaced, and during quiet hours grounded
 * items are suppressed in favour of a greeting. A tiny state file tracks the
 * recently-shown keys + a rotation counter so successive calls (the companion
 * drifts one every ~45s) VARY and never immediately repeat.
 */

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join, resolve as resolvePath } from "node:path";

import {
  resolveContactsFile,
  resolveFollowupsFile,
  resolveLocalCalendarFile,
  resolveNotesDir,
  resolveRemindersFile,
  resolveTasksFile
} from "@muse/autoconfigure";
import {
  avoidedSourceKeys,
  readContacts,
  readTasks,
  readTrustLedger,
  resolveUpcomingBirthdays,
  sourceKey,
  type PersistedTask
} from "@muse/stores";
import { isQuietHour, parseQuietHours, readCheckins, selectDueCheckins } from "@muse/proactivity";
import type { Command } from "commander";

import { checkinsFile } from "./commands-checkins.js";
import { collectNotesRecursive, readDueFollowups, readDueReminders, readLocalEvents } from "./today-local-sources.js";
import { formatLocalTime } from "./human-formatters.js";
import type { ProgramIO } from "./program.js";

export type CompanionLang = "ko" | "en";

export interface CompanionCandidate {
  /** `${kind}:${id}` — the veto/avoidance unit, shared with the trust ledger. */
  readonly key: string;
  readonly line: string;
}

export interface CompanionSelection {
  readonly line: string;
  readonly grounded: boolean;
  readonly key: string;
}

/** How many recent keys to remember so we never immediately repeat one. */
const RECENT_WINDOW = 4;
/** Keep any single field short so the whole line fits the small bubble. */
const MAX_FIELD_LENGTH = 42;

function truncate(value: string): string {
  const clean = value.replace(/\s+/gu, " ").trim();
  return clean.length <= MAX_FIELD_LENGTH ? clean : `${clean.slice(0, MAX_FIELD_LENGTH - 1)}…`;
}

function pickVariant(variants: readonly string[], rotation: number): string {
  if (variants.length === 0) return "";
  const i = ((rotation % variants.length) + variants.length) % variants.length;
  return variants[i]!;
}

/**
 * Phrase ONE grounded candidate deterministically from its real fields. Every
 * template interpolates ONLY the passed store values — there is no free text
 * the model could invent — so a phrased line is true by construction whenever
 * the fields came from a real store row.
 */
export function phraseCandidate(
  kind: string,
  fields: Readonly<Record<string, string | number>>,
  lang: CompanionLang,
  rotation: number
): string {
  const ko = lang === "ko";
  const s = (k: string): string => truncate(String(fields[k] ?? ""));
  switch (kind) {
    case "event":
      return pickVariant(
        ko
          ? [`곧 "${s("title")}" 일정이 있어요 — ${s("time")} 📅`, `${s("time")}에 "${s("title")}", 준비됐어요?`, `다음 일정은 "${s("title")}" (${s("time")})`]
          : [`"${s("title")}" coming up at ${s("time")} 📅`, `You've got "${s("title")}" at ${s("time")}`, `Next up: "${s("title")}" at ${s("time")}`],
        rotation
      );
    case "reminder":
      return Number(fields.overdue) === 1
        ? pickVariant(
            ko
              ? [`"${s("text")}" — 지난 리마인더예요. 지금 해볼까요?`, `아직 "${s("text")}" 남아있어요`]
              : [`Reminder overdue: "${s("text")}" — do it now?`, `Still pending: "${s("text")}"`],
            rotation
          )
        : pickVariant(
            ko
              ? [`"${s("text")}", 잊지 않으셨죠?`, `리마인더: "${s("text")}"`]
              : [`Don't forget: "${s("text")}"`, `Reminder: "${s("text")}"`],
            rotation
          );
    case "task":
      return Number(fields.overdue) === 1
        ? pickVariant(
            ko
              ? [`"${s("title")}" 마감이 지났어요. 도와줄까요?`, `"${s("title")}", 아직 남아있네요`]
              : [`"${s("title")}" is past due — want a hand?`, `"${s("title")}" is still open`],
            rotation
          )
        : pickVariant(
            ko
              ? [`"${s("title")}", 오늘 안에 어때요?`, `할 일: "${s("title")}"`]
              : [`"${s("title")}" — tackle it today?`, `On your list: "${s("title")}"`],
            rotation
          );
    case "birthday":
      return Number(fields.days) === 0
        ? (ko ? `오늘 ${s("name")}님 생일이에요 🎂` : `It's ${s("name")}'s birthday today 🎂`)
        : (ko ? `${String(fields.days)}일 뒤 ${s("name")}님 생일이에요 🎂` : `${s("name")}'s birthday is in ${String(fields.days)} days 🎂`);
    case "checkin":
      return pickVariant(
        ko
          ? [`"${s("commitment")}" 하기로 하셨죠. 잘 됐어요?`, `"${s("commitment")}", 어떻게 됐어요?`]
          : [`You meant to "${s("commitment")}" — how did it go?`, `Following up on "${s("commitment")}"`],
        rotation
      );
    case "followup":
      return pickVariant(
        ko
          ? [`"${s("summary")}" — 어떻게 됐어요?`, `"${s("summary")}", 다시 확인해볼까요?`]
          : [`"${s("summary")}" — any update?`, `Circling back on "${s("summary")}"`],
        rotation
      );
    case "note":
      return pickVariant(
        ko
          ? [`"${s("title")}" 메모, 다시 볼까요?`, `요즘 "${s("title")}" 작업 중이시죠`]
          : [`Want to revisit your "${s("title")}" note?`, `You've been on "${s("title")}" lately`],
        rotation
      );
    default:
      return "";
  }
}

/** A time-of-day greeting that asserts nothing about the user's data. */
export function timeGreeting(lang: CompanionLang, hour: number): string {
  const h = ((hour % 24) + 24) % 24;
  const ko = lang === "ko";
  if (h >= 5 && h <= 11) return ko ? "좋은 아침이에요 ☀️" : "Good morning ☀️";
  if (h >= 12 && h <= 17) return ko ? "오후도 잘 보내고 있어요?" : "Hope your afternoon's going well";
  if (h >= 18 && h <= 22) return ko ? "좋은 저녁이에요 🌆" : "Good evening 🌆";
  return ko ? "늦었네요 — 무리하지 말아요 🌙" : "It's late — don't overdo it 🌙";
}

/** The content-free greeting pool — a time greeting plus rotating musings. */
export function buildGreetings(lang: CompanionLang, hour: number): readonly string[] {
  const rest = lang === "ko"
    ? ["무슨 생각 중이세요?", "여기 있을게요 :)", "필요하면 언제든 불러주세요", "오늘 하루 어때요?", "잠깐 쉬어가도 좋아요 🍵"]
    : ["What's on your mind?", "I'm right here :)", "Call me whenever you need", "How's your day going?", "Take a breather anytime 🍵"];
  return [timeGreeting(lang, hour), ...rest];
}

/**
 * Choose the opener. Pure — all IO already happened. A fresh (not-recently-shown,
 * not-vetoed) grounded candidate wins outside quiet hours; otherwise a fresh
 * greeting. Rotation varies the pick across successive calls; when every grounded
 * candidate was recently shown we deliberately fall to a greeting so the bubble
 * never repeats the same grounded line back-to-back.
 */
export function selectCompanionLine(params: {
  readonly candidates: readonly CompanionCandidate[];
  readonly greetings: readonly string[];
  readonly recent: readonly string[];
  readonly vetoed: ReadonlySet<string>;
  readonly quiet: boolean;
  readonly rotation: number;
}): CompanionSelection {
  const { candidates, greetings, recent, vetoed, quiet, rotation } = params;
  const recentSet = new Set(recent);
  if (!quiet) {
    const fresh = candidates.filter((c) => !vetoed.has(c.key) && !recentSet.has(c.key));
    if (fresh.length > 0) {
      const chosen = fresh[((rotation % fresh.length) + fresh.length) % fresh.length]!;
      return { grounded: true, key: chosen.key, line: chosen.line };
    }
  }
  const items = greetings
    .map((g, i) => ({ key: `greeting:${i.toString()}`, line: g }))
    .filter((it) => it.line.trim().length > 0);
  if (items.length === 0) {
    return { grounded: false, key: "greeting:none", line: "" };
  }
  const freshG = items.filter((it) => !recentSet.has(it.key));
  const pool = freshG.length > 0 ? freshG : items;
  const chosen = pool[((rotation % pool.length) + pool.length) % pool.length]!;
  return { grounded: false, key: chosen.key, line: chosen.line };
}

interface CompanionState {
  readonly recent: readonly string[];
  readonly rotation: number;
}

function stateFile(env: NodeJS.ProcessEnv): string {
  return env.MUSE_COMPANION_STATE_FILE?.trim() || join(homedir(), ".muse", "companion-line-state.json");
}

function trustFile(env: NodeJS.ProcessEnv): string {
  return env.MUSE_PROACTIVE_TRUST_FILE?.trim() || join(homedir(), ".muse", "proactive-trust.json");
}

async function readCompanionState(file: string): Promise<CompanionState> {
  try {
    const parsed = JSON.parse(await fs.readFile(file, "utf8")) as Partial<CompanionState>;
    const recent = Array.isArray(parsed.recent) ? parsed.recent.filter((r): r is string => typeof r === "string") : [];
    const rotation = Number.isFinite(parsed.rotation) ? Math.trunc(parsed.rotation as number) : 0;
    return { recent, rotation };
  } catch {
    return { recent: [], rotation: 0 };
  }
}

async function writeCompanionState(file: string, state: CompanionState): Promise<void> {
  try {
    await fs.mkdir(join(file, ".."), { recursive: true });
    await fs.writeFile(file, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  } catch {
    // best-effort: a companion opener must never fail on a state-file write
  }
}

/** True when the user configured quiet hours AND we're inside that window now. */
function inQuietHours(env: NodeJS.ProcessEnv, now: Date): boolean {
  const range = parseQuietHours(env.MUSE_PROACTIVE_QUIET_HOURS?.trim() || env.MUSE_REMINDER_QUIET_HOURS?.trim());
  return range ? isQuietHour(now.getHours(), range) : false;
}

async function mostRecentNoteTitle(notesDir: string): Promise<string | undefined> {
  const root = resolvePath(notesDir);
  const collected: { name: string; mtime: number }[] = [];
  await collectNotesRecursive(root, "", collected, 0);
  const newest = collected.sort((a, b) => b.mtime - a.mtime)[0];
  return newest ? newest.name.replace(/\.[a-z]+$/iu, "") : undefined;
}

/**
 * Read every grounded source and phrase one candidate per genuinely-relevant
 * item, in rough priority order. Each reader is independently fail-soft: a
 * missing/unreadable store contributes nothing and never sinks the others.
 */
export async function gatherCompanionCandidates(
  env: NodeJS.ProcessEnv,
  now: Date,
  lang: CompanionLang,
  rotation: number
): Promise<readonly CompanionCandidate[]> {
  const nowMs = now.getTime();
  const horizon12 = new Date(nowMs + 12 * 3_600_000);
  const horizon24 = new Date(nowMs + 24 * 3_600_000);
  const out: CompanionCandidate[] = [];

  try {
    const events = await readLocalEvents(resolveLocalCalendarFile(env), now, horizon12);
    for (const e of events.slice(0, 2)) {
      out.push({
        key: sourceKey("calendar", e.id),
        line: phraseCandidate("event", { time: formatLocalTime(e.startsAtIso), title: e.title }, lang, rotation)
      });
    }
  } catch { /* no calendar file */ }

  try {
    const contacts = await readContacts(resolveContactsFile(env));
    for (const b of resolveUpcomingBirthdays(contacts, { now, withinDays: 3 })) {
      out.push({
        key: sourceKey("birthday", b.contact.name),
        line: phraseCandidate("birthday", { days: b.daysUntil, name: b.contact.name }, lang, rotation)
      });
    }
  } catch { /* no contacts file */ }

  try {
    const reminders = await readDueReminders(resolveRemindersFile(env), horizon24);
    for (const r of reminders.slice(0, 3)) {
      out.push({
        key: sourceKey("reminder", r.id),
        line: phraseCandidate("reminder", { overdue: Date.parse(r.dueAt) < nowMs ? 1 : 0, text: r.text }, lang, rotation)
      });
    }
  } catch { /* no reminders file */ }

  try {
    const tasks = await readTasks(resolveTasksFile(env));
    const due = tasks
      .filter((t: PersistedTask) => t.status === "open" && t.dueAt !== undefined && Date.parse(t.dueAt) <= horizon24.getTime())
      .sort((a: PersistedTask, b: PersistedTask) => Date.parse(a.dueAt!) - Date.parse(b.dueAt!));
    for (const t of due.slice(0, 3)) {
      out.push({
        key: sourceKey("task", t.id),
        line: phraseCandidate("task", { overdue: Date.parse(t.dueAt!) < nowMs ? 1 : 0, title: t.title }, lang, rotation)
      });
    }
  } catch { /* no tasks file */ }

  try {
    const checkins = selectDueCheckins(await readCheckins(checkinsFile(env)), nowMs, 2);
    for (const c of checkins) {
      out.push({ key: sourceKey("checkin", c.id), line: phraseCandidate("checkin", { commitment: c.commitment }, lang, rotation) });
    }
  } catch { /* no checkins file */ }

  try {
    const followups = await readDueFollowups(resolveFollowupsFile(env), horizon24);
    for (const f of followups.slice(0, 2)) {
      out.push({ key: sourceKey("followup", f.id), line: phraseCandidate("followup", { summary: f.summary }, lang, rotation) });
    }
  } catch { /* no followups file */ }

  try {
    const note = await mostRecentNoteTitle(resolveNotesDir(env));
    if (note) {
      out.push({ key: sourceKey("note", note), line: phraseCandidate("note", { title: note }, lang, rotation) });
    }
  } catch { /* no notes dir */ }

  return out.filter((c) => c.line.trim().length > 0);
}

export function registerCompanionLineCommand(program: Command, io: ProgramIO): void {
  program
    .command("companion-line")
    .description("One short grounded-or-greeting opener for the desktop companion bubble (JSON: {line, grounded})")
    .option("--lang <code>", "Language for the opener: ko | en", "en")
    .action(async (options: { readonly lang?: string }) => {
      const env = process.env;
      const lang: CompanionLang = (options.lang ?? "en").toLowerCase().startsWith("ko") ? "ko" : "en";
      const now = new Date();

      const state = await readCompanionState(stateFile(env));
      const rotation = state.rotation;

      const [candidates, trust] = await Promise.all([
        gatherCompanionCandidates(env, now, lang, rotation),
        readTrustLedger(trustFile(env)).catch(() => [])
      ]);

      const selection = selectCompanionLine({
        candidates,
        greetings: buildGreetings(lang, now.getHours()),
        quiet: inQuietHours(env, now),
        recent: state.recent,
        rotation,
        vetoed: avoidedSourceKeys(trust)
      });

      const recent = [...state.recent, selection.key].slice(-RECENT_WINDOW);
      await writeCompanionState(stateFile(env), { recent, rotation: rotation + 1 });

      io.stdout(`${JSON.stringify({ grounded: selection.grounded, line: selection.line })}\n`);
    });
}
