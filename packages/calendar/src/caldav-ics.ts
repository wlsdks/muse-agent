/**
 * iCalendar (ICS) codec for the CalDAV provider — VEVENT render/parse, the
 * CALDAV calendar-query report XML, ICS line folding/unfolding + text
 * escaping, and the timezone-wall-clock ↔ UTC math (TZID, all-day, DATE vs
 * DATE-TIME). Pure (no I/O, no HTTP), split out of caldav-provider.ts so the
 * CalDAV HTTP protocol class and the ICS serialization have separate homes.
 */

import { randomUUID } from "node:crypto";

import type { CalendarEvent, CalendarEventInput, CalendarRange } from "./types.js";

export function renderCalendarQueryReport(range: CalendarRange): string {
  return `<?xml version="1.0" encoding="utf-8" ?>
<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:prop>
    <D:getetag/>
    <C:calendar-data/>
  </D:prop>
  <C:filter>
    <C:comp-filter name="VCALENDAR">
      <C:comp-filter name="VEVENT">
        <C:time-range start="${formatIcsTime(range.from)}" end="${formatIcsTime(range.to)}"/>
      </C:comp-filter>
    </C:comp-filter>
  </C:filter>
</C:calendar-query>`;
}

export function renderVEvent(uid: string, input: CalendarEventInput): string {
  const now = new Date();
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Muse//Muse Calendar 1.0//EN",
    "BEGIN:VEVENT",
    `UID:${escapeIcsText(uid)}`,
    `DTSTAMP:${formatIcsTime(now)}`,
    `SUMMARY:${escapeIcsText(input.title)}`,
    input.allDay
      ? `DTSTART;VALUE=DATE:${formatIcsDate(input.startsAt)}`
      : `DTSTART:${formatIcsTime(input.startsAt)}`,
    input.allDay
      ? `DTEND;VALUE=DATE:${formatIcsDate(input.endsAt)}`
      : `DTEND:${formatIcsTime(input.endsAt)}`,
    input.location ? `LOCATION:${escapeIcsText(input.location)}` : null,
    input.notes ? `DESCRIPTION:${escapeIcsText(input.notes)}` : null,
    "END:VEVENT",
    "END:VCALENDAR"
  ].filter((line): line is string => Boolean(line));

  return `${lines.join("\r\n")}\r\n`;
}

export function parseCalendarQueryResponse(xml: string, providerId: string, baseUrl: string): readonly CalendarEvent[] {
  const responses = xml.match(/<(?:D:)?response[\s\S]*?<\/(?:D:)?response>/giu) ?? [];
  return responses.flatMap((entry): readonly CalendarEvent[] => {
    const href = entry.match(/<(?:D:)?href>([\s\S]*?)<\/(?:D:)?href>/iu)?.[1]?.trim();
    const data = entry.match(/<(?:C:)?calendar-data[^>]*>([\s\S]*?)<\/(?:C:)?calendar-data>/iu)?.[1] ?? "";
    if (!data || !href) {
      return [];
    }

    const decoded = decodeXmlText(data);
    const event = parseVEvent(decoded, providerId, hrefToId(href, baseUrl));
    return event ? [event] : [];
  });
}

// RFC 5545 §3.1: a content line longer than 75 octets is folded
// by inserting CRLF + a single space/tab; a parser MUST delete
// that exact pair before reading properties, or a long
// SUMMARY/LOCATION/DESCRIPTION is truncated at the fold. Lenient
// to bare-LF folds — some CalDAV servers omit the CR.
function unfoldIcs(ics: string): string {
  return ics.replace(/\r\n[ \t]/gu, "").replace(/\n[ \t]/gu, "");
}

export function parseVEvent(rawIcs: string, providerId: string, fallbackId: string): CalendarEvent | undefined {
  const unfolded = unfoldIcs(rawIcs);
  // Match properties within the VEVENT body only. A VCALENDAR for a
  // TZID-qualified event carries a VTIMEZONE whose STANDARD/DAYLIGHT
  // DTSTART (a DST-rule date) precedes the VEVENT — a whole-string
  // first-match would read that as the event's start.
  const ics = /BEGIN:VEVENT\r?\n([\s\S]*?)\r?\nEND:VEVENT/u.exec(unfolded)?.[1] ?? unfolded;
  const summary = matchIcs(ics, "SUMMARY");
  const dtstart = matchIcsLine(ics, "DTSTART");
  const dtend = matchIcsLine(ics, "DTEND");
  const uid = matchIcs(ics, "UID");
  const location = matchIcs(ics, "LOCATION");
  const description = matchIcs(ics, "DESCRIPTION");
  const rrule = matchIcsLine(ics, "RRULE")?.value;

  if (!summary || !dtstart) {
    return undefined;
  }

  const allDay = dtstart.params.includes("VALUE=DATE");
  const startsAt = parseIcsTime(dtstart.value, allDay, icsTzid(dtstart.params));
  const endsAt = dtend
    ? parseIcsTime(dtend.value, allDay, icsTzid(dtend.params))
    : startsAt;

  if (!startsAt || !endsAt) {
    return undefined;
  }

  return {
    allDay,
    endsAt,
    id: uid ?? fallbackId,
    providerId,
    startsAt,
    title: summary,
    ...(location ? { location } : {}),
    ...(description ? { notes: description } : {}),
    ...(rrule ? { recurrence: rrule } : {})
  };
}

function matchIcs(ics: string, key: string): string | undefined {
  const line = matchIcsLine(ics, key);
  return line ? unescapeIcsText(line.value) : undefined;
}

function matchIcsLine(ics: string, key: string): { readonly value: string; readonly params: string } | undefined {
  const re = new RegExp(`(^|\\r?\\n)${key}([^:\\r\\n]*):([^\\r\\n]*)`, "u");
  const match = ics.match(re);
  if (!match) {
    return undefined;
  }
  return { params: match[2] ?? "", value: match[3] ?? "" };
}

function escapeIcsText(value: string): string {
  return value
    .replace(/\\/gu, "\\\\")
    .replace(/\n/gu, "\\n")
    .replace(/,/gu, "\\,")
    .replace(/;/gu, "\\;");
}

function unescapeIcsText(value: string): string {
  return value
    .replace(/\\n/giu, "\n")
    .replace(/\\,/gu, ",")
    .replace(/\\;/gu, ";")
    .replace(/\\\\/gu, "\\");
}

function formatIcsTime(value: Date): string {
  return value.toISOString().replace(/[-:]/gu, "").replace(/\.\d{3}Z$/u, "Z");
}

function formatIcsDate(value: Date): string {
  return value.toISOString().slice(0, 10).replace(/-/gu, "");
}

function parseIcsTime(value: string, allDay: boolean, timeZone?: string): Date | undefined {
  if (allDay && /^\d{8}$/u.test(value)) {
    const year = value.slice(0, 4);
    const month = value.slice(4, 6);
    const day = value.slice(6, 8);
    const parsed = new Date(`${year}-${month}-${day}T00:00:00Z`);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed;
  }

  const match = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/u);
  if (!match) {
    return undefined;
  }
  const [, year, month, day, hour, minute, second, zulu] = match;
  if (zulu !== "Z" && timeZone) {
    const ms = zonedWallTimeToUtcMs(
      Number(year), Number(month), Number(day),
      Number(hour), Number(minute), Number(second),
      timeZone
    );
    // Unknown / invalid TZID → fall through to the floating (local)
    // parse rather than dropping the whole event.
    if (ms !== undefined) {
      return new Date(ms);
    }
  }
  const iso = `${year}-${month}-${day}T${hour}:${minute}:${second}${zulu === "Z" ? "Z" : ""}`;
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

/**
 * The UTC offset (ms) the named IANA zone is at for a given UTC
 * instant. Returns undefined for an invalid zone (Intl throws).
 */
function zoneOffsetMsAt(utcMs: number, timeZone: string): number | undefined {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      day: "2-digit",
      hour: "2-digit",
      hourCycle: "h23",
      minute: "2-digit",
      month: "2-digit",
      second: "2-digit",
      timeZone,
      year: "numeric"
    }).formatToParts(new Date(utcMs));
  } catch {
    return undefined;
  }
  const get = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value);
  const asUtc = Date.UTC(
    get("year"), get("month") - 1, get("day"),
    get("hour"), get("minute"), get("second")
  );
  return asUtc - utcMs;
}

/**
 * Convert a wall-clock time *in `timeZone`* to a UTC epoch-ms.
 * Two passes so a DST offset change between the naive guess and the
 * true instant is corrected (the standard Intl technique — a
 * single pass is wrong by an hour around transitions).
 */
function zonedWallTimeToUtcMs(
  year: number, month: number, day: number,
  hour: number, minute: number, second: number,
  timeZone: string
): number | undefined {
  const guess = Date.UTC(year, month - 1, day, hour, minute, second);
  if (Number.isNaN(guess)) {
    return undefined;
  }
  const o1 = zoneOffsetMsAt(guess, timeZone);
  if (o1 === undefined) {
    return undefined;
  }
  const o2 = zoneOffsetMsAt(guess - o1, timeZone);
  return guess - (o2 ?? o1);
}

function icsTzid(params: string): string | undefined {
  const match = params.match(/;TZID=([^;:]+)/u);
  return match?.[1]?.trim() || undefined;
}

function hrefToId(href: string, baseUrl: string): string {
  const trimmed = href.trim();
  const stripped = trimmed.startsWith(baseUrl) ? trimmed.slice(baseUrl.length) : trimmed.split("/").pop() ?? trimmed;
  return stripped.replace(/\.ics$/u, "") || randomUUID();
}

function decodeXmlText(value: string): string {
  return value
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&amp;/gu, "&")
    .replace(/&quot;/gu, "\"");
}
