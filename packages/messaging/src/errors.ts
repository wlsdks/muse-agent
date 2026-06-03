export type MessagingErrorCode =
  | "PROVIDER_NOT_FOUND"
  | "NO_PROVIDERS"
  | "INVALID_DESTINATION"
  | "INVALID_TEXT"
  | "UPSTREAM_FAILED";

/**
 * Classify an HTTP status from a messaging provider as retryable.
 * Mirrors `isRetryableHttpStatus` from `@muse/model` so the
 * resilience layer sees the same shape across LLM providers and
 * chat-out providers:
 *
 *   - 5xx: server-side failure, transient.
 *   - 429: rate limit. Telegram / Discord / Slack / LINE all
 *     answer with 429 + Retry-After when over budget; retry-with-
 *     backoff is the right response, not fail-fast.
 *
 * Anything else (400 / 401 / 403 / 404 / 422 — wrong token, bad
 * destination, malformed payload) MUST fail fast so the proactive
 * loop doesn't burn budget retrying a permanent error.
 */
export function isRetryableMessagingStatus(status: number | undefined): boolean {
  if (status === undefined || !Number.isFinite(status)) return false;
  if (status === 429) return true;
  return status >= 500 && status <= 599;
}

export class MessagingProviderError extends Error {
  readonly providerId: string;
  readonly code: MessagingErrorCode;
  readonly status?: number;
  /**
   * `true` when the underlying HTTP status was a
   * 5xx or a 429 (rate limit). Always `false` for the
   * non-HTTP codes (PROVIDER_NOT_FOUND, INVALID_DESTINATION,
   * INVALID_TEXT) — those are caller errors, not transient.
   */
  readonly retryable: boolean;
  /**
   * The server-mandated wait before retrying, in ms, parsed from a 429's
   * `Retry-After` header (or a provider's body `retry_after`). When present the
   * retry layer waits THIS long instead of its fixed backoff ladder — retrying
   * a rate-limited send sooner just gets throttled again and drops the message.
   */
  readonly retryAfterMs?: number;

  constructor(providerId: string, code: MessagingErrorCode, message: string, status?: number, retryAfterMs?: number) {
    super(message);
    this.name = "MessagingProviderError";
    this.providerId = providerId;
    this.code = code;
    if (status !== undefined) {
      this.status = status;
    }
    if (retryAfterMs !== undefined && Number.isFinite(retryAfterMs) && retryAfterMs >= 0) {
      this.retryAfterMs = retryAfterMs;
    }
    this.retryable = isRetryableMessagingStatus(status);
  }
}

export class MessagingValidationError extends Error {
  readonly field: "destination" | "text";

  constructor(field: "destination" | "text", message: string) {
    super(message);
    this.name = "MessagingValidationError";
    this.field = field;
  }
}
