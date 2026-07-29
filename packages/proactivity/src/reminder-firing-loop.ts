import { dirname, join } from "node:path";

import {
  computeOutboundEffectPayloadHash,
  dispatchDurableEffectOnce,
  dispatchOutboundEffectOnce,
  readOutboundEffect,
  type MessagingProviderRegistry,
  type OutboundEffectView
} from "@muse/messaging";
import { composeIdentityPrompt } from "@muse/prompts";
import { errorMessage, redactSecretsInText, sha256Hex } from "@muse/shared";

import { appendReminderHistoryStrictOnce, readReminderHistoryStrict, withRequiredProcessLock } from "@muse/stores";
import {
  filterReminders,
  fireReminder,
  mutateReminders,
  type PersistedReminder
} from "@muse/stores";
import type {
  ProactiveActivitySource,
  ProactiveAgentRuntimeLike
} from "./proactive-notice-loop.js";
import { isRecentProactiveActivity } from "./presence.js";

const MAX_HISTORY_GAP_WARNING_LENGTH = 500;

/**
 * Phase B firing engine — see `docs/design/reminder-firing.md`.
 *
 * Reads due reminders, fans out to the messaging registry, marks
 * each delivered one as fired, and persists the new state with one
 * atomic write. Pure code path: no LLM, no daemon. The CLI's
 * `muse remind run` calls it directly; a follow-up iter wires it
 * into a scheduler tick so the same engine runs every minute
 * without the user invoking it.
 *
 * The function is data-only — `registry` and `now` are injected so
 * tests can supply fakes without touching env or the real
 * messenger APIs.
 *
 * The whole select→send→mark section runs under the cross-process
 * `withProcessLock` (`${options.file}.firing.lock`, generalized from the
 * digest flush's `withDigestLock` — `@muse/stores/digest-lock.ts`) because the
 * api daemon's tick and the CLI daemon's tick read the SAME reminders
 * file: without a real lock both can read a reminder as due and both
 * deliver it before either marks it fired. A LIVE held lock returns
 * `outcome: "lock-held"` immediately with no send attempted; a broken
 * lock (non-contention fs error) fails OPEN — the tick still runs
 * unlocked rather than silently skipping reminders.
 */

export interface RunDueRemindersOptions {
  readonly file: string;
  readonly registry: Pick<MessagingProviderRegistry, "has" | "send">;
  readonly providerId: string;
  readonly destination: string;
  /** Canonical outbound-effect ledger. Production callers place it beside the action log. */
  readonly effectFile?: string;
  readonly now?: () => Date;
  /**
   * When set, every delivery attempt (success or failure) is
   * appended to this file via `appendReminderHistory`. Records the
   * resolved providerId/destination so the user can audit "did the
   * 9am reminder actually land?" weeks later — even if the source
   * reminder has since been cleared.
   */
  readonly historyFile?: string;
  /**
   * Phase D (mirrors proactive surfacing) — when all three are set
   * AND the activity source reports activity within
   * `activeSessionWindowMs`, the firing loop spawns a one-shot
   * agent run with a JARVIS-style synthesis prompt and uses the
   * LLM reply as the delivered message instead of the raw
   * `reminder.text`. Falls back to the flat text on missing wires,
   * stale window, empty reply, or synthesis error (the failure is
   * recorded in `summary.errors` but the reminder still fires with
   * the original text so the user never misses a beat).
   */
  readonly agentRuntime?: ProactiveAgentRuntimeLike;
  readonly agentModel?: string;
  readonly activitySource?: ProactiveActivitySource;
  /** Default 5 minutes (300_000 ms). */
  readonly activeSessionWindowMs?: number;
}

export interface RunDueRemindersSummary {
  readonly delivered: number;
  readonly due: number;
  readonly errors: readonly string[];
  readonly fired: readonly PersistedReminder[];
  /** Set only when another daemon held the firing lock for this tick — no
   *  read, send, or mark was attempted at all. Absent on every other path. */
  readonly outcome?: "lock-held" | "lock-error";
}

/**
 * Provider-neutral identity for one exact reminder occurrence. Reminders do
 * not carry a mutable revision counter, so the canonical due time is the
 * occurrence generation: recurrence advances it and therefore creates a new
 * dedup key, while replay of the same occurrence remains byte-identical.
 */
export interface ReminderTriggerEnvelope {
  readonly dedupKey: string;
  readonly generation: string;
  readonly occurredAt: string;
  readonly schemaVersion: 1;
  readonly source: "reminder";
  readonly sourceId: string;
}

export async function runDueReminders(options: RunDueRemindersOptions): Promise<RunDueRemindersSummary> {
  const has = options.registry.has;
  const send = options.registry.send;
  const stable = {
    ...options,
    destination: options.destination,
    effectFile: options.effectFile ?? join(dirname(options.file), "outbound-effects.json"),
    file: options.file,
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
  const lockOutcome = await withRequiredProcessLock(lockPath, () => runDueRemindersUnderLock(stable));
  if (lockOutcome.kind === "lock-held") {
    return { delivered: 0, due: 0, errors: [], fired: [], outcome: "lock-held" };
  }
  if (lockOutcome.kind === "lock-error") {
    return { delivered: 0, due: 0, errors: [`reminder-tick: lock acquisition failed: ${lockOutcome.error}`], fired: [], outcome: "lock-error" };
  }
  return lockOutcome.value;
}

async function runDueRemindersUnderLock(options: RunDueRemindersOptions): Promise<RunDueRemindersSummary> {
  const now = options.now ?? (() => new Date());
  let summary: RunDueRemindersSummary = { delivered: 0, due: 0, errors: [], fired: [] };
  await mutateReminders(options.file, async (all) => {
    const due = filterReminders(all, "due", now);
    if (due.length === 0) return all;

    const errors: string[] = [];
    let delivered = 0;
    const fired: PersistedReminder[] = [];
    let next: readonly PersistedReminder[] = all;
    const phaseDActive = isActiveSessionWindow(now(), options);

    for (const reminder of due) {
      const providerId = reminder.via?.providerId ?? options.providerId;
      const destination = reminder.via?.destination ?? options.destination;
      const trigger = buildReminderTriggerEnvelope(reminder);
      const effectId = trigger.dedupKey;
      if (
        providerId.trim().length === 0
        || providerId !== providerId.trim()
        || destination.trim().length === 0
        || destination !== destination.trim()
      ) {
        errors.push(`${reminder.id}: delivery route is unavailable or invalid`);
        continue;
      }
      try {
        if (options.historyFile) {
          await readReminderHistoryStrict(options.historyFile, 500);
        }
        const existing = await readOutboundEffect(options.effectFile!, effectId);
        if (
          existing
          && (existing.binding.providerId !== providerId || existing.binding.destination !== destination)
        ) {
          throw new Error(`outbound effect ${effectId} route binding conflicts with the current reminder`);
        }
        let deliveredText: string | undefined;
        let effect: OutboundEffectView;
        if (!existing) {
          if (!options.registry.has(providerId)) {
            errors.push(`${reminder.id}: delivery route is unavailable or invalid`);
            continue;
          }
          deliveredText = phaseDActive
            ? await synthesizeReminderText(reminder, options).catch((cause) => {
                const message = errorMessage(cause);
                errors.push(`${reminder.id} synthesis: ${message}`);
                return reminder.text;
              })
            : reminder.text;
          effect = await dispatchOutboundEffectOnce({
            destination,
            effectFile: options.effectFile!,
            effectId,
            now,
            providerId,
            registry: options.registry,
            text: deliveredText
          });
        } else if (existing.state === "prepared") {
          effect = await dispatchDurableEffectOnce({
            destination: existing.binding.destination,
            dispatch: async () => {
              throw new Error("prepared reminder replay must never dispatch");
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
        if (effect.state === "unknown") {
          const detail = effect.unknownDetail
            ? ` (${redactSecretsInText(effect.unknownDetail)})`
            : "";
          errors.push(
            `${reminder.id}: delivery is unknown for effect ${effectId}${detail}; reconcile manually with muse messaging effects reconcile and do not retry with a new effect ID`
          );
          continue;
        }
        if (effect.state === "reconciled-not-delivered") {
          errors.push(
            `${reminder.id}: effect ${effectId} was reconciled as not delivered; create or reschedule a new reminder instead of reusing this effect ID`
          );
          continue;
        }
        if (effect.state !== "accepted" && effect.state !== "reconciled-accepted") {
          throw new Error(`outbound effect ${effectId} is safely blocked in state ${effect.state}`);
        }
        const receipt = effect.receipt;
        if (!receipt) throw new Error(`accepted outbound effect ${effectId} has no durable receipt`);
        if (options.historyFile) {
          const historyRecorded = await ensureDeliveredHistory(
            options.historyFile,
            reminder,
            effect,
            deliveredText
          );
          if (!historyRecorded) {
            errors.push(acceptedHistoryGapWarning(effect.binding.effectId));
          }
        }
        const firedAtIso = receipt.receivedAt;
        const updated = fireReminder(next, reminder.id, firedAtIso);
        const justFired = updated?.find((entry) => entry.id === reminder.id);
        if (updated) next = updated;
        if (justFired) fired.push(justFired);
        delivered += 1;
      } catch (cause) {
        const message = redactSecretsInText(errorMessage(cause));
        errors.push(`${reminder.id}: ${message}`);
      }
    }
    summary = { delivered, due: due.length, errors, fired };
    return next;
  });
  return summary;
}

export function reminderOccurrenceEffectId(reminderId: string, dueAt: string): string {
  return `reminder:${sha256Hex(JSON.stringify([reminderId, dueAt]))}`;
}

export function buildReminderTriggerEnvelope(
  reminder: Pick<PersistedReminder, "dueAt" | "id">
): ReminderTriggerEnvelope {
  return {
    dedupKey: reminderOccurrenceEffectId(reminder.id, reminder.dueAt),
    generation: reminder.dueAt,
    occurredAt: reminder.dueAt,
    schemaVersion: 1,
    source: "reminder",
    sourceId: reminder.id
  };
}

async function ensureDeliveredHistory(
  historyFile: string,
  reminder: PersistedReminder,
  effect: OutboundEffectView,
  deliveredText: string | undefined
): Promise<boolean> {
  const receipt = effect.receipt;
  if (!receipt) return false;
  const existing = (await readReminderHistoryStrict(historyFile, 500)).find(
    (entry) => entry.effectId === effect.binding.effectId
  );
  if (existing) {
    if (
      existing.destination !== effect.binding.destination
      || existing.firedAtIso !== receipt.receivedAt
      || existing.providerId !== effect.binding.providerId
      || existing.reminderId !== reminder.id
      || existing.status !== "delivered"
      || historyPayloadHash(existing.text, effect) !== effect.binding.payloadHash
    ) {
      throw new Error(`reminder history conflicts with outbound effect ${effect.binding.effectId}`);
    }
    return true;
  }
  const candidate = deliveredText ?? reminder.text;
  if (historyPayloadHash(candidate, effect) !== effect.binding.payloadHash) {
    return false;
  }
  await appendReminderHistoryStrictOnce(historyFile, {
    destination: effect.binding.destination,
    effectId: effect.binding.effectId,
    firedAtIso: receipt.receivedAt,
    providerId: effect.binding.providerId,
    reminderId: reminder.id,
    status: "delivered",
    text: candidate
  });
  return true;
}

function historyPayloadHash(text: string, effect: OutboundEffectView): string {
  return computeOutboundEffectPayloadHash({
    destination: effect.binding.destination,
    providerId: effect.binding.providerId,
    text: redactSecretsInText(text)
  });
}

function acceptedHistoryGapWarning(effectId: string): string {
  return redactSecretsInText(
    `accepted effect ${effectId}: provider receipt is authoritative, but exact delivered text is unavailable; ` +
    "factual reminder history remains absent and was not fabricated"
  ).slice(0, MAX_HISTORY_GAP_WARNING_LENGTH);
}

function isActiveSessionWindow(now: Date, options: RunDueRemindersOptions): boolean {
  if (!options.agentRuntime || !options.agentModel || !options.activitySource) {
    return false;
  }
  return isRecentProactiveActivity(
    options.activitySource.lastActivityMs(),
    now.getTime(),
    options.activeSessionWindowMs
  );
}

export const REMINDER_PHASE_D_SYSTEM_PROMPT = composeIdentityPrompt(
  `A reminder the
user set earlier just came due. Compose a single short heads-up
(one or two sentences, ≤ 200 chars) that:
- Names the reminder text and signals it's now (not later)
- Suggests ONE concrete next step the user can take, when an
  obvious one fits the reminder. Skip the suggestion if nothing
  obvious — never invent context.

No emojis, no markdown, no lists, no JSON. Plain text only.`
);

async function synthesizeReminderText(
  reminder: PersistedReminder,
  options: RunDueRemindersOptions
): Promise<string> {
  if (!options.agentRuntime || !options.agentModel) {
    return reminder.text;
  }
  const dueLine = reminder.dueAt ? `due at: ${reminder.dueAt}` : `due: now`;
  const factSheet = [
    `kind: reminder`,
    `reminder text: ${reminder.text}`,
    dueLine
  ].join("\n");
  const result = await options.agentRuntime.run({
    // Machine-authored fact sheet, not a human turn — keeps the
    // register/brevity personalization layer off (it would truncate this).
    metadata: { internalTurn: true },
    messages: [
      { content: REMINDER_PHASE_D_SYSTEM_PROMPT, role: "system" },
      { content: factSheet, role: "user" }
    ],
    model: options.agentModel
  });
  const reply = result.response.output.trim();
  return reply.length > 0 ? reply : reminder.text;
}
