/**
 * Shared helpers for messaging provider adapters. Pulled out as
 * Telegram, Discord, and (next) Slack landed independent inbound
 * fetchers and started cloning identical clamp + JSON-parse bits.
 *
 * Keep this thin — anything provider-specific (URL shape, auth
 * header, response decoding) stays in the per-provider file. This
 * module only owns the cross-cutting numeric/parsing primitives.
 */

const MAX_INBOUND_LIMIT = 100;
const DEFAULT_INBOUND_LIMIT = 20;

const DEFAULT_OUTBOUND_TEXT_MAX = 4096;
const TRUNCATION_MARKER = "… [truncated]";

/**
 * Clamp outbound message text to a platform hard limit so a long
 * brief / answer is *delivered truncated* rather than dropped
 * whole when it exceeds the cap. The marker is counted inside
 * `max` so the result never exceeds it. `max` defaults to
 * Telegram's 4096; pass a smaller value for tighter platforms.
 */
export function clampOutboundText(text: string, max: number = DEFAULT_OUTBOUND_TEXT_MAX): string {
  if (text.length <= max) {
    return text;
  }
  // `slice` cuts on UTF-16 code units, so a boundary inside an
  // astral char (emoji / CJK-ext) leaves a lone high surrogate —
  // invalid UTF-8 that Telegram et al. can 400, dropping the whole
  // message and defeating the point of truncating. Drop the
  // orphaned half before appending the marker.
  if (max <= TRUNCATION_MARKER.length) {
    return dropTrailingLoneHighSurrogate(text.slice(0, Math.max(0, max)));
  }
  const head = dropTrailingLoneHighSurrogate(text.slice(0, max - TRUNCATION_MARKER.length));
  return `${head}${TRUNCATION_MARKER}`;
}

function dropTrailingLoneHighSurrogate(value: string): string {
  const last = value.charCodeAt(value.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? value.slice(0, -1) : value;
}

/**
 * Normalise a caller-supplied inbound message limit. NaN / undefined /
 * non-finite falls back to {@link DEFAULT_INBOUND_LIMIT}; finite values
 * truncate to integer and clamp to [1, max] (max default 100, matching
 * Telegram's getUpdates and Discord's channels.messages caps).
 */
export function clampInboundLimit(raw: number | undefined, max: number = MAX_INBOUND_LIMIT): number {
  if (raw === undefined || !Number.isFinite(raw)) {
    return DEFAULT_INBOUND_LIMIT;
  }
  return Math.max(1, Math.min(max, Math.trunc(raw)));
}

/**
 * Parse a body string as JSON, returning the typed value or
 * `undefined` for empty bodies / parse errors. Lets the caller
 * branch on response.ok cleanly without try/catch noise: the
 * pattern was already cloned 4× across telegram/discord/slack/line
 * before this extraction.
 */
export function tryParseJson<T>(body: string): T | undefined {
  if (body.length === 0) {
    return undefined;
  }
  try {
    return JSON.parse(body) as T;
  } catch {
    return undefined;
  }
}
