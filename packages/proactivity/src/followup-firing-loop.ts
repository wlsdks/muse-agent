/**
 * Self-followup firing engine — step 4 of
 * `docs/design/agent-self-followup.md`.
 *
 * Counterpart to `runDueReminders`: reads `~/.muse/followups.json`,
 * selects entries whose `status === "scheduled"` and
 * `scheduledFor <= now`, asks the model to compose the follow-up
 * message it promised, sends each one through the messaging
 * registry, and flips the entry to `fired`.
 *
 * Pure data-only function — `modelProvider`, `registry`, and `now`
 * are injected so tests run without env, real API keys, or a real
 * messenger. The `setInterval`-style daemon that drives this on
 * `MUSE_FOLLOWUP_TICK_MS` (default 60s) lives in `apps/api`
 * (`followup-tick.ts`), mirroring `reminder-tick.ts` / `proactive-tick.ts`.
 *
 * Why this exists separately from `reminder-firing-loop.ts`:
 *   - followups carry the *agent's own* prior commitment (summary +
 *     origin turn hash), not a user-authored reminder text;
 *   - synthesis is the primary path, not an opt-in Phase D; there's
 *     no raw-text fallback because a followup without composition
 *     is just a stale timestamp.
 *   - the store schema and lifecycle (`scheduled → fired | cancelled`)
 *     are owned by `personal-followups-store.ts`, not the reminder store.
 */

import { dirname, join } from "node:path";

import {
  dispatchDurableEffectOnce,
  dispatchOutboundEffectOnce,
  readOutboundEffect,
  type MessagingProviderRegistry,
  type OutboundEffectView
} from "@muse/messaging";
import { composeIdentityPrompt } from "@muse/prompts";
import { errorMessage, redactSecretsInText, sha256Hex } from "@muse/shared";

import {
  avoidedSourceKeys,
  compareFollowupsByScheduledFor,
  markFollowupFired,
  readFollowups,
  readFollowupsStrict,
  readTrustLedger,
  withRequiredProcessLock,
  type PersistedFollowup
} from "@muse/stores";
import { applyInterruptionBudget, resolveInterruptionBudgetCaps, type InterruptionBudgetWiring } from "./interruption-gate.js";
import type { ProactiveModelProviderLike } from "./proactive-notice-loop.js";

export interface RunDueFollowupsOptions {
  readonly file: string;
  readonly registry: Pick<MessagingProviderRegistry, "has" | "send">;
  readonly providerId: string;
  readonly destination: string;
  /** Canonical outbound-effect ledger. Production callers place it beside the action log. */
  readonly effectFile?: string;
  /** Required — followups synthesize their delivery message. */
  readonly modelProvider: ProactiveModelProviderLike;
  readonly model: string;
  readonly now?: () => Date;
  /**
   * Cap per tick so a long-stalled daemon catching up on a week's
   * worth of missed followups doesn't burn the model budget or
   * spam the messenger in one burst. Default 5.
   */
  readonly maxPerTick?: number;
  /**
   * Opt-in interruption budget (unset → identical to pre-budget behavior).
   * Within budget, a due followup still delivers exactly as before; over
   * budget, the send is skipped and the composed text lands in the digest
   * queue instead — the followup is still marked `fired` either way, so a
   * suppressed one is never re-synthesized and re-attempted next tick.
   */
  readonly interruptionBudget?: InterruptionBudgetWiring;
}

export interface RunDueFollowupsSummary {
  readonly delivered: number;
  readonly due: number;
  readonly errors: readonly string[];
  readonly fired: readonly PersistedFollowup[];
  /** Set only when another daemon held the firing lock for this tick — no
   *  read, send, or mark was attempted at all. Absent on every other path. */
  readonly outcome?: "lock-held" | "lock-error";
}

const DEFAULT_MAX_PER_TICK = 5;

export const FOLLOWUP_SYSTEM_PROMPT = composeIdentityPrompt(
  `Earlier you told
the user you would follow up at a specific time, and that time has
now arrived. Compose the single short message you said you would
send (one or two sentences, ≤ 240 chars):
- Open with the followup itself — no greetings, no "as I promised".
- Concrete, useful, present tense. If a question is the right
  followup, ask it directly.
- If your prior promise was vague ("I'll check in"), make the
  check-in concrete — pick the most useful thing to actually say
  given the summary, don't echo the vagueness.

No emojis, no markdown, no lists, no JSON. Plain text only.`
);

/**
 * Fire due followups. The whole select→send→mark section runs under the
 * cross-process `withRequiredProcessLock` (`${options.file}.firing.lock`, the same
 * generalized lock reminder + checkin firing use — `@muse/stores/digest-lock.ts`)
 * because the api daemon's tick (`followup-tick.ts`) and the CLI daemon's tick
 * (`commands-daemon-register.ts`) read the SAME followups file: `markFollowupFired`
 * is atomic per-item, not mutual exclusion, so without a real lock both can read a
 * followup as due and both deliver it before either marks it fired. A LIVE held
 * lock returns `outcome: "lock-held"` immediately with no send attempted; a broken
 * lock fails closed as `outcome: "lock-error"` because an unlocked external send
 * could duplicate delivery.
 */
export async function runDueFollowups(options: RunDueFollowupsOptions): Promise<RunDueFollowupsSummary> {
  const generate = options.modelProvider.generate;
  const has = options.registry.has;
  const send = options.registry.send;
  const stable = {
    ...options,
    destination: options.destination,
    effectFile: options.effectFile ?? join(dirname(options.file), "outbound-effects.json"),
    file: options.file,
    ...(options.interruptionBudget ? { interruptionBudget: { ...options.interruptionBudget } } : {}),
    model: options.model,
    modelProvider: { generate: generate.bind(options.modelProvider) },
    now: options.now ?? (() => new Date()),
    providerId: options.providerId,
    registry: {
      has: typeof has === "function" ? has.bind(options.registry) : () => false,
      send: typeof send === "function"
        ? send.bind(options.registry)
        : async () => { throw new Error("messaging registry send is unavailable"); }
    }
  } as const;
  const lockPath = `${stable.file}.firing.lock`;
  const lockOutcome = await withRequiredProcessLock(lockPath, () => runDueFollowupsUnderLock(stable));
  if (lockOutcome.kind === "lock-held") {
    return { delivered: 0, due: 0, errors: [], fired: [], outcome: "lock-held" };
  }
  if (lockOutcome.kind === "lock-error") {
    return {
      delivered: 0,
      due: 0,
      errors: [`followup-tick: lock acquisition failed: ${lockOutcome.error}`],
      fired: [],
      outcome: "lock-error"
    };
  }
  return lockOutcome.value;
}

async function runDueFollowupsUnderLock(options: RunDueFollowupsOptions): Promise<RunDueFollowupsSummary> {
  const now = options.now ?? (() => new Date());
  // `??` does NOT catch NaN/Infinity: a non-numeric env knob
  // (MUSE_FOLLOWUP_MAX_PER_TICK="5x" → Number(...) → NaN) would make
  // `Math.max(1, NaN)` → NaN, and `.slice(0, NaN)` drops every due
  // followup — silently firing zero forever. Fall back to the default
  // for non-finite values, matching the scheduler's clampInterval guard.
  const requested = Number.isFinite(options.maxPerTick) ? Math.trunc(options.maxPerTick!) : DEFAULT_MAX_PER_TICK;
  const max = Math.max(1, requested);
  const all = await readFollowups(options.file);
  const cutoffMs = now().getTime();
  // Sort soonest-scheduledFor-first (= most-overdue-first for past times) BEFORE the
  // per-tick cap, so when a backlog exceeds maxPerTick the genuinely most-overdue
  // commitments win the budget instead of an arbitrary file-order slice starving them.
  const due = all
    .filter((entry) => entry.status === "scheduled" && Date.parse(entry.scheduledFor) <= cutoffMs)
    .sort(compareFollowupsByScheduledFor)
    .slice(0, max);

  if (due.length === 0) {
    return { delivered: 0, due: 0, errors: [], fired: [] };
  }

  const errors: string[] = [];
  const fired: PersistedFollowup[] = [];
  let delivered = 0;

  const avoidedSources = options.interruptionBudget?.trustLedgerFile
    ? avoidedSourceKeys(await readTrustLedger(options.interruptionBudget.trustLedgerFile).catch(() => []))
    : undefined;

  for (const followup of due) {
    const effectId = followupOccurrenceEffectId(followup.id, followup.scheduledFor);
    if (
      options.providerId.trim().length === 0
      || options.providerId !== options.providerId.trim()
      || options.destination.trim().length === 0
      || options.destination !== options.destination.trim()
    ) {
      errors.push(`${followup.id}: delivery route is unavailable or invalid`);
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
        throw new Error(`outbound effect ${effectId} route binding conflicts with the current followup`);
      }
      let effect: OutboundEffectView | undefined;
      let digested = false;
      if (!existing) {
        if (!options.registry.has(options.providerId)) {
          errors.push(`${followup.id}: delivery route is unavailable or invalid`);
          continue;
        }
        const text = await synthesizeFollowupText(followup, options);
        if (text.length === 0) {
          errors.push(`${followup.id}: synthesis returned empty text`);
          continue;
        }
        await assertCurrentDueOccurrence(options.file, followup, now());
        const deliver = async (): Promise<void> => {
          await assertCurrentDueOccurrence(options.file, followup, now());
          effect = await dispatchOutboundEffectOnce({
            destination: options.destination,
            effectFile: options.effectFile!,
            effectId,
            now,
            providerId: options.providerId,
            registry: options.registry,
            text
          });
          if (effect.state !== "accepted" && effect.state !== "reconciled-accepted") {
            throw new Error(followupEffectBlockedMessage(followup.id, effect));
          }
        };
        if (options.interruptionBudget) {
          const budget = options.interruptionBudget;
          const result = await applyInterruptionBudget({
            avoidedSources,
            caps: resolveInterruptionBudgetCaps(budget),
            deliver,
            digestFile: budget.digestFile,
            errorLogger: (message) => errors.push(`${followup.id}: ${message}`),
            ...(budget.lastDeliveryFile ? { lastDeliveryFile: budget.lastDeliveryFile } : {}),
            ledgerFile: budget.ledgerFile,
            now: now(),
            source: "followup",
            sourceId: followup.id,
            sourceKey: `followup:${followup.id}`,
            text,
            title: followup.summary
          });
          digested = result.outcome !== "delivered";
        } else {
          await deliver();
        }
      } else if (existing.state === "prepared") {
        effect = await dispatchDurableEffectOnce({
          destination: existing.binding.destination,
          dispatch: async () => {
            throw new Error("prepared followup replay must never dispatch");
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
        errors.push(followupEffectBlockedMessage(followup.id, effect));
        continue;
      }
      const receipt = effect?.receipt;
      if (effect && !receipt) {
        throw new Error(`accepted outbound effect ${effectId} has no durable receipt`);
      }
      // Digest/veto paths deliberately create no effect; accepted sends and
      // restart repair use the provider receipt timestamp.
      const firedAtIso = receipt?.receivedAt ?? now().toISOString();
      const patched = await markFollowupFired(
        options.file,
        followup.id,
        firedAtIso,
        followup.scheduledFor
      );
      if (patched) {
        fired.push(patched);
      } else {
        errors.push(`${followup.id}: occurrence changed before final mark; current followup was preserved`);
        continue;
      }
      if (!digested) {
        delivered += 1;
      }
    } catch (cause) {
      const message = redactSecretsInText(errorMessage(cause));
      errors.push(message.startsWith(`${followup.id}: `) ? message : `${followup.id}: ${message}`);
    }
  }

  return { delivered, due: due.length, errors, fired };
}

export function followupOccurrenceEffectId(followupId: string, scheduledFor: string): string {
  return `followup:${sha256Hex(JSON.stringify([followupId, scheduledFor]))}`;
}

async function assertCurrentDueOccurrence(
  file: string,
  expected: PersistedFollowup,
  now: Date
): Promise<void> {
  const current = (await readFollowupsStrict(file)).find((entry) => entry.id === expected.id);
  if (
    !current
    || current.status !== "scheduled"
    || current.scheduledFor !== expected.scheduledFor
    || Date.parse(current.scheduledFor) > now.getTime()
  ) {
    throw new Error(`${expected.id}: occurrence changed before effect acquisition; delivery was skipped`);
  }
}

function followupEffectBlockedMessage(followupId: string, effect: OutboundEffectView): string {
  const effectId = effect.binding.effectId;
  if (effect.state === "unknown") {
    const detail = effect.unknownDetail ? ` (${redactSecretsInText(effect.unknownDetail).slice(0, 500)})` : "";
    return `${followupId}: delivery is unknown for effect ${effectId}${detail}; reconcile manually with muse messaging effects reconcile and do not retry with a new effect ID`;
  }
  if (effect.state === "reconciled-not-delivered") {
    return `${followupId}: effect ${effectId} was reconciled as not delivered; snooze or upsert a new scheduled occurrence instead of reusing this effect ID`;
  }
  return `${followupId}: outbound effect ${effectId} is safely blocked in state ${effect.state}`;
}

async function synthesizeFollowupText(
  followup: PersistedFollowup,
  options: RunDueFollowupsOptions
): Promise<string> {
  const factSheet = [
    `kind: self-followup`,
    `committed summary: ${followup.summary}`,
    `scheduled for: ${followup.scheduledFor}`,
    `now firing.`
  ].join("\n");
  const result = await options.modelProvider.generate({
    maxOutputTokens: 200,
    messages: [
      { content: FOLLOWUP_SYSTEM_PROMPT, role: "system" },
      { content: factSheet, role: "user" }
    ],
    model: options.model,
    temperature: 0.4
  });
  return result.output.trim();
}
