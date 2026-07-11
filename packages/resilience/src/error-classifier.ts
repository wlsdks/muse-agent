/**
 * Deterministic error classification — maps an arbitrary thrown
 * error onto a stable recovery-relevant taxonomy so retry / fallback
 * / compaction policy can choose an action from the REASON instead of
 * re-parsing the error at every call site.
 *
 * Pure and code-only (no LLM, no I/O): inspects HTTP status and
 * message patterns in a fixed priority order. The point is honesty —
 * a 401 (bad key) must fail fast, a 429 must back off and retry, a
 * context-overflow must compress, and a genuinely-unknown error stays
 * retryable so the classifier never makes the loop give up on
 * something it can't explain.
 *
 * Reference-only inspiration from hermes' error_classifier.py
 * FailoverReason taxonomy; Muse's own, trimmed to the classes that
 * actually change what the runtime does.
 */

export type ErrorReason =
  | "auth"
  | "rate_limit"
  | "overloaded"
  | "server_error"
  | "timeout"
  | "network"
  | "context_overflow"
  | "content_policy"
  | "model_not_found"
  | "bad_request"
  | "unknown";

export interface RecoveryHints {
  /** Worth trying again at all. */
  readonly retryable: boolean;
  /** Space the retries out (rate/overload signals). */
  readonly shouldBackoff: boolean;
  /** Route to a fallback model/provider rather than hammering this one. */
  readonly shouldFallbackModel: boolean;
  /** Shrink the context before retrying (overflow signals). */
  readonly shouldCompressContext: boolean;
}

export interface ClassifiedError {
  readonly reason: ErrorReason;
  readonly statusCode: number | null;
  readonly message: string;
  readonly recovery: RecoveryHints;
  /**
   * Server-advised wait before retrying, in ms, when the error carries
   * one (a `retry-after` header, a numeric `retryAfter`/`retry_after`
   * field, or a "try again in Ns" message). `null` when none is
   * present — callers fall back to their own backoff.
   */
  readonly retryAfterMs: number | null;
}

const RETRYABLE_REASONS: ReadonlySet<ErrorReason> = new Set([
  "rate_limit",
  "overloaded",
  "server_error",
  "timeout",
  "network",
  "unknown"
]);
const BACKOFF_REASONS: ReadonlySet<ErrorReason> = new Set(["rate_limit", "overloaded", "server_error"]);
const FALLBACK_REASONS: ReadonlySet<ErrorReason> = new Set(["overloaded", "server_error", "model_not_found"]);

function recoveryFor(reason: ErrorReason): RecoveryHints {
  return {
    retryable: RETRYABLE_REASONS.has(reason),
    shouldBackoff: BACKOFF_REASONS.has(reason),
    shouldFallbackModel: FALLBACK_REASONS.has(reason),
    shouldCompressContext: reason === "context_overflow"
  };
}

export function classifyError(error: unknown): ClassifiedError {
  const statusCode = extractStatus(error);
  const message = extractMessage(error);
  const reason = classifyReason(error, statusCode, message);
  return { reason, statusCode, message, recovery: recoveryFor(reason), retryAfterMs: extractRetryAfterMs(error, message) };
}

function classifyReason(error: unknown, status: number | null, message: string): ErrorReason {
  const text = message.toLowerCase();

  // Status code is the strongest signal when present.
  if (status !== null) {
    if (status === 408) return "timeout";
    if (status === 409 || status === 413 || status === 422) {
      return status === 413 ? "context_overflow" : "bad_request";
    }
    if (status === 429) return "rate_limit";
    if (status === 401 || status === 403) return "auth";
    if (status === 404) return "model_not_found";
    if (status === 503 || status === 529) return "overloaded";
    if (status >= 500) return "server_error";
    if (status >= 400) return "bad_request";
  }

  // Cancellation / timeout by error name (a real timeout, not a user abort —
  // callers short-circuit user cancellation before classifying).
  const name = errorName(error);
  if (name === "TimeoutError" || /\b(timed out|timeout|etimedout)\b/.test(text)) return "timeout";
  if (name === "AbortError") return "timeout";

  // Message patterns (priority order: specific → general).
  if (/rate.?limit|too many requests|quota/.test(text)) return "rate_limit";
  if (/overloaded|capacity|temporarily unavailable|server is busy/.test(text)) return "overloaded";
  if (/context (length|window)|maximum context|too long|token.*(exceed|limit)|input is too large/.test(text)) {
    return "context_overflow";
  }
  if (/content (policy|filter)|safety|moderation|flagged/.test(text)) return "content_policy";
  if (/unauthorized|invalid api key|authentication|forbidden|permission denied/.test(text)) return "auth";
  if (/model.*(not found|does not exist|unknown)|no such model/.test(text)) return "model_not_found";
  if (/econnreset|enotfound|econnrefused|fetch failed|network|socket hang up|dns/.test(text)) return "network";
  if (name === "TypeError" && /fetch/.test(text)) return "network";

  // A wrapped provider error tells us its own retryability even when the
  // surface text is opaque — honor it rather than guessing "unknown".
  const providerRetryable = readBooleanProp(error, "retryable");
  if (providerRetryable === false) return "bad_request";
  if (providerRetryable === true) return "server_error";

  return "unknown";
}

const RETRY_AFTER_MESSAGE = /(?:retry|try) (?:again )?(?:in|after) (\d+(?:\.\d+)?) ?(ms|s|sec|secs|second|seconds|m|min|mins|minute|minutes)\b/i;
const RESETS_IN_MESSAGE = /resets? in (\d+(?:\.\d+)?) ?(ms|s|sec|secs|second|seconds|m|min|mins|minute|minutes)\b/i;
const WAIT_MESSAGE = /(?:please )?wait (\d+(?:\.\d+)?) ?(ms|s|sec|secs|second|seconds|m|min|mins|minute|minutes)\b/i;

function unitToMs(value: number, unit: string): number {
  const u = unit.toLowerCase();
  if (u === "ms") return Math.round(value);
  if (u.startsWith("m")) return Math.round(value * 60_000); // m/min/minute(s)
  return Math.round(value * 1_000); // s/sec/second(s)
}

function extractRetryAfterMs(error: unknown, message: string): number | null {
  // Explicit numeric fields first (seconds by convention; *Ms = ms).
  const ms = readNumberProp(error, "retryAfterMs");
  if (ms !== null && ms >= 0) return Math.round(ms);
  for (const key of ["retryAfter", "retry_after"]) {
    const seconds = readNumberProp(error, key);
    if (seconds !== null && seconds >= 0) return Math.round(seconds * 1_000);
  }
  // `retry-after` header (numeric seconds only — HTTP-date form needs a
  // clock and this stays pure).
  const header = readHeader(error, "retry-after");
  if (header !== null) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1_000);
  }
  // Message patterns.
  for (const re of [RETRY_AFTER_MESSAGE, RESETS_IN_MESSAGE, WAIT_MESSAGE]) {
    const m = re.exec(message);
    if (m && m[1] !== undefined && m[2] !== undefined) {
      return unitToMs(Number(m[1]), m[2]);
    }
  }
  return null;
}

function readHeader(error: unknown, name: string): string | null {
  if (typeof error !== "object" || error === null) return null;
  for (const holder of [error, (error as { response?: unknown }).response]) {
    if (typeof holder !== "object" || holder === null) continue;
    const headers = (holder as { headers?: unknown }).headers;
    if (typeof headers !== "object" || headers === null) continue;
    // Header bags: a plain object, or a Map/Headers with a get().
    const getter = (headers as { get?: unknown }).get;
    if (typeof getter === "function") {
      const value = (getter as (k: string) => unknown).call(headers, name);
      if (typeof value === "string") return value;
    }
    for (const key of [name, name.toLowerCase()]) {
      const value = (headers as Record<string, unknown>)[key];
      if (typeof value === "string" || typeof value === "number") return String(value);
    }
  }
  return null;
}

function extractStatus(error: unknown): number | null {
  if (typeof error !== "object" || error === null) return null;
  const candidates = [
    readNumberProp(error, "status"),
    readNumberProp(error, "statusCode"),
    readNumberProp((error as { response?: unknown }).response, "status")
  ];
  for (const c of candidates) {
    if (c !== null && c >= 100 && c < 600) return c;
  }
  return null;
}

function directMessage(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null) {
    const m = (value as { message?: unknown }).message;
    if (typeof m === "string") return m;
  }
  return "";
}

/**
 * Build the text the reason-patterns match against, unwrapping the common
 * provider NESTINGS so the REAL upstream error is visible: OpenAI-style
 * `{ error: { message } }` and OpenRouter-style `{ metadata: { raw } }`
 * (raw is the upstream error JSON as a string). Without this the
 * classifier only sees the opaque wrapper and mis-classifies a wrapped
 * rate-limit / context-overflow as `unknown`. Byte-identical for a
 * top-level-only error (no nesting → just its own message).
 */
function extractMessage(error: unknown): string {
  const parts: string[] = [directMessage(error)];
  if (typeof error === "object" && error !== null) {
    const e = error as Record<string, unknown>;
    parts.push(directMessage(e.error));
    const meta = e.metadata;
    if (typeof meta === "object" && meta !== null) {
      const raw = (meta as Record<string, unknown>).raw;
      if (typeof raw === "string") {
        try {
          const parsed = JSON.parse(raw) as unknown;
          parts.push(directMessage((parsed as { error?: unknown }).error) || directMessage(parsed) || raw);
        } catch {
          parts.push(raw);
        }
      } else {
        parts.push(directMessage((raw as { error?: unknown } | null)?.error) || directMessage(raw));
      }
    }
  }
  const combined = [...new Set(parts.filter((p) => p.length > 0))].join(" | ");
  return combined || String(error ?? "");
}

function errorName(error: unknown): string {
  if (error instanceof Error) return error.name;
  if (typeof error === "object" && error !== null) {
    const n = (error as { name?: unknown }).name;
    if (typeof n === "string") return n;
  }
  return "";
}

function readNumberProp(obj: unknown, key: string): number | null {
  if (typeof obj !== "object" || obj === null) return null;
  const value = (obj as Record<string, unknown>)[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readBooleanProp(obj: unknown, key: string): boolean | null {
  if (typeof obj !== "object" || obj === null) return null;
  const value = (obj as Record<string, unknown>)[key];
  return typeof value === "boolean" ? value : null;
}

/**
 * A user/caller-initiated abort, not a real failure — circuit breakers,
 * retry, and fallback must all let it propagate unclassified rather than
 * counting it toward failure thresholds or trying another model.
 * Lives alongside `classifyError` (both are error-classification, no
 * dependency on ModelProvider or the resilience primitives above it) so
 * every consumer — including a moved-out module like fallback-strategy —
 * can import it without a reverse dependency on index.ts.
 */
export function isCancellationLikeError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const record = error as { readonly code?: unknown; readonly name?: unknown };
  return record.name === "AbortError" || record.code === "ABORT_ERR";
}
