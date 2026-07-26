/**
 * Confirm / decline a proposed action. The user's `muse propose
 * approve <id>` IS the explicit confirmation outbound-safety requires;
 * only then does the draft execute, exactly once (replay-guarded on
 * status), and every outcome — performed / refused / failed — is
 * appended to the reviewable action log.
 */

import { dirname, join } from "node:path";

import { dispatchOutboundEffectOnce, readOutboundEffect } from "@muse/messaging";
import type { MessagingProviderRegistry, OutboundEffectView } from "@muse/messaging";
import { errorMessage, redactSecretsInText } from "@muse/shared";
import {
  appendActionLog,
  computeProposedActionPayloadHash,
  isProposalActionable,
  patchProposedActionStatus,
  readActionLog,
  readProposedActions,
  withFileLock,
  withFileMutationQueue,
  type ActionLogEntry
} from "@muse/stores";

export interface ConfirmProposedActionOptions {
  readonly file: string;
  readonly id: string;
  readonly payloadHash: string;
  readonly registry: Pick<MessagingProviderRegistry, "send">;
  readonly actionLogFile: string;
  readonly effectFile?: string;
  readonly now?: () => Date;
}

export type ConfirmOutcome =
  | { readonly executed: true; readonly messageId: string }
  | { readonly executed: false; readonly reason: string };

/**
 * Execute a pending proposal once. A proposal that is missing or no
 * longer `pending` is a no-op (the replay guard), so a double
 * `approve` never double-sends.
 */
export async function confirmProposedAction(options: ConfirmProposedActionOptions): Promise<ConfirmOutcome> {
  const stable = {
    actionLogFile: options.actionLogFile,
    effectFile: options.effectFile ?? join(dirname(options.actionLogFile), "outbound-effects.json"),
    file: options.file,
    id: options.id,
    now: options.now ?? (() => new Date()),
    payloadHash: options.payloadHash,
    registry: { send: options.registry.send.bind(options.registry) }
  } as const;
  return withFileMutationQueue(stable.file, async () => {
    const proposals = await readProposedActions(stable.file);
    const found = proposals.find((p) => p.id === stable.id);
    if (!found) {
      return { executed: false, reason: `no proposed action '${stable.id}'` };
    }
    const proposal = { ...found };
    if (proposal.status === "declined") {
      return { executed: false, reason: `already ${proposal.status}` };
    }
    const wasExecuted = proposal.status === "executed";
    const expectedPayloadHash = computeProposedActionPayloadHash(
      proposal.channel,
      proposal.recipient,
      proposal.text,
      proposal.expiresAt
    );
    if (stable.payloadHash !== proposal.payloadHash || proposal.payloadHash !== expectedPayloadHash) {
      return { executed: false, reason: "payload hash mismatch" };
    }
    const effectId = `proposed-action:${proposal.id}`;
    let existingEffect: OutboundEffectView | undefined;
    try {
      existingEffect = await readOutboundEffect(stable.effectFile, effectId);
    } catch (cause) {
      return blockedOutcome(effectId, cause);
    }
    const at = stable.now();
    const attemptAt = Number.isFinite(at.getTime()) ? at.toISOString() : proposal.createdAt;
    if (!existingEffect && !isProposalActionable(proposal, at)) {
      // Past its expiry — outbound-safety: a timed-out approval never sends.
      return { executed: false, reason: "expired" };
    }
    if (proposal.status === "executed" && !existingEffect) {
      return { executed: false, reason: "already executed" };
    }
    let effect: OutboundEffectView;
    try {
      effect = await dispatchOutboundEffectOnce({
        destination: proposal.recipient,
        effectFile: stable.effectFile,
        effectId,
        now: stable.now,
        providerId: proposal.channel,
        registry: stable.registry,
        text: proposal.text
      });
    } catch (cause) {
      await appendFailedAuditBestEffort(stable.actionLogFile, proposal, effectId, attemptAt, cause);
      return blockedOutcome(effectId, cause);
    }
    if (effect.state === "accepted" || effect.state === "reconciled-accepted") {
      const receipt = effect.receipt;
      if (!receipt) return blockedOutcome(effectId, "accepted effect has no durable receipt");
      try {
        await ensureAudit(stable.actionLogFile, {
          detail: `confirmed proposal ${proposal.id} → ${proposal.channel}:${proposal.recipient} (${proposal.payloadHash})`,
          gateClass: "proposed_action",
          id: `act_${proposal.id}_performed`,
          result: "performed",
          userId: proposal.userId,
          what: proposal.text,
          when: receipt.receivedAt,
          why: proposal.reason
        });
        if (!wasExecuted) {
          await patchProposedActionStatus(stable.file, proposal.id, "executed", receipt.receivedAt);
        }
        if (wasExecuted) {
          return { executed: false, reason: "already executed" };
        }
        return { executed: true, messageId: receipt.messageId };
      } catch (cause) {
        return {
          executed: false,
          reason: `delivery was accepted for effect ${effectId}, but proposal finalization is incomplete; replay this approval with the same proposal and effect ID: ${safeError(cause)}`
        };
      }
    }
    if (effect.state === "unknown") {
      const auditFailure = await captureAuditFailure(
        ensureFailedEffectAudit(stable.actionLogFile, proposal, effect, "delivery unknown")
      );
      return {
        executed: false,
        reason: `delivery is unknown for effect ${effectId}; reconcile it manually with muse messaging effects reconcile and do not retry with a new effect ID${auditFailure}`
      };
    }
    if (effect.state === "reconciled-not-delivered") {
      const auditFailure = await captureAuditFailure(
        ensureFailedEffectAudit(stable.actionLogFile, proposal, effect, "reconciled not delivered")
      );
      return {
        executed: false,
        reason: `effect ${effectId} was reconciled as not delivered; create and review a new proposal instead of reusing this effect ID${auditFailure}`
      };
    }
    return blockedOutcome(effectId, `unexpected durable state ${effect.state}`);
  });
}

async function ensureFailedEffectAudit(
  actionLogFile: string,
  proposal: Awaited<ReturnType<typeof readProposedActions>>[number],
  effect: OutboundEffectView,
  label: string
): Promise<void> {
  await ensureAudit(actionLogFile, {
    detail: `${label} for ${effect.binding.providerId}:${effect.binding.destination} (${effect.binding.effectId})`,
    gateClass: "proposed_action",
    id: `act_${proposal.id}_${effect.state}`,
    result: "failed",
    userId: proposal.userId,
    what: proposal.text,
    when: effect.reconciliation?.recordedAt ?? effect.binding.createdAt,
    why: proposal.reason
  });
}

async function ensureAudit(file: string, entry: ActionLogEntry): Promise<void> {
  await withFileLock(`${file}.proposed-action-audit`, async () => {
    const existing = (await readActionLog(file)).find(({ id }) => id === entry.id);
    if (!existing) {
      await appendActionLog(file, entry);
      return;
    }
    const comparable = ({ prevHash: _ignored, ...value }: ActionLogEntry): Omit<ActionLogEntry, "prevHash"> => value;
    if (JSON.stringify(comparable(existing)) !== JSON.stringify(comparable(entry))) {
      throw new Error(`action audit id is already bound to different content: ${entry.id}`);
    }
  });
}

async function captureAuditFailure(operation: Promise<void>): Promise<string> {
  try {
    await operation;
    return "";
  } catch (cause) {
    return `; failed audit could not be recorded: ${safeError(cause)}`;
  }
}

async function appendFailedAuditBestEffort(
  file: string,
  proposal: Awaited<ReturnType<typeof readProposedActions>>[number],
  effectId: string,
  when: string,
  cause: unknown
): Promise<void> {
  try {
    await appendActionLog(file, {
      detail: `outbound effect ${effectId} was safely blocked: ${safeError(cause)}`,
      gateClass: "proposed_action",
      id: `act_${proposal.id}_${Date.parse(when).toString(36)}`,
      result: "failed",
      userId: proposal.userId,
      what: proposal.text,
      when,
      why: proposal.reason
    });
  } catch {
    // Delivery remains blocked; an unavailable audit store must not reopen it.
  }
}

function blockedOutcome(effectId: string, cause: unknown): ConfirmOutcome {
  return {
    executed: false,
    reason: `outbound effect ${effectId} is safely blocked: ${safeError(cause)}`
  };
}

function safeError(cause: unknown): string {
  return redactSecretsInText(errorMessage(cause)).slice(0, 1_000);
}

export interface DeclineProposedActionOptions {
  readonly file: string;
  readonly id: string;
  readonly actionLogFile: string;
  readonly now?: () => Date;
}

/**
 * Decline a pending proposal: flip it to `declined` and log the
 * refusal. A non-pending proposal is a no-op.
 */
export async function declineProposedAction(options: DeclineProposedActionOptions): Promise<{ readonly declined: boolean; readonly reason?: string }> {
  const now = options.now ?? (() => new Date());
  const proposals = await readProposedActions(options.file);
  const proposal = proposals.find((p) => p.id === options.id);
  if (!proposal) {
    return { declined: false, reason: `no proposed action '${options.id}'` };
  }
  if (proposal.status !== "pending") {
    return { declined: false, reason: `already ${proposal.status}` };
  }
  const whenIso = now().toISOString();
  await patchProposedActionStatus(options.file, proposal.id, "declined", whenIso);
  await appendActionLog(options.actionLogFile, {
    detail: `declined proposal ${proposal.id} — not sent`,
    gateClass: "proposed_action",
    id: `act_${proposal.id}_${Date.parse(whenIso).toString(36)}`,
    result: "refused",
    userId: proposal.userId,
    what: proposal.text,
    when: whenIso,
    why: proposal.reason
  });
  return { declined: true };
}
