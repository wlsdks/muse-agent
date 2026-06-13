import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";

import { CalendarProviderError, CALENDAR_RETRY_AFTER_CAP_MS, isRetryableCalendarStatus, parseRetryAfterMs } from "./errors.js";
import type {
  CalendarEvent,
  CalendarEventInput,
  CalendarEventUpdate,
  CalendarProvider,
  CalendarProviderInfo,
  CalendarRange,
  CredentialRequirement
} from "./types.js";

interface CalDAVRetryOptions {
  /**
   * Extra attempts after the first. Bounds the idempotent events read (429/5xx)
   * AND a write's 429-only rate-limit retry (a write 5xx is never retried). Default 2.
   */
  readonly retries?: number;
  /** First backoff in ms; doubles each retry. Default 250. */
  readonly baseDelayMs?: number;
  /** Injectable delay so tests don't wait on real timers. */
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface CalDAVCalendarProviderOptions {
  readonly url: string;
  readonly username: string;
  readonly password: string;
  readonly fetchImpl?: typeof fetch;
  readonly retry?: CalDAVRetryOptions;
}

const credentialRequirements: readonly CredentialRequirement[] = [
  {
    description: "CalDAV calendar URL (e.g. https://caldav.icloud.com/<user-id>/calendars/home/)",
    key: "url",
    label: "CalDAV URL",
    secret: false
  },
  { description: "Account username (typically email)", key: "username", label: "Username", secret: false },
  {
    description: "App-specific password (iCloud / Fastmail / Proton issue these from account settings)",
    key: "password",
    label: "App password",
    secret: true
  }
];

/**
 * Minimal CalDAV adapter built directly on `fetch` — no `tsdav` /
 * `ical.js` dependency. Covers the four operations the agent needs:
 *
 *   - listEvents: REPORT calendar-query with VEVENT time-range.
 *     Parses returned VCALENDAR blocks into `CalendarEvent`s.
 *   - createEvent / updateEvent: PUT a VCALENDAR/VEVENT to
 *     `<url>/<uid>.ics`.
 *   - deleteEvent: DELETE the same path.
 *
 * Works against iCloud, Fastmail, Proton, and any compliant CalDAV
 * server. iCloud requires an app-specific password — the CLI wizard
 * tells the user where to issue one.
 */
export class CalDAVCalendarProvider implements CalendarProvider {
  readonly id = "caldav";
  private readonly url: string;
  private readonly authHeader: string;
  private readonly fetchImpl: typeof fetch;
  private readonly retries: number;
  private readonly baseDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: CalDAVCalendarProviderOptions) {
    this.url = options.url.endsWith("/") ? options.url : `${options.url}/`;
    this.authHeader = `Basic ${Buffer.from(`${options.username}:${options.password}`).toString("base64")}`;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.retries = Number.isFinite(options.retry?.retries) ? Math.max(0, Math.trunc(options.retry!.retries!)) : 2;
    this.baseDelayMs = Number.isFinite(options.retry?.baseDelayMs) ? Math.max(0, options.retry!.baseDelayMs!) : 250;
    this.sleep = options.retry?.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  }

  describe(): CalendarProviderInfo {
    return {
      credentials: credentialRequirements,
      description: "CalDAV calendar (iCloud / Fastmail / Proton / generic).",
      displayName: "CalDAV",
      id: this.id,
      local: false
    };
  }

  async listEvents(range: CalendarRange): Promise<readonly CalendarEvent[]> {
    const body = renderCalendarQueryReport(range);
    // Retry transient 429/5xx (and network rejects) on the idempotent
    // REPORT read so a flaky moment doesn't drop the calendar from the
    // briefing. Writes (PUT/DELETE) are never retried — a retried
    // mutation could double-create / double-delete an event.
    for (let attempt = 0; ; attempt += 1) {
      let response: Response;
      try {
        response = await this.fetchImpl(this.url, {
          body,
          headers: this.headers({ depth: "1", contentType: 'application/xml; charset="utf-8"' }),
          method: "REPORT"
        });
      } catch (cause) {
        if (attempt < this.retries) {
          await this.sleep(this.baseDelayMs * 2 ** attempt);
          continue;
        }
        throw cause;
      }

      if (!response.ok) {
        if (attempt < this.retries && isRetryableCalendarStatus(response.status)) {
          await this.sleep(this.baseDelayMs * 2 ** attempt);
          continue;
        }
        throw new CalendarProviderError(this.id, `HTTP_${response.status}`, await this.errorText(response), undefined, response.status);
      }

      const xml = await response.text();
      return parseCalendarQueryResponse(xml, this.id, this.url);
    }
  }

  async createEvent(input: CalendarEventInput): Promise<CalendarEvent> {
    const uid = `cal_${randomUUID()}`;
    const ics = renderVEvent(uid, input);
    const href = `${this.url}${uid}.ics`;

    const response = await this.writeWithRetry(href, {
      body: ics,
      headers: this.headers({ contentType: "text/calendar; charset=utf-8" }),
      method: "PUT"
    });

    if (!response.ok) {
      throw new CalendarProviderError(this.id, `HTTP_${response.status}`, await this.errorText(response), undefined, response.status);
    }

    return {
      allDay: input.allDay ?? false,
      endsAt: input.endsAt,
      id: uid,
      providerId: this.id,
      startsAt: input.startsAt,
      title: input.title,
      ...(input.location ? { location: input.location } : {}),
      ...(input.notes ? { notes: input.notes } : {}),
      ...(input.tags && input.tags.length > 0 ? { tags: [...input.tags] } : {})
    };
  }

  async updateEvent(id: string, input: CalendarEventUpdate): Promise<CalendarEvent> {
    const events = await this.listEvents({
      from: new Date(0),
      to: new Date(Date.now() + 365 * 86_400_000)
    });
    const existing = events.find((event) => event.id === id);

    if (!existing) {
      throw new CalendarProviderError(this.id, "EVENT_NOT_FOUND", `CalDAV event not found: ${id}`);
    }

    const merged: CalendarEventInput = {
      allDay: input.allDay ?? existing.allDay,
      endsAt: input.endsAt ?? existing.endsAt,
      startsAt: input.startsAt ?? existing.startsAt,
      title: input.title ?? existing.title,
      ...(applyOptional(existing.location, input.location) ? { location: applyOptional(existing.location, input.location)! } : {}),
      ...(applyOptional(existing.notes, input.notes) ? { notes: applyOptional(existing.notes, input.notes)! } : {})
    };

    const ics = renderVEvent(id, merged);
    const href = `${this.url}${id}.ics`;
    const response = await this.writeWithRetry(href, {
      body: ics,
      headers: this.headers({ contentType: "text/calendar; charset=utf-8" }),
      method: "PUT"
    });

    if (!response.ok) {
      throw new CalendarProviderError(this.id, `HTTP_${response.status}`, await this.errorText(response), undefined, response.status);
    }

    return { ...existing, ...merged, id, providerId: this.id };
  }

  async deleteEvent(id: string): Promise<void> {
    const response = await this.writeWithRetry(`${this.url}${id}.ics`, {
      headers: this.headers({}),
      method: "DELETE"
    });

    if (!response.ok && response.status !== 404) {
      throw new CalendarProviderError(this.id, `HTTP_${response.status}`, await this.errorText(response), undefined, response.status);
    }
  }

  /**
   * A CalDAV WRITE (PUT create/update, DELETE) is non-idempotent at the protocol
   * level, so it retries ONLY a 429 rate-limit — iCloud / Fastmail reject it
   * BEFORE applying the mutation, so a retry can't double-create or double-delete
   * — honouring Retry-After (capped). A write 5xx or a network reject is AMBIGUOUS
   * (it may have committed) and is NEVER retried. Same safe-write rule as the
   * Google adapter; the idempotent listEvents REPORT keeps its own 429/5xx retry.
   */
  private async writeWithRetry(href: string, init: RequestInit): Promise<Response> {
    for (let attempt = 0; ; attempt += 1) {
      const response = await this.fetchImpl(href, init);
      if (response.status === 429 && attempt < this.retries) {
        const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"), Date.now());
        await this.sleep(retryAfterMs !== undefined ? Math.min(retryAfterMs, CALENDAR_RETRY_AFTER_CAP_MS) : this.baseDelayMs * 2 ** attempt);
        continue;
      }
      return response;
    }
  }

  private headers(extras: { readonly depth?: string; readonly contentType?: string }): Record<string, string> {
    const headers: Record<string, string> = { authorization: this.authHeader };
    if (extras.depth) {
      headers.depth = extras.depth;
    }
    if (extras.contentType) {
      headers["content-type"] = extras.contentType;
    }
    return headers;
  }

  private async errorText(response: Response): Promise<string> {
    const text = await response.text().catch(() => "");
    return `CalDAV ${response.status}: ${text}`.slice(0, 500);
  }
}

function applyOptional(existing: string | undefined, next: string | null | undefined): string | undefined {
  if (next === null) {
    return undefined;
  }
  return next ?? existing;
}

function renderCalendarQueryReport(range: CalendarRange): string {
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

function renderVEvent(uid: string, input: CalendarEventInput): string {
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

function parseCalendarQueryResponse(xml: string, providerId: string, baseUrl: string): readonly CalendarEvent[] {
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
