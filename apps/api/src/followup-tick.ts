import { errorMessage } from "@muse/shared";
/**
 * Self-followup firing daemon — step 4 of
 * `docs/design/proactive/agent-self-followup.md` wired into apps/api as a
 * `setInterval` rider, mirroring `reminder-tick.ts` /
 * `proactive-tick.ts`.
 *
 * Off by default. Activates only when:
 *   - `MUSE_FOLLOWUP_DEFAULT_PROVIDER` +
 *     `MUSE_FOLLOWUP_DEFAULT_DESTINATION` are set,
 *   - the messaging registry has the named provider,
 *   - `followupsFile` is configured (autoconfigure resolves it to
 *     `~/.muse/followups.json` by default), and
 *   - a `modelProvider` + `defaultModel` are wired (synthesis is
 *     the primary delivery path — see runDueFollowups for why).
 *
 * Tick cadence: `MUSE_FOLLOWUP_TICK_MS` (default 60_000), clamped
 * to [5s, 1h] for the same reason the other ticks clamp.
 */

import { runDueFollowups, type InterruptionBudgetWiring, type ProactiveModelProviderLike, type RunDueFollowupsSummary } from "@muse/proactivity";
import type { MessagingProviderRegistry } from "@muse/messaging";

import { isQuietHour, resolveQuietHoursOption, type QuietHoursOption } from "./reminder-tick.js";
import type { FollowupRuntimeDecision, FollowupRuntimeStatusStore, FollowupRuntimeStatusUpdate } from "./followup-runtime-status.js";

export interface FollowupTickOptions {
  readonly registry: MessagingProviderRegistry;
  readonly followupsFile: string;
  readonly providerId: string;
  readonly destination: string;
  readonly effectFile?: string;
  readonly modelProvider: ProactiveModelProviderLike;
  readonly model: string;
  readonly intervalMs?: number;
  readonly maxPerTick?: number;
  readonly logger?: (message: string) => void;
  readonly errorLogger?: (message: string) => void;
  /**
   * Shared with the reminder + proactive daemons — operators
   * rarely want a different quiet window per channel. Parse via
   * `parseQuietHours(MUSE_FOLLOWUP_QUIET_HOURS ?? MUSE_REMINDER_QUIET_HOURS)`
   * at the wiring layer.
   */
  readonly quietHours?: QuietHoursOption;
  /** Injectable clock for tests; default `() => new Date()`. */
  readonly now?: () => Date;
  /** Opt-in interruption budget — forwarded verbatim to `runDueFollowups`. */
  readonly interruptionBudget?: InterruptionBudgetWiring;
  readonly runtimeStatus?: FollowupRuntimeStatusStore;
}

const DEFAULT_INTERVAL_MS = 60_000;
const MIN_INTERVAL_MS = 5_000;
const MAX_INTERVAL_MS = 60 * 60_000;

export interface FollowupTickHandle {
  readonly stop: () => void;
  readonly tickOnce: () => Promise<void>;
}

export function startFollowupTick(options: FollowupTickOptions): FollowupTickHandle {
  const intervalMs = clampInterval(options.intervalMs ?? DEFAULT_INTERVAL_MS);
  const now = options.now ?? (() => new Date());
  let firing = false;

  const tickOnce = async (): Promise<void> => {
    const observedAt = now();
    if (firing) {
      recordRuntimeStatus(options, { decision: "already-running", observedAt });
      return;
    }
    const activeQuietHours = resolveQuietHoursOption(options.quietHours);
    if (activeQuietHours && isQuietHour(observedAt.getHours(), activeQuietHours)) {
      recordRuntimeStatus(options, { decision: "quiet-hours", observedAt });
      return;
    }
    firing = true;
    try {
      const summary = await runDueFollowups({
        destination: options.destination,
        ...(options.effectFile ? { effectFile: options.effectFile } : {}),
        file: options.followupsFile,
        ...(options.interruptionBudget ? { interruptionBudget: options.interruptionBudget } : {}),
        ...(options.maxPerTick !== undefined ? { maxPerTick: options.maxPerTick } : {}),
        model: options.model,
        modelProvider: options.modelProvider,
        now: () => observedAt,
        providerId: options.providerId,
        registry: options.registry
      });
      recordRuntimeStatus(options, {
        decision: classifyFollowupRuntimeDecision(summary),
        deliveredCount: summary.delivered,
        dueCount: summary.due,
        errorCount: summary.errors.length,
        firedCount: summary.fired.length,
        observedAt
      });
      if (summary.delivered > 0 || summary.errors.length > 0) {
        options.logger?.(
          `followup-tick: fired ${summary.delivered.toString()} of ${summary.due.toString()} due via ${options.providerId}` +
            (summary.errors.length > 0 ? `, ${summary.errors.length.toString()} error(s)` : "")
        );
        for (const error of summary.errors) {
          options.errorLogger?.(`followup-tick: ${error}`);
        }
      }
    } catch (cause) {
      recordRuntimeStatus(options, { decision: "error", errorCount: 1, observedAt });
      const message = errorMessage(cause);
      options.errorLogger?.(`followup-tick: ${message}`);
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

export function classifyFollowupRuntimeDecision(summary: RunDueFollowupsSummary): FollowupRuntimeDecision {
  if (summary.outcome === "lock-held") return "lock-held";
  if (summary.outcome === "lock-error") return "lock-error";
  if (summary.errors.length > 0) return "error";
  if (summary.fired.length > 0) return "fired";
  if (summary.due === 0) return "no-due";
  return "completed";
}

function recordRuntimeStatus(
  options: FollowupTickOptions,
  update: Omit<FollowupRuntimeStatusUpdate, "observedAtIso"> & { readonly observedAt: Date }
): void {
  try {
    const { observedAt, ...statusUpdate } = update;
    options.runtimeStatus?.record({
      ...statusUpdate,
      observedAtIso: observedAt.toISOString()
    });
  } catch {
  }
}

function clampInterval(raw: number): number {
  if (!Number.isFinite(raw)) {
    return DEFAULT_INTERVAL_MS;
  }
  return Math.max(MIN_INTERVAL_MS, Math.min(MAX_INTERVAL_MS, Math.trunc(raw)));
}
