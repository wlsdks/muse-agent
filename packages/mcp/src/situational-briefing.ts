/**
 * Synthesise ONE coherent situational heads-up from the imminent
 * calendar/task items + the delegated-objective lifecycle — the
 * JARVIS "here's your situation" picture, not N disconnected
 * notices.
 *
 * Pure and deterministic: the proactive loop / Phase-D synthesis
 * decides WHEN and through what voice to deliver this; this module
 * only decides WHAT the briefing says given the current context.
 */

import { computeAvailability, type AvailabilityEventLike } from "./calendar-availability.js";
import type { StandingObjective } from "@muse/stores";

/**
 * Duck-typed imminent item — mirrors the public fields of the
 * proactive loop's private `ImminentItem` without coupling to it.
 */
export interface BriefingImminent {
  readonly title: string;
  readonly startsAt: Date;
  readonly kind: string;
}

export interface SituationalBriefingInput {
  readonly now: Date;
  readonly imminent: readonly BriefingImminent[];
  readonly objectives: readonly StandingObjective[];
  /**
   * Optional pre-resolved current-weather line. Supplementary context
   * only — it rides an otherwise-non-empty briefing ("leave early,
   * rain at 3") and NEVER triggers a briefing on its own (a JARVIS
   * doesn't ping "it's sunny" with nothing else to say).
   */
  readonly weather?: string;
  /**
   * Optional pre-resolved unread-inbox line ("3 unread — …").
   * Supplementary, same posture as `weather`: it rides an
   * otherwise-non-empty briefing and never triggers one alone.
   */
  readonly inbox?: string;
  /**
   * Optional pre-resolved "related knowledge" line — a note/task the
   * user already wrote that bears on the top upcoming item ("prep:
   * bring the Q3 deck"). Supplementary, same posture as weather/inbox:
   * it rides an otherwise-non-empty briefing, never triggers one.
   * Proactively surfaces what the user needs to KNOW for what's next.
   */
  readonly related?: string;
  /**
   * Optional pre-resolved home-alert line ("Front door is unlocked").
   * Supplementary, same posture as weather/inbox: it rides an
   * otherwise-non-empty briefing and never triggers one alone — and
   * carries ONLY noteworthy states, never "everything's normal".
   */
  readonly home?: string;
  /**
   * Optional pre-resolved upcoming-birthdays line ("Sarah today; Bob in
   * 3 days"). Supplementary, same posture as weather/inbox/home: rides
   * an otherwise-non-empty briefing and never triggers one alone.
   */
  readonly birthdays?: string;
  /**
   * Optional pre-resolved due-tasks line ("Buy milk (overdue); Pay rent
   * (today)"). Supplementary, same posture as the others.
   */
  readonly tasksDue?: string;
  /**
   * Optional pre-resolved "shape of the day" free/busy line ("free
   * 12:00–13:00, after 16:00" / "booked solid the rest of today").
   * Supplementary, same posture as the others — rides an
   * otherwise-non-empty briefing, never triggers one alone.
   */
  readonly availability?: string;
}

function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}

/**
 * One-line free/busy summary for the REST of today (`now` →
 * `dayEndHour`:00 local, default 22), composing {@link
 * computeAvailability}. Returns `undefined` when there's nothing to say
 * — no commitments left today, or `now` is already past the day's
 * end-hour — so the briefing stays quiet (a supplementary line, never a
 * trigger). "booked solid the rest of today" when no gap remains; else
 * "free <gaps>", a trailing gap to day-end rendered "after HH:MM".
 */
export function resolveDayShapeLine(
  events: readonly AvailabilityEventLike[],
  options: { readonly now?: Date; readonly dayEndHour?: number } = {}
): string | undefined {
  const now = options.now ?? new Date();
  const endHour = Number.isFinite(options.dayEndHour) ? Math.max(1, Math.min(24, Math.trunc(options.dayEndHour as number))) : 22;
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), endHour, 0, 0, 0);
  if (end.getTime() <= now.getTime()) {
    return undefined;
  }
  const result = computeAvailability(events, { from: now, to: end });
  if (result.busy.length === 0) {
    return undefined;
  }
  if (result.free.length === 0) {
    return "booked solid the rest of today";
  }
  const slots = result.free.map((slot) =>
    slot.endsAt.getTime() >= end.getTime()
      ? `after ${pad2(slot.startsAt.getHours())}:${pad2(slot.startsAt.getMinutes())}`
      : `${pad2(slot.startsAt.getHours())}:${pad2(slot.startsAt.getMinutes())}–${pad2(slot.endsAt.getHours())}:${pad2(slot.endsAt.getMinutes())}`
  );
  return `free ${slots.join(", ")}`;
}

function clean(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function minutesUntil(startsAt: Date, now: Date): number {
  return Math.max(0, Math.round((startsAt.getTime() - now.getTime()) / 60_000));
}

/**
 * Returns the briefing text, or `undefined` when there is nothing
 * worth saying (no imminent items AND no active/escalated
 * objectives) — silence is correct; a JARVIS does not narrate an
 * empty schedule.
 */
export function composeSituationalBriefing(input: SituationalBriefingInput): string | undefined {
  const upcoming = [...input.imminent]
    .filter((item) => !Number.isNaN(item.startsAt.getTime()))
    .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());

  const active = input.objectives.filter((o) => o.status === "active");
  const escalated = input.objectives.filter((o) => o.status === "escalated");

  if (upcoming.length === 0 && active.length === 0 && escalated.length === 0) {
    return undefined;
  }

  const lines: string[] = ["[Briefing]"];

  const weather = input.weather ? clean(input.weather) : "";
  if (weather.length > 0) {
    lines.push(`Weather: ${weather}`);
  }

  const inbox = input.inbox ? clean(input.inbox) : "";
  if (inbox.length > 0) {
    lines.push(`Inbox: ${inbox}`);
  }

  const home = input.home ? clean(input.home) : "";
  if (home.length > 0) {
    lines.push(`Home: ${home}`);
  }

  const birthdays = input.birthdays ? clean(input.birthdays) : "";
  if (birthdays.length > 0) {
    lines.push(`Birthdays: ${birthdays}`);
  }

  const tasksDue = input.tasksDue ? clean(input.tasksDue) : "";
  if (tasksDue.length > 0) {
    lines.push(`Due: ${tasksDue}`);
  }

  const availability = input.availability ? clean(input.availability) : "";
  if (availability.length > 0) {
    lines.push(`Schedule: ${availability}`);
  }

  if (upcoming.length > 0) {
    lines.push("Upcoming:");
    for (const item of upcoming) {
      const mins = minutesUntil(item.startsAt, input.now);
      const when = mins === 0 ? "now" : `in ${mins.toString()} min`;
      lines.push(`- ${when}: ${clean(item.title)}`);
    }
  }

  const related = input.related ? clean(input.related) : "";
  if (related.length > 0) {
    lines.push(`Related: ${related}`);
  }

  if (escalated.length > 0) {
    lines.push("Needs you:");
    for (const objective of escalated) {
      const why = objective.resolution ? ` — ${clean(objective.resolution)}` : "";
      lines.push(`- ⚠ ${clean(objective.spec)}${why}`);
    }
  }

  if (active.length > 0) {
    lines.push("Still tracking:");
    for (const objective of active) {
      lines.push(`- ${clean(objective.spec)}`);
    }
  }

  return lines.join("\n");
}
