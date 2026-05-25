/**
 * Draft-first, fail-closed outbound chat message — the messaging-tool
 * analogue of `sendEmailWithApproval`, governed by
 * `.claude/rules/outbound-safety.md`:
 *
 *   1. Draft-first: the exact `{ providerId, destination, text }` is
 *      what the (optional) approval gate sees and what leaves.
 *   2. Fail-closed gate: a gate that denies OR throws (undeliverable
 *      prompt / timeout) ⇒ NO send.
 *   4. Recorded: sent OR refused, every outcome appends a
 *      rationale-bearing action-log entry — the gap `muse.messaging.send`
 *      had versus `email_send` / `web_action` / `home_action`.
 *
 * The approval gate is OPTIONAL because the shipping CLI / API surfaces
 * already gate every non-read tool through the runtime `toolApprovalGate`
 * (chat confirm / channel approval gate). When no self-gate is injected
 * the default is approve — preserving that behaviour — but the send is
 * still action-logged. Injecting a gate adds defense-in-depth for any
 * surface that wires no runtime gate.
 */

import type { MessagingProviderRegistry } from "@muse/messaging";

import { appendActionLog, type ActionResult } from "./personal-action-log-store.js";

export interface ApprovalDecision {
  readonly approved: boolean;
  readonly reason?: string;
}

export interface MessageDraft {
  readonly providerId: string;
  readonly destination: string;
  readonly text: string;
}

/** Presents the EXACT draft to the user; returns approve/deny. */
export type MessageApprovalGate = (draft: MessageDraft) => Promise<ApprovalDecision> | ApprovalDecision;

export interface SendMessageWithApprovalOptions {
  readonly registry: Pick<MessagingProviderRegistry, "send">;
  readonly providerId: string;
  readonly destination: string;
  readonly text: string;
  readonly actionLogFile: string;
  readonly userId: string;
  readonly approvalGate?: MessageApprovalGate;
  readonly now?: () => Date;
  readonly idFactory?: () => string;
}

export type SendMessageOutcome =
  | { readonly sent: true; readonly destination: string; readonly messageId: string }
  | { readonly sent: false; readonly reason: "denied" | "send-failed"; readonly detail: string };

export async function sendMessageWithApproval(options: SendMessageWithApprovalOptions): Promise<SendMessageOutcome> {
  const now = options.now ?? (() => new Date());
  const idFactory = options.idFactory ?? (() => `act_${Date.now().toString()}_${Math.random().toString(36).slice(2, 8)}`);
  const what = `message via ${options.providerId} to ${options.destination}`;
  const log = (result: ActionResult, why: string, detail: string): Promise<void> =>
    appendActionLog(options.actionLogFile, {
      detail,
      id: idFactory(),
      result,
      userId: options.userId,
      what,
      when: now().toISOString(),
      why
    });

  const draft: MessageDraft = { destination: options.destination, providerId: options.providerId, text: options.text };

  // Rules 1 + 2: draft-first, fail-closed gate (deny OR throw ⇒ no send).
  let decision: ApprovalDecision = { approved: true };
  if (options.approvalGate) {
    try {
      decision = await options.approvalGate(draft);
    } catch (cause) {
      decision = { approved: false, reason: `approval gate error: ${cause instanceof Error ? cause.message : String(cause)}` };
    }
  }
  if (!decision.approved) {
    await log("refused", "outbound message refused", decision.reason ?? "not approved");
    return { detail: decision.reason ?? "not approved", reason: "denied", sent: false };
  }

  try {
    const receipt = await options.registry.send(options.providerId, { destination: options.destination, text: options.text });
    await log("performed", "user-approved outbound message", `sent: ${options.text.slice(0, 200)}`);
    return { destination: receipt.destination, messageId: receipt.messageId, sent: true };
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    await log("failed", "user-approved outbound message", detail);
    return { detail, reason: "send-failed", sent: false };
  }
}
