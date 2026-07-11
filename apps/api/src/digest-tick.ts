/**
 * Daily digest-flush daemon — the delivery half of the interruption budget
 * (`packages/proactivity/src/digest-flush.ts` + `interruption-gate.ts`),
 * wired into apps/api as a `setInterval` rider, mirroring `reminder-tick.ts` /
 * `proactive-tick.ts`.
 *
 * Off by default. Activates only when:
 *   - `MUSE_DIGEST_ENABLED` is true (default true — see wiring),
 *   - `MUSE_PROACTIVE_PROVIDER` + `MUSE_PROACTIVE_DESTINATION` are set (the
 *     digest rides the SAME channel as the proactive daemon — a second
 *     configured destination for one occasional daily message is needless),
 *   - the messaging registry has the named provider, and
 *   - a `digestFile` / `sentFile` are configured.
 *
 * Tick cadence: `MUSE_DIGEST_TICK_MS` (default 60_000), clamped to [5s, 1h] —
 * cheap to check every tick (`runDigestFlushIfDue` no-ops outside the digest
 * hour or once already sent today), same shape as the other ticks.
 */

import { runDigestFlushIfDue, type RunDigestFlushOutcome } from "@muse/proactivity";
import type { MessagingProviderRegistry } from "@muse/messaging";

import { isQuietHour, type QuietHourRange } from "./reminder-tick.js";

export interface DigestTickOptions {
  readonly registry: MessagingProviderRegistry;
  readonly digestFile: string;
  readonly sentFile: string;
  readonly providerId: string;
  readonly destination: string;
  /** Local hour the digest fires at. Default 18 (`MUSE_DIGEST_HOUR`). */
  readonly digestHour?: number;
  readonly intervalMs?: number;
  readonly logger?: (message: string) => void;
  readonly errorLogger?: (message: string) => void;
  /**
   * Shared with the other daemons — quiet hours suppress the send this tick;
   * the queue stays intact. Because the flush only fires during the exact
   * `digestHour` window (not "any hour after"), a quiet-hours window that
   * fully covers that hour means the digest does NOT catch up later the same
   * day — it waits for the next day's `digestHour` (documented in FEATURES.md;
   * still gated by the once-per-day sidecar, so it never double-sends).
   */
  readonly quietHours?: QuietHourRange;
  /** Injectable clock for tests; default `() => new Date()`. */
  readonly now?: () => Date;
}

const DEFAULT_INTERVAL_MS = 60_000;
const MIN_INTERVAL_MS = 5_000;
const MAX_INTERVAL_MS = 60 * 60_000;

export interface DigestTickHandle {
  readonly stop: () => void;
  readonly tickOnce: () => Promise<void>;
}

export function startDigestTick(options: DigestTickOptions): DigestTickHandle {
  const intervalMs = clampInterval(options.intervalMs ?? DEFAULT_INTERVAL_MS);
  const now = options.now ?? (() => new Date());
  let firing = false;

  const tickOnce = async (): Promise<void> => {
    if (firing) {
      return;
    }
    if (options.quietHours && isQuietHour(now().getHours(), options.quietHours)) {
      return;
    }
    firing = true;
    try {
      const summary = await runDigestFlushIfDue({
        destination: options.destination,
        digestFile: options.digestFile,
        ...(options.digestHour !== undefined ? { digestHour: options.digestHour } : {}),
        now,
        providerId: options.providerId,
        registry: options.registry,
        sentFile: options.sentFile
      });
      if (LOGGED_OUTCOMES.has(summary.outcome) || summary.errors.length > 0) {
        options.logger?.(`digest-tick: ${summary.outcome} (${summary.itemCount.toString()} item(s)) via ${options.providerId}`);
        for (const error of summary.errors) {
          options.errorLogger?.(`digest-tick: ${error}`);
        }
      }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      options.errorLogger?.(`digest-tick: ${message}`);
    } finally {
      firing = false;
    }
  };

  const handle = setInterval(() => {
    void tickOnce();
  }, intervalMs);
  if (typeof handle.unref === "function") {
    handle.unref();
  }

  return {
    stop: () => clearInterval(handle),
    tickOnce
  };
}

const LOGGED_OUTCOMES: ReadonlySet<RunDigestFlushOutcome> = new Set(["sent", "send-failed"]);

function clampInterval(raw: number): number {
  if (!Number.isFinite(raw)) {
    return DEFAULT_INTERVAL_MS;
  }
  return Math.max(MIN_INTERVAL_MS, Math.min(MAX_INTERVAL_MS, Math.trunc(raw)));
}
