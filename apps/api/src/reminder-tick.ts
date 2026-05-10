/**
 * Reminder firing daemon (Phase B per docs/design/reminder-firing.md)
 * implemented as a plain `setInterval` riding the API server's
 * lifecycle. Sidesteps `DynamicScheduler` to keep the boot path
 * narrow — the scheduler manages user-defined cron jobs; this
 * built-in tick is too low-stakes to need that machinery.
 *
 * Off by default. Activates only when:
 *   - `MUSE_REMINDER_DEFAULT_PROVIDER` and
 *     `MUSE_REMINDER_DEFAULT_DESTINATION` are set,
 *   - the messaging registry has the named provider, and
 *   - a `remindersFile` is configured.
 *
 * Tick cadence is `MUSE_REMINDER_TICK_MS` (default 60_000); clamped
 * to [5s, 1h] to keep accidental misconfiguration from spamming the
 * upstream messenger or stalling firing forever.
 */

import { runDueReminders } from "@muse/mcp";
import type { MessagingProviderRegistry } from "@muse/messaging";

export interface ReminderTickOptions {
  readonly registry: MessagingProviderRegistry;
  readonly remindersFile: string;
  readonly providerId: string;
  readonly destination: string;
  readonly intervalMs?: number;
  readonly logger?: (message: string) => void;
  readonly errorLogger?: (message: string) => void;
  /**
   * Phase D quiet-hours window in local time. Inclusive start,
   * exclusive end; supports midnight wrap (e.g. 23–7 means 23:00,
   * 00:00 … 06:59 are quiet, 07:00 onwards fires). When a tick
   * lands inside the window, the firing call is skipped — pending
   * reminders queue up and flush at the boundary.
   */
  readonly quietHours?: QuietHourRange;
  /** Injectable clock for tests; default is `() => new Date()`. */
  readonly now?: () => Date;
}

export interface QuietHourRange {
  readonly startHour: number;
  readonly endHour: number;
}

/**
 * Parse `MUSE_REMINDER_QUIET_HOURS` of the form `<startHour>-<endHour>`,
 * each `0..23`. Returns `undefined` for malformed input so the daemon
 * falls back to "always allowed to fire" rather than crash.
 */
export function parseQuietHours(raw: string | undefined): QuietHourRange | undefined {
  if (!raw) {
    return undefined;
  }
  const match = raw.trim().match(/^(\d{1,2})-(\d{1,2})$/u);
  if (!match) {
    return undefined;
  }
  const startHour = Number.parseInt(match[1]!, 10);
  const endHour = Number.parseInt(match[2]!, 10);
  if (!Number.isFinite(startHour) || !Number.isFinite(endHour)) {
    return undefined;
  }
  if (startHour < 0 || startHour > 23 || endHour < 0 || endHour > 23) {
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

const DEFAULT_INTERVAL_MS = 60_000;
const MIN_INTERVAL_MS = 5_000;
const MAX_INTERVAL_MS = 60 * 60_000;

export interface ReminderTickHandle {
  readonly stop: () => void;
  readonly tickOnce: () => Promise<void>;
}

export function startReminderTick(options: ReminderTickOptions): ReminderTickHandle {
  const intervalMs = clampInterval(options.intervalMs ?? DEFAULT_INTERVAL_MS);
  const now = options.now ?? (() => new Date());
  let firing = false;

  const tickOnce = async (): Promise<void> => {
    // Single-flight guard: a slow upstream shouldn't pile up overlapping
    // ticks. Skipped ticks just wait for the next interval.
    if (firing) {
      return;
    }
    // Quiet hours: skip the firing call entirely. Reminders queue up
    // (status stays pending) and flush on the first tick after the
    // window ends.
    if (options.quietHours && isQuietHour(now().getHours(), options.quietHours)) {
      return;
    }
    firing = true;
    try {
      const summary = await runDueReminders({
        destination: options.destination,
        file: options.remindersFile,
        providerId: options.providerId,
        registry: options.registry
      });
      if (summary.delivered > 0 || summary.errors.length > 0) {
        options.logger?.(
          `reminder-tick: fired ${summary.delivered.toString()} of ${summary.due.toString()} via ${options.providerId}` +
            (summary.errors.length > 0 ? `, ${summary.errors.length.toString()} error(s)` : "")
        );
        for (const error of summary.errors) {
          options.errorLogger?.(`reminder-tick: ${error}`);
        }
      }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      options.errorLogger?.(`reminder-tick: ${message}`);
    } finally {
      firing = false;
    }
  };

  const handle = setInterval(() => {
    void tickOnce();
  }, intervalMs);
  // Don't keep the process alive just for this tick — the API server
  // already owns the keepalive. unref() is best-effort; not all
  // platforms expose it on the Timeout returned by setInterval.
  if (typeof handle.unref === "function") {
    handle.unref();
  }

  return {
    stop: () => clearInterval(handle),
    tickOnce
  };
}

function clampInterval(raw: number): number {
  if (!Number.isFinite(raw)) {
    return DEFAULT_INTERVAL_MS;
  }
  return Math.max(MIN_INTERVAL_MS, Math.min(MAX_INTERVAL_MS, Math.trunc(raw)));
}
