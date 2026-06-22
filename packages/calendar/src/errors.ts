export class CalendarValidationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "CalendarValidationError";
    this.code = code;
  }
}

/**
 * Classify an HTTP status from a calendar provider
 * (CalDAV / Google) as retryable. Mirrors the model + messaging
 * contract.
 *
 *   - 5xx: server-side failure, almost always transient.
 *   - 429: rate limit. Google Calendar's burst quota answers
 *     with 429 + Retry-After; CalDAV servers (Radicale, Baikal,
 *     iCloud, Google's CalDAV bridge) typically surface 429 or
 *     503 under load.
 *
 * Anything else (400 / 401 / 403 / 404 / 412 — bad token, bad
 * etag, missing resource) MUST fail fast — the resilience layer
 * can't fix a permanent error by retrying.
 */
export function isRetryableCalendarStatus(status: number | undefined): boolean {
  if (status === undefined || !Number.isFinite(status)) return false;
  if (status === 429) return true;
  return status >= 500 && status <= 599;
}

/**
 * Cap on a server-mandated `Retry-After`, so an absurd hint ("retry in an
 * hour") can't freeze a calendar write. A real Google 429 is seconds.
 */
export const CALENDAR_RETRY_AFTER_CAP_MS = 30_000;

/**
 * Parse an HTTP `Retry-After` header into a wait in ms (RFC 7231): either
 * delta-seconds (a non-negative integer) or an HTTP-date. A decimal, negative,
 * or junk value is rejected (→ `undefined`, caller falls back to its backoff);
 * a past date clamps to 0. Mirrors the messaging / model Retry-After contract.
 */
export function parseRetryAfterMs(header: string | null | undefined, nowMs: number): number | undefined {
  if (header === null || header === undefined) return undefined;
  const trimmed = header.trim();
  if (trimmed.length === 0) return undefined;
  if (/^\d+$/u.test(trimmed)) {
    const seconds = Number(trimmed);
    return Number.isFinite(seconds) ? seconds * 1000 : undefined;
  }
  // Only attempt a date parse when the value carries a clock component — this
  // stops the lenient `Date.parse` coercing junk like "3.5" into a stray date.
  if (!trimmed.includes(":")) return undefined;
  const dateMs = Date.parse(trimmed);
  return Number.isFinite(dateMs) ? Math.max(0, dateMs - nowMs) : undefined;
}

export class CalendarProviderError extends Error {
  readonly providerId: string;
  readonly code: string;
  override readonly cause?: unknown;
  /**
   * `true` when the underlying HTTP status was a
   * 5xx or a 429. Optional `status` parameter on the constructor
   * carries the raw HTTP code; legacy call sites that don't pass
   * status land on `retryable: false` (safe default — local /
   * validation errors aren't transient).
   */
  readonly status?: number;
  readonly retryable: boolean;

  constructor(providerId: string, code: string, message: string, cause?: unknown, status?: number) {
    super(message);
    this.name = "CalendarProviderError";
    this.providerId = providerId;
    this.code = code;
    this.cause = cause;
    if (status !== undefined) {
      this.status = status;
    }
    this.retryable = isRetryableCalendarStatus(status);
  }
}
