/**
 * Pure free/busy computation over calendar events — the engine behind
 * the `muse.calendar.availability` tool ("am I free at 3pm?", "find a
 * 30-minute gap this afternoon"). No IO: the caller fetches the events
 * for the window; this merges them into busy blocks and returns the
 * open gaps. Deterministic so it can be exhaustively unit-tested.
 */

import { finiteOr } from "@muse/shared";

export interface AvailabilityEventLike {
  readonly title: string;
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly allDay: boolean;
}

export interface BusyBlock {
  readonly startsAt: Date;
  readonly endsAt: Date;
  /** Titles of the events that make up this merged busy block. */
  readonly titles: readonly string[];
}

export interface FreeSlot {
  readonly startsAt: Date;
  readonly endsAt: Date;
}

export interface AvailabilityResult {
  readonly fullyFree: boolean;
  readonly busy: readonly BusyBlock[];
  readonly free: readonly FreeSlot[];
}

interface ClampedBusy {
  readonly start: number;
  readonly end: number;
  readonly title: string;
}

/**
 * Free/busy within `[window.from, window.to]`. An event counts as busy
 * for the part of it that overlaps the window (clamped); an all-day
 * event blocks its whole span. Overlapping / adjacent busy intervals
 * merge (keeping every contributing title). `free` is the complement —
 * the open gaps — optionally filtered to those at least
 * `minFreeMinutes` long (default 0 = every gap). An invalid window
 * (non-finite, or from >= to) yields `fullyFree: true` with no slots.
 */
export function computeAvailability(
  events: readonly AvailabilityEventLike[],
  window: { readonly from: Date; readonly to: Date },
  options: { readonly minFreeMinutes?: number } = {}
): AvailabilityResult {
  const from = window.from.getTime();
  const to = window.to.getTime();
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) {
    return { busy: [], free: [], fullyFree: true };
  }
  const minFreeMs = Math.max(0, finiteOr(options.minFreeMinutes, 0)) * 60_000;

  const clamped: ClampedBusy[] = [];
  for (const event of events) {
    const start = event.startsAt.getTime();
    const end = event.endsAt.getTime();
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      continue;
    }
    const lo = Math.max(start, from);
    const hi = Math.min(end, to);
    if (hi <= lo) {
      continue;
    }
    clamped.push({ end: hi, start: lo, title: event.title });
  }
  clamped.sort((a, b) => a.start - b.start || a.end - b.end);

  const busy: BusyBlock[] = [];
  for (const block of clamped) {
    const last = busy[busy.length - 1];
    if (last && block.start <= last.endsAt.getTime()) {
      busy[busy.length - 1] = {
        endsAt: new Date(Math.max(last.endsAt.getTime(), block.end)),
        startsAt: last.startsAt,
        titles: [...last.titles, block.title]
      };
    } else {
      busy.push({ endsAt: new Date(block.end), startsAt: new Date(block.start), titles: [block.title] });
    }
  }

  const free: FreeSlot[] = [];
  let cursor = from;
  for (const block of busy) {
    const gap = block.startsAt.getTime() - cursor;
    if (gap >= minFreeMs && gap > 0) {
      free.push({ endsAt: new Date(block.startsAt.getTime()), startsAt: new Date(cursor) });
    }
    cursor = Math.max(cursor, block.endsAt.getTime());
  }
  if (to - cursor >= minFreeMs && to - cursor > 0) {
    free.push({ endsAt: new Date(to), startsAt: new Date(cursor) });
  }

  return { busy, free, fullyFree: busy.length === 0 };
}

