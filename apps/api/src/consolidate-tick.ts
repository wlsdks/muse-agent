/**
 * Idle-gated curator daemon — runs the authored-skill consolidation
 * (`AuthoredSkillStore.consolidate` + the local-Qwen umbrella merger) ON ITS
 * OWN while the user is idle, instead of only at chat session-end behind
 * `MUSE_SKILL_CONSOLIDATE_ENABLED`. A continuous-companion session may rarely
 * "end", and an expensive merge shouldn't block exit — so the autonomous home
 * for it is a background rider that fires only after the user has been quiet
 * for a while (no recent /api activity). setInterval rider mirroring
 * `pattern-tick.ts`; off by default, fail-soft.
 *
 * Curator pattern adapted from Hermes Agent (MIT) — see THIRD_PARTY_NOTICES.md.
 */

import { mergeSkillsIntoUmbrella } from "@muse/agent-core";
import type { ModelProvider } from "@muse/model";
import { AuthoredSkillStore } from "@muse/skills";

import { isQuietHour, type QuietHourRange } from "./reminder-tick.js";

export interface ConsolidateMergeOutcome {
  readonly umbrella: string;
  readonly merged: readonly string[];
}

export interface ConsolidateTickOptions {
  readonly model: string;
  readonly modelProvider: Pick<ModelProvider, "generate">;
  readonly authoredSkillsDir: string;
  /** Idle signal: ms-epoch of the last user activity, or undefined if never. */
  readonly lastActivityMs: () => number | undefined;
  /** Only consolidate after the user has been idle at least this long. Default 30 min. */
  readonly idleThresholdMs?: number;
  readonly intervalMs?: number;
  readonly threshold?: number;
  readonly minClusterSize?: number;
  readonly quietHours?: QuietHourRange;
  readonly logger?: (message: string) => void;
  readonly errorLogger?: (message: string) => void;
  /** Injectable clock for tests. */
  readonly now?: () => Date;
  /** Test seam — defaults to the real AuthoredSkillStore + LLM merger. */
  readonly runConsolidate?: () => Promise<readonly ConsolidateMergeOutcome[]>;
}

const DEFAULT_INTERVAL_MS = 30 * 60_000;
const MIN_INTERVAL_MS = 60_000;
const MAX_INTERVAL_MS = 6 * 60 * 60_000;
const DEFAULT_IDLE_THRESHOLD_MS = 30 * 60_000;

export interface ConsolidateTickHandle {
  readonly stop: () => void;
  readonly tickOnce: () => Promise<void>;
}

/**
 * Idle iff we have a last-activity stamp AND it is at least `idleThresholdMs`
 * old. An UNKNOWN last-activity (no stamp yet) is treated as NOT idle — we
 * never consolidate without positive evidence the user has paused, so a fresh
 * daemon doesn't merge mid-conversation.
 */
export function isIdleForConsolidate(
  nowMs: number,
  lastActivityMs: number | undefined,
  idleThresholdMs: number
): boolean {
  if (lastActivityMs === undefined) return false;
  return nowMs - lastActivityMs >= idleThresholdMs;
}

export function startConsolidateTick(options: ConsolidateTickOptions): ConsolidateTickHandle {
  const intervalMs = clampInterval(options.intervalMs ?? DEFAULT_INTERVAL_MS);
  const idleThresholdMs = Math.max(0, options.idleThresholdMs ?? DEFAULT_IDLE_THRESHOLD_MS);
  const now = options.now ?? (() => new Date());
  let firing = false;

  const runConsolidate =
    options.runConsolidate ??
    (async (): Promise<readonly ConsolidateMergeOutcome[]> => {
      const store = new AuthoredSkillStore({ dir: options.authoredSkillsDir });
      return store.consolidate(
        (cluster) => mergeSkillsIntoUmbrella(cluster, { model: options.model, modelProvider: options.modelProvider }),
        {
          ...(options.threshold !== undefined ? { threshold: options.threshold } : {}),
          ...(options.minClusterSize !== undefined ? { minClusterSize: options.minClusterSize } : {})
        }
      );
    });

  const tickOnce = async (): Promise<void> => {
    if (firing) return;
    const at = now();
    if (options.quietHours && isQuietHour(at.getHours(), options.quietHours)) return;
    if (!isIdleForConsolidate(at.getTime(), options.lastActivityMs(), idleThresholdMs)) return;
    firing = true;
    try {
      const merged = await runConsolidate();
      for (const m of merged) {
        options.logger?.(`consolidate-tick: folded ${m.merged.length.toString()} skills → ${m.umbrella}`);
      }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      options.errorLogger?.(`consolidate-tick: ${message}`);
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
