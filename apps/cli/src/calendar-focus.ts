/**
 * Focus-time analysis — your LONGEST uninterrupted free block each day, not just
 * total free time. Grounded in the deep-work / attention-residue finding (Leroy,
 * "Why is it so hard to do my work? The challenge of attention residue when
 * switching between work tasks", Organizational Behavior and Human Decision
 * Processes 109(2):168-181, 2009; Newport, "Deep Work", 2016): switching leaves
 * "attention residue" that degrades the next task, so an hour split into six
 * ten-minute gaps is worth far less than one unbroken hour. A day's real focus
 * capacity is therefore its LARGEST contiguous free block — this surfaces it and
 * flags days that are fragmented (no block long enough to do deep work). Pure +
 * deterministic — reuses the calendar free/busy engine; no model.
 */

import { computeAvailability, type AvailabilityEventLike } from "@muse/mcp-shared";

export interface DayFocus {
  /** Start of the working window for this day. */
  readonly dayStart: Date;
  /** Minutes in the day's single largest uninterrupted free block. */
  readonly longestFreeMinutes: number;
  /** Total free minutes in the working window (fragmented across gaps). */
  readonly totalFreeMinutes: number;
  /** Number of busy blocks (meetings) intersecting the working window. */
  readonly meetingCount: number;
  /** True when no free block reaches `minFocusMinutes` — the day can't hold deep work. */
  readonly fragmented: boolean;
}

const MS_PER_MIN = 60_000;

/**
 * Build the per-day working-hour windows [startHour:00, endHour:00] LOCAL, for
 * `days` consecutive days beginning with `startDate`'s day. A window where
 * endHour <= startHour is skipped (degenerate).
 */
export function buildDayWindows(startDate: Date, days: number, startHour: number, endHour: number): { from: Date; to: Date }[] {
  const n = Math.max(1, Math.trunc(Number.isFinite(days) ? days : 5));
  const out: { from: Date; to: Date }[] = [];
  for (let i = 0; i < n; i += 1) {
    const from = new Date(startDate);
    from.setDate(startDate.getDate() + i);
    from.setHours(startHour, 0, 0, 0);
    const to = new Date(from);
    to.setHours(endHour, 0, 0, 0);
    if (to.getTime() > from.getTime()) out.push({ from, to });
  }
  return out;
}

/**
 * For each working-hour window, compute the day's focus stats from the events.
 * Pure over explicit windows (so the heart of the analysis is timezone-robust to
 * test). `minFocusMinutes` is the deep-work threshold below which a day is
 * "fragmented".
 */
export function analyzeFocusWindows(
  events: readonly AvailabilityEventLike[],
  windows: readonly { readonly from: Date; readonly to: Date }[],
  minFocusMinutes: number
): DayFocus[] {
  const threshold = Math.max(1, Number.isFinite(minFocusMinutes) ? minFocusMinutes : 60);
  return windows.map((window) => {
    const avail = computeAvailability(events, window);
    let longestMs = 0;
    let totalMs = 0;
    for (const slot of avail.free) {
      const span = slot.endsAt.getTime() - slot.startsAt.getTime();
      totalMs += span;
      if (span > longestMs) longestMs = span;
    }
    // A fully-free day has no busy blocks: its whole window is one free block.
    if (avail.fullyFree) {
      const whole = window.to.getTime() - window.from.getTime();
      longestMs = whole;
      totalMs = whole;
    }
    const longestFreeMinutes = Math.round(longestMs / MS_PER_MIN);
    return {
      dayStart: window.from,
      fragmented: longestFreeMinutes < threshold,
      longestFreeMinutes,
      meetingCount: avail.busy.length,
      totalFreeMinutes: Math.round(totalMs / MS_PER_MIN)
    };
  });
}

/**
 * The FIRST free block of at least `durationMinutes` across the working-hour
 * windows, in order, that starts at or after `notBefore` (so today's already-past
 * hours are never booked). undefined when no window has a long-enough gap. Pure —
 * the engine behind `muse calendar block` (time-blocking / implementation
 * intentions, Gollwitzer 1999): commit a task to a CONCRETE slot, don't leave it
 * a vague intention.
 */
export function findFirstFreeBlock(
  events: readonly AvailabilityEventLike[],
  windows: readonly { readonly from: Date; readonly to: Date }[],
  durationMinutes: number,
  notBefore?: Date
): { from: Date; to: Date } | undefined {
  const durMs = Math.max(1, Math.trunc(Number.isFinite(durationMinutes) ? durationMinutes : 60)) * MS_PER_MIN;
  const floor = notBefore ? notBefore.getTime() : Number.NEGATIVE_INFINITY;
  for (const window of windows) {
    for (const slot of computeAvailability(events, window).free) {
      const start = Math.max(slot.startsAt.getTime(), floor);
      if (slot.endsAt.getTime() - start >= durMs) {
        return { from: new Date(start), to: new Date(start + durMs) };
      }
    }
  }
  return undefined;
}

const fmtMinutes = (m: number): string => {
  const h = Math.floor(m / 60);
  const min = m % 60;
  return h > 0 ? `${h.toString()}h${min > 0 ? `${min.toString()}m` : ""}` : `${min.toString()}m`;
};

const fmtDay = (d: Date): string => d.toLocaleDateString("en-US", { day: "numeric", month: "short", weekday: "short" });

/**
 * A morning-brief beat for TODAY, or undefined. Fires only when the REMAINING
 * working day (now → workEnd) is genuinely fragmented — no free block reaches the
 * deep-work threshold, there is at least one meeting, AND enough of the day is
 * left for the warning to be actionable (so it doesn't nag at 5pm). Pure: the
 * caller passes today's events + `now`. This is the proactive, FELT sibling of
 * the on-demand `muse calendar focus`.
 */
export function briefFocusBeat(
  events: readonly AvailabilityEventLike[],
  now: Date,
  options: {
    readonly workStartHour?: number;
    readonly workEndHour?: number;
    readonly minFocusMinutes?: number;
    readonly minRemainingMinutes?: number;
  } = {}
): string | undefined {
  const workStartHour = options.workStartHour ?? 9;
  const workEndHour = options.workEndHour ?? 18;
  const minFocus = options.minFocusMinutes ?? 60;
  const minRemaining = options.minRemainingMinutes ?? 120;
  const workStart = new Date(now);
  workStart.setHours(workStartHour, 0, 0, 0);
  const workEnd = new Date(now);
  workEnd.setHours(workEndHour, 0, 0, 0);
  const from = new Date(Math.max(now.getTime(), workStart.getTime()));
  if (workEnd.getTime() - from.getTime() < minRemaining * MS_PER_MIN) return undefined;
  const [day] = analyzeFocusWindows(events, [{ from, to: workEnd }], minFocus);
  if (!day || !day.fragmented || day.meetingCount === 0) return undefined;
  return `🧠 Today's looking fragmented — your longest free stretch is only ${fmtMinutes(day.longestFreeMinutes)} across ${day.meetingCount.toString()} meeting${day.meetingCount === 1 ? "" : "s"}. Block focus time or move one before the day fills up (attention residue, Leroy 2009).`;
}

/** Render the human-readable focus report. */
export function formatFocus(days: readonly DayFocus[], minFocusMinutes: number): string {
  if (days.length === 0) return "No working days in range to analyze.\n";
  const lines = [`🧠 Focus time — longest uninterrupted free block per day (deep work needs >= ${minFocusMinutes.toString()}m):`];
  for (const day of days) {
    const tag = day.fragmented ? "  ⚠ fragmented — no deep-work block" : "";
    const meetings = day.meetingCount === 0 ? "no meetings" : `${day.meetingCount.toString()} meeting${day.meetingCount === 1 ? "" : "s"}`;
    lines.push(`  ${fmtDay(day.dayStart)}: longest ${fmtMinutes(day.longestFreeMinutes)} (${fmtMinutes(day.totalFreeMinutes)} free total, ${meetings})${tag}`);
  }
  const fragged = days.filter((d) => d.fragmented).length;
  if (fragged > 0) {
    lines.push(`  ${fragged.toString()} of ${days.length.toString()} day${days.length === 1 ? "" : "s"} can't hold a deep-work block — consider blocking focus time or consolidating meetings (attention residue, Leroy 2009).`);
  } else {
    lines.push("  Every day has room for deep work — your schedule protects focus.");
  }
  return `${lines.join("\n")}\n`;
}
