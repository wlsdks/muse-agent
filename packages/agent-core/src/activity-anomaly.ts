/**
 * Activity anomaly — "your most unusual day, measured against your OWN history."
 *
 * Robust point-anomaly detection via the modified z-score: median + MAD (median
 * absolute deviation), Iglewicz & Hoaglin (1993). Unlike a mean/standard-deviation
 * z-score, the median and MAD are not dragged around by the very outliers we're
 * hunting, so a single huge day can't hide itself by inflating the spread. This
 * is the deterministic per-day cousin of Matrix-Profile subsequence discords (Lu
 * et al., SIGKDD 2022) — same idea ("most unlike the rest"), one number per day.
 *
 * Pure + deterministic: the caller buckets timestamps into per-day counts
 * (`dailyCounts`) and passes them in. Flags BOTH unusually-high and unusually-low
 * days (a day you wrote 5× less than usual is as informative as a spike).
 */

import { median } from "./median.js";

const DAY_MS = 24 * 60 * 60_000;
const MODZ_CONST = 0.6745; // 0.75th quantile of the standard normal — makes MAD a consistent sd estimator
const DEFAULT_THRESHOLD = 3.5; // Iglewicz-Hoaglin recommended cutoff
const DEFAULT_MIN_DAYS = 7;
const DEFAULT_MAX_RESULTS = 5;

export interface DayCount {
  /** Local calendar day, "YYYY-MM-DD". */
  readonly date: string;
  readonly count: number;
}

export interface DayAnomaly {
  readonly date: string;
  readonly count: number;
  readonly median: number;
  /** Modified z-score (sign carries direction). */
  readonly modZScore: number;
  readonly direction: "high" | "low";
}

export interface AnomalyOptions {
  /** |modified z| above this is an anomaly. Default 3.5. */
  readonly threshold?: number;
  /** Need at least this many days of history. Default 7. */
  readonly minDays?: number;
  readonly maxResults?: number;
}

/**
 * Bucket epoch-ms timestamps into per-day counts (UTC day), zero-filling the gap
 * days between the first and last so an unusually QUIET day is detectable too.
 */
export function dailyCounts(timestampsMs: readonly number[]): DayCount[] {
  const valid = timestampsMs.filter((t) => Number.isFinite(t)).sort((a, b) => a - b);
  if (valid.length === 0) {
    return [];
  }
  const dayKey = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
  const counts = new Map<string, number>();
  for (const ms of valid) {
    const key = dayKey(ms);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const out: DayCount[] = [];
  const startDay = Math.floor(valid[0]! / DAY_MS) * DAY_MS;
  const endDay = Math.floor(valid[valid.length - 1]! / DAY_MS) * DAY_MS;
  for (let day = startDay; day <= endDay; day += DAY_MS) {
    const key = dayKey(day);
    out.push({ count: counts.get(key) ?? 0, date: key });
  }
  return out;
}

/**
 * The most anomalous days vs the user's own history, ranked by |modified z|.
 * Returns [] when there's too little history or no spread (every day alike).
 */
export function mostAnomalousDays(days: readonly DayCount[], options: AnomalyOptions = {}): readonly DayAnomaly[] {
  const threshold = Number.isFinite(options.threshold) ? Math.max(0, options.threshold!) : DEFAULT_THRESHOLD;
  const minDays = Number.isFinite(options.minDays) ? Math.max(2, Math.trunc(options.minDays!)) : DEFAULT_MIN_DAYS;
  const maxResults = Number.isFinite(options.maxResults) ? Math.max(1, Math.trunc(options.maxResults!)) : DEFAULT_MAX_RESULTS;
  if (days.length < minDays) {
    return [];
  }
  const values = days.map((day) => day.count);
  const med = median([...values].sort((a, b) => a - b));
  const deviations = values.map((value) => Math.abs(value - med));
  let scale = median([...deviations].sort((a, b) => a - b)) / MODZ_CONST; // MAD → sd estimate
  if (scale === 0) {
    // No MAD spread (>half the days share one value): fall back to mean absolute
    // deviation so a sparse-but-bursty series still has a usable scale.
    const meanAbsDev = deviations.reduce((sum, d) => sum + d, 0) / deviations.length;
    scale = meanAbsDev / 0.7979; // E|N(0,1)| = 0.7979
  }
  if (scale === 0) {
    return []; // genuinely no spread — every day identical
  }
  return days
    .map((day) => {
      const modZScore = (day.count - med) / scale;
      return { count: day.count, date: day.date, direction: modZScore >= 0 ? ("high" as const) : ("low" as const), median: med, modZScore };
    })
    .filter((day) => Math.abs(day.modZScore) > threshold)
    .sort((a, b) => Math.abs(b.modZScore) - Math.abs(a.modZScore))
    .slice(0, maxResults);
}
