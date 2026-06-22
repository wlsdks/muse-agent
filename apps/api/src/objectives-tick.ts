/**
 * Standing-objective re-evaluation daemon — wires
 * `runDueObjectives` (P5-b2) into apps/api as a `setInterval`
 * rider, mirroring `followup-tick.ts` / `proactive-tick.ts`.
 * Without this the delegated-objective autonomy exists only as a
 * library the user's running server never drives.
 *
 * Transport-agnostic like the sibling ticks: `evaluate` / `act` /
 * `escalate` are injected (the concrete production
 * evaluator/actuator is wired at the daemon-set layer). Off
 * unless started. Tick cadence `intervalMs` (default 60_000),
 * clamped to [5s, 1h] like the others; single-flight; fail-soft.
 */

import { type StandingObjective } from "@muse/stores";
import { runDueObjectives, type ObjectiveEvaluation } from "@muse/proactivity";

import { isQuietHour, type QuietHourRange } from "./reminder-tick.js";

export interface ObjectivesTickOptions {
  readonly objectivesFile: string;
  readonly evaluate: (objective: StandingObjective) => Promise<ObjectiveEvaluation>;
  readonly act: (objective: StandingObjective) => Promise<void>;
  readonly escalate?: (objective: StandingObjective, reason: string) => Promise<void>;
  readonly intervalMs?: number;
  readonly maxPerTick?: number;
  readonly maxAttempts?: number;
  readonly logger?: (message: string) => void;
  readonly errorLogger?: (message: string) => void;
  /** Parity with the sibling daemons; gates the whole tick. */
  readonly quietHours?: QuietHourRange;
  /** Injectable clock for tests; default `() => new Date()`. */
  readonly now?: () => Date;
}

const DEFAULT_INTERVAL_MS = 60_000;
const MIN_INTERVAL_MS = 5_000;
const MAX_INTERVAL_MS = 60 * 60_000;

export interface ObjectivesTickHandle {
  readonly stop: () => void;
  readonly tickOnce: () => Promise<void>;
}

export function startObjectivesTick(options: ObjectivesTickOptions): ObjectivesTickHandle {
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
      const summary = await runDueObjectives({
        act: options.act,
        evaluate: options.evaluate,
        file: options.objectivesFile,
        now,
        ...(options.escalate ? { escalate: options.escalate } : {}),
        ...(options.maxPerTick !== undefined ? { maxPerTick: options.maxPerTick } : {}),
        ...(options.maxAttempts !== undefined ? { maxAttempts: options.maxAttempts } : {})
      });
      if (summary.fired.length > 0 || summary.escalated.length > 0 || summary.errors.length > 0) {
        options.logger?.(
          `objectives-tick: ${summary.fired.length.toString()} fired, ` +
            `${summary.escalated.length.toString()} escalated, ` +
            `${summary.retried.length.toString()} retried of ${summary.due.toString()} due` +
            (summary.errors.length > 0 ? `, ${summary.errors.length.toString()} error(s)` : "")
        );
        for (const error of summary.errors) {
          options.errorLogger?.(`objectives-tick: ${error}`);
        }
      }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      options.errorLogger?.(`objectives-tick: ${message}`);
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
  if (!Number.isFinite(raw)) {
    return DEFAULT_INTERVAL_MS;
  }
  return Math.max(MIN_INTERVAL_MS, Math.min(MAX_INTERVAL_MS, Math.trunc(raw)));
}
