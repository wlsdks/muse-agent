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

import { extractEmailAddress, type EmailProvider, type EmailReader, type EmailSearcher, type EmailSender } from "./email-provider.js";
import { composeForward, replyEmailWithApproval, replySubject, sendEmailWithApproval, type EmailApprovalGate } from "./email-send.js";
import type { Contact } from "@muse/stores";

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

export interface EmailReplyToolDeps {
  readonly reader: EmailReader;
  readonly sender: EmailSender;
  readonly approvalGate: EmailApprovalGate;
  readonly actionLogFile: string;
  readonly userId: string;
}

export function createEmailReplyTool(deps: EmailReplyToolDeps): MuseTool {
  return {
    definition: {
      description:
        "SEND a reply to an email the user RECEIVED. The reply goes back to that message's sender with a 'Re:' subject; the user confirms the exact text before it sends. USE WHENEVER the user wants to answer / reply to / respond to / write back to a received email and has given the reply text (e.g. 'reply to email <id> saying Friday works', 'tell them yes'). NOT for just READING the email (that's read_email — this one sends), NOT for a brand-new email to a named contact (that's email_send), NOT for a chat/messenger DM (that's muse.messaging.send).",
      domain: "messaging",
      inputSchema: {
        additionalProperties: false,
        properties: {
          body: { description: "The reply text to send back to the original sender, e.g. 'Thanks — Friday at 3pm works for me.'", type: "string" },
          id: { description: "Id of the message to reply to, from a prior email_recent / search_email / read_email result, e.g. '18f2a1c3d4e5'.", type: "string" }
        },
        required: ["id", "body"],
        type: "object"
      },
      keywords: ["reply", "respond", "answer", "reply to", "email", "write back"],
      name: "email_reply",
      risk: "execute"
    },
    execute: async (args): Promise<JsonObject> => {
      const id = typeof args["id"] === "string" ? args["id"].trim() : "";
      const body = typeof args["body"] === "string" ? args["body"] : "";
      if (id.length === 0) {
        return { error: "email_reply requires the 'id' of the message to reply to (look it up with email_recent or search_email)", sent: false };
      }
      const message = await deps.reader.getMessage(id);
      if (!message) {
        return { detail: `no message with id '${id}' — look it up with email_recent or search_email first`, reason: "unknown-message", sent: false };
      }
      const to = extractEmailAddress(message.from);
      if (!to) {
        return { detail: `couldn't determine a reply address from the sender '${message.from}'`, reason: "no-identifier", sent: false };
      }
      const subject = replySubject(message.subject);
      const outcome = await replyEmailWithApproval({
        actionLogFile: deps.actionLogFile,
        approvalGate: deps.approvalGate,
        body,
        recipientName: message.from,
        sender: deps.sender,
        subject,
        to,
        userId: deps.userId
      });
      if (outcome.sent) {
        return { repliedTo: to, sent: true, subject };
      }
      return { detail: outcome.detail, reason: outcome.reason, sent: false };
    }
  };
}

export interface EmailForwardToolDeps {
  readonly reader: EmailReader;
  readonly sender: EmailSender;
  readonly contacts: () => Promise<readonly Contact[]> | readonly Contact[];
  readonly approvalGate: EmailApprovalGate;
  readonly actionLogFile: string;
  readonly userId: string;
}

export function createEmailForwardTool(deps: EmailForwardToolDeps): MuseTool {
  return {
    definition: {
      description:
        "FORWARD an email the user RECEIVED to one of their CONTACTS (resolved by name). Reads the original message by id, prepends an optional note, and the user confirms the exact forward before it sends. USE when the user says 'forward that / the <X> email to <contact>'. Look the message up first (email_recent / search_email) for its id. NOT a new email (email_send), NOT a reply to the original sender (email_reply).",
      domain: "messaging",
      inputSchema: {
        additionalProperties: false,
        properties: {
          id: { description: "Id of the message to forward, from a prior email_recent / search_email result, e.g. '18f2a1c3d4e5'.", type: "string" },
          note: { description: "Optional note to prepend above the forwarded message, e.g. 'FYI — see below.'", type: "string" },
          to: { description: "Recipient CONTACT NAME (resolved via the contacts graph), e.g. 'Bob'.", type: "string" }
        },
        required: ["id", "to"],
        type: "object"
      },
      keywords: ["forward", "fwd", "email", "send on", "pass along"],
      name: "email_forward",
      risk: "execute"
    },
    execute: async (args): Promise<JsonObject> => {
      const id = typeof args["id"] === "string" ? args["id"].trim() : "";
      const to = typeof args["to"] === "string" ? args["to"].trim() : "";
      const note = typeof args["note"] === "string" ? args["note"] : undefined;
      if (id.length === 0 || to.length === 0) {
        return { error: "email_forward requires 'id' (the message to forward) and 'to' (a contact name)", sent: false };
      }
      const message = await deps.reader.getMessage(id);
      if (!message) {
        return { detail: `no message with id '${id}' — look it up with email_recent or search_email first`, reason: "unknown-message", sent: false };
      }
      const { body, subject } = composeForward({ body: message.body, from: message.from, subject: message.subject }, note);
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
        return { forwardedTo: outcome.to, sent: true, subject };
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
        "List the user's LATEST inbox messages (sender, subject, unread flag, snippet). Use for 'what's in my inbox / any new email / unread'. Use ONLY when there are NO search terms — if the user names a sender, subject word, or keyword to look for ('the email from the bank', 'emails about the trip'), use `search_email` instead. Read-only — never sends anything.",
      domain: "messaging",
      inputSchema: {
        additionalProperties: false,
        properties: {
          limit: { description: "How many recent messages to fetch (1–50, default 10).", type: "number" },
          unreadOnly: { description: "When true, return only unread messages.", type: "boolean" }
        },
        type: "object"
      },
      keywords: ["email", "emails", "inbox", "unread", "mail", "mails", "messages", "read", "이메일", "메일"],
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

export interface EmailSearchToolDeps {
  readonly searcher: EmailSearcher;
}

export function createEmailSearchTool(deps: EmailSearchToolDeps): MuseTool {
  return {
    definition: {
      description:
        "Find inbox messages MATCHING a query — a sender, subject word, or keyword the user named ('the email from the bank', 'emails about the Paris trip', 'invoice from Acme'). Returns the matches (sender, subject, unread flag, snippet, id). Use this whenever the user is looking for SPECIFIC mail; for just the latest messages with no search terms, use `email_recent`. Read-only — never sends anything. Do NOT use when the user is only DESCRIBING or quoting an email they already received and asking what to make of it ('I got an email saying reply YES to confirm — should I trust it?', 'is this email a scam?') — that is a question to answer, not a request to search the inbox.",
      domain: "messaging",
      inputSchema: {
        additionalProperties: false,
        properties: {
          limit: { description: "How many matches to fetch (1–50, default 10).", type: "number" },
          query: { description: "What to look for — sender, subject word, or keyword, e.g. 'from:bank statement' or 'Paris trip'.", type: "string" }
        },
        required: ["query"],
        type: "object"
      },
      keywords: ["email", "emails", "search", "find", "from", "about", "mail", "mails", "이메일", "메일", "찾아"],
      name: "search_email",
      risk: "read"
    },
    execute: async (args): Promise<JsonObject> => {
      const query = typeof args["query"] === "string" ? args["query"].trim() : "";
      if (query.length === 0) {
        return { count: 0, error: "search_email requires a non-empty 'query'", messages: [] };
      }
      const limitArg = args["limit"];
      const limit = typeof limitArg === "number" && Number.isFinite(limitArg)
        ? Math.max(1, Math.min(50, Math.trunc(limitArg)))
        : 10;
      let messages;
      try {
        messages = await deps.searcher.search(query, limit);
      } catch (cause) {
        return { count: 0, error: cause instanceof Error ? cause.message : String(cause), messages: [] };
      }
      return {
        count: messages.length,
        messages: messages.map((m) => ({
          from: m.from,
          id: m.id,
          subject: m.subject,
          unread: m.unread,
          ...(m.snippet ? { snippet: m.snippet } : {})
        })) as JsonObject[],
        query
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
        "Read / SHOW the FULL text of one inbox message by its id (after `email_recent` gives the id). Use ONLY to VIEW a message's content. Read-only — it does NOT answer or send anything; to reply to the message use email_reply.",
      domain: "messaging",
      inputSchema: {
        additionalProperties: false,
        properties: {
          id: { description: "The message id from a prior `email_recent` result.", type: "string" }
        },
        required: ["id"],
        type: "object"
      },
      keywords: ["email", "emails", "read", "open", "full", "message", "body", "이메일", "메일"],
      name: "read_email",
      risk: "read"
    },
    execute: async (args): Promise<JsonObject> => {
      const id = typeof args["id"] === "string" ? args["id"].trim() : "";
      if (id.length === 0) {
        return { found: false, reason: "id is required (from email_recent)" };
      }
      let message;
      try {
        message = await deps.reader.getMessage(id);
      } catch (cause) {
        // A permanent auth failure (expired/missing token) propagates from
        // getMessage — surface it so the agent reports "re-auth" rather than
        // a misleading "no message with that id".
        return { found: false, id, reason: cause instanceof Error ? cause.message : String(cause) };
      }
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
