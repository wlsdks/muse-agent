/**
 * Standing-objective re-evaluation engine — the long-horizon
 * counterpart to `runDueFollowups`. Reads `~/.muse/objectives.json`,
 * picks every `active` objective whose backoff window has elapsed,
 * asks the injected evaluator whether its condition holds, and:
 *   - met        → run the action, flip to `done` (durable)
 *   - unmet      → exponential-backoff retry; never spin
 *   - unmeetable → flip to `escalated` (durable, visible — never
 *                  silently dropped), optional escalate callback
 *   - unmet too many times → escalate (no infinite retry)
 *
 * `evaluate` / `act` / `escalate` / `now` are injected so tests run
 * without env, network, or a real model. The `setInterval` daemon
 * that drives this lives in `apps/api`, mirroring the followup /
 * reminder / proactive ticks.
 */

import {
  patchObjective,
  readObjectives,
  type StandingObjective
} from "@muse/stores";
import type { EvidenceRecord } from "./objective-evidence.js";

export type ObjectiveEvaluation =
  /**
   * `evidence` is the resolved-store proof behind a `met` verdict
   * (`checkObjectiveMet`'s output). It is optional at the TYPE level
   * because a hand-written `evaluate` in a test may not compute one,
   * but `runDueObjectives` fail-closes an evidence-less `met` to
   * `unmet` below — a buggy evaluator can never complete an objective
   * without resolved evidence backing it.
   */
  | { readonly outcome: "met"; readonly evidence?: readonly EvidenceRecord[] }
  | { readonly outcome: "unmet" }
  | { readonly outcome: "unmeetable"; readonly reason: string };

export interface RunDueObjectivesOptions {
  readonly file: string;
  /** Decide whether the objective's condition currently holds. */
  readonly evaluate: (objective: StandingObjective) => Promise<ObjectiveEvaluation>;
  /** Fired exactly once when the condition is met (before `done`), given the evidence that proved it. */
  readonly act: (objective: StandingObjective, evidence: readonly EvidenceRecord[]) => Promise<void>;
  /** Optional escalation sink (e.g. message the user it gave up). */
  readonly escalate?: (objective: StandingObjective, reason: string) => Promise<void>;
  readonly now?: () => Date;
  /** Cap objectives processed per tick so a backlog can't burst. Default 5. */
  readonly maxPerTick?: number;
  /** Unmet this many times → escalate instead of retrying forever. Default 6. */
  readonly maxAttempts?: number;
  /** First backoff delay; doubles each unmet attempt. Default 60_000ms. */
  readonly backoffBaseMs?: number;
  /** Backoff ceiling. Default 6h. */
  readonly backoffMaxMs?: number;
}

export interface RunDueObjectivesSummary {
  readonly due: number;
  /** ids whose condition was met → acted → marked done. */
  readonly fired: readonly string[];
  /** ids escalated (unmeetable or attempts exhausted). */
  readonly escalated: readonly string[];
  /** ids backed-off for a later tick. */
  readonly retried: readonly string[];
  readonly errors: readonly string[];
}

const DEFAULT_MAX_PER_TICK = 5;
const DEFAULT_MAX_ATTEMPTS = 6;
const DEFAULT_BACKOFF_BASE_MS = 60_000;
const DEFAULT_BACKOFF_MAX_MS = 6 * 60 * 60_000;

export async function runDueObjectives(options: RunDueObjectivesOptions): Promise<RunDueObjectivesSummary> {
  const now = options.now ?? (() => new Date());
  // `??` does NOT catch NaN/Infinity: a non-numeric env knob
  // (MUSE_OBJECTIVES_MAX_PER_TICK="5x" → Number(...) → NaN) would make
  // `Math.max(1, NaN)` → NaN, and `.slice(0, NaN)` drops every due
  // objective — silently evaluating zero forever. Fall back to the
  // default for non-finite values, matching the scheduler's guard.
  const max = Math.max(1, Number.isFinite(options.maxPerTick) ? Math.trunc(options.maxPerTick!) : DEFAULT_MAX_PER_TICK);
  const maxAttempts = Math.max(1, Number.isFinite(options.maxAttempts) ? Math.trunc(options.maxAttempts!) : DEFAULT_MAX_ATTEMPTS);
  // Same NaN/Infinity guard as max/maxAttempts above (`??` does NOT catch NaN): a
  // non-finite backoff makes `delay` NaN, then `new Date(nowMs + NaN).toISOString()`
  // throws — the catch swallows it, the objective never gets a new nextEvalAt and
  // re-evaluates EVERY tick (backoff defeated). Fall back to the default.
  const base = Number.isFinite(options.backoffBaseMs) ? options.backoffBaseMs! : DEFAULT_BACKOFF_BASE_MS;
  const cap = Number.isFinite(options.backoffMaxMs) ? options.backoffMaxMs! : DEFAULT_BACKOFF_MAX_MS;

  const nowMs = now().getTime();
  const all = await readObjectives(options.file);
  const due = all
    .filter((o) => {
      if (o.status !== "active") return false;
      if (!o.nextEvalAt) return true;
      const nextMs = Date.parse(o.nextEvalAt);
      // An unparseable nextEvalAt yields NaN; `NaN <= nowMs` is false, which would
      // freeze the objective FOREVER (never evaluated, never escalated — the same
      // NaN-poison class the maxPerTick guard above handles). Fail open to
      // evaluation; the backoff path then rewrites a valid timestamp (self-heal).
      return !Number.isFinite(nextMs) || nextMs <= nowMs;
    })
    .slice(0, max);

  if (due.length === 0) {
    return { due: 0, errors: [], escalated: [], fired: [], retried: [] };
  }

  const fired: string[] = [];
  const escalated: string[] = [];
  const retried: string[] = [];
  const errors: string[] = [];

  for (const objective of due) {
    try {
      const rawEvaluation = await options.evaluate(objective);
      // Fail-close backstop (roadmap D): `met` reaches this loop ONLY
      // when it carries resolved evidence. A buggy or over-eager
      // evaluator that returns `met` with no evidence — bypassing
      // `checkObjectiveMet` — can never complete an objective; it is
      // treated exactly like `unmet` and backs off for a later tick.
      const evaluation: ObjectiveEvaluation =
        rawEvaluation.outcome === "met" && (!rawEvaluation.evidence || rawEvaluation.evidence.length === 0)
          ? { outcome: "unmet" }
          : rawEvaluation;
      const nowIso = now().toISOString();

      if (evaluation.outcome === "met") {
        await options.act(objective, evaluation.evidence ?? []);
        await patchObjective(options.file, objective.id, {
          lastEvaluatedAt: nowIso,
          resolution: "condition met",
          status: "done"
        });
        fired.push(objective.id);
        continue;
      }

      if (evaluation.outcome === "unmeetable") {
        await options.escalate?.(objective, evaluation.reason);
        await patchObjective(options.file, objective.id, {
          lastEvaluatedAt: nowIso,
          resolution: evaluation.reason,
          status: "escalated"
        });
        escalated.push(objective.id);
        continue;
      }

      const attempts = (objective.attempts ?? 0) + 1;
      if (attempts >= maxAttempts) {
        const reason = `unmeetable: ${maxAttempts.toString()} attempts exhausted`;
        await options.escalate?.(objective, reason);
        await patchObjective(options.file, objective.id, {
          attempts,
          lastEvaluatedAt: nowIso,
          resolution: reason,
          status: "escalated"
        });
        escalated.push(objective.id);
        continue;
      }

      const delay = Math.min(cap, base * 2 ** (attempts - 1));
      await patchObjective(options.file, objective.id, {
        attempts,
        lastEvaluatedAt: nowIso,
        nextEvalAt: new Date(nowMs + delay).toISOString()
      });
      retried.push(objective.id);
    } catch (cause) {
      // Fail-open: an evaluator/action error leaves the objective
      // active for the next tick — it is recorded, never silently
      // dropped, and never crashes the loop for sibling objectives.
      errors.push(`${objective.id}: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }

  return { due: due.length, errors, escalated, fired, retried };
}
