/**
 * Draft-first, fail-closed outbound email — the send half, the
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

import { appendActionLog } from "@muse/stores";
import { resolveContact, type Contact } from "@muse/stores";
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
  | { readonly sent: true; readonly to: string; readonly messageId?: string }
  | {
      readonly sent: false;
      readonly reason: "ambiguous-recipient" | "unknown-recipient" | "no-identifier" | "denied" | "send-failed";
      readonly detail: string;
      readonly candidates?: readonly Contact[];
    };

type EmailActionLogger = (result: "performed" | "refused" | "failed", what: string, why: string, detail: string) => Promise<void>;

function makeEmailLogger(actionLogFile: string, userId: string, now: () => Date, idFactory: () => string): EmailActionLogger {
  return (result, what, why, detail) =>
    appendActionLog(actionLogFile, { detail, id: idFactory(), result, userId, what, when: now().toISOString(), why });
}

/**
 * The shared draft-first core (outbound-safety rules 1+2+4): present the EXACT
 * draft to the user, send ONLY on approval, and action-log every outcome. The
 * recipient is ALREADY resolved by the caller (a contact for `sendEmailWithApproval`,
 * the original sender for `replyEmailWithApproval`), so this never guesses one — it
 * is the single deterministic gate both send paths funnel through.
 */
async function dispatchEmailDraft(
  draft: EmailDraft,
  deps: { readonly approvalGate: EmailApprovalGate; readonly sender: EmailSender; readonly log: EmailActionLogger }
): Promise<SendEmailOutcome> {
  let decision: ApprovalDecision;
  try {
    decision = await deps.approvalGate(draft);
  } catch (cause) {
    // A gate that throws (undeliverable prompt, timeout) is fail-closed.
    decision = { approved: false, reason: `approval gate error: ${cause instanceof Error ? cause.message : String(cause)}` };
  }
  if (!decision.approved) {
    await deps.log("refused", `email to ${draft.to}: ${draft.subject}`, "outbound email refused", decision.reason ?? "not approved");
    return { detail: decision.reason ?? "not approved", reason: "denied", sent: false };
  }
  let messageId: string | undefined;
  try {
    messageId = await deps.sender.sendEmail(draft.to, draft.subject, draft.body);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    await deps.log("failed", `email to ${draft.to}: ${draft.subject}`, "user-approved outbound email", detail);
    return { detail, reason: "send-failed", sent: false };
  }
  // Record the provider's message id in the action log as proof-of-send — so
  // "did that email actually go through?" is answerable + the exact message is
  // findable later (post-action verification, per the accountability contract).
  const idNote = messageId ? ` (id: ${messageId})` : "";
  await deps.log("performed", `email to ${draft.to}: ${draft.subject}`, "user-approved outbound email", `sent${idNote}: ${draft.body.slice(0, 200)}`);
  return { sent: true, to: draft.to, ...(messageId ? { messageId } : {}) };
}

export async function sendEmailWithApproval(options: SendEmailWithApprovalOptions): Promise<SendEmailOutcome> {
  const now = options.now ?? (() => new Date());
  const idFactory = options.idFactory ?? (() => `act_${Date.now().toString()}_${Math.random().toString(36).slice(2, 8)}`);
  const log = makeEmailLogger(options.actionLogFile, options.userId, now, idFactory);

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

  // Rules 1 + 2 + 4: draft-first, fail-closed gate, recorded — the shared core.
  const draft: EmailDraft = { body: options.body, recipientName: resolution.contact.name, subject: options.subject, to };
  return dispatchEmailDraft(draft, { approvalGate: options.approvalGate, log, sender: options.sender });
}

export interface ReplyEmailWithApprovalOptions {
  /** The original sender's email address — resolved BY the message being replied to, never guessed. */
  readonly to: string;
  /** Display name for the draft (the original sender's name). */
  readonly recipientName: string;
  /** Already-normalised reply subject (the caller adds the `Re:` prefix). */
  readonly subject: string;
  readonly body: string;
  readonly approvalGate: EmailApprovalGate;
  readonly sender: EmailSender;
  readonly actionLogFile: string;
  readonly userId: string;
  readonly now?: () => Date;
  readonly idFactory?: () => string;
}

/**
 * Draft-first REPLY to a received email. Same outbound-safety contract as
 * `sendEmailWithApproval`, but the recipient is the ORIGINAL SENDER's address
 * (already resolved by the message), so there is no contact lookup to guess — a
 * missing/garbage reply address fails closed before the gate. Everything else
 * (draft-first confirm, deny/timeout ⇒ no send, action-log) is the shared core.
 */
export async function replyEmailWithApproval(options: ReplyEmailWithApprovalOptions): Promise<SendEmailOutcome> {
  const now = options.now ?? (() => new Date());
  const idFactory = options.idFactory ?? (() => `act_${Date.now().toString()}_${Math.random().toString(36).slice(2, 8)}`);
  const log = makeEmailLogger(options.actionLogFile, options.userId, now, idFactory);

  const to = options.to.trim();
  if (!to.includes("@")) {
    await log("refused", `reply to ${options.recipientName}`, "outbound email refused", "the original message has no valid reply address");
    return { detail: "the original message has no valid reply address", reason: "no-identifier", sent: false };
  }
  const draft: EmailDraft = { body: options.body, recipientName: options.recipientName, subject: options.subject, to };
  return dispatchEmailDraft(draft, { approvalGate: options.approvalGate, log, sender: options.sender });
}

/** "Re: …" reply subject, idempotent (never stacks "Re: Re:"). Empty subject → "Re:". */
export function replySubject(original: string): string {
  const trimmed = original.trim();
  if (/^re:/iu.test(trimmed)) {
    return trimmed;
  }
  return trimmed.length > 0 ? `Re: ${trimmed}` : "Re:";
}

/**
 * Compose a FORWARD of a received email — a "Fwd:" subject (idempotent) and a
 * body that prepends an optional note above a quoted "--- Forwarded message ---"
 * header (From / Subject) and the original body. Pure; the actual send still
 * routes through `sendEmailWithApproval` (contact-resolved, draft-first).
 */
export function composeForward(message: { readonly from: string; readonly subject: string; readonly body: string }, note?: string): { readonly subject: string; readonly body: string } {
  const original = message.subject.trim();
  const subject = /^fwd:/iu.test(original) ? original : `Fwd: ${original.length > 0 ? original : "(no subject)"}`;
  const header = `--- Forwarded message ---\nFrom: ${message.from}\nSubject: ${original.length > 0 ? original : "(no subject)"}`;
  const prefix = note !== undefined && note.trim().length > 0 ? `${note.trim()}\n\n` : "";
  return { body: `${prefix}${header}\n\n${message.body}`, subject };
}
