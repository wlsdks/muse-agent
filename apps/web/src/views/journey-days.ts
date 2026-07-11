export interface JourneyDayGroup<T> {
  readonly day: string;
  readonly events: readonly T[];
}

/**
 * Group already-sorted (newest-first) journey events into day buckets for the
 * console's date-header layout. Order-preserving, not a re-sort: a day that
 * reappears non-consecutively (a filter change, an unusual merge order) opens
 * a second bucket rather than being folded back into the first — the buckets
 * always render in the same order the events arrived in. Pure.
 */
export function groupJourneyEventsByDay<T extends { readonly at: string }>(events: readonly T[]): readonly JourneyDayGroup<T>[] {
  const groups: { day: string; events: T[] }[] = [];
  for (const event of events) {
    const day = event.at.slice(0, 10);
    const last = groups[groups.length - 1];
    if (last && last.day === day) {
      last.events.push(event);
    } else {
      groups.push({ day, events: [event] });
    }
  }
  return groups;
}
