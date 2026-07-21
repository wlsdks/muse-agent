import { calendarBackoffMs, CalendarProviderError, CALENDAR_RETRY_AFTER_CAP_MS, isRetryableCalendarStatus, normalizeCalendarRetryCount, normalizeCalendarRetryDelayMs, parseRetryAfterMs } from "./errors.js";
import { selectExactCalendarEvent } from "./exact-event.js";
import { isRecord, parseJson, sleep, withBestEffort } from "@muse/shared";
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

interface GoogleCalendarRetryOptions {
  /** Extra attempts after the first, for idempotent GET reads only. Default 2. */
  readonly retries?: number;
  /** First backoff in ms; doubles each retry. Default 250. */
  readonly baseDelayMs?: number;
  /** Injectable delay so tests don't wait on real timers. */
  readonly sleep?: (ms: number) => Promise<void>;
  /**
   * Per-attempt request timeout in ms (AbortController). A hung Google endpoint
   * otherwise blocks the call until the OS socket timeout (minutes), stalling
   * `muse calendar` / the agent (whose wallclock only checks BETWEEN tool
   * iterations, not mid-fetch). Default 15000; 0 disables. A GET timeout retries
   * (idempotent); a WRITE timeout throws (networkRetries=0 — never double-act).
   */
  readonly timeoutMs?: number;
}

export interface GoogleCalendarProviderOptions {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly refreshToken: string;
  readonly calendarId?: string;
  readonly fetchImpl?: typeof fetch;
  readonly retry?: GoogleCalendarRetryOptions;
}

interface GoogleEventPayload {
  readonly id: string;
  readonly summary?: string;
  readonly description?: string;
  readonly location?: string;
  readonly start?: { readonly dateTime?: string; readonly date?: string };
  readonly end?: { readonly dateTime?: string; readonly date?: string };
  readonly htmlLink?: string;
}

const tokenEndpoint = "https://oauth2.googleapis.com/token";
const apiBase = "https://www.googleapis.com/calendar/v3";

const credentialRequirements: readonly CredentialRequirement[] = [
  { description: "Google Cloud OAuth client ID", key: "clientId", label: "Client ID", secret: false },
  { description: "Google Cloud OAuth client secret", key: "clientSecret", label: "Client secret", secret: true },
  { description: "Long-lived refresh token (issued by `muse setup calendar`)", key: "refreshToken", label: "Refresh token", secret: true },
  { description: "Calendar ID (defaults to `primary`)", key: "calendarId", label: "Calendar ID", secret: false }
];

/**
 * Google Calendar v3 adapter.
 *
 * Uses an OAuth2 refresh token (obtained out-of-band via the CLI
 * setup wizard) to mint short-lived access tokens on demand. Holds
 * the access token in memory until expiry minus a 60-second skew.
 *
 * The CLI's `muse setup calendar` writes the OAuth credentials to
 * `~/.muse/credentials.json` via `FileCalendarCredentialStore`; this
 * provider only consumes them.
 */
export class GoogleCalendarProvider implements CalendarProvider {
  readonly id = "gcal";
  private readonly options: Required<Omit<GoogleCalendarProviderOptions, "fetchImpl" | "retry">>;
  private readonly fetchImpl: typeof fetch;
  private readonly retries: number;
  private readonly baseDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly timeoutMs: number;
  private accessToken?: { readonly value: string; readonly expiresAt: number };

  constructor(options: GoogleCalendarProviderOptions) {
    this.options = {
      calendarId: options.calendarId ?? "primary",
      clientId: options.clientId,
      clientSecret: options.clientSecret,
      refreshToken: options.refreshToken
    };
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.retries = normalizeCalendarRetryCount(options.retry?.retries);
    this.baseDelayMs = normalizeCalendarRetryDelayMs(options.retry?.baseDelayMs);
    this.sleep = options.retry?.sleep ?? sleep;
    this.timeoutMs = Number.isFinite(options.retry?.timeoutMs) ? Math.max(0, Math.trunc(options.retry!.timeoutMs!)) : 15_000;
  }

  /**
   * Wrap a fetch with a timeout signal so a hung Google endpoint can't
   * block the call indefinitely. On timeout the fetch rejects → the caller's
   * existing network-failure handling decides (a GET retries; a WRITE throws,
   * networkRetries=0). `timeoutMs <= 0` disables the guard. An external signal
   * (if any) still aborts too.
   */
  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    if (this.timeoutMs <= 0) {
      return this.fetchImpl(url, init);
    }
    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    const signal = init.signal ? AbortSignal.any([init.signal, timeoutSignal]) : timeoutSignal;
    try {
      return await this.fetchImpl(url, { ...init, signal });
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "TimeoutError") {
        throw new Error(`Google Calendar request timed out after ${this.timeoutMs.toString()}ms`, { cause });
      }
      throw cause;
    }
  }

  describe(): CalendarProviderInfo {
    return {
      credentials: credentialRequirements,
      description: "Google Calendar (OAuth refresh token).",
      displayName: "Google Calendar",
      id: this.id,
      local: false
    };
  }

  async listEvents(range: CalendarRange): Promise<readonly CalendarEvent[]> {
    const params = new URLSearchParams({
      maxResults: "250",
      orderBy: "startTime",
      singleEvents: "true",
      timeMax: range.to.toISOString(),
      timeMin: range.from.toISOString()
    });
    const payload = await this.request<{ readonly items?: unknown }>(
      `/calendars/${encodeURIComponent(this.options.calendarId)}/events?${params.toString()}`,
      { method: "GET" }
    );

    // A single malformed event must not turn into a plausible-looking epoch
    // event or hide the rest of the user's calendar. List responses are
    // best-effort: retain well-formed items and drop only invalid entries.
    if (!isRecord(payload) || !Array.isArray(payload.items)) {
      return [];
    }
    return payload.items.flatMap((item): readonly CalendarEvent[] => {
      try {
        return [this.toEvent(item)];
      } catch {
        return [];
      }
    });
  }

  async resolveExactEvent(locator: CalendarEventLocator): Promise<CalendarEvent | undefined> {
    try {
      const payload = await this.request<GoogleEventPayload>(
        `/calendars/${encodeURIComponent(this.options.calendarId)}/events/${encodeURIComponent(locator.eventId)}`,
        { method: "GET" }
      );
      return selectExactCalendarEvent([this.toEvent(payload)], locator, this.id);
    } catch (cause) {
      if (cause instanceof CalendarProviderError && cause.status === 404) return undefined;
      throw cause;
    }
  }

  async createEvent(input: CalendarEventInput): Promise<CalendarEvent> {
    const body = this.toRequestBody(input);
    const payload = await this.request<GoogleEventPayload>(
      `/calendars/${encodeURIComponent(this.options.calendarId)}/events`,
      { body: JSON.stringify(body), method: "POST" }
    );
    return this.toEvent(payload);
  }

  async updateEvent(id: string, input: CalendarEventUpdate): Promise<CalendarEvent> {
    const body = this.toRequestBody(input);
    const payload = await this.request<GoogleEventPayload>(
      `/calendars/${encodeURIComponent(this.options.calendarId)}/events/${encodeURIComponent(id)}`,
      { body: JSON.stringify(body), method: "PATCH" }
    );
    return this.toEvent(payload);
  }

  async deleteEvent(id: string): Promise<void> {
    await this.request<void>(
      `/calendars/${encodeURIComponent(this.options.calendarId)}/events/${encodeURIComponent(id)}`,
      { method: "DELETE" }
    );
  }

  private toEvent(payload: unknown): CalendarEvent {
    if (!isRecord(payload)) {
      throw new CalendarProviderError(this.id, "MALFORMED_EVENT", "Google Calendar returned a non-object event");
    }

    const id = readStringField(payload, "id");
    const startsAt = parseGoogleTime(payload.start);
    const endsAt = parseGoogleTime(payload.end);
    if (!id || id.trim().length === 0 || !startsAt || !endsAt || endsAt.getTime() < startsAt.getTime()) {
      throw new CalendarProviderError(
        this.id,
        "MALFORMED_EVENT",
        "Google Calendar returned an event without a valid id and time range"
      );
    }
    const start = isRecord(payload.start) ? payload.start : undefined;
    const allDay = typeof start?.date === "string" && typeof start.dateTime !== "string";

    return {
      allDay,
      endsAt,
      id,
      providerId: this.id,
      raw: payload,
      startsAt,
      title: readStringField(payload, "summary") ?? "(untitled)",
      ...(readStringField(payload, "location") ? { location: readStringField(payload, "location")! } : {}),
      ...(readStringField(payload, "description") ? { notes: readStringField(payload, "description")! } : {}),
      ...(readStringField(payload, "htmlLink") ? { url: readStringField(payload, "htmlLink")! } : {})
    };
  }

  private toRequestBody(input: CalendarEventInput | CalendarEventUpdate): Record<string, unknown> {
    const body: Record<string, unknown> = {};
    if (input.title !== undefined) {
      body.summary = input.title;
    }
    if (input.startsAt !== undefined) {
      body.start = input.allDay ? { date: toIsoDate(input.startsAt) } : { dateTime: input.startsAt.toISOString() };
    }
    if (input.endsAt !== undefined) {
      body.end = input.allDay ? { date: toIsoDate(input.endsAt) } : { dateTime: input.endsAt.toISOString() };
    }
    if ("location" in input && input.location !== undefined) {
      body.location = input.location;
    }
    if ("notes" in input && input.notes !== undefined) {
      body.description = input.notes;
    }
    return body;
  }

  private async request<T>(path: string, init: { readonly method: string; readonly body?: string }): Promise<T> {
    // GET (idempotent read): retry transient 429/5xx AND a mid-flight network
    // reject so a flaky moment doesn't drop the calendar from the briefing.
    // A WRITE (POST/PATCH/DELETE) retries ONLY a 429 rate-limit, honouring
    // Retry-After — the server rejected the mutation BEFORE applying it, so a
    // retry can't double-act. A write 5xx or a network reject is AMBIGUOUS (it
    // may have committed) and is NEVER retried.
    const isWrite = init.method !== "GET";
    const networkRetries = isWrite ? 0 : this.retries;
    for (let attempt = 0; ; attempt += 1) {
      const accessToken = await this.acquireAccessToken();
      let response: Response;
      try {
        response = await this.fetchWithTimeout(`${apiBase}${path}`, {
          body: init.body,
          headers: {
            accept: "application/json",
            authorization: `Bearer ${accessToken}`,
            ...(init.body ? { "content-type": "application/json" } : {})
          },
          method: init.method
        });
      } catch (cause) {
        if (attempt < networkRetries) {
          await this.sleep(calendarBackoffMs(this.baseDelayMs, attempt));
          continue;
        }
        throw cause;
      }

      if (response.status === 204) {
        return undefined as T;
      }

      if (!response.ok) {
        const retriable = isWrite ? response.status === 429 : isRetryableCalendarStatus(response.status);
        if (attempt < this.retries && retriable) {
          const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"), Date.now());
          const backoffMs = calendarBackoffMs(this.baseDelayMs, attempt);
          await this.sleep(retryAfterMs !== undefined ? Math.min(retryAfterMs, CALENDAR_RETRY_AFTER_CAP_MS) : backoffMs);
          continue;
        }
        const text = await withBestEffort(response.text(), "");
        throw new CalendarProviderError(
          this.id,
          `HTTP_${response.status}`,
          `Google Calendar request failed: ${response.status} ${text}`.slice(0, 500),
          undefined,
          response.status
        );
      }

      // Parse the 2xx body defensively: a third party CAN return a 2xx with a
      // NON-JSON body (an HTML maintenance / proxy / captive-portal page, a
      // truncated or empty body). `response.json()` would throw a raw,
      // unwrapped SyntaxError that surfaces as an opaque crash — so read the
      // text and turn a malformed body into the SAME typed CalendarProviderError
      // the non-2xx path raises, with the status + a body snippet for triage.
      const body = await response.text();
      const parsed = parseJsonBody<T>(body);
      if (parsed === undefined) {
        throw new CalendarProviderError(
          this.id,
          "MALFORMED_RESPONSE",
          `Google Calendar returned a ${response.status.toString()} with a non-JSON body: ${body.slice(0, 200)}`.slice(0, 500),
          undefined,
          response.status
        );
      }
      return parsed;
    }
  }

  private async acquireAccessToken(): Promise<string> {
    const now = Date.now();

    if (this.accessToken && this.accessToken.expiresAt > now + 60_000) {
      return this.accessToken.value;
    }

    const params = new URLSearchParams({
      client_id: this.options.clientId,
      client_secret: this.options.clientSecret,
      grant_type: "refresh_token",
      refresh_token: this.options.refreshToken
    });

    const response = await this.fetchWithTimeout(tokenEndpoint, {
      body: params.toString(),
      headers: { "content-type": "application/x-www-form-urlencoded" },
      method: "POST"
    });

    if (!response.ok) {
      const text = await withBestEffort(response.text(), "");
      throw new CalendarProviderError(
        this.id,
        `OAUTH_${response.status}`,
        `Google OAuth refresh failed: ${response.status} ${text}`.slice(0, 500),
        undefined,
        response.status
      );
    }

    // The OAuth endpoint can also return a 2xx HTML proxy page or a truncated
    // body. Keep this boundary typed like the calendar API path instead of
    // leaking an opaque JSON SyntaxError to the setup/runtime caller.
    const body = await response.text();
    const payload = parseJsonBody<unknown>(body);
    if (payload === undefined) {
      throw new CalendarProviderError(
        this.id,
        "OAUTH_INVALID_RESPONSE",
        `Google OAuth returned a ${response.status.toString()} with a non-JSON body: ${body.slice(0, 200)}`.slice(0, 500),
        undefined,
        response.status
      );
    }
    const accessToken = readStringField(payload, "access_token");
    if (accessToken === undefined) {
      throw new CalendarProviderError(this.id, "OAUTH_INVALID_RESPONSE", "Google OAuth response missing access_token");
    }

    const expiresIn = readNumberField(payload, "expires_in") ?? 3600;

    this.accessToken = {
      expiresAt: now + expiresIn * 1000,
      value: accessToken
    };
    return accessToken;
  }
}

function readNumberField(value: unknown, key: string): number | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const candidate = value[key];
  return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : undefined;
}

function readStringField(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const candidate = value[key];
  return typeof candidate === "string" ? candidate : undefined;
}

function parseGoogleTime(value: unknown): Date | undefined {
  const raw = readStringField(value, "dateTime") ?? readStringField(value, "date");
  if (!raw) {
    return undefined;
  }
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function toIsoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function parseJsonBody<T>(body: string): T | undefined {
  const parsed = parseJson(body);
  return parsed === undefined ? undefined : parsed as T;
}
