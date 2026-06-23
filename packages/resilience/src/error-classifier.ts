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
  return { reason, statusCode, message, recovery: recoveryFor(reason) };
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

function extractMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (typeof error === "object" && error !== null) {
    const m = (error as { message?: unknown }).message;
    if (typeof m === "string") return m;
  }
  return String(error ?? "");
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
