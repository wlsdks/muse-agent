/**
 * Dunbar tie-strength decay — relationship-maintenance nudges from contact
 * TIMESTAMPS only (no message content).
 *
 * Social ties live in concentric layers and decay without contact at a
 * layer-dependent rate (Dunbar 1993; Roberts & Dunbar 2011; Sapiezynski et al.,
 * Sci. Rep. 2022): once the gap since you last spoke runs well past your USUAL
 * cadence with someone, the tie is likely slipping. This computes that per
 * contact — your own typical interval is the personalised baseline, so a friend
 * you normally see weekly flags after a month, while a once-a-year cousin does
 * not flag at month two.
 *
 * Pure + deterministic (no model, no I/O): the caller resolves each contact's
 * interaction timestamps (from calendar events, episodes, …) and passes them in.
 * Privacy-preserving by construction — it only ever sees dates, never content.
 * It never sends anything; it surfaces a gentle "you haven't connected with X in
 * a while" for the user to act on.
 */

const DAY_MS = 24 * 60 * 60_000;
const DEFAULT_OVERDUE_RATIO = 2.5;
const DEFAULT_MIN_INTERACTIONS = 3;
const DEFAULT_MIN_GAP_DAYS = 14;
const DEFAULT_MAX_RESULTS = 10;

export interface ContactInteractions {
  readonly name: string;
  /** Interaction times in epoch ms, any order. */
  readonly timestampsMs: readonly number[];
}

export interface OverdueContact {
  readonly name: string;
  /** Days since the last interaction. */
  readonly gapDays: number;
  /** The contact's usual interval between interactions (median), in days. */
  readonly cadenceDays: number;
  /** gapDays / cadenceDays — how many "normal intervals" overdue. */
  readonly overdueRatio: number;
}

export interface OverdueOptions {
  readonly nowMs: number;
  /** Overdue when the gap exceeds this many times the usual cadence. Default 2.5. */
  readonly overdueRatio?: number;
  /** Minimum interactions needed to estimate a cadence (≥ 2 gaps). Default 3. */
  readonly minInteractions?: number;
  /** Never nudge for a contact seen within this many days, however short their cadence (anti-nag). Default 14. */
  readonly minGapDays?: number;
  /** Cap the list. Default 10. */
  readonly maxResults?: number;
}

/**
 * Tie strength tracks contact OCCASIONS, not message volume (Dunbar): a burst of
 * messages in one conversation is ONE contact, not many. Collapse same-UTC-day
 * timestamps to a single representative (the latest that day) before estimating
 * cadence — otherwise intra-day gaps (~0) drag the median cadence toward zero and
 * over-flag a contact you actually keep up with on a normal weekly rhythm.
 */
function collapseToDailyOccasions(sortedAscending: readonly number[]): number[] {
  const occasions: number[] = [];
  let currentDay = Number.NaN;
  for (const timestamp of sortedAscending) {
    const day = Math.floor(timestamp / DAY_MS);
    if (day !== currentDay) {
      occasions.push(timestamp);
      currentDay = day;
    } else {
      occasions[occasions.length - 1] = timestamp;
    }
  }
  return occasions;
}

function median(sortedAscending: readonly number[]): number {
  const n = sortedAscending.length;
  if (n === 0) {
    return 0;
  }
  const mid = Math.floor(n / 2);
  return n % 2 === 0 ? (sortedAscending[mid - 1]! + sortedAscending[mid]!) / 2 : sortedAscending[mid]!;
}

/**
 * The contacts whose tie is overdue: gap since last interaction > `overdueRatio`
 * × their own usual cadence AND ≥ `minGapDays`. A contact with fewer than
 * `minInteractions` is skipped (no reliable cadence). Ranked most-overdue first.
 */
export function overdueContacts(
  contacts: readonly ContactInteractions[],
  options: OverdueOptions
): readonly OverdueContact[] {
  const ratio = Number.isFinite(options.overdueRatio) ? Math.max(1, options.overdueRatio!) : DEFAULT_OVERDUE_RATIO;
  const minInteractions = Number.isFinite(options.minInteractions) ? Math.max(2, Math.trunc(options.minInteractions!)) : DEFAULT_MIN_INTERACTIONS;
  const minGapDays = Number.isFinite(options.minGapDays) ? Math.max(0, options.minGapDays!) : DEFAULT_MIN_GAP_DAYS;
  const maxResults = Number.isFinite(options.maxResults) ? Math.max(1, Math.trunc(options.maxResults!)) : DEFAULT_MAX_RESULTS;

  const overdue: OverdueContact[] = [];
  for (const contact of contacts) {
    const times = [...contact.timestampsMs].filter((t) => Number.isFinite(t)).sort((a, b) => a - b);
    const occasions = collapseToDailyOccasions(times);
    if (occasions.length < minInteractions) {
      continue;
    }
    const gaps: number[] = [];
    for (let i = 1; i < occasions.length; i++) {
      gaps.push((occasions[i]! - occasions[i - 1]!) / DAY_MS);
    }
    const cadenceDays = median([...gaps].sort((a, b) => a - b));
    if (cadenceDays <= 0) {
      continue;
    }
    const gapDays = (options.nowMs - occasions[occasions.length - 1]!) / DAY_MS;
    const overdueRatio = gapDays / cadenceDays;
    if (gapDays >= minGapDays && overdueRatio > ratio) {
      overdue.push({ cadenceDays, gapDays, name: contact.name, overdueRatio });
    }
  }
  return overdue.sort((a, b) => b.overdueRatio - a.overdueRatio).slice(0, maxResults);
}
