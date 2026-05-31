import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { EmailDraft } from "../src/email-send.js";
import { sendEmailWithApproval } from "../src/email-send.js";
import type { EmailSender } from "../src/email-provider.js";
import { readActionLog } from "../src/personal-action-log-store.js";
import type { Contact } from "../src/personal-contacts-store.js";

const CONTACTS: readonly Contact[] = [
  { email: "bob@example.com", id: "c1", name: "Bob" },
  { email: "alice.one@example.com", id: "c2", name: "Alice" },
  { email: "alice.two@example.com", id: "c3", name: "Alice" }, // dup name → ambiguous on "alice"
  { handle: "@carol", id: "c4", name: "Carol" } // handle only, no email
];

function recordingSender(): { sender: EmailSender; sent: Array<{ to: string; subject: string; body: string }> } {
  const sent: Array<{ to: string; subject: string; body: string }> = [];
  return { sender: { sendEmail: async (to, subject, body) => { sent.push({ body, subject, to }); } }, sent };
}

let dir: string;
let logFile: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "muse-email-send-"));
  logFile = join(dir, "actions.json");
});
afterEach(async () => {
  await rm(dir, { force: true, recursive: true });
});

const opts = (over: Partial<Parameters<typeof sendEmailWithApproval>[0]> = {}) => ({
  actionLogFile: logFile,
  approvalGate: () => ({ approved: true }),
  body: "the body",
  contacts: CONTACTS,
  recipientQuery: "Bob",
  sender: recordingSender().sender,
  subject: "Hi",
  userId: "u1",
  ...over
});

describe("sendEmailWithApproval — draft-first, fail-closed outbound (outbound-safety.md)", () => {
  it("CONFIRMED: sends exactly once with the confirmed content and logs 'performed'", async () => {
    const { sender, sent } = recordingSender();
    let presentedDraft: EmailDraft | undefined;
    const out = await sendEmailWithApproval(opts({
      approvalGate: (draft) => { presentedDraft = draft; return { approved: true }; },
      sender
    }));
    expect(out).toEqual({ sent: true, to: "bob@example.com" });
    expect(sent).toEqual([{ body: "the body", subject: "Hi", to: "bob@example.com" }]); // exactly once
    // draft-first: the gate saw the EXACT content before anything left
    expect(presentedDraft).toEqual({ body: "the body", recipientName: "Bob", subject: "Hi", to: "bob@example.com" });
    const log = await readActionLog(logFile);
    expect(log.at(-1)).toMatchObject({ result: "performed" });
  });

  it("DENIED: no send, outcome denied, refusal logged with the reason", async () => {
    const { sender, sent } = recordingSender();
    const out = await sendEmailWithApproval(opts({ approvalGate: () => ({ approved: false, reason: "user said no" }), sender }));
    expect(out).toMatchObject({ reason: "denied", sent: false });
    expect(sent).toHaveLength(0);
    expect((await readActionLog(logFile)).at(-1)).toMatchObject({ result: "refused" });
  });

  it("GATE THROWS (timeout / undeliverable prompt): fail-closed — no send", async () => {
    const { sender, sent } = recordingSender();
    const out = await sendEmailWithApproval(opts({
      approvalGate: () => { throw new Error("prompt channel down"); },
      sender
    }));
    expect(out).toMatchObject({ reason: "denied", sent: false });
    expect((out as { detail: string }).detail).toContain("approval gate error");
    expect(sent).toHaveLength(0);
  });

  it("AMBIGUOUS recipient: no send, candidates returned for clarification, refusal logged", async () => {
    const { sender, sent } = recordingSender();
    const out = await sendEmailWithApproval(opts({ recipientQuery: "Alice", sender }));
    expect(out).toMatchObject({ reason: "ambiguous-recipient", sent: false });
    expect((out as { candidates: Contact[] }).candidates).toHaveLength(2);
    expect(sent).toHaveLength(0);
    expect((await readActionLog(logFile)).at(-1)).toMatchObject({ result: "refused" });
  });

  it("UNKNOWN recipient: no send, refusal logged", async () => {
    const { sender, sent } = recordingSender();
    const out = await sendEmailWithApproval(opts({ recipientQuery: "Nobody", sender }));
    expect(out).toMatchObject({ reason: "unknown-recipient", sent: false });
    expect(sent).toHaveLength(0);
  });

  it("NO email address (handle-only contact): no send — never falls back to the handle", async () => {
    const { sender, sent } = recordingSender();
    const out = await sendEmailWithApproval(opts({ recipientQuery: "Carol", sender }));
    expect(out).toMatchObject({ reason: "no-identifier", sent: false });
    expect(sent).toHaveLength(0);
  });

  it("SEND FAILS at the transport: outcome send-failed, logged 'failed'", async () => {
    const sender: EmailSender = { sendEmail: async () => { throw new Error("smtp 554"); } };
    const out = await sendEmailWithApproval(opts({ sender }));
    expect(out).toMatchObject({ reason: "send-failed", sent: false });
    expect((out as { detail: string }).detail).toContain("smtp 554");
    expect((await readActionLog(logFile)).at(-1)).toMatchObject({ result: "failed" });
  });
});
