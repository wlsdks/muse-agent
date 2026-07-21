import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";

import { calendarBackoffMs, CalendarProviderError, CALENDAR_RETRY_AFTER_CAP_MS, isRetryableCalendarStatus, normalizeCalendarRetryCount, normalizeCalendarRetryDelayMs, parseRetryAfterMs } from "./errors.js";
import { selectExactCalendarEvent } from "./exact-event.js";
import { parseCalendarQueryResponse, renderCalendarQueryReport, renderVEvent } from "./caldav-ics.js";
import { expandRecurringEvent } from "./ics-parse.js";
import { sleep } from "@muse/shared";
import type {
  CalendarEvent,
  CalendarEventLocator,
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
  /** Hard cap for each REPORT attempt. Default 30 seconds. */
  readonly timeoutMs?: number;
}

const DEFAULT_CALDAV_TIMEOUT_MS = 30_000;

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
  private readonly timeoutMs: number;

  constructor(options: CalDAVCalendarProviderOptions) {
    this.url = options.url.endsWith("/") ? options.url : `${options.url}/`;
    this.authHeader = `Basic ${Buffer.from(`${options.username}:${options.password}`).toString("base64")}`;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.retries = normalizeCalendarRetryCount(options.retry?.retries);
    this.baseDelayMs = normalizeCalendarRetryDelayMs(options.retry?.baseDelayMs);
    this.sleep = options.retry?.sleep ?? sleep;
    this.timeoutMs = typeof options.timeoutMs === "number" && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
      ? options.timeoutMs
      : DEFAULT_CALDAV_TIMEOUT_MS;
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
    return this.readEvents(range, false);
  }

  private async readEvents(range: CalendarRange, strict: boolean): Promise<readonly CalendarEvent[]> {
    const body = renderCalendarQueryReport(range);
    // Retry transient 429/5xx (and network rejects) on the idempotent
    // REPORT read so a flaky moment doesn't drop the calendar from the
    // briefing. Writes (PUT/DELETE) are never retried — a retried
    // mutation could double-create / double-delete an event.
    for (let attempt = 0; ; attempt += 1) {
      let response: Response;
      const signal = AbortSignal.timeout(this.timeoutMs);
      try {
        response = await this.fetchImpl(this.url, {
          body,
          headers: this.headers({ depth: "1", contentType: 'application/xml; charset="utf-8"' }),
          method: "REPORT",
          signal
        });
      } catch (cause) {
        if (signal.aborted) {
          throw new CalendarProviderError(this.id, "REPORT_TIMEOUT", `CalDAV REPORT timed out after ${this.timeoutMs.toString()}ms`, cause);
        }
        if (attempt < this.retries) {
          await this.sleep(calendarBackoffMs(this.baseDelayMs, attempt));
          continue;
        }
        throw cause;
      }

      if (!response.ok) {
        if (attempt < this.retries && isRetryableCalendarStatus(response.status)) {
          await this.sleep(calendarBackoffMs(this.baseDelayMs, attempt));
          continue;
        }
        throw new CalendarProviderError(this.id, `HTTP_${response.status}`, await this.errorText(response), undefined, response.status);
      }

      const xml = await response.text();
      const baseEvents = parseCalendarQueryResponse(xml, this.id, this.url);
      if (strict) {
        const eventPayloads = xml.match(/BEGIN:VEVENT/giu)?.length ?? 0;
        if (eventPayloads !== baseEvents.length) {
          throw new CalendarProviderError(this.id, "MALFORMED_RESPONSE", "CalDAV exact lookup received malformed VEVENT data");
        }
      }
      return baseEvents.flatMap((event) => expandRecurringEvent(event, range.from, range.to));
    }
  }

  async resolveExactEvent(locator: CalendarEventLocator): Promise<CalendarEvent | undefined> {
    const instant = new Date(locator.startsAt);
    const events = await this.readEvents({ from: instant, to: instant }, true);
    return selectExactCalendarEvent(events, locator, this.id);
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
        await this.sleep(retryAfterMs !== undefined ? Math.min(retryAfterMs, CALENDAR_RETRY_AFTER_CAP_MS) : calendarBackoffMs(this.baseDelayMs, attempt));
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
