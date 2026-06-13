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
    this.retries = Number.isFinite(options.retry?.retries) ? Math.max(0, Math.trunc(options.retry!.retries!)) : 2;
    this.baseDelayMs = Number.isFinite(options.retry?.baseDelayMs) ? Math.max(0, options.retry!.baseDelayMs!) : 250;
    this.sleep = options.retry?.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    this.timeoutMs = Number.isFinite(options.retry?.timeoutMs) ? Math.max(0, Math.trunc(options.retry!.timeoutMs!)) : 15_000;
  }

  /**
   * Wrap a fetch with an AbortController timeout so a hung Google endpoint can't
   * block the call indefinitely. On timeout the fetch rejects → the caller's
   * existing network-failure handling decides (a GET retries; a WRITE throws,
   * networkRetries=0). `timeoutMs <= 0` disables the guard. An external signal
   * (if any) still aborts too.
   */
  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    if (this.timeoutMs <= 0) {
      return this.fetchImpl(url, init);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`Google Calendar request timed out after ${this.timeoutMs.toString()}ms`)), this.timeoutMs);
    try {
      return await this.fetchImpl(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
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
    const payload = await this.request<{ readonly items?: readonly GoogleEventPayload[] }>(
      `/calendars/${encodeURIComponent(this.options.calendarId)}/events?${params.toString()}`,
      { method: "GET" }
    );

    return (payload.items ?? []).map((item) => this.toEvent(item));
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

  private toEvent(payload: GoogleEventPayload): CalendarEvent {
    const allDay = Boolean(payload.start?.date) && !payload.start?.dateTime;
    const startsAt = parseGoogleTime(payload.start) ?? new Date(0);
    const endsAt = parseGoogleTime(payload.end) ?? startsAt;

    return {
      allDay,
      endsAt,
      id: payload.id,
      providerId: this.id,
      raw: payload,
      startsAt,
      title: payload.summary ?? "(untitled)",
      ...(payload.location ? { location: payload.location } : {}),
      ...(payload.description ? { notes: payload.description } : {}),
      ...(payload.htmlLink ? { url: payload.htmlLink } : {})
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
          await this.sleep(this.baseDelayMs * 2 ** attempt);
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
          const backoffMs = this.baseDelayMs * 2 ** attempt;
          await this.sleep(retryAfterMs !== undefined ? Math.min(retryAfterMs, CALENDAR_RETRY_AFTER_CAP_MS) : backoffMs);
          continue;
        }
        const text = await response.text().catch(() => "");
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
      try {
        return JSON.parse(body) as T;
      } catch {
        throw new CalendarProviderError(
          this.id,
          "MALFORMED_RESPONSE",
          `Google Calendar returned a ${response.status.toString()} with a non-JSON body: ${body.slice(0, 200)}`.slice(0, 500),
          undefined,
          response.status
        );
      }
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
      const text = await response.text().catch(() => "");
      throw new CalendarProviderError(
        this.id,
        `OAUTH_${response.status}`,
        `Google OAuth refresh failed: ${response.status} ${text}`.slice(0, 500),
        undefined,
        response.status
      );
    }

    const payload = await response.json() as { readonly access_token?: string; readonly expires_in?: number };
    if (!payload.access_token) {
      throw new CalendarProviderError(this.id, "OAUTH_INVALID_RESPONSE", "Google OAuth response missing access_token");
    }

    this.accessToken = {
      expiresAt: now + (payload.expires_in ?? 3600) * 1000,
      value: payload.access_token
    };
    return payload.access_token;
  }
}

function parseGoogleTime(value: GoogleEventPayload["start"]): Date | undefined {
  if (!value) {
    return undefined;
  }
  const raw = value.dateTime ?? value.date;
  if (!raw) {
    return undefined;
  }
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function toIsoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}
