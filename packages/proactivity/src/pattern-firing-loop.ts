/**
 * Pattern-detection firing engine — step 4 wiring half of
 * `docs/design/pattern-detection.md`. The orchestrator from
 * `@muse/memory`'s `selectFireablePatterns` already decides
 * *which* patterns should fire on a given tick; this engine
 * delivers them.
 *
 * Steps per tick:
 *   1. `aggregateActivitySignals(...)` over the user's local files.
 *   2. `readPatternsFired(...)` for the cooldown index.
 *   3. `selectFireablePatterns(now, signals, fired, options)` to
 *      get the actionable subset.
 *   4. For each match: `messagingRegistry.send` the suggestion
 *      text, then `recordPatternFired(...)` so the next tick
 *      respects the cooldown.
 *   5. Optionally publish each delivered notice to the Phase D
 *      `AgentInitiatedNoticeBroker` for live SSE subscribers.
 *
 * Pure data-only function — `registry`, `now`, and all paths are
 * injected so tests run without a real messenger or filesystem
 * outside the test's own tmpdir. v0 delivers the detector's
 * `suggestion` field verbatim; LLM-composed Phase D synthesis (the
 * way reminders do it via `ProactiveModelProviderLike`) can land
 * in a follow-up iter once the proactive-pattern flow is
 * dogfooded.
 */

import {
  aggregateActivitySignals,
  selectFireablePatterns,
  type AggregateActivitySignalsOptions,
  type PatternMatch,
  type SelectFireablePatternsOptions
} from "@muse/memory";
import type { MessagingProviderRegistry } from "@muse/messaging";
import { errorMessage, withBestEffort } from "@muse/shared";

import { sendWithRetry } from "@muse/mcp-shared";
import { avoidedSourceKeys, isPatternDismissed, isPatternOnCooldown, readPatternsFired, readTrustLedger, recordPatternFired, withProcessLock } from "@muse/stores";
import { applyInterruptionBudget, resolveInterruptionBudgetCaps, type InterruptionBudgetWiring } from "./interruption-gate.js";
import type { AgentInitiatedNoticeBrokerLike } from "./proactive-notice-loop.js";

export interface RunDuePatternNoticesOptions {
  /** Where to read the cooldown sidecar from. Required. */
  readonly patternsFiredFile: string;
  readonly registry: MessagingProviderRegistry;
  readonly providerId: string;
  readonly destination: string;
  /** Forwarded to `aggregateActivitySignals`. Defaults documented there. */
  readonly signals?: AggregateActivitySignalsOptions;
  /** Forwarded to `selectFireablePatterns`. Default cooldown 24h, min-confidence 0.7. */
  readonly select?: SelectFireablePatternsOptions;
  readonly now?: () => Date;
  /**
   * Optional LLM synthesis of the suggestion text (the deferred "Phase D
   * synthesis"). Given the fireable match, return a composed suggestion or
   * undefined to keep the detector's verbatim `match.suggestion`. Kept as a
   * callback so this loop stays free of any model dependency — the daemon
   * supplies one backed by `synthesizePatternSuggestion`.
   */
  readonly composeSuggestion?: (match: PatternMatch) => Promise<string | undefined>;
  /**
   * Phase D fan-out. Both must be set for the broker leg to fire;
   * the messaging-send leg always runs.
   */
  readonly agentInitiatedNoticeBroker?: AgentInitiatedNoticeBrokerLike;
  readonly agentInitiatedNoticeUserId?: string;
  /**
   * Opt-in interruption budget (unset → identical to pre-budget behavior).
   * Within budget, a fireable pattern still delivers exactly as before; over
   * budget, the send is skipped and the suggestion lands in the digest queue
   * instead — the cooldown sidecar still advances either way so it doesn't
   * re-offer the same match next tick.
   */
  readonly interruptionBudget?: InterruptionBudgetWiring;
}

export interface RunDuePatternNoticesSummary {
  readonly fireable: number;
  readonly delivered: number;
  readonly errors: readonly string[];
  readonly fired: readonly PatternMatch[];
  /** Set only when another daemon held the firing lock for this tick — no
   *  read, send, or mark was attempted at all. Absent on every other path. */
  readonly outcome?: "lock-held";
}

/**
 * Fire due pattern notices. The whole select→send→mark section runs under
 * the cross-process `withProcessLock` (`${options.patternsFiredFile}.firing.lock`,
 * the same generalized lock the reminder/followup/checkin/objective ticks use —
 * `@muse/stores/digest-lock.ts`) because the api daemon's tick
 * (`apps/api/src/pattern-tick.ts`) and the CLI daemon's tick
 * (`daemon-delivery-ticks.ts`'s `makePatternTick`) read the SAME patterns-fired
 * sidecar: `readPatternsFired` is read ONCE per tick (not mutual exclusion), so
 * without a real lock both daemons can read the same match as un-fired and both
 * deliver it before either records the cooldown. A LIVE held lock returns
 * `outcome: "lock-held"` immediately with no send attempted; a broken lock
 * (non-contention fs error) fails OPEN — the tick still runs unlocked rather
 * than silently skipping pattern notices.
 */
export async function runDuePatternNotices(options: RunDuePatternNoticesOptions): Promise<RunDuePatternNoticesSummary> {
  const lockPath = `${options.patternsFiredFile}.firing.lock`;
  const lockOutcome = await withProcessLock(lockPath, () => runDuePatternNoticesUnderLock(options));
  if (lockOutcome.kind === "lock-held") {
    return { delivered: 0, errors: [], fireable: 0, fired: [], outcome: "lock-held" };
  }
  if (lockOutcome.lockError !== undefined) {
    // Fail-open on a BROKEN lock (not contention): the tick still ran,
    // unlocked, so this degrades to the pre-lock duplicate-delivery risk
    // rather than silencing pattern notices.
    return {
      ...lockOutcome.value,
      errors: [`pattern-tick: lock acquisition failed, proceeding without lock: ${lockOutcome.lockError}`, ...lockOutcome.value.errors]
    };
  }
  return lockOutcome.value;
}

async function runDuePatternNoticesUnderLock(options: RunDuePatternNoticesOptions): Promise<RunDuePatternNoticesSummary> {
  const now = options.now ?? (() => new Date());
  const signals = await aggregateActivitySignals({
    now: () => now().getTime(),
    ...(options.signals ?? {})
  });
  const firedRecords = await readPatternsFired(options.patternsFiredFile);
  const fireable = selectFireablePatterns(now(), signals, firedRecords, options.select ?? {});

  if (fireable.length === 0) {
    return { delivered: 0, errors: [], fireable: 0, fired: [] };
  }

  const errors: string[] = [];
  const fired: PatternMatch[] = [];
  let delivered = 0;

  // Read once per tick (not per notice) — a veto recorded mid-tick still
  // waits for the NEXT tick, matching the cooldown sidecar's own tick-
  // granularity freshness.
  const avoidedSources = options.interruptionBudget?.trustLedgerFile
    ? avoidedSourceKeys(await withBestEffort(readTrustLedger(options.interruptionBudget.trustLedgerFile), []))
    : undefined;

  // The orchestrator already filtered cooldown ones out, but a
  // pathological caller passing stale fired-records could let one
  // through. Double-check inline so a buggy caller cannot
  // accidentally re-spam.
  const cooldownMs = options.select?.cooldownMs ?? 24 * 60 * 60_000;

  for (const match of fireable) {
    // Learned avoidance: a dismissed pattern never re-fires (stronger than the
    // time-bounded cooldown — the user said "stop suggesting this").
    if (isPatternDismissed(firedRecords, match.id)) {
      continue;
    }
    if (isPatternOnCooldown(firedRecords, match.id, now().getTime(), cooldownMs)) {
      continue;
    }
    try {
      // Composed (LLM) suggestion when a composer is supplied; else the
      // detector's verbatim text. Composition is fail-soft (undefined →
      // fallback) so a model glitch never drops the suggestion.
      let text = match.suggestion;
      if (options.composeSuggestion) {
      const composed = await withBestEffort(options.composeSuggestion(match), undefined);
        if (composed && composed.trim().length > 0) text = composed.trim();
      }
      const deliver = async (): Promise<void> => {
        await sendWithRetry(options.registry, options.providerId, {
          destination: options.destination,
          text
        });
      };
      let outcome: "delivered" | "digested" | "skipped" = "delivered";
      if (options.interruptionBudget) {
        const budget = options.interruptionBudget;
        const result = await applyInterruptionBudget({
          avoidedSources,
          caps: resolveInterruptionBudgetCaps(budget),
          deliver,
          digestFile: budget.digestFile,
          errorLogger: (message) => errors.push(`${match.id}: ${message}`),
          ...(budget.lastDeliveryFile ? { lastDeliveryFile: budget.lastDeliveryFile } : {}),
          ledgerFile: budget.ledgerFile,
          now: now(),
          source: "pattern-firing",
          sourceId: match.id,
          sourceKey: `pattern-firing:${match.id}`,
          text,
          title: text
        });
        outcome = result.outcome;
      } else {
        await deliver();
      }
      // The cooldown sidecar advances whether the suggestion was sent or
      // suppressed to the digest — a suppressed match must not re-offer
      // itself next tick just because it never actually reached the user.
      await recordPatternFired(options.patternsFiredFile, match.id, now().getTime());
      fired.push(match);
      if (outcome === "delivered") {
        delivered += 1;
      }
      // The broker feeds an already-open live stream (an engaged user watching
      // /api/agent-notices/stream) — publish regardless of a budget DIGEST
      // (the budget governs push channels only; suppressing ambient
      // visibility too would defeat the point of the live feed). A VETO is
      // different: the user explicitly said "stop these", a stronger signal
      // than the frequency budget, so it silences the live stream too.
      if (outcome !== "skipped" && options.agentInitiatedNoticeBroker && options.agentInitiatedNoticeUserId) {
        try {
          options.agentInitiatedNoticeBroker.publish(options.agentInitiatedNoticeUserId, {
            generatedAt: now().toISOString(),
            kind: "pattern",
            sourceId: match.id,
            text
          });
        } catch (cause) {
          errors.push(`${match.id} broker: ${errorMessage(cause)}`);
        }
      }
    } catch (cause) {
      errors.push(`${match.id}: ${errorMessage(cause)}`);
    }
  }

  return { delivered, errors, fireable: fireable.length, fired };
}
