/**
 * Step 4 of `docs/design/pattern-detection.md` — orchestrator that
 * stitches the two detectors together with a cooldown gate.
 *
 * Pure function. Caller resolves the fired-records sidecar from
 * disk (`@muse/mcp`'s `readPatternsFired`), passes them in.
 * Returns the subset of detected patterns that should actually
 * fire *right now*: in-slot (currentSlotOnly), past cooldown, and
 * over the configured confidence floor.
 *
 * The daemon-side wiring (read sidecar → call this → fire through
 * messaging → record patternId via `recordPatternFired`) ships in
 * a follow-on iter; this module keeps the policy logic
 * I/O-free for testability.
 */

import {
  detectTimeOfDayPatterns,
  detectWeeklyTaskPatterns,
  type PatternMatch,
  type Weekday
} from "./pattern-detector.js";
import type { PatternSignals } from "./pattern-signals.js";

export interface CooldownRecordLike {
  readonly patternId: string;
  readonly firedAtMs: number;
}

export interface SelectFireablePatternsOptions {
  readonly cooldownMs?: number;
  readonly minConfidence?: number;
  /** Cap on returned matches per tick. Default 3. */
  readonly maxPerTick?: number;
  /** Detector knobs. Both flow through to their respective detectors. */
  readonly timeOfDay?: {
    readonly minMatches?: number;
    readonly minDistinctDays?: number;
  };
  readonly weeklyTask?: {
    readonly minMatches?: number;
    readonly minDistinctWeeks?: number;
  };
}

const DEFAULT_COOLDOWN_MS = 24 * 60 * 60_000;
const DEFAULT_MIN_CONFIDENCE = 0.7;
const DEFAULT_MAX_PER_TICK = 3;

/**
 * Combine both detectors with `currentSlotOnly: true`, then drop
 * anything that's on cooldown or below the proactive confidence
 * floor. The output is what the daemon should actually fire on
 * this tick, sorted by confidence desc.
 *
 * Note the confidence floor here (default 0.7) is intentionally
 * stricter than the detectors' raw floor (0.4). A cluster that
 * passes the detector's "is this real?" bar may still be too
 * uncertain to interrupt the user with a proactive suggestion;
 * 0.7 catches the strong patterns only.
 */
export function selectFireablePatterns(
  now: Date,
  signals: PatternSignals,
  fired: readonly CooldownRecordLike[],
  options: SelectFireablePatternsOptions = {}
): readonly PatternMatch[] {
  // `??` does NOT catch NaN/Infinity (from a typo'd
  // MUSE_PROACTIVE_PATTERN_* env knob parsed via raw `Number(...)`).
  // Unguarded: a NaN maxPerTick → `slice(0, NaN)` fires nothing; a NaN
  // minConfidence → `confidence < NaN` is false so the floor vanishes
  // and every weak pattern fires; a NaN cooldownMs → `< NaN` is false
  // so cooldown never applies and patterns re-fire. Fall back to the
  // default for any non-finite knob (same guard the context-ref store uses).
  const cooldownMs = Number.isFinite(options.cooldownMs) ? options.cooldownMs! : DEFAULT_COOLDOWN_MS;
  const minConfidence = Number.isFinite(options.minConfidence) ? options.minConfidence! : DEFAULT_MIN_CONFIDENCE;
  const maxPerTick = Math.max(1, Number.isFinite(options.maxPerTick) ? Math.trunc(options.maxPerTick!) : DEFAULT_MAX_PER_TICK);
  const nowMs = now.getTime();

  const timeOfDay = detectTimeOfDayPatterns(now, signals, {
    currentSlotOnly: true,
    ...(options.timeOfDay?.minMatches !== undefined ? { minMatches: options.timeOfDay.minMatches } : {}),
    ...(options.timeOfDay?.minDistinctDays !== undefined ? { minDistinctDays: options.timeOfDay.minDistinctDays } : {})
  });
  const weekly = detectWeeklyTaskPatterns(now, signals, {
    currentSlotOnly: true,
    ...(options.weeklyTask?.minMatches !== undefined ? { minMatches: options.weeklyTask.minMatches } : {}),
    ...(options.weeklyTask?.minDistinctWeeks !== undefined ? { minDistinctWeeks: options.weeklyTask.minDistinctWeeks } : {})
  });

  const all: PatternMatch[] = [...timeOfDay, ...weekly];

  const cooldownByPattern = buildCooldownIndex(fired);

  const fireable = all.filter((match) => {
    if (match.confidence < minConfidence) return false;
    const lastFired = cooldownByPattern.get(match.id);
    if (lastFired !== undefined && nowMs - lastFired < cooldownMs) {
      return false;
    }
    return true;
  });

  fireable.sort((left, right) => right.confidence - left.confidence);

  return fireable.slice(0, maxPerTick);
}

function buildCooldownIndex(fired: readonly CooldownRecordLike[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const record of fired) {
    const prior = out.get(record.patternId);
    if (prior === undefined || record.firedAtMs > prior) {
      out.set(record.patternId, record.firedAtMs);
    }
  }
  return out;
}

const PREDICT_WEEKDAYS: readonly Weekday[] = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** The next wall-clock ms at or after `now` falling on `weekday` at `startHour:00`. */
export function nextOccurrenceMs(weekday: Weekday, startHour: number, now: Date): number {
  const target = PREDICT_WEEKDAYS.indexOf(weekday);
  const result = new Date(now);
  result.setHours(startHour, 0, 0, 0);
  let daysAhead = (target - now.getDay() + 7) % 7;
  if (daysAhead === 0 && result.getTime() <= now.getTime()) daysAhead = 7; // today's slot already passed → next week
  result.setDate(result.getDate() + daysAhead);
  result.setHours(startHour, 0, 0, 0);
  return result.getTime();
}

export interface PredictedNeed {
  readonly id: string;
  readonly label: string;
  readonly predictedAtMs: number;
  readonly confidence: number;
  readonly kind: "time-of-day-action" | "weekly-task";
}

export interface PredictUpcomingNeedsOptions {
  readonly leadWindowMs?: number;
  readonly minConfidence?: number;
}

/**
 * ALLOSTASIS — predictive regulation (Sterling, "Allostasis: a model of
 * predictive regulation", Physiology & Behavior 106(1):5-15, 2012): a system
 * adjusts AHEAD of an anticipated demand rather than only reacting once the
 * demand arrives. Muse's pattern firing is reactive — `selectFireablePatterns`
 * fires only when `now` is INSIDE a recurring slot. This anticipates: from the
 * detected recurring patterns it computes each one's NEXT occurrence and returns
 * those landing within `[now, now+leadWindow]`, soonest first — so Muse can
 * pre-position a heads-up before the slot, not at it. Pure; the detectors do the
 * mining, this projects them forward. Defaults: 48 h lead window, 0.6 confidence.
 */
export function predictUpcomingNeeds(
  now: Date,
  signals: PatternSignals,
  options: PredictUpcomingNeedsOptions = {}
): readonly PredictedNeed[] {
  const leadWindowMs = Number.isFinite(options.leadWindowMs) ? options.leadWindowMs! : 48 * 3_600_000;
  const minConfidence = Number.isFinite(options.minConfidence) ? options.minConfidence! : 0.6;
  const nowMs = now.getTime();
  const horizon = nowMs + Math.max(0, leadWindowMs);
  const out: PredictedNeed[] = [];
  for (const match of [...detectTimeOfDayPatterns(now, signals), ...detectWeeklyTaskPatterns(now, signals)]) {
    if (match.confidence < minConfidence) continue;
    const parsedHour = match.category === "time-of-day-action" ? Number.parseInt(match.bucket.hourBand.split("-")[0]!, 10) : 9;
    const startHour = Number.isFinite(parsedHour) ? parsedHour : 9;
    const predictedAtMs = nextOccurrenceMs(match.bucket.weekday, startHour, now);
    if (predictedAtMs >= nowMs && predictedAtMs <= horizon) {
      out.push({ confidence: match.confidence, id: match.id, kind: match.category, label: match.suggestion, predictedAtMs });
    }
  }
  return out.sort((left, right) => left.predictedAtMs - right.predictedAtMs);
}

export interface LapsedPattern {
  readonly id: string;
  readonly label: string;
  readonly lastSeenMs: number;
  readonly cyclesMissed: number;
  readonly confidence: number;
}

export interface DetectLapsedPatternsOptions {
  readonly minCyclesMissed?: number;
  readonly minConfidence?: number;
}

const LAPSE_WEEKDAYS: readonly Weekday[] = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const lapseHourBand = (hour: number): string => {
  const start = Math.floor(hour / 3) * 3;
  return `${start}-${start + 3}`;
};

/**
 * CUSUM / change-point detection (Page, "Continuous Inspection Schemes",
 * Biometrika 41:100-115, 1954): a control chart accumulates the deviation of a
 * process from its expected level and signals when that cumulative sum sustains
 * past a control limit — robust to a single off observation, alarming only on a
 * SUSTAINED shift. Applied to the user's established weekly habits (the mirror of
 * `selectFireablePatterns`/`predictUpcomingNeeds`, which find ACTIVE habits):
 * a recurring weekday pattern whose latest occurrence is `minCyclesMissed` or
 * more weekly cycles in the past has LAPSED — a sustained break, not a one-off
 * miss. Returns the lapsed patterns, most-missed first. Pure.
 */
export function detectLapsedPatterns(
  now: Date,
  signals: PatternSignals,
  options: DetectLapsedPatternsOptions = {}
): readonly LapsedPattern[] {
  const minCyclesMissed = Math.max(1, Math.trunc(Number.isFinite(options.minCyclesMissed) ? options.minCyclesMissed! : 2));
  const minConfidence = Number.isFinite(options.minConfidence) ? options.minConfidence! : 0.5;
  const nowMs = now.getTime();
  const cadenceMs = 7 * 86_400_000; // a weekday-specific pattern recurs weekly
  const out: LapsedPattern[] = [];
  for (const match of detectTimeOfDayPatterns(now, signals)) {
    if (match.category !== "time-of-day-action") continue;
    if (match.confidence < minConfidence) continue;
    let lastSeenMs = -Infinity;
    for (const edit of signals.noteEdits) {
      const when = new Date(edit.mtimeMs);
      const family = edit.pathFamily.length > 0 ? edit.pathFamily : "(root)";
      if (LAPSE_WEEKDAYS[when.getDay()] !== match.bucket.weekday) continue;
      if (lapseHourBand(when.getHours()) !== match.bucket.hourBand) continue;
      if (family !== match.bucket.pathFamily) continue;
      if (edit.mtimeMs > lastSeenMs) lastSeenMs = edit.mtimeMs;
    }
    if (!Number.isFinite(lastSeenMs)) continue;
    const cyclesMissed = Math.floor((nowMs - lastSeenMs) / cadenceMs);
    if (cyclesMissed >= minCyclesMissed) {
      out.push({ confidence: match.confidence, cyclesMissed, id: match.id, label: match.suggestion, lastSeenMs });
    }
  }
  return out.sort((left, right) => right.cyclesMissed - left.cyclesMissed);
}
