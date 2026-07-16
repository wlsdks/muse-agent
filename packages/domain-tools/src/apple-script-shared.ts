/** Shared AppleScript process and string-boundary rules for local macOS providers. */

export const APPLE_SCRIPT_DEFAULT_TIMEOUT_MS = 30_000;
export const APPLE_SCRIPT_MAX_TIMEOUT_MS = 300_000;

/** Keep configurable process timeouts within Node's reliable timer range. */
export function normalizeAppleScriptTimeout(timeoutMs: number | undefined): number {
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return APPLE_SCRIPT_DEFAULT_TIMEOUT_MS;
  }
  return Math.min(APPLE_SCRIPT_MAX_TIMEOUT_MS, Math.trunc(timeoutMs));
}

/** Encode a value as one AppleScript string literal without allowing line breaks to alter the script. */
export function quoteAppleScriptString(value: string): string {
  return `"${value
    .replace(/\\/gu, "\\\\")
    .replace(/"/gu, '\\"')
    .replace(/\r/gu, "\\r")
    .replace(/\n/gu, "\\n")}"`;
}
