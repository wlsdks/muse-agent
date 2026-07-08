/**
 * First-run "install → first value" building blocks — the three additions that
 * turn a fresh, EMPTY install into one that already has data to learn from,
 * sensible defaults on, and a personalized proof-of-value moment.
 *
 * A brand-new `~/.muse` is the data famine: every sensor is opt-in and OFF, so
 * the "learns you" pitch has nothing to land on. This module is the pure,
 * deps-injected core the first-run wizard calls after the model pick:
 *
 *   1. DATA-CONNECT — a multi-select of the SAFE, already-built connectors
 *      (`muse setup data`'s steps). Selection → `DataSetupFlags` → the EXISTING
 *      `runDataSetup` flag-mode path (ingestion is never hand-rolled here).
 *   2. SMART DEFAULTS — scaffold a couple of starter skills when the skills dir
 *      is empty (idempotent), and confirm memory auto-extract is on / proactivity
 *      stays opt-in. Nothing intrusive, nothing that egresses.
 *   3. FIRST-VALUE LINE — one warm, PERSONALIZED success line grounded ONLY in
 *      data now present (name / a just-connected source), under the SAME
 *      fabrication=0 discipline as `companion-line` (`phrasingIsGrounded` /
 *      `isContentFreeLine`). No real datum ⇒ a content-free welcome. An invented
 *      trait can never be produced: the grounded line is composed
 *      deterministically from real strings and re-checked before it is shown.
 */

import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { isContentFreeLine, phrasingIsGrounded } from "./companion-line.js";
import { DATA_STEPS, type DataSetupFlags } from "./commands-setup-data.js";

/** The connectors offered at first-run — the SAFE, already-built `setup data` steps. */
export const FIRST_RUN_DATA_STEP_IDS = ["contacts", "browsing", "remindersMirror", "notesMirror"] as const;
export type FirstRunDataStepId = (typeof FIRST_RUN_DATA_STEP_IDS)[number];

/** Concise bilingual labels for the multi-select rows (the `why` subtitle is reused from DATA_STEPS). */
const DATA_LABELS: Readonly<Record<FirstRunDataStepId, string>> = {
  browsing: "🌐 크롬 방문 기록   ·   Chrome browsing history",
  contacts: "📇 애플 연락처   ·   Apple Contacts",
  notesMirror: "🗒️  애플 메모 미러   ·   Apple Notes mirror",
  remindersMirror: "⏰ 애플 미리 알림 미러   ·   Apple Reminders mirror"
};

export const FIRST_RUN_DATA_MESSAGE =
  "연결할 데이터 고르기 (스페이스로 선택 · 전부 로컬 · 건너뛰기 OK)   ·   Connect your data (space to pick — all local, skippable)";

/**
 * The multi-select rows, pinned so the premium bilingual copy can't silently
 * regress. Each row's hint is the SAME one-line WHY `muse setup data` shows.
 */
export const FIRST_RUN_DATA_OPTIONS: readonly {
  readonly value: FirstRunDataStepId;
  readonly label: string;
  readonly hint: string;
}[] = FIRST_RUN_DATA_STEP_IDS.map((id) => {
  const step = DATA_STEPS.find((s) => s.id === id);
  return { hint: step?.why ?? "", label: DATA_LABELS[id], value: id };
});

/** Map the chosen connector ids to the `setup data` flag-mode opt-ins. */
export function dataFlagsFromSelection(ids: readonly string[]): DataSetupFlags {
  const set = new Set(ids);
  return {
    browsing: set.has("browsing"),
    contacts: set.has("contacts"),
    notesMirror: set.has("notesMirror"),
    remindersMirror: set.has("remindersMirror")
  };
}

/**
 * Starter skills scaffolded on a fresh install so `muse` isn't skill-empty on
 * day one. These are real, useful bodies — not the bare `skills add` placeholder.
 */
export const STARTER_SKILLS: readonly { readonly name: string; readonly description: string; readonly body: string }[] = [
  {
    body:
      "When the user asks for a brief, a daily summary, or \"what's on today\", pull the\n" +
      "grounded local sources — upcoming calendar events, due reminders, and open tasks —\n" +
      "and answer with a short bullet list, newest/soonest first. Cite each item's source.\n" +
      "If a source is empty, say so plainly rather than inventing anything.",
    description: "Summarize today's calendar, reminders, and open tasks into a short cited brief.",
    name: "daily-briefing"
  },
  {
    body:
      "When the user tosses out a thought, task, or thing to remember (\"note that…\",\n" +
      "\"remind me to…\", \"capture this…\"), route it to the right store: a task, a reminder,\n" +
      "or a note. Confirm back in one line what you captured and where. Keep it frictionless —\n" +
      "one short confirmation, no interrogation.",
    description: "Capture a quick note, task, or reminder from what the user says.",
    name: "quick-capture"
  }
];

function renderStarterSkill(skill: { readonly name: string; readonly description: string; readonly body: string }): string {
  return `---\nname: ${skill.name}\ndescription: ${skill.description}\n---\n\n# ${skill.name}\n\n${skill.body}\n`;
}

/**
 * Write the starter skills ONLY when the skills dir has no skills yet. Idempotent
 * and non-destructive: if any skill folder already exists, this is a no-op and
 * returns 0, so a re-run (or a user who already added skills) is never clobbered.
 * Best-effort — a write failure returns the count written so far, never throws.
 */
export async function scaffoldStarterSkillsIfEmpty(skillsDir: string): Promise<number> {
  let existing: string[];
  try {
    existing = await readdir(skillsDir);
  } catch {
    existing = [];
  }
  if (existing.some((entry) => !entry.startsWith("."))) return 0;

  let written = 0;
  for (const skill of STARTER_SKILLS) {
    try {
      const dir = join(skillsDir, skill.name);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "SKILL.md"), renderStarterSkill(skill), "utf8");
      written += 1;
    } catch {
      break;
    }
  }
  return written;
}

/** One-line summary of the smart defaults that are now in effect. */
export function smartDefaultsNote(skillsScaffolded: number): string {
  const skills = skillsScaffolded > 0
    ? `시작용 스킬 ${skillsScaffolded.toString()}개를 넣어 뒀어요 · scaffolded ${skillsScaffolded.toString()} starter skill(s).\n`
    : "";
  return (
    `${skills}` +
    "메모리 자동 학습은 켜져 있어요 — 대화에서 당신을 배웁니다 · memory auto-extract is ON.\n" +
    "능동 알림(proactivity)은 꺼진 채로 둘게요 — 원할 때 직접 켜세요 · proactivity stays OFF (opt-in)."
  );
}

export interface FirstValueContext {
  /** A short display name for the user, if one is already known. */
  readonly userName?: string;
  /** Contacts imported THIS run (only counted when > 0). */
  readonly contactsImported?: number;
  /** Browsing visits synced THIS run (only counted when > 0). */
  readonly browsingSynced?: number;
  /** Rotation seed for the content-free welcome pool. */
  readonly rotation?: number;
}

export interface FirstValueResult {
  readonly line: string;
  readonly grounded: boolean;
}

/** Hard ceiling matching companion-line's grounded-line gate. */
const MAX_NAME_LENGTH = 24;

/** The content-free welcome pool — asserts NOTHING about the user (fabrication-safe by construction). */
export function contentFreeWelcomePool(): readonly string[] {
  return [
    "준비 끝 — 이제 뭐든 물어보세요   ·   You're all set — ask me anything",
    "다 됐어요 — 저는 바로 여기 있을게요   ·   All done — I'm right here",
    "설정 끝! 편하게 말 걸어주세요   ·   Ready when you are"
  ];
}

/**
 * The real fact atoms a first-value line may assert — a short name and the
 * just-connected source counts. This IS the fabrication-check evidence: a line
 * may reference only these values. Empty ⇒ no fact-bearing line is possible.
 */
export function firstValueFactAtoms(ctx: FirstValueContext): readonly string[] {
  const atoms: string[] = [];
  const name = (ctx.userName ?? "").replace(/\s+/gu, " ").trim();
  if (name.length > 0 && name.length <= MAX_NAME_LENGTH) atoms.push(name);
  if (typeof ctx.contactsImported === "number" && ctx.contactsImported > 0) atoms.push(`${ctx.contactsImported.toString()} contacts`);
  if (typeof ctx.browsingSynced === "number" && ctx.browsingSynced > 0) atoms.push(`${ctx.browsingSynced.toString()} visits`);
  return atoms;
}

/**
 * Compose ONE bilingual grounded line by interpolating ONLY real strings (name,
 * one primary source with its real count) — true by construction. Returns "" when
 * there is nothing real to say. Kept concise so it fits the grounded-line gate.
 */
function composeGroundedFirstValue(ctx: FirstValueContext): string {
  const name = (ctx.userName ?? "").replace(/\s+/gu, " ").trim();
  const hasName = name.length > 0 && name.length <= MAX_NAME_LENGTH;

  const c = ctx.contactsImported;
  const b = ctx.browsingSynced;
  let sourceKo = "";
  let sourceEn = "";
  if (typeof c === "number" && c > 0) {
    sourceKo = `연락처 ${c.toString()}명`;
    sourceEn = `${c.toString()} contacts`;
  } else if (typeof b === "number" && b > 0) {
    sourceKo = `방문 기록 ${b.toString()}건`;
    sourceEn = `${b.toString()} visits`;
  }

  if (hasName && sourceEn.length > 0) {
    return `${name}님, ${sourceKo} 연결됐어요 — 이제 당신을 배울게요   ·   ${name}, ${sourceEn} connected — learning you now`;
  }
  if (hasName) {
    return `${name}님, 반가워요 — 이제 당신을 배우기 시작할게요   ·   Nice to meet you, ${name} — starting to learn you`;
  }
  if (sourceEn.length > 0) {
    return `${sourceKo} 연결됐어요 — 여기서부터 당신을 배울게요   ·   ${sourceEn} connected — I'll learn you from here`;
  }
  return "";
}

/**
 * The fabrication gate on a first-value line — REUSES companion-line's discipline:
 * a grounded line must pass `phrasingIsGrounded` (no new number / quoted entity /
 * numeric mismatch, length-bounded); a content-free line must pass
 * `isContentFreeLine` (short, digit-free, non-refusal). This is the guard the
 * whole module leans on; weaken it and a fabricated line could reach the user.
 */
export function firstValueLineIsSafe(line: string, facts: readonly string[], grounded: boolean): boolean {
  return grounded ? phrasingIsGrounded(line, facts) : isContentFreeLine(line);
}

/**
 * Build the first-value success line. GROUNDED when a real fact atom exists and
 * the composed line survives the fabrication gate; otherwise a CONTENT-FREE
 * welcome. With no atoms no fact-bearing line is produced at all — the
 * fabrication floor. Pure + deterministic in `rotation`.
 */
export function buildFirstValueLine(ctx: FirstValueContext): FirstValueResult {
  const facts = firstValueFactAtoms(ctx);
  if (facts.length > 0) {
    const candidate = composeGroundedFirstValue(ctx);
    if (candidate.length > 0 && firstValueLineIsSafe(candidate, facts, true)) {
      return { grounded: true, line: candidate };
    }
  }
  const pool = contentFreeWelcomePool();
  const rotation = Number.isFinite(ctx.rotation) ? (ctx.rotation as number) : 0;
  const line = pool[((rotation % pool.length) + pool.length) % pool.length]!;
  return { grounded: false, line };
}

/** Derive the grounded first-value inputs from a `setup data` result (0 counts dropped). */
export function firstValueContextFromDataResult(
  result: { readonly contacts?: { readonly imported: number }; readonly browsing?: { readonly synced: number } } | undefined
): Pick<FirstValueContext, "contactsImported" | "browsingSynced"> {
  if (!result) return {};
  return {
    ...(result.contacts && result.contacts.imported > 0 ? { contactsImported: result.contacts.imported } : {}),
    ...(result.browsing && result.browsing.synced > 0 ? { browsingSynced: result.browsing.synced } : {})
  };
}
