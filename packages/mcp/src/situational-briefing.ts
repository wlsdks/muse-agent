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

import type { StandingObjective } from "./personal-objectives-store.js";

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
