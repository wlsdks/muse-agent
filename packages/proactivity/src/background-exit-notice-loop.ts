/**
 * On-exit proactive notice (DS-10) — turn a background process finishing
 * into a one-shot "your job '<label>' finished" heads-up.
 *
 * Muse's background-process registry (`@muse/stores`) already records a
 * spawned process moving to `exited` / `failed` (both while Muse is up, via
 * the child's `onExit` hook, AND across a restart, via
 * `reconcileBackgroundProcesses` marking a dead-while-down PID `exited`).
 * This loop RIDES that existing exit signal — it does not spawn or watch
 * anything — so a single poll covers the in-process and the crash-restart
 * cases uniformly.
 *
 * Design choice vs. a new scheduler `on-exit` kind: the exit signal already
 * lands in the store, and `@muse/stores` cannot depend on the notice broker
 * (that is a layering inversion). So the natural, least-invasive home is a
 * poll here — mirroring every other `runDue*` proactive trigger — rather
 * than extending the cron schema or coupling the store layer to delivery.
 *
 * Fail-closed one-shot: messaging delivery is acquired through the durable
 * outbound-effect ledger, then the process id is persisted to the notified
 * sidecar only after a durable accepted receipt. A restart repairs accepted
 * effects without calling the provider again, while prepared/unknown effects
 * stay sealed for explicit reconciliation. Broker-only and non-effect
 * interruption outcomes retain their sidecar one-shot.
 */

import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";

import {
  computeOutboundEffectPayloadHash,
  dispatchDurableEffectOnce,
  dispatchOutboundEffectOnce,
  readOutboundEffect,
  type MessagingProviderRegistry,
  type OutboundEffectView
} from "@muse/messaging";
import { errorMessage, redactSecretsInText, sha256Hex } from "@muse/shared";
import {
  atomicWriteFile,
  avoidedSourceKeys,
  readBackgroundProcesses,
  readTrustLedger,
  withRequiredProcessLock,
  type BackgroundProcessRecord
} from "@muse/stores";

import { applyInterruptionBudget, resolveInterruptionBudgetCaps, type InterruptionBudgetWiring } from "./interruption-gate.js";
import type { AgentInitiatedNoticeBrokerLike } from "./proactive-notice-loop.js";
import { isVetoed } from "./veto-key.js";

/** Terminal states that warrant a heads-up. `killed` is user-initiated
 *  (they ran `muse bg stop`) so it is deliberately excluded — the user
 *  already knows it stopped. */
const NOTIFY_STATUSES: ReadonlySet<string> = new Set(["exited", "failed"]);

export interface BackgroundExitNotifiedSidecar {
  readonly notifiedIds: readonly string[];
}

/** Read the one-shot sidecar. Missing / corrupt degrades to empty, never throws. */
export async function readBackgroundExitNotified(file: string): Promise<ReadonlySet<string>> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    return new Set();
  }
  try {
    const parsed = JSON.parse(raw) as Partial<BackgroundExitNotifiedSidecar>;
    if (Array.isArray(parsed.notifiedIds)) {
      return new Set(parsed.notifiedIds.filter((id): id is string => typeof id === "string"));
    }
  } catch {
    /* corrupt → treat as none notified; durable messaging effects still
       prevent provider re-dispatch when a receipt was already recorded */
  }
  return new Set();
}

async function writeBackgroundExitNotified(file: string, ids: ReadonlySet<string>): Promise<void> {
  const payload: BackgroundExitNotifiedSidecar = { notifiedIds: [...ids] };
  await atomicWriteFile(file, `${JSON.stringify(payload, null, 2)}\n`);
}

/** Short, redaction-safe label for a background process (its command, capped). */
export function backgroundJobLabel(record: BackgroundProcessRecord): string {
  const command = record.command.trim();
  const firstLine = command.split("\n")[0] ?? command;
  return firstLine.length > 60 ? `${firstLine.slice(0, 57)}…` : firstLine;
}

/** One-line notice text for a finished background job. */
export function backgroundExitNoticeText(record: BackgroundProcessRecord): string {
  const label = backgroundJobLabel(record);
  if (record.status === "failed") {
    const code = typeof record.exitCode === "number" ? ` (exit code ${record.exitCode.toString()})` : "";
    return `⚠️ background job '${label}' failed${code}`;
  }
  const code = typeof record.exitCode === "number" ? ` — exit code ${record.exitCode.toString()}` : "";
  return `✅ background job '${label}' finished${code}`;
}

export interface RunDueBackgroundExitNoticesOptions {
  /** Background-process registry file (`~/.muse/background-processes.json`). */
  readonly storeFile: string;
  /** One-shot sidecar tracking which exited process ids have been resolved. */
  readonly notifiedFile: string;
  /**
   * Notice broker — fans the heads-up to live chat-stream subscribers,
   * mirroring the proactive-notice loop's broker fan-out.
   */
  readonly broker?: AgentInitiatedNoticeBrokerLike;
  readonly brokerUserId?: string;
  /** Optional messaging delivery (Telegram / Discord / log) for the notice. */
  readonly messagingRegistry?: Pick<MessagingProviderRegistry, "has" | "send">;
  readonly providerId?: string;
  readonly destination?: string;
  /** Canonical outbound-effect ledger. Production callers place it beside the action log. */
  readonly effectFile?: string;
  /** Injectable clock. Default `() => new Date()`. */
  readonly now?: () => Date;
  /**
   * Opt-in interruption budget (unset → identical to pre-budget behavior).
   * Gates only the `messagingRegistry` leg — the broker fan-out (live
   * chat-stream subscribers) is unaffected. Within budget, the messaging
   * send still happens exactly as before; over budget, it's skipped and the
   * notice text lands in the digest queue instead. Non-effect outcomes are
   * marked only after the budget decision returns.
   */
  readonly interruptionBudget?: InterruptionBudgetWiring;
}

export interface RunDueBackgroundExitNoticesSummary {
  /** Terminal, not-yet-notified records found this tick. */
  readonly pending: number;
  /** Notices actually delivered this tick. */
  readonly notified: number;
  /** One string per delivery or persistence failure. */
  readonly errors: readonly string[];
  /** Another daemon owns this tick, so no read, mark, or delivery was attempted. */
  readonly outcome?: "lock-held" | "lock-error";
}

/**
 * Poll the background registry and fire a one-shot notice for each newly
 * finished (exited/failed) process. A record already in the notified sidecar
 * is skipped. Messaging replay safety comes from the durable effect ledger;
 * broker-only and non-effect outcomes use the sidecar as their one-shot seal.
 */
export async function runDueBackgroundExitNotices(
  options: RunDueBackgroundExitNoticesOptions
): Promise<RunDueBackgroundExitNoticesSummary> {
  const has = options.messagingRegistry?.has;
  const send = options.messagingRegistry?.send;
  const publish = options.broker?.publish;
  const stable = {
    ...options,
    effectFile: options.effectFile ?? join(dirname(options.notifiedFile), "outbound-effects.json"),
    now: options.now ?? (() => new Date()),
    ...(options.interruptionBudget ? { interruptionBudget: { ...options.interruptionBudget } } : {}),
    ...(options.messagingRegistry
      ? {
          messagingRegistry: {
            has: typeof has === "function" ? has.bind(options.messagingRegistry) : () => false,
            send: typeof send === "function"
              ? send.bind(options.messagingRegistry)
              : async () => { throw new Error("messaging registry send is unavailable"); }
          }
        }
      : {}),
    ...(publish ? { broker: { publish: publish.bind(options.broker) } } : {})
  } as const;
  // The API daemon and CLI daemon poll the same background-process registry.
  // Hold one cross-process lock across select -> effect/sidecar transition so both
  // cannot observe one terminal process and deliver duplicate notices.
  const lockOutcome = await withRequiredProcessLock(
    `${stable.notifiedFile}.firing.lock`,
    () => runDueBackgroundExitNoticesUnderLock(stable)
  );
  if (lockOutcome.kind === "lock-held") {
    return { errors: [], notified: 0, outcome: "lock-held", pending: 0 };
  }
  if (lockOutcome.kind === "lock-error") {
    return {
      errors: [`background-exit: lock acquisition failed: ${lockOutcome.error}`],
      notified: 0,
      outcome: "lock-error",
      pending: 0
    };
  }
  return lockOutcome.value;
}

async function runDueBackgroundExitNoticesUnderLock(
  options: RunDueBackgroundExitNoticesOptions
): Promise<RunDueBackgroundExitNoticesSummary> {
  const now = options.now ?? (() => new Date());
  const records = await readBackgroundProcesses(options.storeFile);
  const notified = new Set(await readBackgroundExitNotified(options.notifiedFile));

  const pending = records.filter(
    (record) => NOTIFY_STATUSES.has(record.status) && !notified.has(record.id)
  );
  if (pending.length === 0) {
    return { errors: [], notified: 0, pending: 0 };
  }

  const errors: string[] = [];
  let delivered = 0;
  const at = now();

  const avoidedSources = options.interruptionBudget?.trustLedgerFile
    ? avoidedSourceKeys(await readTrustLedger(options.interruptionBudget.trustLedgerFile).catch(() => []))
    : undefined;

  for (const record of pending) {
    const text = redactSecretsInText(backgroundExitNoticeText(record));
    const generatedAt = at.toISOString();
    const sourceKey = `background-exit:${record.id}`;
    // A veto is stronger than the interruption budget's digest fallback (the
    // user explicitly said "stop these"), so it silences the broker's
    // live-stream fan-out too — not just the messaging leg the budget
    // otherwise gates alone.
    const vetoed = isVetoed(avoidedSources, sourceKey);
    try {
      const brokerConfigured = Boolean(options.broker && options.brokerUserId);
      const messagingConfigured = Boolean(options.messagingRegistry && options.providerId && options.destination);
      if (!messagingConfigured) {
        await markBackgroundExitNotified(options.notifiedFile, notified, record.id);
        if (brokerConfigured && !vetoed) {
          try {
            options.broker!.publish(options.brokerUserId!, {
              generatedAt,
              kind: "background_process_exited",
              sourceId: record.id,
              text
            });
            delivered += 1;
          } catch (cause) {
            errors.push(`${record.id} broker: ${describe(cause)}`);
          }
        } else if (!vetoed) {
          errors.push(`${record.id}: no delivery sink configured`);
        }
        continue;
      }

      const messagingRegistry = options.messagingRegistry!;
      const providerId = options.providerId!;
      const destination = options.destination!;
      if (
        providerId.trim().length === 0
        || providerId !== providerId.trim()
        || destination.trim().length === 0
        || destination !== destination.trim()
      ) {
        errors.push(`${record.id}: delivery route is unavailable or invalid`);
        continue;
      }
      const effectId = backgroundExitEffectId(record.id);
      const payloadHash = computeOutboundEffectPayloadHash({ destination, providerId, text });
      const existing = await readOutboundEffect(options.effectFile!, effectId);
      if (
        existing
        && (
          existing.binding.providerId !== providerId
          || existing.binding.destination !== destination
          || existing.binding.payloadHash !== payloadHash
        )
      ) {
        throw new Error(`outbound effect ${effectId} binding conflicts with the current background exit`);
      }

      if (existing) {
        let terminal = existing;
        if (existing.state === "prepared") {
          terminal = await dispatchDurableEffectOnce({
            destination: existing.binding.destination,
            dispatch: async () => {
              throw new Error("prepared background-exit replay must never dispatch");
            },
            effectFile: options.effectFile!,
            effectId,
            now,
            payloadHash: existing.binding.payloadHash,
            providerId: existing.binding.providerId
          });
        }
        if (terminal.state === "accepted" || terminal.state === "reconciled-accepted") {
          if (!terminal.receipt) {
            throw new Error(`accepted outbound effect ${effectId} has no durable receipt`);
          }
          await markBackgroundExitNotified(options.notifiedFile, notified, record.id);
          delivered += 1;
        } else if (terminal.state === "reconciled-not-delivered") {
          await markBackgroundExitNotified(options.notifiedFile, notified, record.id);
        } else {
          errors.push(backgroundExitEffectBlockedMessage(record.id, terminal));
        }
        continue;
      }

      if (vetoed) {
        await markBackgroundExitNotified(options.notifiedFile, notified, record.id);
        continue;
      }

      let effect: OutboundEffectView | undefined;
      let outcome: "delivered" | "digested" | "skipped" = "delivered";
      const deliver = async (): Promise<void> => {
        if (!messagingRegistry.has(providerId)) {
          throw new Error("delivery route is unavailable or invalid");
        }
        effect = await dispatchOutboundEffectOnce({
          destination,
          effectFile: options.effectFile!,
          effectId,
          now,
          providerId,
          registry: messagingRegistry,
          text
        });
        if (effect.state !== "accepted" && effect.state !== "reconciled-accepted") {
          throw new Error(backgroundExitEffectBlockedMessage(record.id, effect));
        }
      };

      if (options.interruptionBudget) {
        const budget = options.interruptionBudget;
        const result = await applyInterruptionBudget({
          avoidedSources,
          caps: resolveInterruptionBudgetCaps(budget),
          deliver,
          digestFile: budget.digestFile,
          errorLogger: (message) => errors.push(`${record.id}: ${message}`),
          ...(budget.lastDeliveryFile ? { lastDeliveryFile: budget.lastDeliveryFile } : {}),
          ledgerFile: budget.ledgerFile,
          now: at,
          source: "background-exit",
          sourceId: record.id,
          sourceKey,
          text,
          title: backgroundJobLabel(record)
        });
        outcome = result.outcome;
      } else {
        await deliver();
      }

      if (outcome === "delivered") {
        if (!effect?.receipt) {
          throw new Error(`accepted outbound effect ${effectId} has no durable receipt`);
        }
        await markBackgroundExitNotified(options.notifiedFile, notified, record.id);
        delivered += 1;
      } else {
        // Digest/veto branches create no effect. Mark only after the budget
        // decision returns; messaging recovery must never be traded for
        // digest crash idempotency.
        await markBackgroundExitNotified(options.notifiedFile, notified, record.id);
      }
      if (
        outcome !== "skipped"
        && brokerConfigured
        && (outcome === "digested" || effect?.state === "accepted" || effect?.state === "reconciled-accepted")
      ) {
        try {
          options.broker!.publish(options.brokerUserId!, {
            generatedAt,
            kind: "background_process_exited",
            sourceId: record.id,
            text
          });
          if (outcome === "digested") delivered += 1;
        } catch (cause) {
          errors.push(`${record.id} broker: ${describe(cause)}`);
        }
      }
    } catch (cause) {
      const message = redactSecretsInText(describe(cause));
      errors.push(message.startsWith(`${record.id}: `) ? message : `${record.id}: ${message}`);
    }
  }

  return { errors, notified: delivered, pending: pending.length };
}

function describe(cause: unknown): string {
  return errorMessage(cause);
}

export function backgroundExitEffectId(recordId: string): string {
  return `background-exit:${sha256Hex(JSON.stringify([recordId]))}`;
}

async function markBackgroundExitNotified(
  file: string,
  notified: Set<string>,
  recordId: string
): Promise<void> {
  if (notified.has(recordId)) return;
  notified.add(recordId);
  try {
    await writeBackgroundExitNotified(file, notified);
  } catch (cause) {
    notified.delete(recordId);
    throw new Error(`${recordId}: sidecar write failed: ${describe(cause)}`, { cause });
  }
}

function backgroundExitEffectBlockedMessage(recordId: string, effect: OutboundEffectView): string {
  const effectId = effect.binding.effectId;
  if (effect.state === "unknown") {
    const detail = effect.unknownDetail ? ` (${redactSecretsInText(effect.unknownDetail).slice(0, 500)})` : "";
    return `${recordId}: delivery is unknown for effect ${effectId}${detail}; reconcile manually with muse messaging effects reconcile and do not retry this record`;
  }
  if (effect.state === "reconciled-not-delivered") {
    return `${recordId}: effect ${effectId} was reconciled as not delivered; this exit is sealed`;
  }
  return `${recordId}: outbound effect ${effectId} is safely blocked in state ${effect.state}`;
}
