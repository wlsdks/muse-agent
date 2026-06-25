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

import { mergeSkillsIntoUmbrella, validateUmbrellaCoverage } from "@muse/agent-core";
import type { ModelProvider } from "@muse/model";
import { AuthoredSkillStore } from "@muse/skills";

import { isOsIdleEnough } from "./os-idle.js";
import { isPowerOkForLlm } from "./power-state.js";
import { clearCluster, DEFAULT_COOLDOWN_THRESHOLD, recordClusterReject, shouldSkipCluster } from "./reject-ledger.js";
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
  /**
   * REAL OS idle time in ms (system-wide HID idle), e.g. `osIdleMs` from
   * `./os-idle.js`. When provided, the LLM consolidation ALSO requires the OS
   * to be idle ≥ `idleThresholdMs` — not just Muse's /api quiet — so the merge
   * never fires while the user is busy in another app. Fail-closed: an unknown
   * OS idle (undefined) blocks the run. Omitted ⇒ OS-idle gate skipped
   * (back-compat).
   */
  readonly osIdleMs?: () => number | undefined;
  /**
   * Model-already-resident guard: when provided, the LLM merge runs ONLY if
   * the model is already loaded in Ollama — never cold-loading the multi-GB
   * model unattended. Fail-closed: resolve false on any error ⇒ defer.
   * Omitted ⇒ guard skipped (back-compat).
   */
  readonly isModelResident?: () => boolean | Promise<boolean>;
  /**
   * AC-power state (true=AC, false=battery, undefined=unknown). When provided,
   * the LLM merge runs only on confirmed AC — battery/unknown ⇒ skip, so the
   * heavy background job never drains the battery. Omitted ⇒ gate skipped
   * (back-compat).
   */
  readonly isOnAcPower?: () => boolean | undefined;
  /**
   * Foreground/background contention brake: true when a foreground call
   * (chat/ask) currently holds the Ollama lease. When provided and true, the
   * merge defers so the daemon never contends with a live foreground call for
   * the local model. Omitted ⇒ skipped (back-compat).
   */
  readonly isForegroundBusy?: () => boolean | Promise<boolean>;
  /**
   * Idle REM phase: drain the learn-queue, distilling queued
   * corrections into learned strategies. Runs behind ALL the brakes above.
   * Returns the count distilled (for logging). Omitted ⇒ phase skipped.
   */
  readonly distillQueued?: () => Promise<number>;
  /**
   * Idle RL phase: decay positive-reward strategies the user has
   * stopped reinforcing back toward neutral, so a stale thumbs-up can't steer
   * the agent forever. Cheap + local (no LLM), runs behind the same brakes as
   * the distill phase. Returns the count decayed (for logging). Omitted ⇒ skip.
   */
  readonly decayStale?: () => Promise<number>;
  /**
   * Embed text to a vector (the local nomic embedder) for the SkillOpt held-out
   * coverage gate. When provided, a proposed umbrella commits ONLY if it
   * semantically covers every clustered skill; a coverage-losing merge is
   * rejected (originals untouched) and logged. Omitted ⇒ gate skipped
   * (back-compat: every cohering merge commits).
   */
  readonly embed?: (text: string) => Promise<readonly number[]>;
  /** Cosine floor for the coverage gate. Default 0.65 (calibrated for nomic-embed-text). */
  readonly coverageFloor?: number;
  /**
   * Cross-tick reject cooldown ledger file. When set, a cluster the gate keeps
   * rejecting is skipped after `cooldownThreshold` rejects (until a member edits),
   * so a truly-unmergeable cluster stops burning a merge call every tick. Omitted
   * ⇒ no cooldown.
   */
  readonly rejectLedgerFile?: string;
  /** Consecutive rejects before cooldown. Default 2. */
  readonly cooldownThreshold?: number;
  /**
   * Deterministic curate phase: archive authored skills idle longer than this
   * many days (`AuthoredSkillStore.curate`) so the local model isn't choosing
   * among stale skills (tool-calling.md). Cheap + model-free, so it runs behind
   * ONLY the idle gate — before the LLM brakes — and prunes even when the model
   * is cold or on battery. Omitted / non-positive ⇒ phase skipped. archive =
   * recoverable rename, never delete.
   */
  readonly curateMaxIdleDays?: number;
  /** Test seam for the curate phase — defaults to AuthoredSkillStore.curate. Returns archived names. */
  readonly runCurate?: () => Promise<readonly string[]>;
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
      const { embed } = options;
      return store.consolidate(
        (cluster, feedback) => mergeSkillsIntoUmbrella(cluster, {
          model: options.model,
          modelProvider: options.modelProvider,
          ...(feedback ? { feedback } : {})
        }),
        {
          ...(options.threshold !== undefined ? { threshold: options.threshold } : {}),
          ...(options.minClusterSize !== undefined ? { minClusterSize: options.minClusterSize } : {}),
          // SkillOpt held-out gate: commit a merge only if the umbrella
          // semantically covers every clustered skill; a coverage-losing
          // umbrella is rejected (originals untouched) and logged. The verdict's
          // `lost` labels steer a single feedbackRetry re-proposal (so a fixable
          // umbrella converges instead of being recomputed identically next
          // tick). Needs an embedder — gate skipped without one.
          feedbackRetry: true,
          // Cross-tick cooldown: skip a cluster the gate keeps rejecting (until a
          // member edits) so it stops burning a merge call every idle tick.
          ...(options.rejectLedgerFile
            ? {
                shouldSkipCluster: (c) => shouldSkipCluster(options.rejectLedgerFile!, c, options.cooldownThreshold ?? DEFAULT_COOLDOWN_THRESHOLD),
                recordReject: (c) => recordClusterReject(options.rejectLedgerFile!, c, now().toISOString()),
                recordMerged: (c) => clearCluster(options.rejectLedgerFile!, c)
              }
            : {}),
          ...(embed
            ? {
                validate: async (cluster, umbrella) => {
                  const verdict = await validateUmbrellaCoverage(cluster, umbrella, {
                    embed,
                    ...(options.coverageFloor !== undefined ? { floor: options.coverageFloor } : {})
                  });
                  if (!verdict.accept) {
                    options.logger?.(`consolidate-tick: held-out gate rejected — ${verdict.reason}`);
                  }
                  return { accept: verdict.accept, lost: verdict.lost };
                }
              }
            : {})
        }
      );
    });

  const runCurate =
    options.runCurate ??
    (async (): Promise<readonly string[]> => {
      const store = new AuthoredSkillStore({ dir: options.authoredSkillsDir });
      return store.curate(options.curateMaxIdleDays ?? 0);
    });

  const tickOnce = async (): Promise<void> => {
    if (firing) return;
    const at = now();
    if (options.quietHours && isQuietHour(at.getHours(), options.quietHours)) return;
    if (!isIdleForConsolidate(at.getTime(), options.lastActivityMs(), idleThresholdMs)) return;
    firing = true;
    try {
      // Deterministic curate phase: archive skills idle past the threshold.
      // Cheap + model-free, so it runs behind ONLY the idle gate — BEFORE the
      // LLM brakes below — pruning stale skills even when the model is cold or
      // on battery. Idempotent (re-archiving an archived skill is a no-op).
      if (options.curateMaxIdleDays !== undefined && options.curateMaxIdleDays > 0) {
        try {
          const archived = await runCurate();
          if (archived.length > 0) {
            options.logger?.(`consolidate-tick: archived ${archived.length.toString()} stale skill(s)`);
          }
        } catch (cause) {
          options.errorLogger?.(`consolidate-tick (curate): ${cause instanceof Error ? cause.message : String(cause)}`);
        }
      }
      // Brake-first: when a real OS-idle probe is wired, the LLM merge ALSO
      // requires the MACHINE to be idle (not just Muse's /api), fail-closed —
      // so it never strains the laptop while the user works in another app.
      if (options.osIdleMs && !isOsIdleEnough(options.osIdleMs(), idleThresholdMs)) return;
      // Brake-first: a heavy LLM merge must not drain the battery — AC only.
      if (options.isOnAcPower && !isPowerOkForLlm(options.isOnAcPower())) return;
      // Brake-first: never contend with a live foreground call for Ollama.
      if (options.isForegroundBusy && (await options.isForegroundBusy())) return;
      // Brake-first: never COLD-load the multi-GB model in the background — only
      // merge when it's already resident (a foreground call warmed it).
      if (options.isModelResident && !(await options.isModelResident())) return;
      // Idle REM phase: distill ONE queued correction into a
      // learned strategy while idle — the felt "grows-with-you" payoff. Runs
      // behind the same brakes as the skill merge.
      if (options.distillQueued) {
        const learned = await options.distillQueued();
        if (learned > 0) {
          options.logger?.(`consolidate-tick: distilled ${learned.toString()} strategy(ies) from queued corrections`);
        }
      }
      // Idle RL phase: fade strategies the user stopped reinforcing.
      if (options.decayStale) {
        const decayed = await options.decayStale();
        if (decayed > 0) {
          options.logger?.(`consolidate-tick: decayed ${decayed.toString()} unreinforced strategy(ies) toward neutral`);
        }
      }
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
