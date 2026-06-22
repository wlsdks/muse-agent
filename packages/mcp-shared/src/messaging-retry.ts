/**
 * Shared retry-with-backoff for messaging dispatch.
 *
 * Lifted out of `proactive-notice-loop.ts` so
 * `reminder-firing-loop.ts` can use the same transient-resilience
 * path: a 9am reminder shouldn't fail because Telegram returned a
 * one-off 503. Three attempts (0ms / 200ms / 800ms backoff) match
 * the proactive surface; permanent errors (401, 404,
 * INVALID_DESTINATION / INVALID_TEXT validation failures) short-
 * circuit on attempt 1 via `MessagingProviderError.retryable`
 * instead of burning the full ladder.
 *
 * Pure helper — `registry` is injected so tests fake the messenger
 * directly without env or real provider keys.
 */

import { MessagingProviderError, type MessagingProviderRegistry, type OutboundReceipt } from "@muse/messaging";

const BACKOFFS_MS: readonly number[] = [0, 200, 800];
/**
 * Cap on a server-mandated `Retry-After`, so a hostile / absurd hint
 * ("retry in 1 hour") can't hang a firing loop. A real chat-provider 429 is
 * seconds, well under this.
 */
const RETRY_AFTER_CAP_MS = 30_000;

export interface SendWithRetryOptions {
  /** Injected so tests assert the delay without real wall-clock waits. */
  readonly sleep?: (ms: number) => Promise<void>;
}

export async function sendWithRetry(
  registry: Pick<MessagingProviderRegistry, "send">,
  providerId: string,
  message: { readonly destination: string; readonly text: string },
  options: SendWithRetryOptions = {}
): Promise<OutboundReceipt> {
  const sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let lastError: unknown;
  for (let attempt = 0; attempt < BACKOFFS_MS.length; attempt += 1) {
    if (attempt > 0) {
      // A 429's server-mandated Retry-After (from the PREVIOUS failure, capped)
      // overrides the fixed ladder: the server said "wait THIS long", and
      // retrying sooner just gets throttled again and DROPS the message. Absent
      // a hint, the ladder's transient-5xx backoff stands (no regression).
      const serverHint = lastError instanceof MessagingProviderError && lastError.retryAfterMs !== undefined
        ? Math.min(lastError.retryAfterMs, RETRY_AFTER_CAP_MS)
        : undefined;
      await sleep(serverHint ?? BACKOFFS_MS[attempt] ?? 0);
    }
    try {
      return await registry.send(providerId, message);
    } catch (cause) {
      lastError = cause;
      if (cause instanceof MessagingProviderError && !cause.retryable) {
        break;
      }
    }
  }
  throw lastError;
}
