/**
 * Earned proactivity — a persistence detector so Muse only speaks up unasked
 * when a theme has genuinely EARNED it.
 *
 * The coherent type-1 feed-forward loop (Mangan & Alon, J. Mol. Biol. 2003) is
 * how a cell filters noise: a master regulator X turns on both an intermediate Y
 * and an output Z, but Z ALSO needs Y — and Y takes time to accumulate, so Z only
 * fires after X has been PERSISTENTLY on. A brief flicker of X never reaches the
 * output. Here X = a theme appearing in your data; the output (a proactive nudge)
 * fires only once the theme has persisted: seen across ≥ minSources independent
 * sources, ≥ minOccurrences times, spanning ≥ minDwellDays, and still active. A
 * single fleeting mention is filtered as noise.
 *
 * This is the deterministic gate behind the "earned proactivity is the north
 * star" line — it decides WHEN it's earned, never WHAT to say (the grounding
 * floor still governs the message). Pure: the caller resolves theme occurrences
 * (from notes / calendar / recent queries) and passes them in.
 */

const DAY_MS = 24 * 60 * 60_000;
const DEFAULT_MIN_SOURCES = 2;
const DEFAULT_MIN_OCCURRENCES = 3;
const DEFAULT_MIN_DWELL_DAYS = 2;
const DEFAULT_ACTIVE_WITHIN_DAYS = 14;
const DEFAULT_MAX_RESULTS = 10;

export interface ThemeOccurrence {
  /** Which source surfaced the theme: a note path, "calendar", "query", … */
  readonly source: string;
  readonly atMs: number;
}

export interface ThemeSignal {
  readonly theme: string;
  readonly occurrences: readonly ThemeOccurrence[];
}

export interface EarnedTheme {
  readonly theme: string;
  readonly occurrences: number;
  readonly distinctSources: number;
  /** Span from first to last occurrence, in days. */
  readonly dwellDays: number;
  /** Days since the most recent occurrence. */
  readonly recencyDays: number;
}

export interface EarnedProactivityOptions {
  readonly nowMs: number;
  /** Distinct sources the theme must appear in (cross-source corroboration). Default 2. */
  readonly minSources?: number;
  /** Total occurrences required. Default 3. */
  readonly minOccurrences?: number;
  /** Minimum first→last span — a single-day burst is not "sustained". Default 2 days. */
  readonly minDwellDays?: number;
  /** The last occurrence must be within this many days (still current). Default 14. */
  readonly activeWithinDays?: number;
  readonly maxResults?: number;
}

/**
 * The themes that have EARNED a proactive nudge: persistent (≥ minOccurrences
 * across ≥ minSources, spanning ≥ minDwellDays) AND still active (last seen
 * within activeWithinDays). A fleeting single mention is filtered. Ranked by
 * dwell × sources (the most-established first).
 */
export function selectEarnedThemes(
  themes: readonly ThemeSignal[],
  options: EarnedProactivityOptions
): readonly EarnedTheme[] {
  const minSources = Number.isFinite(options.minSources) ? Math.max(1, Math.trunc(options.minSources!)) : DEFAULT_MIN_SOURCES;
  const minOccurrences = Number.isFinite(options.minOccurrences) ? Math.max(1, Math.trunc(options.minOccurrences!)) : DEFAULT_MIN_OCCURRENCES;
  const minDwellDays = Number.isFinite(options.minDwellDays) ? Math.max(0, options.minDwellDays!) : DEFAULT_MIN_DWELL_DAYS;
  const activeWithinDays = Number.isFinite(options.activeWithinDays) ? Math.max(0, options.activeWithinDays!) : DEFAULT_ACTIVE_WITHIN_DAYS;
  const maxResults = Number.isFinite(options.maxResults) ? Math.max(1, Math.trunc(options.maxResults!)) : DEFAULT_MAX_RESULTS;

  const earned: EarnedTheme[] = [];
  for (const signal of themes) {
    // Persistence is accumulated PAST recurrence. A future-dated occurrence (an
    // upcoming calendar event) is a plan, not evidence the theme has persisted —
    // counting it would push recencyDays negative (a stale theme falsely reads
    // "just seen", resurrecting it) and inflate the dwell span. Score only what
    // has actually happened (atMs <= now).
    const past = signal.occurrences.filter((o) => Number.isFinite(o.atMs) && o.atMs <= options.nowMs);
    const times = past.map((o) => o.atMs);
    if (times.length < minOccurrences) {
      continue;
    }
    const distinctSources = new Set(past.map((o) => o.source.trim()).filter((s) => s.length > 0)).size;
    if (distinctSources < minSources) {
      continue;
    }
    const first = Math.min(...times);
    const last = Math.max(...times);
    const dwellDays = (last - first) / DAY_MS;
    const recencyDays = (options.nowMs - last) / DAY_MS;
    if (dwellDays >= minDwellDays && recencyDays <= activeWithinDays) {
      earned.push({ distinctSources, dwellDays, occurrences: times.length, recencyDays, theme: signal.theme });
    }
  }
  return earned
    .sort((a, b) => b.dwellDays * b.distinctSources - a.dwellDays * a.distinctSources)
    .slice(0, maxResults);
}
