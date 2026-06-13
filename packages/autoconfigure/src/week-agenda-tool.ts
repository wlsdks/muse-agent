/**
 * `week_agenda` agent tool + the pure `groupWeekAgenda` aggregator behind it.
 *
 * One call merges the user's calendar events, due tasks, and upcoming birthdays
 * into the next N local days grouped by day — so a small local model gets "what's
 * my week look like?" in a single tool call instead of chaining calendar.list +
 * tasks.list + birthdays and merging them itself (which it does unreliably).
 *
 * `groupWeekAgenda` lives here (moved from apps/cli) so BOTH the `muse week`
 * command and this tool share one implementation; the runtime can only project a
 * tool from a package the assembly imports. Weather is intentionally NOT part of
 * the tool (it has its own tool) — the forecast plumbing stays in the CLI.
 */

import type { JsonObject } from "@muse/shared";
import { stripUntrustedTerminalChars } from "@muse/shared";
import type { MuseTool } from "@muse/tools";

export interface WeekDay {
  readonly label: string;
  readonly lines: readonly string[];
  /** This day's weather forecast summary; present only when the caller passes forecasts (the CLI does; the agent tool does not). */
  readonly forecast?: string;
}

export interface WeekAgendaInput {
  readonly events: readonly { readonly title: string; readonly startsAtIso: string }[];
  readonly tasks: readonly { readonly title: string; readonly dueAt: string }[];
  readonly birthdays: readonly { readonly name: string; readonly daysUntil: number }[];
  /** Per-day forecast summaries keyed by local YYYY-MM-DD; attached to each day's header. */
  readonly forecasts?: readonly { readonly dateIso: string; readonly summary: string }[];
}

const DAY_MS = 86_400_000;
const clean = (s: string): string => stripUntrustedTerminalChars(s).replace(/\s+/gu, " ").trim();
const startOfLocalDay = (d: Date): number => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
const dayLabel = (d: Date): string => d.toLocaleDateString("en-US", { day: "numeric", month: "short", weekday: "short" });
const localDateIso = (d: Date): string =>
  `${d.getFullYear().toString()}-${(d.getMonth() + 1).toString().padStart(2, "0")}-${d.getDate().toString().padStart(2, "0")}`;

/**
 * Bucket events / due tasks / birthdays into the next `days` LOCAL calendar
 * days from `now` and render each as a line (timed events first by time, then
 * untimed tasks/birthdays). Only days with something appear. Pure.
 */
export function groupWeekAgenda(data: WeekAgendaInput, now: Date, days = 7): readonly WeekDay[] {
  const today0 = startOfLocalDay(now);
  const dayIndex = (ms: number): number => Math.floor((startOfLocalDay(new Date(ms)) - today0) / DAY_MS);
  const buckets: { time: number; text: string }[][] = Array.from({ length: days }, () => []);
  const push = (idx: number, text: string, time: number): void => {
    if (idx >= 0 && idx < days) {
      buckets[idx]!.push({ text, time });
    }
  };
  for (const event of data.events) {
    const ms = Date.parse(event.startsAtIso);
    if (Number.isFinite(ms)) {
      push(dayIndex(ms), `${new Date(ms).toTimeString().slice(0, 5)} ${clean(event.title)}`, ms);
    }
  }
  for (const task of data.tasks) {
    const ms = Date.parse(task.dueAt);
    if (Number.isFinite(ms)) {
      push(dayIndex(ms), `☑ ${clean(task.title)} (due)`, Number.POSITIVE_INFINITY);
    }
  }
  for (const birthday of data.birthdays) {
    push(birthday.daysUntil, `🎂 ${clean(birthday.name)}'s birthday`, Number.POSITIVE_INFINITY);
  }
  const forecastByDate = new Map((data.forecasts ?? []).map((f) => [f.dateIso, f.summary] as const));
  const out: WeekDay[] = [];
  for (let i = 0; i < days; i += 1) {
    const items = buckets[i]!;
    const date = new Date(today0 + i * DAY_MS);
    const forecast = forecastByDate.get(localDateIso(date));
    if (items.length === 0 && forecast === undefined) {
      continue;
    }
    items.sort((a, b) => a.time - b.time);
    const label = i === 0 ? `Today — ${dayLabel(date)}` : i === 1 ? `Tomorrow — ${dayLabel(date)}` : dayLabel(date);
    out.push({ label, lines: items.map((item) => item.text), ...(forecast !== undefined ? { forecast } : {}) });
  }
  return out;
}

export interface WeekAgendaToolDeps {
  readonly weekInput: () => Promise<WeekAgendaInput> | WeekAgendaInput;
  /** Injected clock so the day window is deterministic in tests. */
  readonly now?: () => Date;
}

export function createWeekAgendaTool(deps: WeekAgendaToolDeps): MuseTool {
  return {
    definition: {
      description:
        "Answers 'what's my week look like?' / 'what's coming up this week?' / '이번 주 어때, 한눈에 보여줘'. ONE combined overview of the next N days — your calendar events, your due tasks, AND upcoming birthdays merged and grouped by day (read-only, local), so you don't chain separate lookups. Use this for a HOLISTIC week view that spans all three. For ONLY calendar events use the calendar list tool; for ONLY due tasks use the tasks list tool; for the weather forecast use the weather tool.",
      domain: "calendar",
      inputSchema: {
        additionalProperties: false,
        properties: {
          days: { description: "How many days ahead to include, e.g. 7 for a week. Defaults to 7.", maximum: 14, minimum: 1, type: "integer" }
        },
        required: [],
        type: "object"
      },
      keywords: ["week", "agenda", "this week", "coming up", "what's on", "schedule", "주간", "이번 주", "일정", "다가오는"],
      name: "week_agenda",
      risk: "read"
    },
    execute: async (args): Promise<JsonObject> => {
      const rawDays = args["days"];
      const days = typeof rawDays === "number" && Number.isFinite(rawDays) && rawDays >= 1 ? Math.min(14, Math.trunc(rawDays)) : 7;
      const now = deps.now ? deps.now() : new Date();
      const week = groupWeekAgenda(await Promise.resolve(deps.weekInput()), now, days);
      return {
        days,
        week: week.map((d) => ({ items: [...d.lines], label: d.label }))
      };
    }
  };
}
