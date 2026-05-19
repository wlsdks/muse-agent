import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";

export type JsonPrimitive = string | number | boolean | null;

export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];

export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export type MuseMode = "local" | "remote";

export type RunStatus = "queued" | "running" | "blocked" | "completed" | "failed" | "cancelled";

export interface RunIdentity {
  readonly runId: string;
  readonly userId?: string;
}

export interface BoundaryViolation {
  readonly boundary: string;
  readonly expected?: string;
  readonly actual?: string;
  readonly reason: string;
}

export interface CancellationToken {
  readonly signal: AbortSignal;
  readonly cancel: (reason?: string) => void;
  readonly throwIfCancelled: () => void;
}

export function createRunId(prefix = "run"): string {
  return `${prefix}_${randomUUID()}`;
}

export function sha256Hex(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

export function hmacSha256Hex(input: string | Buffer, secret: string | Buffer): string {
  return createHmac("sha256", secret).update(input).digest("hex");
}

export function verifyHmacSha256Hex(input: string | Buffer, signature: string, secret: string | Buffer): boolean {
  // Fail closed: a missing/non-string signature (an absent HTTP
  // header reaching here despite the type) must reject, never
  // throw a 500 from `.startsWith` on a security boundary.
  if (typeof signature !== "string") {
    return false;
  }
  const normalized = signature.startsWith("sha256=") ? signature.slice("sha256=".length) : signature;

  if (!/^[0-9a-f]{64}$/iu.test(normalized)) {
    return false;
  }

  const expected = hmacSha256Hex(input, secret);
  return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(normalized, "hex"));
}

export function formatBoundaryViolation(violation: BoundaryViolation): string {
  const details = [
    `boundary=${violation.boundary}`,
    `reason=${violation.reason}`,
    violation.expected ? `expected=${violation.expected}` : undefined,
    violation.actual ? `actual=${violation.actual}` : undefined
  ].filter((part): part is string => Boolean(part));

  return `Boundary violation: ${details.join("; ")}`;
}

/**
 * Default cap for `truncateErrorBody`. Chosen to keep a one-line
 * preview readable on a 200-column terminal even when prefixed
 * with provider id + status. Goal 002.
 */
export const DEFAULT_ERROR_BODY_CAP = 240;

/**
 * Cap an upstream response body for inclusion in an error message.
 * Library + CLI sites that wrap a non-OK HTTP response into a
 * thrown error funnel through this so a single hostile upstream
 * (or a misrouted call that returns a multi-kilobyte HTML page)
 * can't flood the user's stderr with one giant string.
 *
 * Trims surrounding whitespace, slices to `cap`, appends `…` when
 * the body was longer than the cap. Empty / falsy input returns
 * the empty string — caller decides whether to fall back to
 * `statusText`.
 */
/**
 * Strip C0 control bytes (except newline + tab) plus DEL + C1
 * high-set (\x7f-\x9f) from untrusted text before writing it to a
 * terminal or persisting it where it'll later be displayed.
 * Defense against ANSI escape (`\x1b[2J`, `\x1b]…\x07`), bare CSI
 * on permissive terminals (`\x9b`), BEL, NUL, etc.
 *
 * Anywhere Muse hands tool output / search results / model deltas
 * straight to the user's stdout or a downstream display, this is
 * the single sanitizer to use. Goal 003 lifted the helper out of
 * the CLI-only `commands-search.ts` so the SSE consumer +
 * messaging providers + any future surface share one
 * implementation.
 */
export function stripUntrustedTerminalChars(value: string): string {
  return value.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/gu, "");
}

/**
 * Goal 086 — high-confidence secret-shape patterns. Each entry
 * names the family + the regex that catches the bytes. The
 * matches are replaced with `[redacted-<family>]` so an operator
 * reading a proactive-notice log line still sees WHICH kind of
 * secret leaked (without leaking the secret itself).
 *
 * The patterns lean toward "stable prefix + entropy length". A
 * false positive on a regular sentence is much less harmful than
 * a false negative on a real credential, but we still prefer
 * recognisable upstream-issued shapes over generic "long random
 * string" heuristics.
 */
const SECRET_PATTERNS: ReadonlyArray<{ readonly name: string; readonly regex: RegExp }> = [
  // `<scheme>://[user]:password@host` — DB / cache / broker
  // connection URIs with an inline password. Runs FIRST so the
  // whole credentialed URI is redacted as one unit before a
  // sub-pattern can nibble (e.g. a JWT-shaped password). A
  // credential-free `https://host` lacks `:pass@` and is left
  // intact. Sibling of the migration-redaction connection rule.
  { name: "connection-uri", regex: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/?#@:]*:[^\s/?#@]+@[^\s)"'<>]+/giu },
  // Order matters: the more-specific Anthropic / OpenAI-project
  // prefixes must run before the generic `sk-` so a token like
  // `sk-ant-api03-...` lands in the right bucket.
  { name: "anthropic-key", regex: /sk-ant-[A-Za-z0-9_-]{20,}/gu },
  { name: "openai-key", regex: /sk-(?:proj-)?[A-Za-z0-9_-]{20,}/gu },
  { name: "github-pat", regex: /gh[pousr]_[A-Za-z0-9_]{30,}/gu },
  // Fine-grained PATs are `github_pat_…`, which the classic
  // `gh[pousr]_` shape above cannot match — it's now GitHub's
  // default token format, so a separate pattern is required.
  { name: "github-pat", regex: /\bgithub_pat_[A-Za-z0-9_]{30,}\b/gu },
  { name: "aws-access-key", regex: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/gu },
  { name: "google-api-key", regex: /\bAIza[0-9A-Za-z_-]{35,}/gu },
  { name: "slack-bot-token", regex: /xox[abprs]-[A-Za-z0-9-]{10,}/gu },
  // Publishable pk_* keys are deliberately NOT redacted — they
  // ship in client code by design.
  { name: "stripe-secret", regex: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{24,}\b/gu },
  // Only the modern glpat- shape; legacy GitLab tokens are too
  // low-entropy to redact without false positives.
  { name: "gitlab-pat", regex: /\bglpat-[A-Za-z0-9_-]{20,}\b/gu },
  { name: "jwt", regex: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/gu },
  // Muse's own delivery channels: a leaked bot token round-trips
  // via the very channel it controls (the docstring's threat
  // model). Telegram: `<botId 6+ digits>:<exactly 35 base64url>`
  // — distinctive enough to redact without false positives.
  { name: "telegram-bot-token", regex: /\b\d{6,}:[A-Za-z0-9_-]{35}\b/gu },
  // Discord bot token: three base64url segments, NOT `eyJ`-prefixed
  // (the jwt rule above runs first and rewrites real JWTs, so this
  // only ever sees genuine non-JWT triple-segment tokens).
  { name: "discord-bot-token", regex: /\b[A-Za-z0-9_-]{23,28}\.[A-Za-z0-9_-]{6,8}\.[A-Za-z0-9_-]{27,}\b/gu }
];

/**
 * Goal 086 — strip high-confidence credential shapes from a text
 * payload. Used pre-delivery on proactive notices so a credential
 * that accidentally landed in a task title (`"rotate API key
 * sk-proj-..."`) doesn't round-trip back via Telegram / Slack.
 *
 * Returns the scrubbed string. The function never throws; an
 * empty / non-string input passes through.
 */
export function redactSecretsInText(value: string): string {
  if (typeof value !== "string" || value.length === 0) return value;
  let scrubbed = value;
  for (const { name, regex } of SECRET_PATTERNS) {
    scrubbed = scrubbed.replace(regex, `[redacted-${name}]`);
  }
  return scrubbed;
}

export function truncateErrorBody(body: string | undefined, cap: number = DEFAULT_ERROR_BODY_CAP): string {
  if (!body) {
    return "";
  }
  const trimmed = body.trim();
  if (trimmed.length <= cap) {
    return trimmed;
  }
  return `${trimmed.slice(0, cap)}…`;
}

export function createCancellationToken(): CancellationToken {
  const controller = new AbortController();

  return {
    cancel: (reason = "Operation cancelled") => {
      controller.abort(new Error(reason));
    },
    signal: controller.signal,
    throwIfCancelled: () => {
      if (controller.signal.aborted) {
        const reason = controller.signal.reason;
        throw reason instanceof Error ? reason : new Error("Operation cancelled");
      }
    }
  };
}
