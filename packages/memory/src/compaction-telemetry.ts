/**
 * Bounded, low-cardinality classification for a compaction failure — the
 * self-improvement flywheel needs a stable bucket to aggregate on, not a
 * free-text error message that never groups the same way twice.
 *
 * `classifyCompactionFailure` is pure and deterministic: same input, same
 * bucket, forever. It accepts three shapes because compaction failures
 * originate from different layers:
 *   - a literal reason string a deterministic call site already knows
 *     (e.g. `trimConversationMessages` recognizing its own no-op), passed
 *     straight through after validation;
 *   - a `ModelProviderError`-shaped object (duck-typed on `retryable` /
 *     `status` so this module never imports `@muse/model` and stays
 *     dependency-light) from an aux-summarizer model call;
 *   - a plain `Error` (or any other thrown value) whose message is sniffed
 *     for a recognizable signal before falling back to `unknown`.
 */

export type CompactionFailureReason =
  | "no_compactable_entries"
  | "below_threshold"
  | "guard_blocked"
  | "summary_failed"
  | "timeout"
  | "provider_error_5xx"
  | "provider_error_4xx"
  | "unknown";

const COMPACTION_FAILURE_REASONS: readonly CompactionFailureReason[] = [
  "no_compactable_entries",
  "below_threshold",
  "guard_blocked",
  "summary_failed",
  "timeout",
  "provider_error_5xx",
  "provider_error_4xx",
  "unknown"
];

function isCompactionFailureReason(value: string): value is CompactionFailureReason {
  return COMPACTION_FAILURE_REASONS.includes(value);
}

/**
 * Duck-typed `ModelProviderError` shape (`packages/model/src/provider-base.ts`).
 * Matched structurally so this module never imports `@muse/model` — the
 * classifier only needs to read fields, never construct or `instanceof` the
 * real class.
 */
export interface CompactionFailureStatusLike {
  readonly status?: number;
  readonly retryable?: boolean;
  readonly name?: string;
  readonly message?: string;
}

export type CompactionFailureInput = CompactionFailureReason | Error | CompactionFailureStatusLike | string | undefined | null;

// Checked BEFORE the retryable/status branch so an explicit textual signal
// (a timeout, a guard refusal) always wins over the coarser HTTP-status
// bucketing — an HTTP 408 is `retryable: true` on `ModelProviderError` but
// callers want it in the more specific `timeout` bucket, not lumped into
// `provider_error_5xx`.
const TIMEOUT_PATTERN = /\b(timed?[\s_-]?out|timeout|ETIMEDOUT|AbortError)\b/iu;
const GUARD_PATTERN = /\b(guard(?:ed|[\s_-]?blocked)?|blocked|refus(?:e|ed|al)|immutable)\b/iu;
const THRESHOLD_PATTERN = /\bbelow[\s_-]?threshold\b/iu;
const NO_COMPACTABLE_PATTERN = /\b(no[\s_-]?compactable|nothing to compact)\b/iu;

function classifyByStatus(status: number | undefined, retryable: boolean | undefined): CompactionFailureReason {
  if (status === 408) {
    return "timeout";
  }
  if (typeof retryable === "boolean") {
    return retryable ? "provider_error_5xx" : "provider_error_4xx";
  }
  if (typeof status === "number") {
    if (status === 429 || (status >= 500 && status <= 599)) {
      return "provider_error_5xx";
    }
    if (status >= 400 && status <= 499) {
      return "provider_error_4xx";
    }
  }
  return "summary_failed";
}

function classifyByText(text: string): CompactionFailureReason | undefined {
  if (TIMEOUT_PATTERN.test(text)) {
    return "timeout";
  }
  if (GUARD_PATTERN.test(text)) {
    return "guard_blocked";
  }
  if (THRESHOLD_PATTERN.test(text)) {
    return "below_threshold";
  }
  if (NO_COMPACTABLE_PATTERN.test(text)) {
    return "no_compactable_entries";
  }
  return undefined;
}

export function classifyCompactionFailure(input: CompactionFailureInput): CompactionFailureReason {
  if (input === undefined || input === null) {
    return "unknown";
  }

  if (typeof input === "string") {
    if (isCompactionFailureReason(input)) {
      return input;
    }
    return classifyByText(input) ?? "unknown";
  }

  const text = toCompactionFailureText(input);
  const byText = text ? classifyByText(text) : undefined;
  if (byText) {
    return byText;
  }

  // Duck-typed: a real `ModelProviderError` carries `status`/`retryable` but
  // isn't statically one of this union's members (this module doesn't
  // import `@muse/model` — see the module doc), so read them structurally.
  const status = pickCompactionFailureStatus(input);
  const retryable = pickCompactionFailureRetryable(input);
  if (status !== undefined || retryable !== undefined) {
    return classifyByStatus(status, retryable);
  }

  if (input instanceof Error) {
    return "summary_failed";
  }

  return "unknown";
}

function pickCompactionFailureStatus(value: unknown): number | undefined {
  return isCompactionFailureStatusLike(value) && typeof value.status === "number" ? value.status : undefined;
}

function pickCompactionFailureRetryable(value: unknown): boolean | undefined {
  return isCompactionFailureStatusLike(value) && typeof value.retryable === "boolean" ? value.retryable : undefined;
}

function isCompactionFailureStatusLike(value: unknown): value is CompactionFailureStatusLike {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  if (!("status" in value) && !("retryable" in value) && !("name" in value) && !("message" in value)) {
    return false;
  }
  if ("status" in value && typeof value.status !== "number") {
    return false;
  }
  if ("retryable" in value && typeof value.retryable !== "boolean") {
    return false;
  }
  if ("name" in value && typeof value.name !== "string") {
    return false;
  }
  if ("message" in value && typeof value.message !== "string") {
    return false;
  }
  return true;
}

function toCompactionFailureText(value: unknown): string {
  if (!isCompactionFailureStatusLike(value)) {
    return "";
  }
  return `${value.name ?? ""} ${value.message ?? ""}`.trim();
}
