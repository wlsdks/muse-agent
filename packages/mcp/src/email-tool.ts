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

import type { EmailProvider, EmailReader, EmailSender } from "./email-provider.js";
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

export interface EmailReadToolDeps {
  readonly provider: EmailProvider;
}

export function createEmailReadTool(deps: EmailReadToolDeps): MuseTool {
  return {
    definition: {
      description:
        "List the user's recent inbox messages (sender, subject, unread flag, snippet). Use when the user asks about their email / inbox / unread / whether someone wrote. Read-only — never sends anything.",
      domain: "messaging",
      inputSchema: {
        additionalProperties: false,
        properties: {
          limit: { description: "How many recent messages to fetch (1–50, default 10).", type: "number" },
          unreadOnly: { description: "When true, return only unread messages.", type: "boolean" }
        },
        type: "object"
      },
      keywords: ["email", "inbox", "unread", "mail", "messages", "read"],
      name: "email_recent",
      risk: "read"
    },
    execute: async (args): Promise<JsonObject> => {
      const limitArg = args["limit"];
      const limit = typeof limitArg === "number" && Number.isFinite(limitArg)
        ? Math.max(1, Math.min(50, Math.trunc(limitArg)))
        : 10;
      const unreadOnly = args["unreadOnly"] === true;
      let messages;
      try {
        messages = await deps.provider.listRecent(limit);
      } catch (cause) {
        return { error: cause instanceof Error ? cause.message : String(cause), messages: [] };
      }
      const filtered = unreadOnly ? messages.filter((m) => m.unread) : messages;
      return {
        count: filtered.length,
        messages: filtered.map((m) => ({
          from: m.from,
          id: m.id,
          subject: m.subject,
          unread: m.unread,
          ...(m.snippet ? { snippet: m.snippet } : {})
        })) as JsonObject[]
      };
    }
  };
}

export interface EmailReadMessageToolDeps {
  readonly reader: EmailReader;
}

export function createEmailReadMessageTool(deps: EmailReadMessageToolDeps): MuseTool {
  return {
    definition: {
      description:
        "Read the FULL text of one inbox message by its id. Use after `email_recent` (which returns each message's id) when the user wants the whole email, not just the snippet. Read-only.",
      domain: "messaging",
      inputSchema: {
        additionalProperties: false,
        properties: {
          id: { description: "The message id from a prior `email_recent` result.", type: "string" }
        },
        required: ["id"],
        type: "object"
      },
      keywords: ["email", "read", "open", "full", "message", "body"],
      name: "read_email",
      risk: "read"
    },
    execute: async (args): Promise<JsonObject> => {
      const id = typeof args["id"] === "string" ? args["id"].trim() : "";
      if (id.length === 0) {
        return { found: false, reason: "id is required (from email_recent)" };
      }
      const message = await deps.reader.getMessage(id);
      if (message === undefined) {
        return { found: false, id, reason: "no message with that id (or the inbox was unreachable)" };
      }
      return {
        body: message.body,
        found: true,
        from: message.from,
        id: message.id,
        subject: message.subject,
        ...(message.date ? { date: message.date } : {})
      };
    }
  };
}
