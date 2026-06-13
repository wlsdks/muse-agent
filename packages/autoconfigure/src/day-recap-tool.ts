/**
 * `day_recap` agent tool + the pure `composeDayRecap` aggregator behind it.
 *
 * The RETROSPECTIVE twin of `today_brief`. `today_brief` looks FORWARD ("what's
 * on my plate / overdue right now"); `day_recap` looks BACK over the user's OWN
 * day — what THEY accomplished (tasks completed today, reminders that fired) and
 * what slipped (still-overdue tasks/reminders) — a "how did my day go" digest.
 * The recap aggregation already existed for `muse recap` (CLI) and the evening
 * daemon tick, but was never projected as an agent tool, so the local model had
 * to chain tasks.list(done) + reminders + overdue lookups and merge them.
 *
 * Carve (the 12B must hold it): day_recap = a RETROSPECTIVE of MY day;
 * today_brief = what's still LEFT/forward; recent_actions = what MUSE did
 * autonomously on my behalf (sends/bookings/refusals). Subject + tense differ.
 */

import type { JsonObject } from "@muse/shared";
import { stripUntrustedTerminalChars } from "@muse/shared";
import type { MuseTool } from "@muse/tools";

export interface DayRecapInput {
  /** Tasks the user completed today (with the local completion time). */
  readonly completedTasks: readonly { readonly title: string; readonly completedAt: string }[];
  /** Reminders that fired today. */
  readonly firedReminders: readonly { readonly text: string; readonly firedAt: string }[];
  /** Open tasks whose due time has already passed (slipping). */
  readonly overdueTasks: readonly { readonly title: string; readonly dueAt: string }[];
  /** Pending reminders whose due time has already passed (slipping). */
  readonly overdueReminders: readonly { readonly text: string; readonly dueAt: string }[];
}

export interface DayRecap {
  /** What the user got done today (completed tasks + fired reminders), by time. */
  readonly accomplished: readonly string[];
  /** What slipped (still-overdue tasks/reminders), soonest-overdue first. */
  readonly slipping: readonly string[];
}

const clean = (s: string): string => stripUntrustedTerminalChars(s).replace(/\s+/gu, " ").trim();
const hhmm = (ms: number): string => new Date(ms).toTimeString().slice(0, 5);

/**
 * Build the retrospective: `accomplished` = today's completed tasks + fired
 * reminders (by time), `slipping` = still-overdue tasks/reminders (soonest
 * first). Pure — unparseable times are dropped.
 */
export function composeDayRecap(data: DayRecapInput): DayRecap {
  const accomplished: { ms: number; text: string }[] = [];
  for (const task of data.completedTasks) {
    const ms = Date.parse(task.completedAt);
    if (Number.isFinite(ms)) accomplished.push({ ms, text: `✓ ${clean(task.title)}` });
  }
  for (const reminder of data.firedReminders) {
    const ms = Date.parse(reminder.firedAt);
    if (Number.isFinite(ms)) accomplished.push({ ms, text: `${hhmm(ms)} ⏰ ${clean(reminder.text)}` });
  }
  const slipping: { ms: number; text: string }[] = [];
  for (const task of data.overdueTasks) {
    const ms = Date.parse(task.dueAt);
    if (Number.isFinite(ms)) slipping.push({ ms, text: `☑ ${clean(task.title)} (still overdue)` });
  }
  for (const reminder of data.overdueReminders) {
    const ms = Date.parse(reminder.dueAt);
    if (Number.isFinite(ms)) slipping.push({ ms, text: `⏰ ${clean(reminder.text)} (still overdue)` });
  }
  accomplished.sort((a, b) => a.ms - b.ms);
  slipping.sort((a, b) => a.ms - b.ms);
  return { accomplished: accomplished.map((x) => x.text), slipping: slipping.map((x) => x.text) };
}

export interface DayRecapToolDeps {
  readonly recapInput: () => Promise<DayRecapInput> | DayRecapInput;
}

export function createDayRecapTool(deps: DayRecapToolDeps): MuseTool {
  return {
    definition: {
      description:
        "Answers 'how did my day go?' / 'what did I get done today?' / 'recap my day' / '오늘 하루 어땠어?' / '오늘 내가 한 거 정리해줘'. A RETROSPECTIVE look BACK over the user's OWN day — what THEY accomplished (tasks they finished, reminders that fired) and what SLIPPED (still-overdue items), merged (read-only, local), so you don't chain separate lookups. USE WHEN the user wants to look BACK / wrap up / review their own day. For what MUSE did autonomously on their behalf (messages it sent, bookings, refusals) use recent_actions, NOT this. For what's still LEFT to do / overdue right now use today_brief. For ONLY finished tasks use the tasks list tool.",
      domain: "calendar",
      inputSchema: {
        additionalProperties: false,
        properties: {},
        required: [],
        type: "object"
      },
      keywords: ["recap", "how did my day", "wrap up", "review my day", "got done", "accomplished", "오늘 하루", "하루 어땠", "되돌아", "정리해", "하루 정리"],
      name: "day_recap",
      risk: "read"
    },
    execute: async (): Promise<JsonObject> => {
      const recap = composeDayRecap(await Promise.resolve(deps.recapInput()));
      return { accomplished: [...recap.accomplished], slipping: [...recap.slipping] };
    }
  };
}
