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

export interface UpcomingConflictNotice {
  /** Stable per-pair key for cross-tick dedup (same clash never re-notified). */
  readonly key: string;
  /** Human-readable warning line, times in the SERVER's local timezone. */
  readonly line: string;
  /** When the overlap begins — used to order notices soonest-first. */
  readonly startsAt: Date;
}

function fmtConflictTime(d: Date): string {
  return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
}

function fmtConflictDay(d: Date): string {
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

function conflictKey(c: CalendarConflict): string {
  return `${c.a.title}@${c.a.startsAt.toISOString()}|${c.b.title}@${c.b.startsAt.toISOString()}`;
}

function formatConflictLine(c: CalendarConflict): string {
  const day = fmtConflictDay(c.a.startsAt);
  return `${day}: "${c.a.title}" (${fmtConflictTime(c.a.startsAt)}–${fmtConflictTime(c.a.endsAt)}) overlaps "${c.b.title}" (${fmtConflictTime(c.b.startsAt)}–${fmtConflictTime(c.b.endsAt)})`;
}

/**
 * The proactive-notice layer over {@link detectCalendarConflicts}: the
 * double-bookings whose overlap begins in the FUTURE window `[now, now +
 * withinDays]`. A clash already underway/past is excluded (you can't un-book
 * the past — nagging about it is noise); only upcoming clashes are surfaced so
 * the daemon can warn you about a Friday double-booking on Wednesday. Each
 * notice carries a stable dedup `key` (so a standing clash notifies ONCE across
 * ticks) and a local-time `line`. Pure: no I/O, no model. Soonest-first.
 */
export function selectUpcomingConflicts(
  events: readonly ConflictEventLike[],
  options: { readonly now: Date; readonly withinDays?: number }
): readonly UpcomingConflictNotice[] {
  const nowMs = options.now.getTime();
  const within = Math.max(1, Math.trunc(options.withinDays ?? 7));
  const horizonMs = nowMs + within * 86_400_000;
  const out: UpcomingConflictNotice[] = [];
  for (const c of detectCalendarConflicts(events)) {
    const overlapStartMs = c.overlapStartsAt.getTime();
    if (overlapStartMs < nowMs || overlapStartMs > horizonMs) continue;
    out.push({ key: conflictKey(c), line: formatConflictLine(c), startsAt: c.overlapStartsAt });
  }
  return out.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
}
