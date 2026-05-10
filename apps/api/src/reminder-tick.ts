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
  let firing = false;

  const tickOnce = async (): Promise<void> => {
    // Single-flight guard: a slow upstream shouldn't pile up overlapping
    // ticks. Skipped ticks just wait for the next interval.
    if (firing) {
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
