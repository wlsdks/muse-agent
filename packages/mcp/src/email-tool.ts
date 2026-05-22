/**
 * P17 conversational actuation: expose the gated email send as an
 * AGENT tool so Muse can act on "email Bob the summary" mid-turn — not
 * only via `muse email send`. Execution routes through the proven
 * fail-closed `sendEmailWithApproval` (recipient resolved via
 * `resolveContact`, draft-first approval gate, action-logged), so the
 * agent path inherits the SAME outbound-safety guarantees as the CLI:
 * deny / timeout / ambiguous-recipient ⇒ no send.
 *
 * `risk: "execute"` so the runtime only exposes it in local mode and
 * the (caller-supplied) approval gate is the confirmation point.
 */

import type { JsonObject } from "@muse/shared";
import type { MuseTool } from "@muse/tools";

import type { EmailSender } from "./email-provider.js";
import { sendEmailWithApproval, type EmailApprovalGate } from "./email-send.js";
import type { Contact } from "./personal-contacts-store.js";

export interface EmailSendToolDeps {
  readonly contacts: () => Promise<readonly Contact[]> | readonly Contact[];
  readonly sender: EmailSender;
  readonly approvalGate: EmailApprovalGate;
  readonly actionLogFile: string;
  readonly userId: string;
}

export function createEmailSendTool(deps: EmailSendToolDeps): MuseTool {
  return {
    definition: {
      description:
        "Send an email to one of the user's contacts. The recipient is resolved by name from the contacts graph; the user must confirm the exact drafted content before anything is sent. An ambiguous or unknown recipient is reported back for clarification, never guessed.",
      domain: "messaging",
      inputSchema: {
        additionalProperties: false,
        properties: {
          body: { description: "Email body.", type: "string" },
          subject: { description: "Email subject line.", type: "string" },
          to: { description: "Recipient contact name (resolved via the contacts graph).", type: "string" }
        },
        required: ["to", "subject", "body"],
        type: "object"
      },
      keywords: ["email", "send", "reply", "mail"],
      name: "email_send",
      risk: "execute"
    },
    execute: async (args): Promise<JsonObject> => {
      const to = typeof args["to"] === "string" ? args["to"].trim() : "";
      const subject = typeof args["subject"] === "string" ? args["subject"] : "";
      const body = typeof args["body"] === "string" ? args["body"] : "";
      if (to.length === 0) {
        return { error: "email_send requires a non-empty 'to' contact name", sent: false };
      }
      const outcome = await sendEmailWithApproval({
        actionLogFile: deps.actionLogFile,
        approvalGate: deps.approvalGate,
        body,
        contacts: await Promise.resolve(deps.contacts()),
        recipientQuery: to,
        sender: deps.sender,
        subject,
        userId: deps.userId
      });
      if (outcome.sent) {
        return { sent: true, to: outcome.to };
      }
      return {
        detail: outcome.detail,
        reason: outcome.reason,
        sent: false,
        ...(outcome.reason === "ambiguous-recipient" && outcome.candidates
          ? { candidates: outcome.candidates.map((c) => c.name) }
          : {})
      };
    }
  };
}
