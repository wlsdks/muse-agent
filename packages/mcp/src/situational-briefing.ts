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

  if (upcoming.length > 0) {
    lines.push("Upcoming:");
    for (const item of upcoming) {
      const mins = minutesUntil(item.startsAt, input.now);
      const when = mins === 0 ? "now" : `in ${mins.toString()} min`;
      lines.push(`- ${when}: ${clean(item.title)}`);
    }
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
