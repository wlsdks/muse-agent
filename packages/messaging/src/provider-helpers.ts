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
