import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { EmailApprovalGate, EmailMessage, EmailReader, EmailSender } from "@muse/domain-tools";
import { Command } from "commander";
import { describe, expect, it } from "vitest";

import { registerEmailCommands, type EmailCommandDeps } from "./commands-email.js";

function fixtures(contacts: Array<{ id: string; name: string; email?: string }>): { contactsFile: string; actionLogFile: string } {
  const dir = mkdtempSync(join(tmpdir(), "muse-cli-email-"));
  const contactsFile = join(dir, "contacts.json");
  writeFileSync(contactsFile, JSON.stringify({ contacts }), "utf8");
  return { actionLogFile: join(dir, "action-log.json"), contactsFile };
}

function recordingSender(): { sender: EmailSender; sends: { to: string; subject: string; body: string }[] } {
  const sends: { to: string; subject: string; body: string }[] = [];
  return { sender: { sendEmail: async (to, subject, body) => { sends.push({ body, subject, to }); } }, sends };
}

async function run(args: string[], deps: EmailCommandDeps): Promise<{ output: string; exitCode: number | undefined }> {
  const output: string[] = [];
  const io = { stderr: (m: string) => output.push(m), stdout: (m: string) => output.push(m) };
  const prevExit = process.exitCode;
  process.exitCode = 0;
  const program = new Command();
  program.exitOverride();
  registerEmailCommands(program, io, deps);
  try {
    await program.parseAsync(["node", "muse", "email", ...args]);
  } catch { /* commander exitOverride throws on parse errors */ }
  const exitCode = process.exitCode === 0 ? undefined : process.exitCode;
  process.exitCode = prevExit;
  return { exitCode, output: output.join("") };
}

const approve: EmailApprovalGate = () => ({ approved: true });
const deny: EmailApprovalGate = () => ({ approved: false, reason: "declined" });

describe("muse email send — surface", () => {
  it("CONFIRM: sends to the resolved recipient and reports it", async () => {
    const fix = fixtures([{ email: "alice@example.com", id: "c_a", name: "Alice" }]);
    const { sender, sends } = recordingSender();
    const r = await run(["send", "--to", "Alice", "--subject", "Hi", "--body", "hello"], { ...fix, approvalGate: approve, sender });
    expect(r.output).toContain("Sent to alice@example.com");
    expect(sends).toEqual([{ body: "hello", subject: "Hi", to: "alice@example.com" }]);
    expect(r.exitCode).toBeUndefined();
  });

  it("DENY: no send, exit 1", async () => {
    const fix = fixtures([{ email: "alice@example.com", id: "c_a", name: "Alice" }]);
    const { sender, sends } = recordingSender();
    const r = await run(["send", "--to", "Alice", "--subject", "Hi", "--body", "hello"], { ...fix, approvalGate: deny, sender });
    expect(sends).toHaveLength(0);
    expect(r.output).toContain("Not sent (denied)");
    expect(r.exitCode).toBe(1);
  });

  it("AMBIGUOUS recipient: lists candidates, no send, exit 1 (even with an approving gate)", async () => {
    const fix = fixtures([
      { email: "bob1@x.com", id: "c_b1", name: "Bob" },
      { email: "bob2@y.com", id: "c_b2", name: "Bob" }
    ]);
    const { sender, sends } = recordingSender();
    const r = await run(["send", "--to", "Bob", "--subject", "Hi", "--body", "hello"], { ...fix, approvalGate: approve, sender });
    expect(sends).toHaveLength(0);
    expect(r.output).toContain("is ambiguous — did you mean");
    expect(r.output).toContain("bob1@x.com");
    expect(r.exitCode).toBe(1);
  });
});

describe("muse email sync — pull recent emails into recallable notes (contract-faithful Gmail)", () => {
  // A contract-faithful Gmail fake: the REAL GmailEmailProvider drives the real
  // Gmail API shape (messages.list → messages.get?format=metadata) against this
  // fake transport — never a stubbed provider.
  const gmailFetch = (responses: { list: unknown; messages: Record<string, unknown> }): typeof globalThis.fetch =>
    (async (url: string) => {
      const u = String(url);
      const msgMatch = u.match(/\/messages\/([^?]+)\?/u);
      if (msgMatch) {
        const id = decodeURIComponent(msgMatch[1]!);
        return new Response(JSON.stringify(responses.messages[id] ?? {}), { status: 200 });
      }
      return new Response(JSON.stringify(responses.list), { status: 200 }); // messages.list
    }) as unknown as typeof globalThis.fetch;

  const message = (from: string, subject: string, snippet: string, date?: string): Record<string, unknown> => ({
    labelIds: ["INBOX", "UNREAD"],
    snippet,
    payload: { headers: [{ name: "From", value: from }, { name: "Subject", value: subject }, ...(date ? [{ name: "Date", value: date }] : [])] }
  });

  it("writes one recallable note per email (from/subject/snippet), idempotent by message id", async () => {
    const { GmailEmailProvider } = await import("@muse/domain-tools");
    const notesDir = mkdtempSync(join(tmpdir(), "muse-email-sync-"));
    const fetchImpl = gmailFetch({
      list: { messages: [{ id: "m1" }, { id: "m2" }] },
      messages: {
        m1: message("Dana Wu <dana@example.com>", "Q3 budget review", "Can we move the Q3 review to Thursday?", "Tue, 2 Jun 2026 10:00:00 +0000"),
        m2: message("Bob <bob@example.com>", "Lunch?", "Free for lunch Friday?")
      }
    });
    const emailSource = new GmailEmailProvider("tok", fetchImpl);

    const res = await run(["sync", "--limit", "20"], { emailSource, notesDir });
    expect(res.exitCode).toBeUndefined();
    expect(res.output).toContain("Synced 2 emails");

    const dana = readFileSync(join(notesDir, "email", "m1.md"), "utf8");
    expect(dana).toContain("Q3 budget review"); // subject
    expect(dana).toContain("Dana Wu");          // from → "what did Dana email about?" recalls this
    expect(dana).toContain("move the Q3 review"); // snippet
    const bob = readFileSync(join(notesDir, "email", "m2.md"), "utf8");
    expect(bob).toContain("Lunch?");

    // Idempotent: a re-sync overwrites the same files, never duplicates.
    await run(["sync"], { emailSource, notesDir });
    const { readdirSync } = await import("node:fs");
    expect(readdirSync(join(notesDir, "email")).filter((f) => f.endsWith(".md")).length).toBe(2);
  });

  it("without MUSE_GMAIL_TOKEN (and no injected source) it explains how to enable, no write", async () => {
    const prev = process.env.MUSE_GMAIL_TOKEN;
    delete process.env.MUSE_GMAIL_TOKEN;
    try {
      const res = await run(["sync"], {});
      expect(res.exitCode).toBe(1);
      expect(res.output).toContain("MUSE_GMAIL_TOKEN");
    } finally {
      if (prev !== undefined) process.env.MUSE_GMAIL_TOKEN = prev;
    }
  });

  it("a Gmail read error is surfaced (fail-soft, no crash)", async () => {
    const notesDir = mkdtempSync(join(tmpdir(), "muse-email-sync-err-"));
    const { GmailEmailProvider } = await import("@muse/domain-tools");
    const boom = (async () => { throw new Error("network down"); }) as unknown as typeof globalThis.fetch;
    const res = await run(["sync"], { emailSource: new GmailEmailProvider("tok", boom), notesDir });
    expect(res.exitCode).toBe(1);
    expect(res.output).toContain("could not read Gmail");
  });
});

describe("muse email reply — surface (draft-first reply to a received email)", () => {
  const MSG: EmailMessage = { body: "Can you confirm Friday?", from: "Jane Park <jane@globex.com>", id: "m1", subject: "Q3 budget" };
  const reader = (msg: EmailMessage | undefined): EmailReader => ({ getMessage: async (id) => (id === "m1" ? msg : undefined) });

  it("CONFIRM: reads the message, replies to the SENDER's address with a Re: subject + body", async () => {
    const fix = fixtures([]);
    const { sender, sends } = recordingSender();
    const r = await run(["reply", "--id", "m1", "--body", "Friday works."], { ...fix, approvalGate: approve, reader: reader(MSG), sender });
    expect(r.output).toContain("Replied to jane@globex.com");
    expect(sends).toEqual([{ body: "Friday works.", subject: "Re: Q3 budget", to: "jane@globex.com" }]);
    expect(r.exitCode).toBeUndefined();
  });

  it("DENY: nothing is sent", async () => {
    const fix = fixtures([]);
    const { sender, sends } = recordingSender();
    const r = await run(["reply", "--id", "m1", "--body", "no thanks"], { ...fix, approvalGate: deny, reader: reader(MSG), sender });
    expect(r.output).toContain("Not sent (denied)");
    expect(sends).toHaveLength(0);
    expect(r.exitCode).toBe(1);
  });

  it("UNKNOWN id: no send, clear error", async () => {
    const fix = fixtures([]);
    const { sender, sends } = recordingSender();
    const r = await run(["reply", "--id", "nope", "--body", "x"], { ...fix, approvalGate: approve, reader: reader(MSG), sender });
    expect(r.output).toContain("no message with id 'nope'");
    expect(sends).toHaveLength(0);
    expect(r.exitCode).toBe(1);
  });

  it("sender with no parseable address: no send (fails closed)", async () => {
    const fix = fixtures([]);
    const { sender, sends } = recordingSender();
    const r = await run(["reply", "--id", "m1", "--body", "x"], { ...fix, approvalGate: approve, reader: reader({ ...MSG, from: "Anonymous Sender" }), sender });
    expect(r.output).toContain("couldn't determine a reply address");
    expect(sends).toHaveLength(0);
    expect(r.exitCode).toBe(1);
  });
});

describe("muse email forward — surface (draft-first forward to a contact)", () => {
  const MSG: EmailMessage = { body: "Can you confirm Friday?", from: "Jane Park <jane@globex.com>", id: "m1", subject: "Q3 budget" };
  const reader = (msg: EmailMessage | undefined): EmailReader => ({ getMessage: async (id) => (id === "m1" ? msg : undefined) });

  it("CONFIRM: reads the message, forwards to the resolved CONTACT with a Fwd: subject + quoted body", async () => {
    const fix = fixtures([{ email: "alice@example.com", id: "c_a", name: "Alice" }]);
    const { sender, sends } = recordingSender();
    const r = await run(["forward", "--id", "m1", "--to", "Alice", "--note", "FYI Alice"], { ...fix, approvalGate: approve, reader: reader(MSG), sender });
    expect(r.output).toContain("Forwarded to alice@example.com");
    expect(sends).toHaveLength(1);
    expect(sends[0]!.to).toBe("alice@example.com");
    expect(sends[0]!.subject).toBe("Fwd: Q3 budget");
    expect(sends[0]!.body).toContain("FYI Alice");
    expect(sends[0]!.body).toContain("--- Forwarded message ---");
    expect(sends[0]!.body).toContain("Can you confirm Friday?");
    expect(r.exitCode).toBeUndefined();
  });

  it("AMBIGUOUS contact: no send, lists candidates", async () => {
    const fix = fixtures([{ email: "bob1@example.com", id: "c_b1", name: "Bob" }, { email: "bob2@example.com", id: "c_b2", name: "Bob" }]);
    const { sender, sends } = recordingSender();
    const r = await run(["forward", "--id", "m1", "--to", "Bob"], { ...fix, approvalGate: approve, reader: reader(MSG), sender });
    expect(r.output).toContain("is ambiguous");
    expect(sends).toHaveLength(0);
    expect(r.exitCode).toBe(1);
  });

  it("UNKNOWN message id: no send, clear error", async () => {
    const fix = fixtures([{ email: "alice@example.com", id: "c_a", name: "Alice" }]);
    const { sender, sends } = recordingSender();
    const r = await run(["forward", "--id", "nope", "--to", "Alice"], { ...fix, approvalGate: approve, reader: reader(MSG), sender });
    expect(r.output).toContain("no message with id 'nope'");
    expect(sends).toHaveLength(0);
    expect(r.exitCode).toBe(1);
  });

  it("DENY: nothing is sent", async () => {
    const fix = fixtures([{ email: "alice@example.com", id: "c_a", name: "Alice" }]);
    const { sender, sends } = recordingSender();
    const r = await run(["forward", "--id", "m1", "--to", "Alice"], { ...fix, approvalGate: deny, reader: reader(MSG), sender });
    expect(r.output).toContain("Not sent (denied)");
    expect(sends).toHaveLength(0);
    expect(r.exitCode).toBe(1);
  });
});
