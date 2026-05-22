/**
 * Draft-first, fail-closed outbound email — the P11-send half, the
 * first capability that *transmits content to a third party*, governed
 * by `.claude/rules/outbound-safety.md`:
 *
 *   1. Draft-first: the agent produces the exact content; nothing
 *      leaves without the user confirming THAT content (the approval
 *      gate receives the drafted body).
 *   2. Fail-closed approval gate: deny / timeout / gate-error ⇒ NO
 *      send. A send never proceeds because the confirmation step
 *      failed.
 *   3. Recipient resolved, never guessed: `resolveContact`; an
 *      ambiguous / unknown recipient ⇒ NO send (the caller clarifies).
 *   4. Recorded: sent OR refused, every outcome appends a
 *      rationale-bearing action-log entry.
 *
 * Security is deterministic code here, never a prompt instruction. The
 * sender transport is injected so the gate can be exercised over a
 * real provider request shape with only the HTTP boundary faked.
 */

import { appendActionLog } from "./personal-action-log-store.js";
import { resolveContact, type Contact } from "./personal-contacts-store.js";
import type { EmailSender } from "./email-provider.js";

export interface EmailDraft {
  readonly to: string;
  readonly recipientName: string;
  readonly subject: string;
  readonly body: string;
}

export interface ApprovalDecision {
  readonly approved: boolean;
  readonly reason?: string;
}

/** Presents the EXACT draft to the user; returns approve/deny. */
export type EmailApprovalGate = (draft: EmailDraft) => Promise<ApprovalDecision> | ApprovalDecision;

export interface SendEmailWithApprovalOptions {
  readonly recipientQuery: string;
  readonly subject: string;
  readonly body: string;
  readonly contacts: readonly Contact[];
  readonly approvalGate: EmailApprovalGate;
  readonly sender: EmailSender;
  readonly actionLogFile: string;
  readonly userId: string;
  readonly now?: () => Date;
  readonly idFactory?: () => string;
}

export type SendEmailOutcome =
  | { readonly sent: true; readonly to: string }
  | {
      readonly sent: false;
      readonly reason: "ambiguous-recipient" | "unknown-recipient" | "no-identifier" | "denied" | "send-failed";
      readonly detail: string;
      readonly candidates?: readonly Contact[];
    };

export async function sendEmailWithApproval(options: SendEmailWithApprovalOptions): Promise<SendEmailOutcome> {
  const now = options.now ?? (() => new Date());
  const idFactory = options.idFactory ?? (() => `act_${Date.now().toString()}_${Math.random().toString(36).slice(2, 8)}`);
  const log = (result: "performed" | "refused" | "failed", what: string, why: string, detail: string): Promise<void> =>
    appendActionLog(options.actionLogFile, {
      detail,
      id: idFactory(),
      result,
      userId: options.userId,
      what,
      when: now().toISOString(),
      why
    });

  // Rule 3: recipient resolved, never guessed.
  const resolution = resolveContact(options.contacts, options.recipientQuery);
  if (resolution.status === "ambiguous") {
    await log("refused", `email to '${options.recipientQuery}'`, "outbound email refused", "ambiguous recipient — clarification required");
    return { candidates: resolution.matches, detail: `'${options.recipientQuery}' matches ${resolution.matches.length.toString()} contacts`, reason: "ambiguous-recipient", sent: false };
  }
  if (resolution.status === "unknown") {
    await log("refused", `email to '${options.recipientQuery}'`, "outbound email refused", "unknown recipient");
    return { detail: `no contact matches '${options.recipientQuery}'`, reason: "unknown-recipient", sent: false };
  }
  // Email send needs an email address specifically — a handle-only
  // contact is NOT a valid recipient (don't fall back to the handle).
  const to = resolution.contact.email;
  if (!to || !to.includes("@")) {
    await log("refused", `email to ${resolution.contact.name}`, "outbound email refused", "contact has no email address");
    return { detail: `${resolution.contact.name} has no email address`, reason: "no-identifier", sent: false };
  }

  // Rules 1 + 2: draft-first, fail-closed approval gate.
  const draft: EmailDraft = { body: options.body, recipientName: resolution.contact.name, subject: options.subject, to };
  let decision: ApprovalDecision;
  try {
    decision = await options.approvalGate(draft);
  } catch (cause) {
    // A gate that throws (undeliverable prompt, timeout) is fail-closed.
    decision = { approved: false, reason: `approval gate error: ${cause instanceof Error ? cause.message : String(cause)}` };
  }
  if (!decision.approved) {
    await log("refused", `email to ${to}: ${options.subject}`, "outbound email refused", decision.reason ?? "not approved");
    return { detail: decision.reason ?? "not approved", reason: "denied", sent: false };
  }

  // Confirmed: the send fires exactly once, with the confirmed content.
  try {
    await options.sender.sendEmail(to, options.subject, options.body);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    await log("failed", `email to ${to}: ${options.subject}`, "user-approved outbound email", detail);
    return { detail, reason: "send-failed", sent: false };
  }
  await log("performed", `email to ${to}: ${options.subject}`, "user-approved outbound email", `sent: ${options.body.slice(0, 200)}`);
  return { sent: true, to };
}
