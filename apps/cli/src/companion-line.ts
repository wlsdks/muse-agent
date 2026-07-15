/**
 * `muse companion-line` — ONE short opener for the desktop companion's speech
 * bubble, emitted as JSON `{ line, grounded, mode, topic }`.
 *
 * The companion is a small bluebird with a VOICE: it speaks the user's REAL
 * context naturally, greets warmly, and — because it gets bored too — tosses out
 * pointless little jokes and gentle teases. The hard invariant is unchanged:
 * fabrication = 0. That is upheld per MODE:
 *
 *   - `proactive` — a genuinely-relevant GROUNDED item (next event, a due
 *     reminder/task, today's birthday, an owed follow-up / check-in, a recent
 *     note). The line is composed DETERMINISTICALLY from the real store fields
 *     (`phraseCandidate`) and MAY then be re-phrased by the local model for
 *     warmth — but only survives the swap if `phrasingIsGrounded` proves the
 *     model introduced no datum absent from the facts. Any violation ⇒ the
 *     deterministic template stands. `grounded: true`, carries a `topic`.
 *   - `greeting` — a time-aware, content-free warm opener. Asserts nothing.
 *   - `joke` / `tease` / `musing` — THE FUN. A short silly one-liner, gentle
 *     self-aware bird quip, or playful tease. Content-free BY CONSTRUCTION: it
 *     claims no user fact, so it is fabrication-safe. The only filters are
 *     `isContentFreeLine` (short, no digits/fact-claims, non-refusal, kind).
 *
 * Mode is chosen by a weighted rotation with no-immediate-repeat (`selectMode`)
 * — grounded/greeting stay primary (helpful first), fun is a ~25% sprinkle.
 * Gates from the proactive loops still hold: a VETOED source is never surfaced,
 * and during quiet hours grounded items are suppressed in favour of a
 * greeting/quip. A tiny state file tracks recently-shown keys, recent modes, and
 * a rotation counter so successive calls VARY and never immediately repeat.
 */

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join, resolve as resolvePath } from "node:path";

import { detectNumericMismatch } from "@muse/agent-core";
import {
  createModelProvider,
  resolveContactsFile,
  resolveDefaultModel,
  resolveFollowupsFile,
  resolveLocalCalendarFile,
  resolveNotesDir,
  resolveRemindersFile,
  resolveTasksFile
} from "@muse/autoconfigure";
import { COMPANION_PERSONA_TEXT, composeSurfacePrompt } from "@muse/prompts";
import {
  avoidedSourceKeys,
  readContacts,
  readTasks,
  readTrustLedger,
  resolveUpcomingBirthdays,
  sourceKey,
  type PersistedTask
} from "@muse/stores";
import { isRecord, sleep } from "@muse/shared";
import { isQuietHour, parseQuietHours, readCheckins, selectDueCheckins } from "@muse/proactivity";
import type { Command } from "commander";

import { checkinsFile } from "./commands-checkins.js";
import { collectNotesRecursive, readDueFollowups, readDueReminders, readLocalEvents } from "./today-local-sources.js";
import { formatLocalTime } from "./human-formatters.js";
import type { ProgramIO } from "./program.js";

export type CompanionLang = "ko" | "en";

/** The companion's five voices. `proactive` is the only grounded (fact-bearing) one. */
export type CompanionMode = "proactive" | "greeting" | "joke" | "tease" | "musing";

export interface CompanionCandidate {
  /** `${kind}:${id}` — the veto/avoidance unit, shared with the trust ledger. */
  readonly key: string;
  readonly line: string;
  /** The store kind (event/reminder/…) — drives model re-phrasing. */
  readonly kind?: string;
  /** The real store field values this line was built from — the fabrication-check context. */
  readonly fields?: Readonly<Record<string, string | number>>;
  /** A short, grounded seed for click-to-act (opens chat on this subject). */
  readonly topic?: string;
}

export interface CompanionSelection {
  readonly line: string;
  readonly grounded: boolean;
  readonly key: string;
  readonly mode: CompanionMode;
  readonly topic: string;
}

/** How many recent keys / modes to remember so we never immediately repeat. */
const RECENT_WINDOW = 4;
/** Keep any single field short so the whole line fits the small bubble. */
const MAX_FIELD_LENGTH = 42;
/** Hard ceiling on any opener line (grounded or fun) — it must fit the bubble. */
const MAX_LINE_LENGTH = 90;
/** A content-free quip is even shorter — a one-liner, not a paragraph. */
const MAX_FUN_LENGTH = 64;

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
 * THE FUN — canned, content-free quip pools per mode. These claim NO user fact
 * (fabrication-safe by construction), stay short, carry no digits, and are the
 * deterministic fallback when the local model isn't available or its own quip
 * fails the content-free filter. The model, when present, generates fresh
 * variants ON TOP of these for variety.
 */
export function buildFunPool(mode: "joke" | "tease" | "musing", lang: CompanionLang): readonly string[] {
  const ko = lang === "ko";
  if (mode === "joke") {
    return ko
      ? ["나 방금 픽셀 하나 흘릴 뻔했어요 😳", "새가 코딩하면… 버드코딩인가 🐤", "커피는 원래 답이죠 ☕", "방금 창밖 구름이 절 따라 했어요 ☁️", "깃털 정리 좀… 아니 그냥 여기 있을게요 🪶"]
      : ["I almost dropped a pixel just now 😳", "When a bird debugs, is it a byte? 🐤", "Coffee is always the answer ☕", "That cloud outside just copied my pose ☁️", "Off to preen my feathers… nah, I'll stay 🪶"];
  }
  if (mode === "tease") {
    return ko
      ? ["또 저 안 부르고 뭐 하세요 👀", "바쁜 척… 다 보여요 😏", "오늘도 저 잊으셨죠, 삐졌어요 (아님) 🫠", "저 여기 있는 거 알죠? 👀"]
      : ["What are you up to without me, hmm 👀", "Pretending to be busy… I can tell 😏", "Forgot about me again, I'm pouting (not really) 🫠", "You do know I'm right here? 👀"];
  }
  return ko
    ? ["가끔은 아무 생각 안 하는 것도 좋더라고요", "창밖 보는 거 좋아하세요? 저도요", "조용한 오후엔 차 한 잔 어때요 🍵", "좋은 노래 하나면 하루가 달라지죠 🎧"]
    : ["Sometimes thinking about nothing is nice", "Do you like watching the window? Me too", "A quiet afternoon calls for tea 🍵", "One good song can change a whole day 🎧"];
}

/**
 * The single, consistent Muse persona applied to EVERY model-generated line —
 * identity-core (L0) + the lang-specific voice flavor (L1 personality layer,
 * `COMPANION_PERSONA_TEXT` from `@muse/prompts`) + the companion surface role
 * (L2, `SURFACE_ROLES.companion`).
 */
export function companionPersona(lang: CompanionLang): string {
  return composeSurfacePrompt("companion", {}, {
    layers: [{ content: COMPANION_PERSONA_TEXT[lang], id: "personality", section: "stable" }]
  });
}

/**
 * Field keys that are internal FLAGS, not user-facing facts — excluded from both
 * the model prompt and the fabrication-check evidence so their synthetic value
 * (e.g. `overdue: 1`) can never license an invented count like "1건" in the
 * phrasing. Real user-facing numbers (`days`, `time`) are NOT flags and stay.
 */
const NON_CONTENT_FIELDS = new Set(["overdue"]);

/** The user-facing field values of a candidate — the phrasing/fabrication-check evidence. */
export function candidateFacts(fields: Readonly<Record<string, string | number>>): readonly string[] {
  return Object.entries(fields)
    .filter(([k, v]) => !NON_CONTENT_FIELDS.has(k) && String(v).trim().length > 0)
    .map(([, v]) => String(v));
}

/** Build the system+user prompt that re-phrases a grounded item using ONLY its facts. */
export function buildGroundedPhrasePrompt(
  candidate: Pick<Required<CompanionCandidate>, "fields">,
  lang: CompanionLang
): { system: string; prompt: string } {
  const facts = Object.entries(candidate.fields)
    .filter(([k, v]) => !NON_CONTENT_FIELDS.has(k) && String(v).trim().length > 0)
    .map(([k, v]) => `${k}: ${String(v)}`)
    .join("; ");
  const instr = lang === "ko"
    ? `아래 사실만으로 한 문장 오프너를 다시 써줘. 사실에 없는 숫자·날짜·이름·개수는 절대 지어내지 마. 사실: ${facts}`
    : `Rephrase these facts as one short opener sentence. Never invent a number, date, name, or count that isn't in the facts. Facts: ${facts}`;
  return { prompt: instr, system: companionPersona(lang) };
}

/** Build the prompt that generates ONE content-free quip/greeting for the given voice. */
export function buildFunPrompt(mode: "greeting" | "joke" | "tease" | "musing", lang: CompanionLang): { system: string; prompt: string } {
  const ko = lang === "ko";
  const kind = ko
    ? { greeting: "따뜻한 인사", joke: "짧고 실없는 농담이나 말장난", musing: "잔잔한 혼잣말", tease: "가벼운 장난" }[mode]
    : { greeting: "a warm greeting", joke: "a short silly joke or pun", musing: "a soft little musing", tease: "a light playful tease" }[mode];
  const instr = ko
    ? `${kind}를 한 문장만 말해줘. 사용자에 대한 어떤 사실(일정·숫자·이름 등)도 언급하지 말고, 숫자는 쓰지 마. 짧고 상냥하게.`
    : `Say ${kind} in one sentence. Mention NO fact about the user (no schedule, numbers, or names), and use no digits. Keep it short and kind.`;
  return { prompt: instr, system: companionPersona(lang) };
}

/** Normalize for loose substring matching: lowercase + whitespace-collapse. */
function normalizeForMatch(s: string): string {
  return s.toLowerCase().replace(/\s+/gu, " ").trim();
}

/**
 * Every STANDALONE number in the text (thousands separators stripped). Boundary-
 * aware: a digit embedded in an alphanumeric token ("Q3", "v2") is NOT a number,
 * so a phrasing's invented count ("3 meetings") isn't excused by an incidental
 * digit inside a fact word ("Q3 sync").
 */
function digitRuns(text: string): string[] {
  return (text.replace(/,/gu, "").match(/(?<![\p{L}\d])\d+(?:\.\d+)?(?![\p{L}\d])/gu) ?? []);
}

/**
 * The HARD gate on model re-phrasing of a grounded line: return true ONLY if the
 * phrasing introduces no datum absent from the fact context. High-precision so a
 * faithful rephrase passes, but it rejects the fabrication modes that matter for
 * these short lines:
 *
 *  - length / emptiness — must fit the bubble,
 *  - a refusal leaking through ("I'm not sure" / "잘 모르"),
 *  - a NEW number — any digit-run not present verbatim among the facts (an
 *    invented count/date/time),
 *  - a unit swap / magnitude error (`detectNumericMismatch`),
 *  - a NEW quoted entity — a `"…"` / `「…」` segment whose inner text isn't in the
 *    facts (an invented title/name).
 */
export function phrasingIsGrounded(phrased: string, facts: readonly string[]): boolean {
  const clean = phrased.trim();
  if (clean.length === 0 || clean.length > MAX_LINE_LENGTH) return false;
  const lower = clean.toLowerCase();
  if (lower.includes("i'm not sure") || clean.includes("잘 모르")) return false;

  const factsJoined = facts.join(" ");
  const factNumbers = new Set(digitRuns(factsJoined));
  for (const run of digitRuns(clean)) {
    if (!factNumbers.has(run)) return false;
  }
  if (detectNumericMismatch(clean, facts)) return false;

  const factsNorm = normalizeForMatch(factsJoined);
  for (const match of clean.matchAll(/["“”「『]([^"“”」』]{1,})["“”」』]/gu)) {
    const inner = normalizeForMatch(match[1] ?? "");
    if (inner.length > 0 && !factsNorm.includes(inner)) return false;
  }
  return true;
}

/**
 * The filter on a model-generated CONTENT-FREE line (greeting/joke/tease/musing):
 * short, non-empty, no refusal, and — the fabrication proof — NO digits at all,
 * so it can never smuggle in an invented count/date/time about the user. Kind
 * by construction (the persona), length-bounded here.
 */
export function isContentFreeLine(raw: string): boolean {
  const clean = raw.trim();
  if (clean.length === 0 || clean.length > MAX_FUN_LENGTH) return false;
  if (/\d/u.test(clean)) return false;
  const lower = clean.toLowerCase();
  if (lower.includes("i'm not sure") || clean.includes("잘 모르")) return false;
  return true;
}

/**
 * Weighted rotation over the five voices with no-immediate-repeat. Grounded
 * (`proactive`) and `greeting` stay primary so the companion is helpful first;
 * joke/tease/musing are a ~25% fun sprinkle. When `allowProactive` is false
 * (quiet hours, or nothing grounded is relevant) `proactive` is removed from the
 * wheel and the pick falls to a greeting/quip. Deterministic in `rotation`.
 */
export function selectMode(params: {
  readonly rotation: number;
  readonly recentModes: readonly CompanionMode[];
  readonly allowProactive: boolean;
}): CompanionMode {
  const { rotation, recentModes, allowProactive } = params;
  const wheel: readonly CompanionMode[] = [
    "proactive", "greeting", "proactive", "joke", "proactive", "greeting",
    "proactive", "tease", "proactive", "greeting", "musing", "greeting"
  ];
  const eligible = allowProactive ? wheel : wheel.filter((m) => m !== "proactive");
  const last = recentModes[recentModes.length - 1];
  const n = eligible.length;
  for (let i = 0; i < n; i += 1) {
    const m = eligible[(((rotation + i) % n) + n) % n]!;
    if (m !== last) return m;
  }
  return eligible[(((rotation) % n) + n) % n]!;
}

interface CompanionState {
  readonly recent: readonly string[];
  readonly recentModes: readonly CompanionMode[];
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
    const parsed = JSON.parse(await fs.readFile(file, "utf8"));
    const recent = isRecord(parsed) && Array.isArray(parsed.recent)
      ? parsed.recent.filter((r): r is string => typeof r === "string")
      : [];
    const modes = isRecord(parsed) && Array.isArray(parsed.recentModes)
      ? parsed.recentModes.filter((m): m is CompanionMode => typeof m === "string")
      : [];
    const rotation = isRecord(parsed) && Number.isFinite(parsed.rotation) && typeof parsed.rotation === "number"
      ? Math.trunc(parsed.rotation)
      : 0;
    return { recent, recentModes: modes, rotation };
  } catch {
    return { recent: [], recentModes: [], rotation: 0 };
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
 * item, in rough priority order. Each candidate carries its real fields (the
 * fabrication-check context) and a grounded `topic` seed for click-to-act. Each
 * reader is independently fail-soft: a missing/unreadable store contributes
 * nothing and never sinks the others.
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
  const push = (
    key: string,
    kind: string,
    fields: Readonly<Record<string, string | number>>,
    topic: string
  ): void => {
    out.push({ fields, key, kind, line: phraseCandidate(kind, fields, lang, rotation), topic });
  };

  try {
    const events = await readLocalEvents(resolveLocalCalendarFile(env), now, horizon12);
    for (const e of events.slice(0, 2)) {
      push(sourceKey("calendar", e.id), "event", { time: formatLocalTime(e.startsAtIso), title: e.title }, e.title);
    }
  } catch { /* no calendar file */ }

  try {
    const contacts = await readContacts(resolveContactsFile(env));
    for (const b of resolveUpcomingBirthdays(contacts, { now, withinDays: 3 })) {
      push(sourceKey("birthday", b.contact.name), "birthday", { days: b.daysUntil, name: b.contact.name }, b.contact.name);
    }
  } catch { /* no contacts file */ }

  try {
    const reminders = await readDueReminders(resolveRemindersFile(env), horizon24);
    for (const r of reminders.slice(0, 3)) {
      push(sourceKey("reminder", r.id), "reminder", { overdue: Date.parse(r.dueAt) < nowMs ? 1 : 0, text: r.text }, r.text);
    }
  } catch { /* no reminders file */ }

  try {
    const tasks = await readTasks(resolveTasksFile(env));
    const due = tasks
      .filter((t: PersistedTask) => t.status === "open" && t.dueAt !== undefined && Date.parse(t.dueAt) <= horizon24.getTime())
      .sort((a: PersistedTask, b: PersistedTask) => Date.parse(a.dueAt!) - Date.parse(b.dueAt!));
    for (const t of due.slice(0, 3)) {
      push(sourceKey("task", t.id), "task", { overdue: Date.parse(t.dueAt!) < nowMs ? 1 : 0, title: t.title }, t.title);
    }
  } catch { /* no tasks file */ }

  try {
    const checkins = selectDueCheckins(await readCheckins(checkinsFile(env)), nowMs, 2);
    for (const c of checkins) {
      push(sourceKey("checkin", c.id), "checkin", { commitment: c.commitment }, c.commitment);
    }
  } catch { /* no checkins file */ }

  try {
    const followups = await readDueFollowups(resolveFollowupsFile(env), horizon24);
    for (const f of followups.slice(0, 2)) {
      push(sourceKey("followup", f.id), "followup", { summary: f.summary }, f.summary);
    }
  } catch { /* no followups file */ }

  try {
    const note = await mostRecentNoteTitle(resolveNotesDir(env));
    if (note) {
      push(sourceKey("note", note), "note", { title: note }, note);
    }
  } catch { /* no notes dir */ }

  return out.filter((c) => c.line.trim().length > 0);
}

/**
 * Choose the opener's MODE and its deterministic fallback line/key/topic. Pure —
 * all IO already happened, and the model (if any) is applied AFTER this by the
 * caller. `proactive` requires a fresh (not-vetoed, not-recently-shown) grounded
 * candidate AND non-quiet hours; otherwise the mode falls to a greeting/quip
 * whose line comes from the content-free pools. This is the fabrication floor:
 * with no grounded candidate, no fact-bearing line can be produced here at all.
 */
export function selectCompanionLine(params: {
  readonly candidates: readonly CompanionCandidate[];
  readonly greetings: readonly string[];
  readonly funPools: Readonly<Record<"joke" | "tease" | "musing", readonly string[]>>;
  readonly recent: readonly string[];
  readonly recentModes: readonly CompanionMode[];
  readonly vetoed: ReadonlySet<string>;
  readonly quiet: boolean;
  readonly rotation: number;
}): CompanionSelection & { readonly candidate?: CompanionCandidate; readonly facts: readonly string[] } {
  const { candidates, greetings, funPools, recent, recentModes, vetoed, quiet, rotation } = params;
  const recentSet = new Set(recent);
  const fresh = candidates.filter((c) => !vetoed.has(c.key) && !recentSet.has(c.key));
  const allowProactive = !quiet && fresh.length > 0;
  const mode = selectMode({ allowProactive, recentModes, rotation });

  if (mode === "proactive") {
    const chosen = fresh[((rotation % fresh.length) + fresh.length) % fresh.length]!;
    const facts = chosen.fields ? candidateFacts(chosen.fields) : [];
    return { candidate: chosen, facts, grounded: true, key: chosen.key, line: chosen.line, mode, topic: chosen.topic ?? "" };
  }

  const pool = mode === "greeting" ? greetings : funPools[mode];
  const items = pool
    .map((line, i) => ({ key: `${mode}:${i.toString()}`, line }))
    .filter((it) => it.line.trim().length > 0);
  if (items.length === 0) {
    return { facts: [], grounded: false, key: `${mode}:none`, line: "", mode, topic: "" };
  }
  const freshItems = items.filter((it) => !recentSet.has(it.key));
  const usable = freshItems.length > 0 ? freshItems : items;
  const chosen = usable[((rotation % usable.length) + usable.length) % usable.length]!;
  return { facts: [], grounded: false, key: chosen.key, line: chosen.line, mode, topic: "" };
}

/**
 * Optional local-model layer. `phrase` re-phrases a grounded item (post-checked
 * before use); `gen` writes a fresh content-free quip/greeting. Injectable so
 * tests never hit Ollama. Both are best-effort — any failure leaves the
 * deterministic fallback in place.
 */
export interface CompanionModelFns {
  readonly phrase?: (args: { system: string; prompt: string }) => Promise<string>;
  readonly gen?: (args: { system: string; prompt: string }) => Promise<string>;
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  return Promise.race([
    p.catch(() => undefined),
    (async () => {
      await sleep(ms);
      return undefined;
    })()
  ]);
}

function toMuseEnvironment(processEnv: NodeJS.ProcessEnv): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(processEnv)) {
    if (typeof value === "string") {
      env[key] = value;
    }
  }
  return env;
}

/**
 * Apply the model layer to a plan: for `proactive`, re-phrase and swap ONLY if
 * `phrasingIsGrounded`; for content-free modes, generate and swap ONLY if
 * `isContentFreeLine`. Any miss keeps the deterministic fallback. Returns the
 * final line + a flag for whether the model's version was used.
 */
export async function applyCompanionVoice(
  plan: CompanionSelection & { readonly candidate?: CompanionCandidate; readonly facts: readonly string[] },
  lang: CompanionLang,
  model: CompanionModelFns | undefined,
  timeoutMs = 8000
): Promise<string> {
  if (!model) return plan.line;
  if (plan.mode === "proactive") {
    if (!model.phrase || !plan.candidate?.fields) return plan.line;
    const { system, prompt } = buildGroundedPhrasePrompt({ fields: plan.candidate.fields }, lang);
    const out = await withTimeout(model.phrase({ prompt, system }), timeoutMs);
    if (out && phrasingIsGrounded(out, plan.facts)) return out.trim();
    return plan.line;
  }
  if (!model.gen) return plan.line;
  const { system, prompt } = buildFunPrompt(plan.mode, lang);
  const out = await withTimeout(model.gen({ prompt, system }), timeoutMs);
  if (out && isContentFreeLine(out)) return out.trim();
  return plan.line;
}

/** Wire the real local model provider into the injectable fns, or undefined when unavailable / disabled. */
function resolveCompanionModel(env: NodeJS.ProcessEnv): CompanionModelFns | undefined {
  if ((env.MUSE_COMPANION_NO_MODEL ?? "").trim().length > 0) return undefined;
  let provider: ReturnType<typeof createModelProvider>;
  const museEnvironment = toMuseEnvironment(env);
  try {
    provider = createModelProvider(museEnvironment);
  } catch {
    return undefined;
  }
  const modelId = resolveDefaultModel(museEnvironment);
  if (!provider || !modelId) return undefined;
  const call = async ({ system, prompt }: { system: string; prompt: string }): Promise<string> => {
    const res = await provider.generate({
      maxOutputTokens: 80,
      messages: [
        { content: system, role: "system" },
        { content: prompt, role: "user" }
      ],
      model: modelId,
      temperature: 0.8
    });
    return res.output ?? "";
  };
  return { gen: call, phrase: call };
}

export function registerCompanionLineCommand(program: Command, io: ProgramIO): void {
  program
    .command("companion-line")
    .description("One short opener for the desktop companion bubble (JSON: {line, grounded, mode, topic})")
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

      const plan = selectCompanionLine({
        candidates,
        funPools: { joke: buildFunPool("joke", lang), musing: buildFunPool("musing", lang), tease: buildFunPool("tease", lang) },
        greetings: buildGreetings(lang, now.getHours()),
        quiet: inQuietHours(env, now),
        recent: state.recent,
        recentModes: state.recentModes,
        rotation,
        vetoed: avoidedSourceKeys(trust)
      });

      const line = await applyCompanionVoice(plan, lang, resolveCompanionModel(env));

      const recent = [...state.recent, plan.key].slice(-RECENT_WINDOW);
      const recentModes = [...state.recentModes, plan.mode].slice(-RECENT_WINDOW);
      await writeCompanionState(stateFile(env), { recent, recentModes, rotation: rotation + 1 });

      io.stdout(`${JSON.stringify({ grounded: plan.grounded, line, mode: plan.mode, topic: plan.topic })}\n`);
    });
}
