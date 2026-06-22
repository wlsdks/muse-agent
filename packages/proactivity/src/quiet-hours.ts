/**
 * Quiet-hours ("do not disturb") window for proactive delivery — shared by
 * the API ticks and the CLI `muse daemon` so both honour the same window.
 * During the window, ambient/awareness chatter is suppressed; explicit
 * user-scheduled reminders fire on their own path, so a "pay rent today"
 * style urgent reminder is unaffected.
 */

import type { ProactiveNoticeSink } from "./proactive-notice-loop.js";

export interface QuietHourRange {
  readonly startHour: number;
  readonly endHour: number;
}

/**
 * Parse `MUSE_PROACTIVE_QUIET_HOURS` / `MUSE_REMINDER_QUIET_HOURS` of the form
 * `<start>-<end>`. Each side is an hour `0..23`, optionally with a `:MM`
 * (`0..59`) suffix — so the natural `22:00-07:00` works as well as the bare
 * `22-7`. The window is hour-granular: an explicit `:MM` is validated but the
 * window rounds down to the hour. Returns `undefined` for malformed input so
 * the caller falls back to "always allowed to fire" rather than silently
 * disabling itself on a typo.
 */
export function parseQuietHours(raw: string | undefined): QuietHourRange | undefined {
  if (!raw) {
    return undefined;
  }
  const match = raw.trim().match(/^(\d{1,2})(?::(\d{2}))?-(\d{1,2})(?::(\d{2}))?$/u);
  if (!match) {
    return undefined;
  }
  const startHour = Number.parseInt(match[1]!, 10);
  const startMinute = match[2] !== undefined ? Number.parseInt(match[2], 10) : 0;
  const endHour = Number.parseInt(match[3]!, 10);
  const endMinute = match[4] !== undefined ? Number.parseInt(match[4], 10) : 0;
  if (startHour > 23 || endHour > 23 || startMinute > 59 || endMinute > 59) {
    return undefined;
  }
  if (startHour === endHour) {
    return undefined; // empty / always-quiet would be ambiguous; treat as off.
  }
  return { endHour, startHour };
}

/**
 * Inclusive start, exclusive end. Wraps across midnight when
 * `startHour > endHour` (the common case: 23–7 means 23,0,1…6).
 */
export function isQuietHour(currentHour: number, range: QuietHourRange): boolean {
  if (range.startHour < range.endHour) {
    return currentHour >= range.startHour && currentHour < range.endHour;
  }
  return currentHour >= range.startHour || currentHour < range.endHour;
}

/**
 * Wrap a proactive-notice sink so that, during the quiet-hours window,
 * delivery is suppressed (the ambient/awareness "nice to know" notices the
 * resident daemon would otherwise push at night). With no window the original
 * sink is returned unchanged. `onSuppress` lets the caller log what was held.
 */
export function gateProactiveNoticeSink(
  sink: ProactiveNoticeSink,
  options: {
    readonly quietHours?: QuietHourRange;
    readonly now?: () => Date;
    readonly onSuppress?: (notice: { readonly text: string; readonly title: string; readonly kind: string }) => void;
  }
): ProactiveNoticeSink {
  if (!options.quietHours) return sink;
  const quietHours = options.quietHours;
  const now = options.now ?? ((): Date => new Date());
  return {
    deliver: async (notice) => {
      if (isQuietHour(now().getHours(), quietHours)) {
        options.onSuppress?.(notice);
        return;
      }
      await sink.deliver(notice);
    }
  };
}
