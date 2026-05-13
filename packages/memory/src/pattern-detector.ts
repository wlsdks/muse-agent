/**
 * Step 2 of `docs/design/pattern-detection.md` — the
 * time-of-day-action detector (category 1). Pure function over the
 * `PatternSignals` envelope produced by `aggregateActivitySignals`.
 *
 * Heuristic: cluster note-edit signals (`signals.noteEdits`) by
 *   - the weekday the edit landed on,
 *   - a 3-hour band (`0-3 | 3-6 | 6-9 | 9-12 | 12-15 | 15-18 | 18-21 | 21-24`),
 *   - the note's `pathFamily` (first directory segment under
 *     `notesDir`, e.g. `journal` or `meeting-notes`).
 *
 * A cluster fires a `PatternMatch` when:
 *   - the bucket has >= `minMatches` (default 3) total edits,
 *   - those edits span >= `minDistinctDays` (default 2) calendar
 *     days (a one-off mass edit on a single day doesn't count),
 *   - the implied confidence (`matches / observedWeeksForThatWeekday`)
 *     clears the `minConfidence` floor (default 0.4).
 *
 * Stable ids: `tod:<weekday>:<hourBand>:<pathFamily>` hashed with
 * sha256 + truncated to 12 hex chars. Lets dedup / cooldown /
 * veto layers (later iters) key off a single value.
 *
 * No I/O. Deterministic given the envelope + `now()`. The current
 * temporal slot ("are we IN the cluster right now?") is computed
 * from `now`, so callers pass an injectable clock.
 */

import { createHash } from "node:crypto";

import type { NoteMtimeSignal, PatternSignals } from "./pattern-signals.js";

export type PatternMatch = TimeOfDayMatch | WeeklyTaskMatch;

export interface TimeOfDayMatch {
  readonly id: string;
  readonly category: "time-of-day-action";
  readonly confidence: number;
  readonly suggestion: string;
  readonly relatedPaths: readonly string[];
  /** Diagnostic — the cluster's key components, useful when a CLI surfaces "why did this fire?". */
  readonly bucket: {
    readonly weekday: Weekday;
    readonly hourBand: HourBand;
    readonly pathFamily: string;
    readonly matches: number;
    readonly distinctDays: number;
  };
}

export interface WeeklyTaskMatch {
  readonly id: string;
  readonly category: "weekly-task";
  readonly confidence: number;
  readonly suggestion: string;
  /** Example task titles from the cluster (most recent first, capped). */
  readonly relatedTitles: readonly string[];
  /**
   * True when `now`'s ISO-week contains no task whose normalised title
   * matches the cluster's template AND today's weekday is the
   * cluster's matching weekday. The proactive integration step uses
   * this to decide whether to actually fire the suggestion vs. just
   * audit.
   */
  readonly missingThisWeek: boolean;
  readonly bucket: {
    readonly weekday: Weekday;
    readonly titleKey: string;
    /** Human-readable template — the most-recent matching title in raw form. */
    readonly titleTemplate: string;
    readonly matches: number;
    readonly distinctWeeks: number;
  };
}

export type Weekday = "Sun" | "Mon" | "Tue" | "Wed" | "Thu" | "Fri" | "Sat";
export type HourBand = "0-3" | "3-6" | "6-9" | "9-12" | "12-15" | "15-18" | "18-21" | "21-24";

const WEEKDAYS: readonly Weekday[] = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export interface DetectTimeOfDayPatternsOptions {
  readonly minMatches?: number;
  readonly minDistinctDays?: number;
  readonly minConfidence?: number;
  /**
   * When set, only return matches whose bucket also includes the
   * current temporal slot (now's weekday + hour-band).  This is
   * how the proactive integration step gates "fire NOW vs. just
   * audit". Defaults to false — return every cluster regardless
   * of whether it's the active slot.
   */
  readonly currentSlotOnly?: boolean;
}

const DEFAULT_MIN_MATCHES = 3;
const DEFAULT_MIN_DISTINCT_DAYS = 2;
const DEFAULT_MIN_CONFIDENCE = 0.4;

export function detectTimeOfDayPatterns(
  now: Date,
  signals: PatternSignals,
  options: DetectTimeOfDayPatternsOptions = {}
): readonly PatternMatch[] {
  const minMatches = Math.max(1, options.minMatches ?? DEFAULT_MIN_MATCHES);
  const minDistinctDays = Math.max(1, options.minDistinctDays ?? DEFAULT_MIN_DISTINCT_DAYS);
  const minConfidence = options.minConfidence ?? DEFAULT_MIN_CONFIDENCE;

  if (signals.noteEdits.length === 0) {
    return [];
  }

  // Bucket key: `${weekday}|${hourBand}|${pathFamily}`. Empty
  // pathFamily ("root-level note") is folded into a `(root)`
  // pseudo-family so the bucket key stays printable.
  const buckets = new Map<string, BucketState>();
  for (const edit of signals.noteEdits) {
    const date = new Date(edit.mtimeMs);
    const weekday = WEEKDAYS[date.getDay()]!;
    const hourBand = hourBandOf(date.getHours());
    const pathFamily = edit.pathFamily.length > 0 ? edit.pathFamily : "(root)";
    const key = `${weekday}|${hourBand}|${pathFamily}`;
    let state = buckets.get(key);
    if (!state) {
      state = {
        days: new Set<string>(),
        hourBand,
        matches: 0,
        pathFamily,
        relatedPaths: [],
        weekday
      };
      buckets.set(key, state);
    }
    state.matches += 1;
    state.days.add(formatLocalDay(date));
    if (state.relatedPaths.length < 5 && !state.relatedPaths.includes(edit.absPath)) {
      state.relatedPaths.push(edit.absPath);
    }
  }

  const observedWeeks = countObservedWeeks(signals.noteEdits);
  const nowWeekday = WEEKDAYS[now.getDay()]!;
  const nowHourBand = hourBandOf(now.getHours());

  const matches: PatternMatch[] = [];
  for (const state of buckets.values()) {
    if (state.matches < minMatches) continue;
    if (state.days.size < minDistinctDays) continue;
    // Confidence floor: how often did this slot fire across the
    // observed weeks? If we saw 3 edits but only 1 week of data,
    // confidence is 1.0 (it fired every week we observed). With 3
    // edits over 4 weeks, confidence drops to 0.75.
    const denominator = Math.max(state.days.size, observedWeeks);
    const confidence = denominator > 0 ? Math.min(1, state.days.size / denominator) : 0;
    if (confidence < minConfidence) continue;
    if (options.currentSlotOnly === true) {
      if (state.weekday !== nowWeekday || state.hourBand !== nowHourBand) continue;
    }
    matches.push(buildMatch(state, confidence));
  }

  // Newest / strongest first so a downstream cap-to-N keeps the
  // most useful suggestions.
  matches.sort((left, right) => {
    if (right.confidence !== left.confidence) return right.confidence - left.confidence;
    return right.bucket.matches - left.bucket.matches;
  });

  return matches;
}

interface BucketState {
  readonly weekday: Weekday;
  readonly hourBand: HourBand;
  readonly pathFamily: string;
  matches: number;
  readonly days: Set<string>;
  readonly relatedPaths: string[];
}

function buildMatch(state: BucketState, confidence: number): PatternMatch {
  const stableKey = `tod:${state.weekday}:${state.hourBand}:${state.pathFamily}`;
  const id = createHash("sha256").update(stableKey).digest("hex").slice(0, 12);
  const familyLabel = state.pathFamily === "(root)" ? "root-level notes" : `${state.pathFamily} notes`;
  const suggestion = `You usually edit ${familyLabel} around ${state.hourBand} on ${state.weekday}s (${state.matches.toString()} edits across ${state.days.size.toString()} days). Want me to surface the most recent one?`;
  return {
    bucket: {
      distinctDays: state.days.size,
      hourBand: state.hourBand,
      matches: state.matches,
      pathFamily: state.pathFamily,
      weekday: state.weekday
    },
    category: "time-of-day-action",
    confidence,
    id,
    relatedPaths: state.relatedPaths,
    suggestion
  };
}

function hourBandOf(hour: number): HourBand {
  if (hour < 3) return "0-3";
  if (hour < 6) return "3-6";
  if (hour < 9) return "6-9";
  if (hour < 12) return "9-12";
  if (hour < 15) return "12-15";
  if (hour < 18) return "15-18";
  if (hour < 21) return "18-21";
  return "21-24";
}

function formatLocalDay(date: Date): string {
  const year = date.getFullYear().toString().padStart(4, "0");
  const month = (date.getMonth() + 1).toString().padStart(2, "0");
  const day = date.getDate().toString().padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function countObservedWeeks(noteEdits: readonly NoteMtimeSignal[]): number {
  if (noteEdits.length === 0) return 0;
  let oldest = Infinity;
  let newest = -Infinity;
  for (const edit of noteEdits) {
    if (edit.mtimeMs < oldest) oldest = edit.mtimeMs;
    if (edit.mtimeMs > newest) newest = edit.mtimeMs;
  }
  if (!Number.isFinite(oldest) || !Number.isFinite(newest)) return 0;
  const spanMs = newest - oldest;
  const weeks = spanMs / (7 * 24 * 60 * 60_000);
  // Round up — three edits over 4 days still counts as "1 week
  // of observation" rather than 0 (which would zero-divide the
  // confidence calc).
  return Math.max(1, Math.ceil(weeks));
}

/**
 * Weekly-task detector (category 2 of `docs/design/pattern-detection.md`).
 * Same shape as the time-of-day detector but consumes
 * `signals.tasks` (createdAt timestamps + titles) instead of
 * `signals.noteEdits`.
 *
 * Cluster key: `${weekday-of-createdAt}|${normalised-title}`. The
 * normaliser lowercases + collapses whitespace; that's deliberately
 * conservative — "Daily standup" and "daily  standup" cluster, but
 * "Daily standup" vs. "Daily standup notes" do NOT. A fuzzier
 * Jaccard-on-tokens cluster is a future iter; for v0 false-positive
 * avoidance beats recall.
 *
 * `missingThisWeek` is the proactive-fire gate: today's weekday
 * matches the cluster's weekday AND no task in the current ISO week
 * carries the same normalised title. Use `currentSlotOnly: true` at
 * the call site to filter down to only the actionable rows.
 */
export interface DetectWeeklyTaskPatternsOptions {
  readonly minMatches?: number;
  readonly minDistinctWeeks?: number;
  readonly minConfidence?: number;
  /** When true, only return matches whose `missingThisWeek` is true. */
  readonly currentSlotOnly?: boolean;
}

const DEFAULT_WEEKLY_MIN_MATCHES = 3;
const DEFAULT_WEEKLY_MIN_DISTINCT_WEEKS = 2;
const DEFAULT_WEEKLY_MIN_CONFIDENCE = 0.4;

interface WeeklyBucketState {
  readonly weekday: Weekday;
  readonly titleKey: string;
  matches: number;
  readonly distinctWeeks: Set<string>;
  /** Most-recent matching title (raw) used as the human-readable template. */
  template: string;
  templateTsMs: number;
  /** Up to 5 distinct raw titles seen, newest-first. */
  readonly relatedTitles: string[];
}

export function detectWeeklyTaskPatterns(
  now: Date,
  signals: PatternSignals,
  options: DetectWeeklyTaskPatternsOptions = {}
): readonly WeeklyTaskMatch[] {
  const minMatches = Math.max(1, options.minMatches ?? DEFAULT_WEEKLY_MIN_MATCHES);
  const minDistinctWeeks = Math.max(1, options.minDistinctWeeks ?? DEFAULT_WEEKLY_MIN_DISTINCT_WEEKS);
  const minConfidence = options.minConfidence ?? DEFAULT_WEEKLY_MIN_CONFIDENCE;

  if (signals.tasks.length === 0) {
    return [];
  }

  const buckets = new Map<string, WeeklyBucketState>();
  for (const task of signals.tasks) {
    const titleKey = normaliseTaskTitle(task.title);
    if (titleKey.length === 0) continue;
    const date = new Date(task.createdAtMs);
    const weekday = WEEKDAYS[date.getDay()]!;
    const key = `${weekday}|${titleKey}`;
    let state = buckets.get(key);
    if (!state) {
      state = {
        distinctWeeks: new Set<string>(),
        matches: 0,
        relatedTitles: [],
        template: task.title,
        templateTsMs: task.createdAtMs,
        titleKey,
        weekday
      };
      buckets.set(key, state);
    }
    state.matches += 1;
    state.distinctWeeks.add(isoWeekKey(date));
    if (task.createdAtMs > state.templateTsMs) {
      state.template = task.title;
      state.templateTsMs = task.createdAtMs;
    }
    if (state.relatedTitles.length < 5 && !state.relatedTitles.includes(task.title)) {
      state.relatedTitles.push(task.title);
    }
  }

  const observedWeeks = countObservedWeeksFromTasks(signals.tasks);
  const nowWeekday = WEEKDAYS[now.getDay()]!;
  const nowWeek = isoWeekKey(now);

  // For the "missing this week" check, build a set of normalised titles
  // that already exist in the current ISO week so the per-cluster check
  // is a single set lookup.
  const titlesThisWeek = new Set<string>();
  for (const task of signals.tasks) {
    if (isoWeekKey(new Date(task.createdAtMs)) !== nowWeek) continue;
    titlesThisWeek.add(normaliseTaskTitle(task.title));
  }

  const matches: WeeklyTaskMatch[] = [];
  for (const state of buckets.values()) {
    if (state.matches < minMatches) continue;
    if (state.distinctWeeks.size < minDistinctWeeks) continue;
    const denominator = Math.max(state.distinctWeeks.size, observedWeeks);
    const confidence = denominator > 0 ? Math.min(1, state.distinctWeeks.size / denominator) : 0;
    if (confidence < minConfidence) continue;
    const missingThisWeek = state.weekday === nowWeekday && !titlesThisWeek.has(state.titleKey);
    if (options.currentSlotOnly === true && !missingThisWeek) continue;
    matches.push(buildWeeklyTaskMatch(state, confidence, missingThisWeek));
  }

  matches.sort((left, right) => {
    if (right.confidence !== left.confidence) return right.confidence - left.confidence;
    return right.bucket.matches - left.bucket.matches;
  });

  return matches;
}

function buildWeeklyTaskMatch(state: WeeklyBucketState, confidence: number, missingThisWeek: boolean): WeeklyTaskMatch {
  const stableKey = `weekly-task:${state.weekday}:${state.titleKey}`;
  const id = createHash("sha256").update(stableKey).digest("hex").slice(0, 12);
  const verb = missingThisWeek
    ? "You usually create this on ${weekday}s but haven't this week — want me to add it?"
    : "You typically create this on ${weekday}s (cluster spotted, no action needed yet).";
  const suggestion = `"${state.template}" — ${verb.replace("${weekday}", state.weekday)} (${state.matches.toString()} times across ${state.distinctWeeks.size.toString()} weeks).`;
  return {
    bucket: {
      distinctWeeks: state.distinctWeeks.size,
      matches: state.matches,
      titleKey: state.titleKey,
      titleTemplate: state.template,
      weekday: state.weekday
    },
    category: "weekly-task",
    confidence,
    id,
    missingThisWeek,
    relatedTitles: state.relatedTitles,
    suggestion
  };
}

function normaliseTaskTitle(title: string): string {
  // Collapse whitespace, lowercase. Conservative — exact-after-normalise
  // match only. Strip trailing punctuation runs so "Standup notes."
  // clusters with "Standup notes".
  return title
    .toLowerCase()
    .replace(/\s+/gu, " ")
    .replace(/[.,;:!?]+$/u, "")
    .trim();
}

function isoWeekKey(date: Date): string {
  // Anchor on Monday-as-start-of-week to match the design doc's
  // "every Monday morning" intuition. The week key is the date of
  // that week's Monday (local time) as `YYYY-MM-DD`.
  const day = date.getDay(); // 0=Sun, 1=Mon, …
  const offset = day === 0 ? -6 : 1 - day; // Sun shifts back 6 days, others toward Mon.
  const monday = new Date(date.getFullYear(), date.getMonth(), date.getDate() + offset);
  return formatLocalDay(monday);
}

function countObservedWeeksFromTasks(tasks: readonly { readonly createdAtMs: number }[]): number {
  if (tasks.length === 0) return 0;
  let oldest = Infinity;
  let newest = -Infinity;
  for (const task of tasks) {
    if (task.createdAtMs < oldest) oldest = task.createdAtMs;
    if (task.createdAtMs > newest) newest = task.createdAtMs;
  }
  if (!Number.isFinite(oldest) || !Number.isFinite(newest)) return 0;
  const spanMs = newest - oldest;
  const weeks = spanMs / (7 * 24 * 60 * 60_000);
  return Math.max(1, Math.ceil(weeks));
}
