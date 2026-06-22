import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { GmailEmailProvider, type EmailMessage } from "./email-provider.js";
import { createEmailForwardTool, createEmailReplyTool, createEmailSendTool } from "./email-tool.js";
import type { EmailApprovalGate } from "./email-send.js";
import { readActionLog } from "@muse/stores";
import type { Contact } from "@muse/stores";

const CONTACTS: Contact[] = [
  { email: "alice@example.com", id: "c_a", name: "Alice" },
  { email: "bob1@example.com", id: "c_b1", name: "Bob" },
  { email: "bob2@example.com", id: "c_b2", name: "Bob" }
];

function gmail(): { sender: GmailEmailProvider; sends: string[] } {
  const sends: string[] = [];
  const fetchImpl = (async (url: string | URL) => {
    sends.push(String(url));
    return new Response(JSON.stringify({ id: "x" }), { status: 200 });
  }) as unknown as typeof globalThis.fetch;
  return { sender: new GmailEmailProvider("tok", fetchImpl), sends };
}

const approve: EmailApprovalGate = () => ({ approved: true });
const deny: EmailApprovalGate = () => ({ approved: false, reason: "declined" });

function logFile(): string {
  return join(mkdtempSync(join(tmpdir(), "muse-email-tool-")), "action-log.json");
}

const ctx = { runId: "run-1", userId: "stark" };

describe("createEmailSendTool", () => {
  it("exposes an execute-risk email_send tool with the right schema", () => {
    const { sender } = gmail();
    const tool = createEmailSendTool({ actionLogFile: logFile(), approvalGate: approve, contacts: () => CONTACTS, sender, userId: "stark" });
    expect(tool.definition.name).toBe("email_send");
    expect(tool.definition.risk).toBe("execute");
    expect(tool.definition.inputSchema.required).toEqual(["to", "subject", "body"]);
  });

  it("CONFIRM: resolves the contact, sends, and reports sent", async () => {
    const { sender, sends } = gmail();
    const actionLogFile = logFile();
    const tool = createEmailSendTool({ actionLogFile, approvalGate: approve, contacts: () => CONTACTS, sender, userId: "stark" });
    const out = await tool.execute({ body: "hello", subject: "Hi", to: "Alice" }, ctx);
    expect(out).toEqual({ sent: true, to: "alice@example.com" });
    expect(sends).toHaveLength(1);
    expect((await readActionLog(actionLogFile))[0]).toMatchObject({ result: "performed" });
  });

  it("DENY: no send, reports the refusal", async () => {
    const { sender, sends } = gmail();
    const tool = createEmailSendTool({ actionLogFile: logFile(), approvalGate: deny, contacts: () => CONTACTS, sender, userId: "stark" });
    const out = await tool.execute({ body: "hello", subject: "Hi", to: "Alice" }, ctx);
    expect(out).toMatchObject({ reason: "denied", sent: false });
    expect(sends).toHaveLength(0);
  });

  it("AMBIGUOUS recipient: no send, returns candidate names to clarify (even with an approving gate)", async () => {
    const { sender, sends } = gmail();
    const tool = createEmailSendTool({ actionLogFile: logFile(), approvalGate: approve, contacts: () => CONTACTS, sender, userId: "stark" });
    const out = await tool.execute({ body: "hello", subject: "Hi", to: "Bob" }, ctx) as Record<string, unknown>;
    expect(out.sent).toBe(false);
    expect(out.reason).toBe("ambiguous-recipient");
    expect(out.candidates).toEqual(["Bob", "Bob"]);
    expect(sends).toHaveLength(0);
  });
});

describe("createEmailReplyTool — reply to a received email, draft-first", () => {
  const message: EmailMessage = { body: "Can you confirm Friday?", from: "Jane Park <jane@globex.com>", id: "m1", subject: "Q3 budget" };
  const reader = (msg: EmailMessage | undefined) => ({ getMessage: async (id: string) => (id === "m1" ? msg : undefined) });

  it("exposes an execute-risk email_reply tool with {id, body} required", () => {
    const { sender } = gmail();
    const tool = createEmailReplyTool({ actionLogFile: logFile(), approvalGate: approve, reader: reader(message), sender, userId: "stark" });
    expect(tool.definition.name).toBe("email_reply");
    expect(tool.definition.risk).toBe("execute");
    expect(tool.definition.inputSchema.required).toEqual(["id", "body"]);
  });

  it("CONFIRM: reads the message, replies to the SENDER's address with a Re: subject, reports sent", async () => {
    const { sender, sends } = gmail();
    const actionLogFile = logFile();
    const tool = createEmailReplyTool({ actionLogFile, approvalGate: approve, reader: reader(message), sender, userId: "stark" });
    const out = await tool.execute({ body: "Friday at 3pm works.", id: "m1" }, ctx);
    expect(out).toMatchObject({ repliedTo: "jane@globex.com", sent: true, subject: "Re: Q3 budget" });
    expect(sends).toHaveLength(1);
    expect((await readActionLog(actionLogFile))[0]).toMatchObject({ result: "performed" });
  });

  it("UNKNOWN message id: nothing is sent, points the model to look it up first", async () => {
    const { sender, sends } = gmail();
    const tool = createEmailReplyTool({ actionLogFile: logFile(), approvalGate: approve, reader: reader(message), sender, userId: "stark" });
    const out = await tool.execute({ body: "hi", id: "does-not-exist" }, ctx);
    expect(out).toMatchObject({ reason: "unknown-message", sent: false });
    expect(sends).toHaveLength(0);
  });

  it("DENY: drafted but NOT sent", async () => {
    const { sender, sends } = gmail();
    const tool = createEmailReplyTool({ actionLogFile: logFile(), approvalGate: deny, reader: reader(message), sender, userId: "stark" });
    const out = await tool.execute({ body: "hi", id: "m1" }, ctx);
    expect(out).toMatchObject({ reason: "denied", sent: false });
    expect(sends).toHaveLength(0);
  });

  it("sender with no parseable address: no send (fails closed)", async () => {
    const { sender, sends } = gmail();
    const tool = createEmailReplyTool({ actionLogFile: logFile(), approvalGate: approve, reader: reader({ ...message, from: "Anonymous Sender" }), sender, userId: "stark" });
    const out = await tool.execute({ body: "hi", id: "m1" }, ctx);
    expect(out).toMatchObject({ reason: "no-identifier", sent: false });
    expect(sends).toHaveLength(0);
  });
});

describe("createEmailForwardTool — forward a received email to a contact, draft-first", () => {
  const message: EmailMessage = { body: "Can you confirm Friday?", from: "Jane Park <jane@globex.com>", id: "m1", subject: "Q3 budget" };
  const reader = (msg: EmailMessage | undefined) => ({ getMessage: async (id: string) => (id === "m1" ? msg : undefined) });

  it("exposes an execute-risk email_forward tool with {id, to} required", () => {
    const { sender } = gmail();
    const tool = createEmailForwardTool({ actionLogFile: logFile(), approvalGate: approve, contacts: () => CONTACTS, reader: reader(message), sender, userId: "stark" });
    expect(tool.definition.name).toBe("email_forward");
    expect(tool.definition.risk).toBe("execute");
    expect(tool.definition.inputSchema.required).toEqual(["id", "to"]);
  });

  it("CONFIRM: reads the message, forwards to the resolved CONTACT with a Fwd: subject + quoted body", async () => {
    const { sender, sends } = gmail();
    const actionLogFile = logFile();
    const tool = createEmailForwardTool({ actionLogFile, approvalGate: approve, contacts: () => CONTACTS, reader: reader(message), sender, userId: "stark" });
    const out = await tool.execute({ id: "m1", note: "FYI", to: "Alice" }, ctx);
    expect(out).toMatchObject({ forwardedTo: "alice@example.com", sent: true, subject: "Fwd: Q3 budget" });
    expect(sends).toHaveLength(1);
    expect((await readActionLog(actionLogFile))[0]).toMatchObject({ result: "performed" });
  });

  it("UNKNOWN message id: nothing is sent", async () => {
    const { sender, sends } = gmail();
    const tool = createEmailForwardTool({ actionLogFile: logFile(), approvalGate: approve, contacts: () => CONTACTS, reader: reader(message), sender, userId: "stark" });
    const out = await tool.execute({ id: "nope", to: "Alice" }, ctx);
    expect(out).toMatchObject({ reason: "unknown-message", sent: false });
    expect(sends).toHaveLength(0);
  });

  it("AMBIGUOUS contact: no send, returns candidates to clarify", async () => {
    const { sender, sends } = gmail();
    const tool = createEmailForwardTool({ actionLogFile: logFile(), approvalGate: approve, contacts: () => CONTACTS, reader: reader(message), sender, userId: "stark" });
    const out = await tool.execute({ id: "m1", to: "Bob" }, ctx) as Record<string, unknown>;
    expect(out.sent).toBe(false);
    expect(out.reason).toBe("ambiguous-recipient");
    expect(out.candidates).toEqual(["Bob", "Bob"]);
    expect(sends).toHaveLength(0);
  });

  it("DENY: drafted but NOT sent", async () => {
    const { sender, sends } = gmail();
    const tool = createEmailForwardTool({ actionLogFile: logFile(), approvalGate: deny, contacts: () => CONTACTS, reader: reader(message), sender, userId: "stark" });
    const out = await tool.execute({ id: "m1", to: "Alice" }, ctx);
    expect(out).toMatchObject({ reason: "denied", sent: false });
    expect(sends).toHaveLength(0);
  });
});
