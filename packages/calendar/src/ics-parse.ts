/**
 * Parse a whole iCalendar (`.ics`) document into CalendarEvents.
 *
 * A real beachhead user exports their calendar to a local `.ics` file
 * (Google/Apple "export"), so Muse can read it WITHOUT any cloud/CalDAV
 * round-trip. This splits the VCALENDAR into its VEVENT blocks and reuses the
 * proven CalDAV `parseVEvent` for each (UID/SUMMARY/DTSTART/DTEND, all-day,
 * TZID). Tolerant: a malformed VEVENT is skipped, never throwing.
 */
import { parseVEvent } from "./caldav-provider.js";
import type { CalendarEvent } from "./types.js";

/** Every VEVENT in `icsText` as a CalendarEvent, sorted by start; bad ones skipped. */
export function parseIcsCalendar(icsText: string, providerId: string): readonly CalendarEvent[] {
  const blocks = icsText.match(/BEGIN:VEVENT[\s\S]*?END:VEVENT/gu) ?? [];
  return blocks
    .map((block, index) => parseVEvent(block, providerId, `${providerId}-${index.toString()}`))
    .filter((event): event is CalendarEvent => event !== undefined)
    .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
}
