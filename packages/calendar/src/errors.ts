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

export class CalendarProviderError extends Error {
  readonly providerId: string;
  readonly code: string;
  readonly cause?: unknown;
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
