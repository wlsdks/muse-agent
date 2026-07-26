import { createHash } from "node:crypto";
import { dirname, join } from "node:path";

import {
  dispatchDurableEffectOnce,
  OutboundEffectDispatchUncertainError,
  type OutboundEffectView
} from "@muse/messaging";
import { errorMessage } from "@muse/shared";
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
  readonly effectId: string;
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
  /** Stable identity for exactly one intended external email. */
  readonly effectId: string;
  /** Defaults beside the action log (`outbound-effects.json`). */
  readonly effectFile?: string;
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
  /**
   * The registered tool name recorded on the action-log entry as `gateClass`
   * for approval-rate telemetry. Default `"email_send"`; `email-tool.ts`'s
   * forward handler overrides it to `"email_forward"` since it reuses this
   * same primitive under a different tool identity.
   */
  readonly gateClass?: string;
}

export type SendEmailOutcome =
  | { readonly sent: true; readonly effectId: string; readonly to: string; readonly messageId: string }
  | {
      readonly sent: false;
      readonly effectId: string;
      readonly reason:
        | "ambiguous-recipient"
        | "unknown-recipient"
        | "no-identifier"
        | "invalid-input"
        | "denied"
        | "send-failed"
        | "send-unknown"
        | "not-delivered";
      readonly detail: string;
      readonly candidates?: readonly Contact[];
    };

type EmailActionLogger = (result: "performed" | "refused" | "failed", what: string, why: string, detail: string) => Promise<void>;

function makeEmailLogger(
  actionLogFile: string,
  userId: string,
  now: () => Date,
  idFactory: () => string,
  gateClass: string
): EmailActionLogger {
  return (result, what, why, detail) =>
    appendActionLog(actionLogFile, { detail, gateClass, id: idFactory(), result, userId, what, when: now().toISOString(), why });
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
  deps: {
    readonly approvalGate: EmailApprovalGate;
    readonly sender: EmailSender;
    readonly effectFile: string;
    readonly log: EmailActionLogger;
    readonly now: () => Date;
  }
): Promise<SendEmailOutcome> {
  const stable = {
    approvalGate: deps.approvalGate,
    body: draft.body,
    effectFile: deps.effectFile,
    effectId: draft.effectId,
    log: deps.log,
    now: deps.now,
    recipientName: draft.recipientName,
    sendEmail: deps.sender.sendEmail.bind(deps.sender),
    subject: draft.subject,
    to: draft.to
  } as const;
  const stableDraft: EmailDraft = {
    body: stable.body,
    effectId: stable.effectId,
    recipientName: stable.recipientName,
    subject: stable.subject,
    to: stable.to
  };
  let decision: ApprovalDecision;
  try {
    decision = await stable.approvalGate(stableDraft);
  } catch (cause) {
    // A gate that throws (undeliverable prompt, timeout) is fail-closed.
    decision = { approved: false, reason: `approval gate error: ${errorMessage(cause)}` };
  }
  if (!decision.approved) {
    await stable.log("refused", `email to ${stable.to}: ${stable.subject}`, "outbound email refused", decision.reason ?? "not approved");
    return { detail: decision.reason ?? "not approved", effectId: stable.effectId, reason: "denied", sent: false };
  }

  let effect: OutboundEffectView;
  try {
    effect = await dispatchDurableEffectOnce({
      destination: stable.to,
      dispatch: async () => ({
        messageId: await stable.sendEmail(stable.to, stable.subject, stable.body)
      }),
      effectFile: stable.effectFile,
      effectId: stable.effectId,
      now: stable.now,
      payloadHash: emailPayloadHash(stable.to, stable.subject, stable.body),
      providerId: "email"
    });
  } catch (cause) {
    const detail = errorMessage(cause);
    await safeEffectLog(
      stable.log,
      "failed",
      `email to ${stable.to}: ${stable.subject}`,
      "user-approved outbound email",
      effectDetail(stable, detail)
    );
    return {
      detail,
      effectId: stable.effectId,
      reason: cause instanceof OutboundEffectDispatchUncertainError ? "send-unknown" : "send-failed",
      sent: false
    };
  }
  if (effect.state === "accepted" || effect.state === "reconciled-accepted") {
    const receipt = effect.receipt;
    if (!receipt) throw new Error(`accepted outbound email effect ${stable.effectId} has no provider receipt`);
    await safeEffectLog(
      stable.log,
      "performed",
      `email to ${stable.to}: ${stable.subject}`,
      "user-approved outbound email",
      effectDetail(stable, `accepted provider message id: ${receipt.messageId}`)
    );
    return { effectId: stable.effectId, messageId: receipt.messageId, sent: true, to: stable.to };
  }
  if (effect.state === "reconciled-not-delivered") {
    const detail = `effect ${stable.effectId} was manually reconciled as not delivered`;
    await safeEffectLog(
      stable.log,
      "failed",
      `email to ${stable.to}: ${stable.subject}`,
      "user-approved outbound email not delivered",
      effectDetail(stable, detail)
    );
    return { detail, effectId: stable.effectId, reason: "not-delivered", sent: false };
  }
  const detail =
    `${effect.unknownDetail ?? `effect ${stable.effectId} delivery is unknown`}; ` +
    `do not retry with a new effectId — inspect and manually reconcile effect ${stable.effectId} first`;
  await safeEffectLog(
    stable.log,
    "failed",
    `email to ${stable.to}: ${stable.subject}`,
    "user-approved outbound email delivery unknown",
    effectDetail(stable, detail)
  );
  return { detail, effectId: stable.effectId, reason: "send-unknown", sent: false };
}

export async function sendEmailWithApproval(options: SendEmailWithApprovalOptions): Promise<SendEmailOutcome> {
  const now = options.now ?? (() => new Date());
  const idFactory = options.idFactory ?? (() => `act_${Date.now().toString()}_${Math.random().toString(36).slice(2, 8)}`);
  const stable = {
    actionLogFile: options.actionLogFile,
    approvalGate: options.approvalGate,
    body: options.body,
    contacts: [...options.contacts],
    effectFile: options.effectFile ?? join(dirname(options.actionLogFile), "outbound-effects.json"),
    effectId: options.effectId,
    gateClass: options.gateClass ?? "email_send",
    recipientQuery: options.recipientQuery,
    sender: options.sender,
    subject: options.subject,
    userId: options.userId
  } as const;
  const log = makeEmailLogger(stable.actionLogFile, stable.userId, now, idFactory, stable.gateClass);
  const inputError = validateEmailEffectInput(stable.effectId, stable.subject, stable.body);
  if (inputError) {
    return { detail: inputError, effectId: stable.effectId, reason: "invalid-input", sent: false };
  }

  // Rule 3: recipient resolved, never guessed.
  const resolution = resolveContact(stable.contacts, stable.recipientQuery);
  if (resolution.status === "ambiguous") {
    await log("refused", `email to '${stable.recipientQuery}'`, "outbound email refused", "ambiguous recipient — clarification required");
    return { candidates: resolution.matches, detail: `'${stable.recipientQuery}' matches ${resolution.matches.length.toString()} contacts`, effectId: stable.effectId, reason: "ambiguous-recipient", sent: false };
  }
  if (resolution.status === "unknown") {
    await log("refused", `email to '${stable.recipientQuery}'`, "outbound email refused", "unknown recipient");
    return { detail: `no contact matches '${stable.recipientQuery}'`, effectId: stable.effectId, reason: "unknown-recipient", sent: false };
  }
  // Email send needs an email address specifically — a handle-only
  // contact is NOT a valid recipient (don't fall back to the handle).
  const to = resolution.contact.email;
  if (!to || !to.includes("@")) {
    await log("refused", `email to ${resolution.contact.name}`, "outbound email refused", "contact has no email address");
    return { detail: `${resolution.contact.name} has no email address`, effectId: stable.effectId, reason: "no-identifier", sent: false };
  }

  // Rules 1 + 2 + 4: draft-first, fail-closed gate, recorded — the shared core.
  const draft: EmailDraft = {
    body: stable.body,
    effectId: stable.effectId,
    recipientName: resolution.contact.name,
    subject: stable.subject,
    to
  };
  return dispatchEmailDraft(draft, {
    approvalGate: stable.approvalGate,
    effectFile: stable.effectFile,
    log,
    now,
    sender: stable.sender
  });
}

export interface ReplyEmailWithApprovalOptions {
  /** Stable identity for exactly one intended external reply. */
  readonly effectId: string;
  /** Defaults beside the action log (`outbound-effects.json`). */
  readonly effectFile?: string;
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
  /** Recorded as `gateClass` on the action-log entry. Default `"email_reply"`. */
  readonly gateClass?: string;
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
  const stable = {
    actionLogFile: options.actionLogFile,
    approvalGate: options.approvalGate,
    body: options.body,
    effectFile: options.effectFile ?? join(dirname(options.actionLogFile), "outbound-effects.json"),
    effectId: options.effectId,
    gateClass: options.gateClass ?? "email_reply",
    recipientName: options.recipientName,
    sender: options.sender,
    subject: options.subject,
    to: options.to.trim(),
    userId: options.userId
  } as const;
  const log = makeEmailLogger(stable.actionLogFile, stable.userId, now, idFactory, stable.gateClass);
  const inputError = validateEmailEffectInput(stable.effectId, stable.subject, stable.body);
  if (inputError) {
    return { detail: inputError, effectId: stable.effectId, reason: "invalid-input", sent: false };
  }

  if (!stable.to.includes("@")) {
    await log("refused", `reply to ${stable.recipientName}`, "outbound email refused", "the original message has no valid reply address");
    return { detail: "the original message has no valid reply address", effectId: stable.effectId, reason: "no-identifier", sent: false };
  }
  const draft: EmailDraft = {
    body: stable.body,
    effectId: stable.effectId,
    recipientName: stable.recipientName,
    subject: stable.subject,
    to: stable.to
  };
  return dispatchEmailDraft(draft, {
    approvalGate: stable.approvalGate,
    effectFile: stable.effectFile,
    log,
    now,
    sender: stable.sender
  });
}

const MAX_EFFECT_ID_BYTES = 256;
const MAX_EMAIL_SUBJECT_LENGTH = 998;
const MAX_EMAIL_BODY_LENGTH = 4096;
const UNSAFE_EFFECT_ID_CHARACTERS = /\p{Cc}/u;

function validateEmailEffectInput(effectId: string, subject: string, body: string): string | undefined {
  if (
    typeof effectId !== "string"
    || effectId.trim().length === 0
    || effectId !== effectId.trim()
    || Buffer.byteLength(effectId, "utf8") > MAX_EFFECT_ID_BYTES
    || UNSAFE_EFFECT_ID_CHARACTERS.test(effectId)
  ) {
    return `effectId must be a non-empty exact string of at most ${MAX_EFFECT_ID_BYTES.toString()} UTF-8 bytes with no control characters`;
  }
  if (subject.length > MAX_EMAIL_SUBJECT_LENGTH) {
    return `email subject must be at most ${MAX_EMAIL_SUBJECT_LENGTH.toString()} characters`;
  }
  if (body.trim().length === 0 || body.length > MAX_EMAIL_BODY_LENGTH) {
    return `email body must be non-empty and at most ${MAX_EMAIL_BODY_LENGTH.toString()} characters`;
  }
  return undefined;
}

function emailPayloadHash(to: string, subject: string, body: string): string {
  return createHash("sha256").update(JSON.stringify({ body, subject, to })).digest("hex");
}

function effectDetail(
  stable: { readonly body: string; readonly effectId: string; readonly subject: string; readonly to: string },
  outcome: string
): string {
  return JSON.stringify({
    bodyPreview: stable.body.slice(0, 200),
    effectId: stable.effectId,
    outcome,
    subject: stable.subject,
    to: stable.to
  });
}

async function safeEffectLog(
  log: EmailActionLogger,
  result: "performed" | "failed",
  what: string,
  why: string,
  detail: string
): Promise<void> {
  try {
    await log(result, what, why, detail);
  } catch {
    // The durable effect ledger is authoritative after provider dispatch.
    // Audit failure must never downgrade an accepted effect or invite retry.
  }
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
