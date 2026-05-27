/**
 * Pure double-booking detection over calendar events — the anticipation
 * counterpart to `calendar-availability.ts`. Where availability MERGES
 * overlapping events into busy blocks (hiding a clash), this REPORTS each
 * overlapping pair so Muse can warn "3pm review overlaps your 3:30pm call".
 *
 * Back-to-back events (one ends exactly when the next starts) are NOT a
 * conflict. Zero/negative-duration and unparseable-time events are skipped.
 */

export interface ConflictEventLike {
  readonly title: string;
  readonly startsAt: Date;
  readonly endsAt: Date;
}

export interface CalendarConflict {
  readonly a: ConflictEventLike;
  readonly b: ConflictEventLike;
  /** The overlapping span [overlapStartsAt, overlapEndsAt) — always positive. */
  readonly overlapStartsAt: Date;
  readonly overlapEndsAt: Date;
}

/**
 * Every pair of events whose time spans overlap with positive duration.
 * Events are sorted by start; for each, later events are checked until one
 * starts at/after this event's end (sorted ⇒ no later event can overlap it).
 * O(n·k) where k is the local clash fan-out — fine for personal calendars.
 */
export function detectCalendarConflicts(events: readonly ConflictEventLike[]): CalendarConflict[] {
  const valid = events.filter((e) => {
    const s = e.startsAt.getTime();
    const t = e.endsAt.getTime();
    return Number.isFinite(s) && Number.isFinite(t) && t > s;
  });
  const sorted = [...valid].sort((a, b) =>
    a.startsAt.getTime() - b.startsAt.getTime() || a.endsAt.getTime() - b.endsAt.getTime()
  );
  const conflicts: CalendarConflict[] = [];
  for (let i = 0; i < sorted.length; i += 1) {
    const a = sorted[i]!;
    const aEnd = a.endsAt.getTime();
    for (let j = i + 1; j < sorted.length; j += 1) {
      const b = sorted[j]!;
      const bStart = b.startsAt.getTime();
      // Sorted by start: once b begins at/after a ends, no later event overlaps a.
      if (bStart >= aEnd) break;
      const overlapStart = bStart; // b starts at/after a (sorted)
      const overlapEnd = Math.min(aEnd, b.endsAt.getTime());
      if (overlapEnd > overlapStart) {
        conflicts.push({
          a,
          b,
          overlapStartsAt: new Date(overlapStart),
          overlapEndsAt: new Date(overlapEnd)
        });
      }
    }
  }
  return conflicts;
}
