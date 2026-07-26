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

import { dirname, join } from "node:path";

import {
  aggregateActivitySignals,
  selectFireablePatterns,
  type AggregateActivitySignalsOptions,
  type PatternMatch,
  type SelectFireablePatternsOptions
} from "@muse/memory";
import {
  dispatchDurableEffectOnce,
  dispatchOutboundEffectOnce,
  readOutboundEffect,
  type MessagingProviderRegistry,
  type OutboundEffectView
} from "@muse/messaging";
import { errorMessage, redactSecretsInText, sha256Hex } from "@muse/shared";

import { avoidedSourceKeys, isPatternDismissed, isPatternOnCooldown, readPatternsFired, readTrustLedger, recordPatternFired, withRequiredProcessLock } from "@muse/stores";
import { applyInterruptionBudget, resolveInterruptionBudgetCaps, type InterruptionBudgetWiring } from "./interruption-gate.js";
import { neutralizeProactivityDeliveryText } from "./delivery-text.js";
import type { AgentInitiatedNoticeBrokerLike } from "./proactive-notice-loop.js";

export interface RunDuePatternNoticesOptions {
  /** Where to read the cooldown sidecar from. Required. */
  readonly patternsFiredFile: string;
  readonly registry: Pick<MessagingProviderRegistry, "has" | "send">;
  readonly providerId: string;
  readonly destination: string;
  /** Canonical outbound-effect ledger. Production callers place it beside the action log. */
  readonly effectFile?: string;
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
  readonly outcome?: "lock-held" | "lock-error";
}

/**
 * Fire due pattern notices. The whole select→send→mark section runs under
 * the cross-process `withRequiredProcessLock` (`${options.patternsFiredFile}.firing.lock`,
 * the same generalized lock the reminder/followup/checkin/objective ticks use —
 * `@muse/stores/digest-lock.ts`) because the api daemon's tick
 * (`apps/api/src/pattern-tick.ts`) and the CLI daemon's tick
 * (`daemon-delivery-ticks.ts`'s `makePatternTick`) read the SAME patterns-fired
 * sidecar: `readPatternsFired` is read ONCE per tick (not mutual exclusion), so
 * without a real lock both daemons can read the same match as un-fired and both
 * deliver it before either records the cooldown. A LIVE held lock returns
 * `outcome: "lock-held"` immediately with no send attempted; a broken lock
 * fails CLOSED because an unlocked external send could duplicate delivery.
 */
export async function runDuePatternNotices(options: RunDuePatternNoticesOptions): Promise<RunDuePatternNoticesSummary> {
  const has = options.registry.has;
  const send = options.registry.send;
  const publish = options.agentInitiatedNoticeBroker?.publish;
  const stable = {
    ...options,
    destination: options.destination,
    effectFile: options.effectFile ?? join(dirname(options.patternsFiredFile), "outbound-effects.json"),
    now: options.now ?? (() => new Date()),
    patternsFiredFile: options.patternsFiredFile,
    providerId: options.providerId,
    registry: {
      has: typeof has === "function" ? has.bind(options.registry) : () => false,
      send: typeof send === "function"
        ? send.bind(options.registry)
        : async () => { throw new Error("messaging registry send is unavailable"); }
    },
    ...(options.select ? { select: { ...options.select } } : {}),
    ...(options.signals ? { signals: { ...options.signals } } : {}),
    ...(publish
      ? { agentInitiatedNoticeBroker: { publish: publish.bind(options.agentInitiatedNoticeBroker) } }
      : {})
  } as const;
  const lockPath = `${stable.patternsFiredFile}.firing.lock`;
  const lockOutcome = await withRequiredProcessLock(lockPath, () => runDuePatternNoticesUnderLock(stable));
  if (lockOutcome.kind === "lock-held") {
    return { delivered: 0, errors: [], fireable: 0, fired: [], outcome: "lock-held" };
  }
  if (lockOutcome.kind === "lock-error") {
    return {
      delivered: 0,
      errors: [`pattern-tick: lock acquisition failed: ${lockOutcome.error}`],
      fireable: 0,
      fired: [],
      outcome: "lock-error"
    };
  }
  return lockOutcome.value;
}

async function runDuePatternNoticesUnderLock(options: RunDuePatternNoticesOptions): Promise<RunDuePatternNoticesSummary> {
  const now = options.now ?? (() => new Date());
  const at = now();
  const signals = await aggregateActivitySignals({
    ...(options.signals ?? {}),
    now: () => at.getTime()
  });
  const firedRecords = await readPatternsFired(options.patternsFiredFile);
  const fireable = selectFireablePatterns(at, signals, firedRecords, options.select ?? {});

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
    ? avoidedSourceKeys(await readTrustLedger(options.interruptionBudget.trustLedgerFile).catch(() => []))
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
    if (isPatternOnCooldown(firedRecords, match.id, at.getTime(), cooldownMs)) {
      continue;
    }
    const effectId = patternNaturalSlotEffectId(match, at);
    if (
      options.providerId.trim().length === 0
      || options.providerId !== options.providerId.trim()
      || options.destination.trim().length === 0
      || options.destination !== options.destination.trim()
    ) {
      errors.push(`${match.id}: delivery route is unavailable or invalid`);
      continue;
    }
    try {
      const existing = await readOutboundEffect(options.effectFile!, effectId);
      if (
        existing
        && (
          existing.binding.providerId !== options.providerId
          || existing.binding.destination !== options.destination
        )
      ) {
        throw new Error(`outbound effect ${effectId} route binding conflicts with the current pattern slot`);
      }
      let effect: OutboundEffectView | undefined;
      let deliveryText: string | undefined;
      let text: string | undefined;
      let outcome: "delivered" | "digested" | "skipped" = "delivered";
      let newSlot = false;
      if (!existing) {
        text = match.suggestion;
        if (options.composeSuggestion) {
          const composed = await options.composeSuggestion(match).catch(() => undefined);
          if (composed && composed.trim().length > 0) text = composed.trim();
        }
        deliveryText = neutralizeProactivityDeliveryText(text);
        const deliver = async (): Promise<void> => {
          if (!options.registry.has(options.providerId)) {
            throw new Error("delivery route is unavailable or invalid");
          }
          effect = await dispatchOutboundEffectOnce({
            destination: options.destination,
            effectFile: options.effectFile!,
            effectId,
            now,
            providerId: options.providerId,
            registry: options.registry,
            text: deliveryText!
          });
          if (effect.state !== "accepted" && effect.state !== "reconciled-accepted") {
            throw new Error(patternEffectBlockedMessage(match.id, effect));
          }
        };
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
            now: at,
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
        newSlot = true;
      } else if (existing.state === "prepared") {
        effect = await dispatchDurableEffectOnce({
          destination: existing.binding.destination,
          dispatch: async () => {
            throw new Error("prepared pattern replay must never dispatch");
          },
          effectFile: options.effectFile!,
          effectId,
          now,
          payloadHash: existing.binding.payloadHash,
          providerId: existing.binding.providerId
        });
      } else {
        effect = existing;
      }
      if (effect && effect.state !== "accepted" && effect.state !== "reconciled-accepted") {
        if (effect.state !== "reconciled-not-delivered") {
          errors.push(patternEffectBlockedMessage(match.id, effect));
          continue;
        }
        outcome = "skipped";
      }
      // The cooldown sidecar advances whether the suggestion was sent or
      // suppressed to the digest — a suppressed match must not re-offer
      // itself next tick just because it never actually reached the user.
      const receipt = effect?.receipt;
      if (
        effect
        && (effect.state === "accepted" || effect.state === "reconciled-accepted")
        && !receipt
      ) {
        throw new Error(`accepted outbound effect ${effectId} has no durable receipt`);
      }
      const firedAtMs = receipt ? Date.parse(receipt.receivedAt) : at.getTime();
      await recordPatternFired(options.patternsFiredFile, match.id, firedAtMs);
      fired.push(match);
      if (outcome === "delivered" && effect?.state !== "reconciled-not-delivered") {
        delivered += 1;
      }
      // The broker feeds an already-open live stream (an engaged user watching
      // /api/agent-notices/stream) — publish regardless of a budget DIGEST
      // (the budget governs push channels only; suppressing ambient
      // visibility too would defeat the point of the live feed). A VETO is
      // different: the user explicitly said "stop these", a stronger signal
      // than the frequency budget, so it silences the live stream too.
      if (
        newSlot
        && outcome !== "skipped"
        && deliveryText
        && options.agentInitiatedNoticeBroker
        && options.agentInitiatedNoticeUserId
      ) {
        try {
          options.agentInitiatedNoticeBroker.publish(options.agentInitiatedNoticeUserId, {
            generatedAt: at.toISOString(),
            kind: "pattern",
            sourceId: match.id,
            text: deliveryText
          });
        } catch (cause) {
          errors.push(`${match.id} broker: ${errorMessage(cause)}`);
        }
      }
    } catch (cause) {
      const message = redactSecretsInText(errorMessage(cause));
      errors.push(message.startsWith(`${match.id}: `) ? message : `${match.id}: ${message}`);
    }
  }

  return { delivered, errors, fireable: fireable.length, fired };
}

export function patternNaturalSlotEffectId(match: PatternMatch, now: Date): string {
  const slot = match.category === "time-of-day-action"
    ? [match.id, match.category, localDateKey(now), match.bucket.hourBand]
    : [match.id, match.category, isoWeekKey(now)];
  return `pattern:${sha256Hex(JSON.stringify(slot))}`;
}

function localDateKey(date: Date): string {
  return [
    date.getFullYear().toString().padStart(4, "0"),
    (date.getMonth() + 1).toString().padStart(2, "0"),
    date.getDate().toString().padStart(2, "0")
  ].join("-");
}

function isoWeekKey(date: Date): string {
  const target = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const isoDay = target.getUTCDay() || 7;
  target.setUTCDate(target.getUTCDate() + 4 - isoDay);
  const isoYear = target.getUTCFullYear();
  const yearStart = new Date(Date.UTC(isoYear, 0, 1));
  const week = Math.ceil((((target.getTime() - yearStart.getTime()) / 86_400_000) + 1) / 7);
  return `${isoYear.toString().padStart(4, "0")}-W${week.toString().padStart(2, "0")}`;
}

function patternEffectBlockedMessage(patternId: string, effect: OutboundEffectView): string {
  const effectId = effect.binding.effectId;
  if (effect.state === "unknown") {
    const detail = effect.unknownDetail ? ` (${redactSecretsInText(effect.unknownDetail).slice(0, 500)})` : "";
    return `${patternId}: delivery is unknown for effect ${effectId}${detail}; reconcile manually with muse messaging effects reconcile and do not retry this slot`;
  }
  if (effect.state === "reconciled-not-delivered") {
    return `${patternId}: effect ${effectId} was reconciled as not delivered; the current natural slot is sealed`;
  }
  return `${patternId}: outbound effect ${effectId} is safely blocked in state ${effect.state}`;
}
