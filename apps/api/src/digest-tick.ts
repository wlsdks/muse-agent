import { errorMessage } from "@muse/shared";
/**
 * Daily digest-flush daemon — the delivery half of the interruption budget
 * (`packages/proactivity/src/digest-flush.ts` + `interruption-gate.ts`),
 * wired into apps/api as a `setInterval` rider, mirroring `reminder-tick.ts` /
 * `proactive-tick.ts`.
 *
 * `MUSE_DIGEST_ENABLED` is true (default true — see wiring), and the daemon
 * wiring has a configured or paired route. The digest rides the SAME channel
 * as the proactive daemon, and re-resolves that route before every delivery
 * so pairing changes take effect without restarting the API.
 * The messaging registry has the selected provider, and
 *   - a `digestFile` / `sentFile` are configured.
 *
 * Tick cadence: `MUSE_DIGEST_TICK_MS` (default 60_000), clamped to [5s, 1h] —
 * cheap to check every tick (`runDigestFlushIfDue` no-ops outside the digest
 * hour or once already sent today), same shape as the other ticks.
 */

import { runDigestFlushIfDue, type RunDigestFlushOutcome } from "@muse/proactivity";
import type { MessagingProviderRegistry } from "@muse/messaging";
import type { MessagingRouteResolution } from "@muse/autoconfigure";

import { isQuietHour, resolveQuietHoursOption, type QuietHoursOption } from "./reminder-tick.js";
import type {
  DigestRuntimeDecision,
  DigestRuntimeStatus,
  DigestRuntimeStatusStore
} from "./digest-runtime-status.js";
import { admitAutomationRoute } from "./automation-route-admission.js";

export interface DigestTickOptions {
  readonly registry: MessagingProviderRegistry;
  readonly digestFile: string;
  readonly sentFile: string;
  /** Canonical route resolver, invoked once immediately before delivery. */
  readonly resolveRoute: () => unknown;
  /** Captured effective local-only posture for bounded fallback receipts. */
  readonly localOnly: boolean;
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
  readonly quietHours?: QuietHoursOption;
  /** Injectable clock for tests; default `() => new Date()`. */
  readonly now?: () => Date;
  /** In-memory read seam shared with the assembled Upcoming route. */
  readonly runtimeStatus?: DigestRuntimeStatusStore;
}

const DEFAULT_INTERVAL_MS = 60_000;
const MIN_INTERVAL_MS = 5_000;
const MAX_INTERVAL_MS = 60 * 60_000;

export interface DigestTickHandle {
  readonly getStatus: () => DigestRuntimeStatus | null;
  readonly stop: () => void;
  readonly tickOnce: () => Promise<void>;
}

export function startDigestTick(options: DigestTickOptions): DigestTickHandle {
  const intervalMs = clampInterval(options.intervalMs ?? DEFAULT_INTERVAL_MS);
  const now = options.now ?? (() => new Date());
  let firing = false;

  const observe = (
    decision: DigestRuntimeDecision,
    at: Date,
    itemCount = 0,
    errorCount = 0,
    lastRoute?: MessagingRouteResolution
  ): void => {
    try {
      options.runtimeStatus?.record({
        availability: "observed",
        decision,
        errorCount,
        itemCount,
        lastRoute,
        observedAtIso: at.toISOString(),
        phase: "tick"
      });
    } catch {
    }
  };

  const tickOnce = async (): Promise<void> => {
    if (firing) {
      observe("already-running", now());
      return;
    }
    const at = now();
    const activeQuietHours = resolveQuietHoursOption(options.quietHours);
    if (activeQuietHours && isQuietHour(at.getHours(), activeQuietHours)) {
      observe("quiet-hours", at);
      return;
    }
    firing = true;
    let attemptedRoute: MessagingRouteResolution | undefined;
    try {
      const admission = admitAutomationRoute({
        localOnly: options.localOnly,
        resolveRoute: options.resolveRoute
      });
      attemptedRoute = admission.route;
      if (!admission.admitted) {
        observe("route-unavailable", at, 0, 0, admission.route);
        return;
      }
      const route = admission.route;
      const summary = await runDigestFlushIfDue({
        destination: route.destination,
        digestFile: options.digestFile,
        ...(options.digestHour !== undefined ? { digestHour: options.digestHour } : {}),
        now: () => at,
        providerId: route.providerId,
        registry: options.registry,
        sentFile: options.sentFile
      });
      observe(summary.outcome, at, summary.itemCount, summary.errors.length, route);
      if (LOGGED_OUTCOMES.has(summary.outcome) || summary.errors.length > 0) {
        options.logger?.(`digest-tick: ${summary.outcome} (${summary.itemCount.toString()} item(s)) via ${route.providerId}`);
        for (const error of summary.errors) {
          options.errorLogger?.(`digest-tick: ${error}`);
        }
      }
    } catch (cause) {
      observe("error", at, 0, 1, attemptedRoute);
      const message = errorMessage(cause);
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
    getStatus: () => options.runtimeStatus?.get() ?? null,
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
