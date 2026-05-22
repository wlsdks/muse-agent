import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { GmailEmailProvider } from "./email-provider.js";
import { createEmailSendTool } from "./email-tool.js";
import type { EmailApprovalGate } from "./email-send.js";
import { readActionLog } from "./personal-action-log-store.js";
import type { Contact } from "./personal-contacts-store.js";

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
