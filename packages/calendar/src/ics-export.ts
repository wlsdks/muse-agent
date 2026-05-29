/**
 * Serialize calendar events to a standard iCalendar (.ics / VCALENDAR) string
 * so the user can take Muse-managed events into any calendar app. Pure: no
 * I/O. Read/export only — the inverse of the CalDAV provider's VEVENT write.
 *
 * Interop parallels the competitors' export/portability affordances
 * (Hermes/OpenClaw); the format is the RFC 5545 standard, not third-party code.
 */

export interface IcsEvent {
  readonly id: string;
  readonly title: string;
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly allDay?: boolean;
  readonly location?: string;
  readonly notes?: string;
}

function escapeText(value: string): string {
  return value
    .replace(/\\/gu, "\\\\")
    .replace(/;/gu, "\\;")
    .replace(/,/gu, "\\,")
    .replace(/\r?\n/gu, "\\n");
}

function utcStamp(date: Date): string {
  return date.toISOString().replace(/[-:]/gu, "").replace(/\.\d{3}/u, "");
}

function dateStamp(date: Date): string {
  return date.toISOString().slice(0, 10).replace(/-/gu, "");
}

/**
 * Build a VCALENDAR with one VEVENT per event. All-day events use
 * `VALUE=DATE`; timed events use UTC `…Z` timestamps. `now` (default a fresh
 * Date) stamps DTSTAMP; inject it for deterministic output. Lines are
 * CRLF-joined per RFC 5545.
 */
export function eventsToIcs(
  events: readonly IcsEvent[],
  options: { readonly now?: Date; readonly prodId?: string } = {}
): string {
  const dtstamp = utcStamp(options.now ?? new Date());
  const prodId = options.prodId ?? "-//Muse//calendar export//EN";
  const lines: string[] = ["BEGIN:VCALENDAR", "VERSION:2.0", `PRODID:${prodId}`, "CALSCALE:GREGORIAN"];
  for (const event of events) {
    lines.push("BEGIN:VEVENT");
    lines.push(`UID:${escapeText(event.id)}@muse`);
    lines.push(`DTSTAMP:${dtstamp}`);
    lines.push(`SUMMARY:${escapeText(event.title)}`);
    if (event.allDay) {
      lines.push(`DTSTART;VALUE=DATE:${dateStamp(event.startsAt)}`);
      lines.push(`DTEND;VALUE=DATE:${dateStamp(event.endsAt)}`);
    } else {
      lines.push(`DTSTART:${utcStamp(event.startsAt)}`);
      lines.push(`DTEND:${utcStamp(event.endsAt)}`);
    }
    if (event.location && event.location.length > 0) lines.push(`LOCATION:${escapeText(event.location)}`);
    if (event.notes && event.notes.length > 0) lines.push(`DESCRIPTION:${escapeText(event.notes)}`);
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return `${lines.join("\r\n")}\r\n`;
}
