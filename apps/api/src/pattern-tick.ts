/**
 * Pattern-detection firing daemon — step 4 wiring of
 * `docs/design/pattern-detection.md`. setInterval rider on the
 * API server's lifecycle, mirroring `followup-tick.ts` /
 * `proactive-tick.ts`.
 *
 * Off by default. Activates only when ALL of these hold:
 *   - `MUSE_PROACTIVE_PATTERN_ENABLED=true`
 *   - `MUSE_PROACTIVE_PATTERN_PROVIDER` + `..._DESTINATION` are set
 *   - the messaging registry has the named provider
 *   - `patternsFiredFile` is configured (autoconfigure default:
 *     `~/.muse/patterns-fired.json`)
 *
 * Tick cadence: `MUSE_PROACTIVE_PATTERN_TICK_MS` (default
 * 15 * 60_000 = 15 min). Pattern firing is much less time-sensitive
 * than reminders / followups; a 15-min cadence keeps the
 * filesystem-walk cost trivial. Clamped to [60s, 1h].
 */

import { runDuePatternNotices, type AgentInitiatedNoticeBrokerLike } from "@muse/proactivity";
import type { MessagingProviderRegistry } from "@muse/messaging";

import { isQuietHour, type QuietHourRange } from "./reminder-tick.js";

export interface PatternTickOptions {
  readonly registry: MessagingProviderRegistry;
  readonly patternsFiredFile: string;
  readonly providerId: string;
  readonly destination: string;
  /** Forwarded to `aggregateActivitySignals` — overrides the three source paths. */
  readonly activityFile?: string;
  readonly tasksFile?: string;
  readonly notesDir?: string;
  /** Optional Phase D broker fan-out. */
  readonly agentInitiatedNoticeBroker?: AgentInitiatedNoticeBrokerLike;
  readonly agentInitiatedNoticeUserId?: string;
  readonly intervalMs?: number;
  readonly cooldownMs?: number;
  readonly maxPerTick?: number;
  readonly minConfidence?: number;
  readonly logger?: (message: string) => void;
  readonly errorLogger?: (message: string) => void;
  readonly quietHours?: QuietHourRange;
  /** Injectable clock for tests. */
  readonly now?: () => Date;
}

const DEFAULT_INTERVAL_MS = 15 * 60_000;
const MIN_INTERVAL_MS = 60_000;
const MAX_INTERVAL_MS = 60 * 60_000;

export interface PatternTickHandle {
  readonly stop: () => void;
  readonly tickOnce: () => Promise<void>;
}

export function startPatternTick(options: PatternTickOptions): PatternTickHandle {
  const intervalMs = clampInterval(options.intervalMs ?? DEFAULT_INTERVAL_MS);
  const now = options.now ?? (() => new Date());
  let firing = false;

  const tickOnce = async (): Promise<void> => {
    if (firing) return;
    if (options.quietHours && isQuietHour(now().getHours(), options.quietHours)) {
      return;
    }
    firing = true;
    try {
      const summary = await runDuePatternNotices({
        destination: options.destination,
        now,
        patternsFiredFile: options.patternsFiredFile,
        providerId: options.providerId,
        registry: options.registry,
        ...(options.agentInitiatedNoticeBroker ? { agentInitiatedNoticeBroker: options.agentInitiatedNoticeBroker } : {}),
        ...(options.agentInitiatedNoticeUserId ? { agentInitiatedNoticeUserId: options.agentInitiatedNoticeUserId } : {}),
        select: {
          ...(options.cooldownMs !== undefined ? { cooldownMs: options.cooldownMs } : {}),
          ...(options.maxPerTick !== undefined ? { maxPerTick: options.maxPerTick } : {}),
          ...(options.minConfidence !== undefined ? { minConfidence: options.minConfidence } : {})
        },
        signals: {
          ...(options.activityFile ? { activityFile: options.activityFile } : {}),
          ...(options.notesDir ? { notesDir: options.notesDir } : {}),
          ...(options.tasksFile ? { tasksFile: options.tasksFile } : {})
        }
      });
      if (summary.delivered > 0 || summary.errors.length > 0) {
        options.logger?.(
          `pattern-tick: fired ${summary.delivered.toString()} of ${summary.fireable.toString()} fireable via ${options.providerId}` +
            (summary.errors.length > 0 ? `, ${summary.errors.length.toString()} error(s)` : "")
        );
        for (const error of summary.errors) {
          options.errorLogger?.(`pattern-tick: ${error}`);
        }
      }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      options.errorLogger?.(`pattern-tick: ${message}`);
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

function clampInterval(raw: number): number {
  if (!Number.isFinite(raw)) return DEFAULT_INTERVAL_MS;
  return Math.max(MIN_INTERVAL_MS, Math.min(MAX_INTERVAL_MS, Math.trunc(raw)));
}
