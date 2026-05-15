/**
 * Non-tool time helpers reused by ActiveContextProvider so the
 * agent runtime can format current time + decide working-hours
 * without going through the `muse.time.now` tool. Mirrors the
 * Intl.DateTimeFormat-based approach used by
 * `packages/tools/src/muse-tools-time.ts:18-65`.
 */

export interface FormattedTime {
  readonly iso: string;
  readonly timezone: string;
  readonly weekday: string;
  readonly localHour: number;
}

const FALLBACK_TIMEZONE = "UTC";

export function resolveTimezone(preferred?: string): string {
  if (preferred && isValidTimezone(preferred)) {
    return preferred;
  }
  try {
    const resolved = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return resolved && isValidTimezone(resolved) ? resolved : FALLBACK_TIMEZONE;
  } catch {
    return FALLBACK_TIMEZONE;
  }
}

export function formatCurrentTime(now: Date, timezone?: string): FormattedTime {
  const tz = resolveTimezone(timezone);
  const formatter = new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    hour12: false,
    timeZone: tz,
    weekday: "long"
  });
  const parts = formatter.formatToParts(now);
  const weekday = parts.find((part) => part.type === "weekday")?.value ?? "Unknown";
  const hourPart = parts.find((part) => part.type === "hour")?.value ?? "0";
  const localHour = Number.parseInt(hourPart, 10);
  return {
    iso: now.toISOString(),
    localHour: Number.isFinite(localHour) ? localHour : 0,
    timezone: tz,
    weekday
  };
}

export function isWorkingHours(
  now: Date,
  range: { readonly start: number; readonly end: number },
  timezone?: string
): boolean {
  const { localHour } = formatCurrentTime(now, timezone);
  const start = clampHour(range.start);
  const end = clampHour(range.end);
  if (start === end) {
    return false;
  }
  if (start < end) {
    return localHour >= start && localHour < end;
  }
  return localHour >= start || localHour < end;
}

export function parseWorkingHoursString(value: string | undefined): { start: number; end: number } | undefined {
  if (!value) {
    return undefined;
  }
  const match = /^\s*(\d{1,2})\s*[-–~:to]+\s*(\d{1,2})\s*$/iu.exec(value);
  if (!match) {
    return undefined;
  }
  const start = clampHour(Number.parseInt(match[1] ?? "", 10));
  const end = clampHour(Number.parseInt(match[2] ?? "", 10));
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return undefined;
  }
  return { end, start };
}

function clampHour(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  if (value < 0) return 0;
  if (value > 24) return 24;
  return Math.trunc(value);
}

function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/**
 * Render the offset from `now` to `target` as a short, human-readable
 * phrase ("in 30 min", "2h ago", "now", "in 3 days"). Lets the agent
 * read a calendar event line and answer "when's the next meeting?"
 * without doing date arithmetic in its head.
 *
 * Returns undefined when either input cannot be parsed so the caller
 * can fall back to the raw ISO.
 */
export function humanizeRelativeFromIso(nowIso: string, targetIso: string): string | undefined {
  const now = Date.parse(nowIso);
  const target = Date.parse(targetIso);
  if (!Number.isFinite(now) || !Number.isFinite(target)) {
    return undefined;
  }
  return humanizeRelativeMs(target - now);
}

export function humanizeRelativeMs(deltaMs: number): string {
  if (!Number.isFinite(deltaMs)) {
    return "unknown";
  }
  const abs = Math.abs(deltaMs);
  // Within ±60 seconds → call it "now" so a meeting that started a few
  // seconds ago still reads as "now" rather than "1 min ago".
  if (abs < 60_000) {
    return "now";
  }
  const isPast = deltaMs < 0;
  const minutes = Math.round(abs / 60_000);
  if (minutes < 60) {
    return isPast ? `${minutes.toString()} min ago` : `in ${minutes.toString()} min`;
  }
  const hours = Math.round(abs / 3_600_000);
  if (hours < 24) {
    return isPast ? `${hours.toString()}h ago` : `in ${hours.toString()}h`;
  }
  const days = Math.round(abs / 86_400_000);
  // Goal 123 — proper singular / plural so the [Active Context]
  // line reads "in 1 day" / "in 3 days" instead of the awkward
  // placeholder form. Pure cosmetic but it's user-facing prompt
  // text; consistency matters.
  const dayUnit = days === 1 ? "day" : "days";
  return isPast ? `${days.toString()} ${dayUnit} ago` : `in ${days.toString()} ${dayUnit}`;
}
