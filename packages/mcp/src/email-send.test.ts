import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { GmailEmailProvider } from "./email-provider.js";
import { sendEmailWithApproval, type EmailApprovalGate } from "./email-send.js";
import { readActionLog } from "./personal-action-log-store.js";
import type { Contact } from "./personal-contacts-store.js";

const CONTACTS: Contact[] = [
  { email: "bob@example.com", id: "c_bob", name: "Bob" },
  { email: "bob.jones@example.com", id: "c_bob2", name: "Bob" },
  { email: "alice@example.com", id: "c_alice", name: "Alice" },
  { handle: "@dave", id: "c_dave", name: "Dave" }
];

// Real GmailEmailProvider with the HTTP boundary faked — records every
// send POST so a test can assert the send fired (or didn't) and carried
// the Bearer + base64url raw message. Never a fake "did it" flag.
function gmailSender(): { sender: GmailEmailProvider; sends: { url: string; bearer: boolean; raw: string }[] } {
  const sends: { url: string; bearer: boolean; raw: string }[] = [];
  const fetchImpl = (async (url: string | URL, init?: { headers?: Record<string, string>; body?: string }) => {
    sends.push({
      bearer: (init?.headers?.authorization ?? "").startsWith("Bearer "),
      raw: String(JSON.parse(String(init?.body ?? "{}")).raw ?? ""),
      url: String(url)
    });
    return new Response(JSON.stringify({ id: "sent1" }), { status: 200 });
  }) as unknown as typeof globalThis.fetch;
  return { sender: new GmailEmailProvider("tok", fetchImpl), sends };
}

const approve: EmailApprovalGate = () => ({ approved: true });
const deny: EmailApprovalGate = () => ({ approved: false, reason: "user declined" });
const throwingGate: EmailApprovalGate = () => { throw new Error("approval prompt undeliverable"); };

function logFile(): string {
  return join(mkdtempSync(join(tmpdir(), "muse-email-send-")), "action-log.json");
}

function baseOpts(over: Partial<Parameters<typeof sendEmailWithApproval>[0]> = {}) {
  const { sender } = gmailSender();
  return {
    actionLogFile: logFile(),
    approvalGate: approve,
    body: "See attached.",
    contacts: CONTACTS,
    recipientQuery: "Alice",
    sender,
    subject: "Q3 plan",
    userId: "stark",
    ...over
  };
}

describe("sendEmailWithApproval — outbound-safety contract", () => {
  it("CONFIRM: the HTTP send fires exactly once with the drafted content, and logs `performed`", async () => {
    const { sender, sends } = gmailSender();
    const opts = baseOpts({ approvalGate: approve, sender });
    const outcome = await sendEmailWithApproval(opts);
    expect(outcome).toEqual({ sent: true, to: "alice@example.com" });
    expect(sends).toHaveLength(1);
    expect(sends[0]!.url).toContain("/messages/send");
    expect(sends[0]!.bearer).toBe(true);
    // The confirmed body is what left (base64url-decoded MIME contains it).
    expect(Buffer.from(sends[0]!.raw, "base64url").toString("utf8")).toContain("See attached.");
    const log = await readActionLog(opts.actionLogFile);
    expect(log[0]).toMatchObject({ result: "performed", what: "email to alice@example.com: Q3 plan" });
  });

  it("DENY: no send fires and the refusal is logged", async () => {
    const { sender, sends } = gmailSender();
    const opts = baseOpts({ approvalGate: deny, sender });
    const outcome = await sendEmailWithApproval(opts);
    expect(outcome).toMatchObject({ reason: "denied", sent: false });
    expect(sends).toHaveLength(0);
    expect((await readActionLog(opts.actionLogFile))[0]).toMatchObject({ result: "refused" });
  });

  it("TIMEOUT / gate error: fail-closed — no send fires", async () => {
    const { sender, sends } = gmailSender();
    const opts = baseOpts({ approvalGate: throwingGate, sender });
    const outcome = await sendEmailWithApproval(opts);
    expect(outcome).toMatchObject({ reason: "denied", sent: false });
    expect(sends).toHaveLength(0);
  });

  it("AMBIGUOUS recipient: no send, returns candidates to clarify, logs refusal", async () => {
    const { sender, sends } = gmailSender();
    const opts = baseOpts({ approvalGate: approve, recipientQuery: "Bob", sender });
    const outcome = await sendEmailWithApproval(opts);
    expect(outcome.sent).toBe(false);
    if (!outcome.sent) {
      expect(outcome.reason).toBe("ambiguous-recipient");
      expect(outcome.candidates?.length).toBe(2);
    }
    // Approved gate, but the send STILL must not fire on an ambiguous recipient.
    expect(sends).toHaveLength(0);
    expect((await readActionLog(opts.actionLogFile))[0]).toMatchObject({ result: "refused" });
  });

  it("UNKNOWN recipient: no send", async () => {
    const { sender, sends } = gmailSender();
    const outcome = await sendEmailWithApproval(baseOpts({ approvalGate: approve, recipientQuery: "Carol", sender }));
    expect(outcome).toMatchObject({ reason: "unknown-recipient", sent: false });
    expect(sends).toHaveLength(0);
  });

  it("recipient with no email (handle-only contact): no send", async () => {
    const { sender, sends } = gmailSender();
    const outcome = await sendEmailWithApproval(baseOpts({ approvalGate: approve, recipientQuery: "Dave", sender }));
    expect(outcome).toMatchObject({ reason: "no-identifier", sent: false });
    expect(sends).toHaveLength(0);
  });

  it("APPROVED but the transport rejects (Gmail 5xx): reason `send-failed`, NOT a false `sent`, attempted ONCE (no double-send), logged failed", async () => {
    // The user confirmed, but the send API failed. Reporting sent:true would tell
    // the user a message left when it didn't; retrying could double-deliver a
    // message to a human. The outcome must be sent:false/send-failed, the send
    // attempted exactly once, and the failure recorded (outbound-safety rule 4).
    let attempts = 0;
    const fetchImpl = (async () => { attempts += 1; return new Response("err", { status: 500 }); }) as unknown as typeof globalThis.fetch;
    const sender = new GmailEmailProvider("tok", fetchImpl);
    const opts = baseOpts({ approvalGate: approve, recipientQuery: "Alice", sender });
    const outcome = await sendEmailWithApproval(opts);
    expect(outcome).toMatchObject({ reason: "send-failed", sent: false });
    expect(attempts).toBe(1);
    expect((await readActionLog(opts.actionLogFile))[0]).toMatchObject({ result: "failed" });
  });
});
