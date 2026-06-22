/**
 * Confirm / decline a proposed action. The user's `muse propose
 * approve <id>` IS the explicit confirmation outbound-safety requires;
 * only then does the draft execute, exactly once (replay-guarded on
 * status), and every outcome — performed / refused / failed — is
 * appended to the reviewable action log.
 */

import { appendActionLog } from "@muse/stores";
import { isProposalActionable, patchProposedActionStatus, readProposedActions } from "@muse/stores";

import type { MessagingProviderRegistry } from "@muse/messaging";

export interface ConfirmProposedActionOptions {
  readonly file: string;
  readonly id: string;
  readonly registry: Pick<MessagingProviderRegistry, "send">;
  readonly actionLogFile: string;
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
  const now = options.now ?? (() => new Date());
  const proposals = await readProposedActions(options.file);
  const proposal = proposals.find((p) => p.id === options.id);
  if (!proposal) {
    return { executed: false, reason: `no proposed action '${options.id}'` };
  }
  if (proposal.status !== "pending") {
    return { executed: false, reason: `already ${proposal.status}` };
  }
  if (!isProposalActionable(proposal, now())) {
    // Past its expiry — outbound-safety: a timed-out approval never sends.
    return { executed: false, reason: "expired" };
  }
  const whenIso = now().toISOString();
  try {
    const receipt = await options.registry.send(proposal.providerId, {
      destination: proposal.destination,
      text: proposal.text
    });
    await patchProposedActionStatus(options.file, proposal.id, "executed", whenIso);
    await appendActionLog(options.actionLogFile, {
      detail: `confirmed proposal ${proposal.id} → ${proposal.providerId}:${proposal.destination}`,
      id: `act_${proposal.id}_${Date.parse(whenIso).toString(36)}`,
      result: "performed",
      userId: proposal.userId,
      what: proposal.summary,
      when: whenIso,
      why: proposal.reason
    });
    return { executed: true, messageId: receipt.messageId };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    // Leave it `pending` so the user can retry; record the failure.
    await appendActionLog(options.actionLogFile, {
      detail: `send failed: ${message}`,
      id: `act_${proposal.id}_${Date.parse(whenIso).toString(36)}`,
      result: "failed",
      userId: proposal.userId,
      what: proposal.summary,
      when: whenIso,
      why: proposal.reason
    });
    return { executed: false, reason: `send failed: ${message}` };
  }
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
    id: `act_${proposal.id}_${Date.parse(whenIso).toString(36)}`,
    result: "refused",
    userId: proposal.userId,
    what: proposal.summary,
    when: whenIso,
    why: proposal.reason
  });
  return { declined: true };
}
