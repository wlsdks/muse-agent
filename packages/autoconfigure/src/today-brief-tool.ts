/**
 * `today_brief` agent tool + the pure `composeTodayBrief` aggregator behind it.
 *
 * The TODAY/triage twin of `week_agenda`. `week_agenda` is a forward, day-by-day
 * PLANNING view of the next N days; `today_brief` answers "what's on my plate
 * RIGHT NOW?" — it LEADS WITH OVERDUE (past-due tasks, reminders, missed
 * follow-ups) then today's remaining events / due reminders / tasks, in ONE call.
 * The today aggregation already existed for `muse today`, the in-chat `/today`,
 * and the web/API surfaces, but — unlike the week path — was never projected as
 * an agent tool, so the local model had to chain calendar+tasks+reminders+
 * followups (4 calls) to answer "what's today", which it does unreliably
 * (coherence degrades after 2-3 steps). This closes that asymmetry.
 */

import type { JsonObject } from "@muse/shared";
import { stripUntrustedTerminalChars } from "@muse/shared";
import type { MuseTool } from "@muse/tools";

export interface TodayBriefInput {
  /** Open tasks that carry a due time. */
  readonly tasks: readonly { readonly title: string; readonly dueAt: string }[];
  /** Pending reminders. */
  readonly reminders: readonly { readonly text: string; readonly dueAt: string }[];
  /** Scheduled (not yet fired/cancelled) follow-up commitments. */
  readonly followups: readonly { readonly summary: string; readonly scheduledFor: string }[];
  /** Calendar events whose start falls within today's window. `endsAtIso` (when
   * known) lets an IN-PROGRESS event (started before now, still running) surface;
   * `allDay` marks a date-only event (a birthday/holiday) so it isn't rendered as
   * a misleading "00:00 (now)" timed item. */
  readonly events: readonly { readonly title: string; readonly startsAtIso: string; readonly endsAtIso?: string; readonly allDay?: boolean }[];
}

export interface TodayBrief {
  /** Past-due items (before `now`), soonest-first — the triage lead. */
  readonly overdue: readonly string[];
  /** Remaining items between `now` and the lookahead cutoff, by time. */
  readonly today: readonly string[];
}

const clean = (s: string): string => stripUntrustedTerminalChars(s).replace(/\s+/gu, " ").trim();
const hhmm = (ms: number): string => new Date(ms).toTimeString().slice(0, 5);
const endOfLocalDay = (d: Date): number => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999).getTime();

/**
 * Partition the merged today inputs into OVERDUE (time strictly before `now`,
 * the lead) and TODAY (time in `[now, cutoff]`). `cutoff` defaults to the end of
 * the local day; a positive `lookaheadHours` overrides it to `now + N hours`.
 * Pure — unparseable times are dropped, both buckets are soonest-first.
 */
export function composeTodayBrief(data: TodayBriefInput, now: Date, lookaheadHours?: number): TodayBrief {
  const nowMs = now.getTime();
  const cutoff = lookaheadHours !== undefined && Number.isFinite(lookaheadHours) && lookaheadHours > 0
    ? nowMs + lookaheadHours * 3_600_000
    : endOfLocalDay(now);
  const overdue: { ms: number; text: string }[] = [];
  const today: { ms: number; text: string }[] = [];
  const place = (ms: number, overdueText: string, todayText: string): void => {
    if (!Number.isFinite(ms)) return;
    if (ms < nowMs) overdue.push({ ms, text: overdueText });
    else if (ms <= cutoff) today.push({ ms, text: todayText });
  };

  for (const task of data.tasks) {
    const ms = Date.parse(task.dueAt);
    place(ms, `☑ ${clean(task.title)} (overdue)`, `☑ ${clean(task.title)} (due)`);
  }
  for (const reminder of data.reminders) {
    const ms = Date.parse(reminder.dueAt);
    place(ms, `⏰ ${clean(reminder.text)} (overdue)`, `${hhmm(ms)} ⏰ ${clean(reminder.text)}`);
  }
  for (const followup of data.followups) {
    const ms = Date.parse(followup.scheduledFor);
    place(ms, `↩ ${clean(followup.summary)} (follow-up overdue)`, `${hhmm(ms)} ↩ ${clean(followup.summary)}`);
  }
  for (const event of data.events) {
    const ms = Date.parse(event.startsAtIso);
    if (!Number.isFinite(ms)) continue;
    // An all-day event (a birthday/holiday) has no clock time — render it as a
    // plain all-day item, NOT a misleading "00:00 (now)" timed one. Sorted by its
    // midnight start, so it sits at the top of today's items.
    if (event.allDay) {
      today.push({ ms, text: `📅 ${clean(event.title)} (all day)` });
      continue;
    }
    // An UPCOMING event (starts in [now, cutoff]) shows as a remaining item; an
    // IN-PROGRESS one (started before now but still running) is on the plate
    // RIGHT NOW, so surface it too (marked "(now)"). A finished event is dropped.
    const endsMs = event.endsAtIso ? Date.parse(event.endsAtIso) : Number.NaN;
    if (ms >= nowMs && ms <= cutoff) today.push({ ms, text: `${hhmm(ms)} ${clean(event.title)}` });
    else if (ms < nowMs && Number.isFinite(endsMs) && endsMs > nowMs) today.push({ ms, text: `${hhmm(ms)} ${clean(event.title)} (now)` });
  }

  overdue.sort((a, b) => a.ms - b.ms);
  today.sort((a, b) => a.ms - b.ms);
  return { overdue: overdue.map((x) => x.text), today: today.map((x) => x.text) };
}

export interface TodayBriefToolDeps {
  readonly todayInput: () => Promise<TodayBriefInput> | TodayBriefInput;
  /** Injected clock so the window is deterministic in tests. */
  readonly now?: () => Date;
}

export function createTodayBriefTool(deps: TodayBriefToolDeps): MuseTool {
  return {
    definition: {
      description:
        "Answers 'what's on my plate today?' / 'what do I need to do right now?' / 'what did I miss / what's overdue?' / '오늘 뭐 해야 해?' / '지금 뭐부터 해야 돼?'. ONE triage view for TODAY — it LEADS WITH anything OVERDUE (past-due tasks, reminders, missed follow-ups), then today's remaining calendar events, due reminders, and tasks, merged (read-only, local), so you don't chain separate lookups. USE WHEN the user means TODAY / right now / what's overdue / what they missed. For the week-ahead PLANNING view of the next N days use week_agenda, NOT this; for ONLY tasks/reminders/events use their own list tools.",
      domain: "calendar",
      inputSchema: {
        additionalProperties: false,
        properties: {
          lookaheadHours: { description: "How many hours ahead to include beyond now, e.g. 4. Defaults to the rest of today.", maximum: 24, minimum: 1, type: "integer" }
        },
        required: [],
        type: "object"
      },
      keywords: ["today", "오늘", "right now", "지금", "overdue", "밀린", "놓친", "missed", "what's left", "남은", "오늘 할 일", "to do today", "plate"],
      name: "today_brief",
      risk: "read"
    },
    execute: async (args): Promise<JsonObject> => {
      const rawHours = args["lookaheadHours"];
      const lookaheadHours = typeof rawHours === "number" && Number.isFinite(rawHours) && rawHours >= 1 ? Math.min(24, Math.trunc(rawHours)) : undefined;
      const now = deps.now ? deps.now() : new Date();
      const brief = composeTodayBrief(await Promise.resolve(deps.todayInput()), now, lookaheadHours);
      return { overdue: [...brief.overdue], today: [...brief.today] };
    }
  };
}
