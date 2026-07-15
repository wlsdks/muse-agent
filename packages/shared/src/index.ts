import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { homedir } from "node:os";

import { redactSecrets } from "./secret-redaction.js";
import { SECRET_PATTERNS } from "./secret-patterns.js";

export {
  clearSecretRegistryForTests,
  hasRegisteredSecrets,
  redactSecrets,
  registerSecretValue
} from "./secret-redaction.js";

export { findSecrets, findSecretsForGuard, SECRET_PATTERNS, GUARD_ONLY_PATTERNS, type SecretMatch } from "./secret-patterns.js";

export {
  guardSecretPersistence,
  assertNoSecretInPersistedFields,
  SECRET_PERSISTENCE_NOTICE,
  type SecretPersistenceGuardResult
} from "./secret-persistence-guard.js";

export {
  resolvePlatformCapabilities,
  type PlatformCapabilities,
  type PlatformOs
} from "./platform-capabilities.js";

export {
  backupPlaintextCredentialsFile,
  credentialEncryptionEnabled,
  credentialEncryptionSecret,
  decodeMaybeEncryptedCredentialsJson,
  decryptCredentialEnvelope,
  encryptCredentialEnvelope,
  isCredentialsFileEncryptedAtRest,
  isEncryptedCredentialEnvelope,
  type EncryptedCredentialEnvelope
} from "./credential-encryption.js";

export { sleep, withTimeout, withTimeoutFallback } from "./sleep.js";
export { isNodeError, isNodeErrorCode, hasNodeErrorCodeIn, NODE_ERROR_CODES, type NodeErrorCode } from "./node-error.js";
export { serializePerKey } from "./serialize-per-key.js";
export { withBestEffort } from "./best-effort.js";
export { createStringSetGuard } from "./string-set-guard.js";
export { resolveAmbientSourceMode, type AmbientSourceMode, type AmbientSourceResolveOptions } from "./ambient-source.js";
export {
  runCommandWithTimeout,
  type RunCommandOptions,
  type RunCommandResult
} from "./run-command.js";

export {
  ENV_BOOLEAN_FALSE_VALUES,
  ENV_BOOLEAN_TRUE_VALUES,
  parseBooleanFromEnv,
  parseBooleanTriStateFromEnv
} from "./env-boolean.js";

export type JsonPrimitive = string | number | boolean | null;

export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];

export interface JsonObject {
  [key: string]: JsonValue | undefined;
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
 * with provider id + status.
 */
export const DEFAULT_ERROR_BODY_CAP = 240;

/**
 * Strip C0 control bytes (except newline + tab) plus DEL + C1
 * high-set (\x7f-\x9f) from untrusted text before writing it to a
 * terminal or persisting it where it'll later be displayed.
 * Defense against ANSI escape (`\x1b[2J`, `\x1b]…\x07`), bare CSI
 * on permissive terminals (`\x9b`), BEL, NUL, etc.
 *
 * Anywhere Muse hands tool output / search results / model deltas
 * straight to the user's stdout or a downstream display, this is
 * the single sanitizer to use. The helper lives here rather than
 * in the CLI-only `commands-search.ts` so the SSE consumer +
 * messaging providers + any future surface share one
 * implementation.
 */
export function stripUntrustedTerminalChars(value: string): string {
  return value.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/gu, "");
}

/**
 * Strip high-confidence credential shapes from a text
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
  // ALSO mask any EXACT secret value resolved through SecretSource (the registry). The pattern loop
  // only catches credential-SHAPED strings; an arbitrary resolved value (a keychain password) has no
  // shape. Composing both here means every sink that scrubs text (29 call sites) masks resolved
  // secrets too — a no-op until a secret is registered, so no behavior change for non-secret text.
  return redactSecrets(scrubbed);
}

/**
 * One-stop sanitizer for printing an unknown error to a terminal.
 * Extracts the message (Error instance or String fallback), strips
 * untrusted terminal control chars, and truncates with the default
 * body cap. Use this anywhere an error from an external source
 * (HTTP response, feed body, untrusted file, model output) reaches
 * io.stderr / io.stdout — a raw `error.message` can carry ESC bytes
 * a malicious upstream embedded to clear the user's screen or
 * inject text that mimics a real prompt.
 */
export function formatErrorForTerminal(cause: unknown, cap: number = DEFAULT_ERROR_BODY_CAP): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  return truncateErrorBody(stripUntrustedTerminalChars(message), cap);
}

/**
 * Extract a human-readable message from an unknown thrown value.
 * An `Error` instance yields its `.message`; anything else falls
 * back to `fallback` when given, else `String(cause)` (so a thrown
 * string / number / plain object still produces useful text instead
 * of a generic placeholder).
 */
export function errorMessage(cause: unknown, fallback?: string): string {
  if (cause instanceof Error) {
    return cause.message;
  }
  return fallback ?? String(cause);
}

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
export function truncateErrorBody(body: string | undefined, cap: number = DEFAULT_ERROR_BODY_CAP): string {
  if (!body) {
    return "";
  }
  const trimmed = body.trim();
  if (trimmed.length <= cap) {
    return trimmed;
  }
  const head = truncateUtf16Safe(trimmed, cap);
  return `${head}…`;
}

/**
 * UTF-16-safe substring: like `text.slice(start, end)` but never returns a
 * lone surrogate half — drops a leading lone LOW surrogate (start split a
 * pair) and a trailing lone HIGH surrogate (end split a pair), so an astral
 * char (emoji / CJK-extension) is never cut into invalid UTF-16.
 * Byte-identical to `slice()` when no pair sits on either boundary.
 */
export function sliceUtf16Safe(text: string, start: number, end: number): string {
  let s = Math.max(0, Math.min(start, text.length));
  let e = Math.max(s, Math.min(end, text.length));
  const lead = text.charCodeAt(s);
  if (s > 0 && lead >= 0xdc00 && lead <= 0xdfff) s += 1;
  if (e > s) {
    const tail = text.charCodeAt(e - 1);
    if (tail >= 0xd800 && tail <= 0xdbff) e -= 1;
  }
  return text.slice(s, e);
}

/**
 * UTF-16-safe head truncation: the first `cap` units, minus a trailing lone
 * high surrogate. `truncateUtf16Safe(t, n)` === `sliceUtf16Safe(t, 0, n)`.
 */
export function truncateUtf16Safe(text: string, cap: number): string {
  if (cap <= 0) return "";
  return sliceUtf16Safe(text, 0, cap);
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

/** Classic Levenshtein edit-distance, O(n·m) two-row DP. */
export function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let previous = new Array<number>(b.length + 1);
  let current = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j += 1) previous[j] = j;

  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      current[j] = Math.min(
        (current[j - 1] ?? 0) + 1,
        (previous[j] ?? 0) + 1,
        (previous[j - 1] ?? 0) + cost
      );
    }
    [previous, current] = [current, previous];
  }
  return previous[b.length] ?? 0;
}

function closestNameLengthAwareCap(len: number): number {
  if (len <= 3) return 1;
  if (len <= 7) return 2;
  return 3;
}

/**
 * Pick the closest candidate to `input` within `maxDistance` edits. Ties
 * broken by candidate order (caller supplies a stable list). Returns
 * `undefined` when nothing is close enough — a "did you mean" prompt with a
 * random-looking guess is worse than no prompt at all.
 *
 * `maxDistance` defaults to a length-aware threshold: 1 edit for 1-3
 * character inputs, 2 for 4-7, 3 for 8+. Shared (not CLI-only) so any
 * surface needing a typo/close-miss suggestion — CLI subcommands
 * (`apps/cli/src/closest-command.ts` re-exports this), the `/model <name>`
 * channel switch — uses the identical algorithm; two independent
 * implementations would risk one surface suggesting a name the other
 * rejects.
 */
export function closestCommandName(
  input: string,
  candidates: readonly string[],
  maxDistance?: number
): string | undefined {
  const trimmed = input.trim();
  if (trimmed.length === 0) return undefined;
  const cap = maxDistance ?? closestNameLengthAwareCap(trimmed.length);

  let best: { name: string; distance: number } | undefined;
  for (const candidate of candidates) {
    const d = levenshteinDistance(trimmed.toLowerCase(), candidate.toLowerCase());
    if (d > cap) continue;
    if (!best || d < best.distance) best = { name: candidate, distance: d };
  }
  return best?.name;
}

/** Type guard for a non-null, non-array object (the canonical shape-inspection helper). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Escape a string's regex metacharacters so it matches literally inside a `RegExp`. */
export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/** Clamp a number to `[min, max]` (assumes `min <= max`). */
export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** Return `value` when it is a finite number, else `fallback`. */
export function finiteOr(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

/**
 * Resolve the user's home directory, preferring `$HOME` and falling
 * back to `os.homedir()`. Throws when both are empty — silently
 * writing under a blank/root-relative path is worse than a loud
 * failure for `~/.muse/*` state files.
 */
export function resolveHomeDir(): string {
  const envHome = process.env.HOME?.trim();
  if (envHome && envHome.length > 0) return envHome;
  const sysHome = homedir().trim();
  if (sysHome.length > 0) return sysHome;
  throw new Error("Cannot resolve home directory — HOME is empty and os.homedir() returned no value");
}
