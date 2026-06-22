/**
 * Shared HTTP retry-with-backoff for read-only / idempotent actuator
 * fetches (weather lookups, inbox reads). State-changing sends must
 * NOT use this — a retried POST can double-act.
 */

export interface RetryOptions {
  /** Extra attempts after the first. Default 2 (so up to 3 calls). */
  readonly retries?: number;
  /** First backoff in ms; doubles each retry. Default 250. */
  readonly baseDelayMs?: number;
  /** Injectable delay so tests don't wait on real timers. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Passed through to `fetchImpl(url, init)` (e.g. auth headers). */
  readonly init?: RequestInit;
  /**
   * Per-attempt wall-clock cap in ms. A host that accepts the
   * connection but never responds (a service mid-restart, a black-hole
   * proxy) makes a bare `fetch` hang forever — no status, no reject, so
   * the retry logic never engages and the whole turn freezes. Each
   * attempt is aborted after this window and treated as a transient
   * failure (retried; the final attempt's timeout error propagates).
   * Default 15000. `0` disables the cap.
   */
  readonly timeoutMs?: number;
  /**
   * Upper bound on a server-supplied `Retry-After` wait. A rate-limited
   * host may answer `Retry-After: 3600` (an hour) — honouring that
   * verbatim would freeze the agent turn, so the wait is clamped to
   * this. Beyond it we still wait the cap then make the final attempt.
   * Default 30000. `0` ignores `Retry-After` entirely (pure backoff).
   */
  readonly maxRetryAfterMs?: number;
}

/**
 * Parse an HTTP `Retry-After` header into a wait in ms, per RFC 7231:
 * either delta-seconds (a non-negative integer) or an HTTP-date. A
 * decimal, negative, or junk value is rejected (→ `undefined`, caller
 * falls back to its own backoff). A past date clamps to 0.
 */
export function parseRetryAfterMs(header: string | null | undefined, nowMs: number): number | undefined {
  if (header === null || header === undefined) return undefined;
  const trimmed = header.trim();
  if (trimmed.length === 0) return undefined;
  if (/^\d+$/u.test(trimmed)) {
    const seconds = Number(trimmed);
    return Number.isFinite(seconds) ? seconds * 1000 : undefined;
  }
  // Only attempt a date parse when the value carries a clock component
  // — every valid HTTP-date / ISO timestamp does. This stops the famously
  // lenient `Date.parse` from coercing junk like "3.5" into a stray date.
  if (!trimmed.includes(":")) return undefined;
  const dateMs = Date.parse(trimmed);
  return Number.isFinite(dateMs) ? Math.max(0, dateMs - nowMs) : undefined;
}

/**
 * Transient HTTP failures worth retrying: 429 (rate-limit) and any
 * 5xx. A 4xx other than 429 is a permanent client error — retrying it
 * just wastes the window, so fail fast.
 */
export function isRetriableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

/**
 * `fetch` with retry-with-backoff for transient failures (429 / 5xx /
 * network reject). Permanent responses (2xx, or a non-429 4xx) return
 * immediately; the last attempt's response/error is handed back so the
 * caller's own status handling still runs.
 */
export async function fetchWithRetry(
  fetchImpl: typeof globalThis.fetch,
  url: string,
  options: RetryOptions = {}
): Promise<Response> {
  const retries = Number.isFinite(options.retries) ? Math.max(0, Math.trunc(options.retries as number)) : 2;
  const baseDelayMs = Number.isFinite(options.baseDelayMs) ? Math.max(0, options.baseDelayMs as number) : 250;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(0, options.timeoutMs as number) : 15_000;
  const maxRetryAfterMs = Number.isFinite(options.maxRetryAfterMs) ? Math.max(0, options.maxRetryAfterMs as number) : 30_000;

  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    let retryAfterMs: number | undefined;
    const controller = timeoutMs > 0 ? new AbortController() : undefined;
    const externalSignal = options.init?.signal ?? undefined;
    let onExternalAbort: (() => void) | undefined;
    if (controller && externalSignal) {
      if (externalSignal.aborted) {
        controller.abort(externalSignal.reason);
      } else {
        onExternalAbort = () => controller.abort(externalSignal.reason);
        externalSignal.addEventListener("abort", onExternalAbort, { once: true });
      }
    }
    const timer = controller
      ? setTimeout(() => controller.abort(new Error(`fetchWithRetry: attempt timed out after ${timeoutMs.toString()}ms`)), timeoutMs)
      : undefined;
    try {
      const init = controller ? { ...(options.init ?? {}), signal: controller.signal } : options.init;
      const response = init === undefined ? await fetchImpl(url) : await fetchImpl(url, init);
      if (response.ok || !isRetriableStatus(response.status) || attempt === retries) {
        return response;
      }
      if (maxRetryAfterMs > 0) {
        retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"), Date.now());
      }
    } catch (cause) {
      lastError = cause;
      if (attempt === retries) {
        throw cause;
      }
    } finally {
      if (timer) clearTimeout(timer);
      if (externalSignal && onExternalAbort) externalSignal.removeEventListener("abort", onExternalAbort);
    }
    const backoffMs = baseDelayMs * 2 ** attempt;
    await sleep(retryAfterMs !== undefined ? Math.min(retryAfterMs, maxRetryAfterMs) : backoffMs);
  }
  throw lastError ?? new Error("fetchWithRetry: retries exhausted");
}
