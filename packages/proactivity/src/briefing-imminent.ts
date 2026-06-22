/**
 * Ground the situational briefing in the user's REAL imminent
 * personal tasks (P8-b3). Mirrors `runDueProactiveNotices`'s task
 * imminence selection exactly so the briefing's "Upcoming:" lines
 * agree with what the proactive daemon considers imminent:
 *   - status "open", a parseable `dueAt`, `proactive !== false`,
 *   - `dueAt` in `[now, now + leadMinutes]`.
 *
 * Pure + deterministic. The situational-briefing daemon calls this
 * per tick (imminence is time-relative); calendar-derived imminent
 * can be unioned in here later without touching the briefing
 * composer.
 */

import { readTasks } from "@muse/stores";
import type { BriefingImminent } from "./situational-briefing.js";

const DEFAULT_LEAD_MINUTES = 120;

/** Duck-typed calendar event — the public subset the rule needs. */
export interface BriefingCalendarEvent {
  readonly title: string;
  readonly startsAt: Date;
  readonly allDay: boolean;
  readonly notes?: string;
}

export type BriefingCalendarLister = (range: {
  readonly from: Date;
  readonly to: Date;
}) => Promise<readonly BriefingCalendarEvent[]>;

const NO_PROACTIVE_MARKER = "[no-proactive]";

/**
 * Calendar counterpart to `deriveBriefingImminent`. Mirrors
 * `runDueProactiveNotices`'s calendar imminence rule EXACTLY so
 * the briefing and the proactive daemon never disagree: skip
 * all-day, skip an unparseable `startsAt`, must fall in
 * `[now, now+leadMinutes]`, and respect the `[no-proactive]`
 * opt-out marker (title/notes). Fail-soft: a throwing lister →
 * `[]` (the objective + task briefing still goes out).
 */
export async function deriveCalendarBriefingImminent(
  lister: BriefingCalendarLister,
  options: { readonly now: Date; readonly leadMinutes?: number }
): Promise<readonly BriefingImminent[]> {
  const lead = typeof options.leadMinutes === "number" && Number.isFinite(options.leadMinutes)
    ? options.leadMinutes
    : DEFAULT_LEAD_MINUTES;
  const from = options.now;
  const to = new Date(options.now.getTime() + lead * 60_000);

  let events: readonly BriefingCalendarEvent[];
  try {
    events = await lister({ from, to });
  } catch {
    return [];
  }

  const imminent: BriefingImminent[] = [];
  for (const event of events) {
    if (event.allDay) continue;
    const startMs = event.startsAt.getTime();
    if (Number.isNaN(startMs)) continue;
    if (startMs < from.getTime() || startMs > to.getTime()) continue;
    if (event.title.toLowerCase().includes(NO_PROACTIVE_MARKER)) continue;
    if (event.notes && event.notes.toLowerCase().includes(NO_PROACTIVE_MARKER)) continue;
    imminent.push({ kind: "calendar", startsAt: event.startsAt, title: event.title });
  }
  return imminent;
}

export async function deriveBriefingImminent(
  tasksFile: string,
  options: { readonly now: Date; readonly leadMinutes?: number }
): Promise<readonly BriefingImminent[]> {
  const lead = typeof options.leadMinutes === "number" && Number.isFinite(options.leadMinutes)
    ? options.leadMinutes
    : DEFAULT_LEAD_MINUTES;
  const nowMs = options.now.getTime();
  const cutoffMs = nowMs + lead * 60_000;

  let tasks: Awaited<ReturnType<typeof readTasks>>;
  try {
    tasks = await readTasks(tasksFile);
  } catch {
    return [];
  }

  const imminent: BriefingImminent[] = [];
  for (const task of tasks) {
    if (task.status !== "open") continue;
    if (!task.dueAt) continue;
    if (task.proactive === false) continue;
    const dueAt = new Date(task.dueAt);
    const dueMs = dueAt.getTime();
    if (Number.isNaN(dueMs)) continue;
    if (dueMs < nowMs || dueMs > cutoffMs) continue;
    imminent.push({ kind: "task", startsAt: dueAt, title: task.title });
  }
  return imminent;
}
