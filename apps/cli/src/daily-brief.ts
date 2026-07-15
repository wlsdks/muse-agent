/**
 * Pure helpers for the fixed-time daily brief (`muse setup briefing` +
 * `makeDailyBriefTick`). Split out so the once-a-day gate and the "HH:MM
 * only" time validation are directly unit-testable without touching the
 * daemon tick or the messaging registry.
 */

export const DEFAULT_DAILY_BRIEF_TIME = "08:30";

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/u;

/**
 * Strict 24-hour "HH:MM" only — cadence NL parsing ("every day at 9am") is
 * the scheduler's job (`muse scheduler add`), not this preset's. Rejects
 * "25:00" (out of range) and "9am" (wrong format) with the accepted form
 * named in the error so the caller can surface it verbatim.
 */
export function parseDailyBriefTime(raw: string): { readonly hour: number; readonly minute: number } {
  const trimmed = raw.trim();
  const match = TIME_PATTERN.exec(trimmed);
  if (!match) {
    throw new Error(`invalid time '${raw}' — expected 24-hour "HH:MM" (e.g. "08:30")`);
  }
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

function sameLocalDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/**
 * Pure: should the fixed-time daily brief fire now? True once local clock
 * time is past `hour:minute` AND it hasn't already fired today (once per
 * calendar day) — the same restart-safe shape as `shouldFireRecap`
 * (commands-recap.ts), at minute instead of hour granularity. A missing/
 * garbage last-fired timestamp counts as "not fired" (fire). Deliberately
 * does NOT back-fill: a daemon that was off past the target time fires once
 * on its next tick TODAY, never for a day it was never running.
 */
export function shouldFireDailyBrief(now: Date, lastFiredISO: string | undefined, hour: number, minute: number): boolean {
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const targetMinutes = hour * 60 + minute;
  if (nowMinutes < targetMinutes) {
    return false;
  }
  if (lastFiredISO === undefined || lastFiredISO.length === 0) {
    return true;
  }
  const last = new Date(lastFiredISO);
  return Number.isNaN(last.getTime()) || !sameLocalDay(last, now);
}
