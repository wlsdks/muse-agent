import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeContacts, type Contact, type EmailMessage, type EmailProvider, type EmailReader, type EmailSummary } from "@muse/mcp";
import { Command } from "commander";
import { describe, expect, it } from "vitest";

import { buildInboxKnownSender, formatEmailMessage, formatInboxLine, registerInboxCommand } from "./commands-inbox.js";

const INBOX: EmailSummary[] = [
  { from: "Alice <a@x.com>", id: "m1", snippet: "draft", subject: "Q3 plan", unread: true },
  { from: "Bob <b@y.com>", id: "m2", snippet: "noon", subject: "lunch?", unread: false }
];

function run(args: string[], provider?: EmailProvider & Partial<EmailReader>) {
  const output: string[] = [];
  const io = { stderr: (m: string) => output.push(m), stdout: (m: string) => output.push(m) };
  const program = new Command();
  program.exitOverride();
  registerInboxCommand(program, io, provider);
  return { output, run: program.parseAsync(["node", "muse", "inbox", ...args]) };
}

describe("muse inbox", () => {
  it("triages the inbox: summary line + per-message listing with an unread marker", async () => {
    const provider: EmailProvider = { listRecent: async () => INBOX };
    const { output, run: done } = run([], provider);
    await done;
    const text = output.join("");
    expect(text).toContain("2 messages, 1 unread");
    expect(text).toContain("● Alice <a@x.com> — Q3 plan");
    expect(text).toContain("  Bob <b@y.com> — lunch?");
  });

  it("shows a short id per line so a message can be read by id", async () => {
    const provider: EmailProvider = { listRecent: async () => INBOX };
    const { output, run: done } = run([], provider);
    await done;
    expect(output.join("")).toContain("[m1] ● Alice <a@x.com> — Q3 plan");
  });

  it("--json emits the structured summaries", async () => {
    const provider: EmailProvider = { listRecent: async () => INBOX };
    const { output, run: done } = run(["--json"], provider);
    await done;
    expect(JSON.parse(output.join(""))).toEqual(INBOX);
  });

  it("surfaces a provider auth error (exit 1)", async () => {
    const prevExit = process.exitCode;
    process.exitCode = 0;
    const provider: EmailProvider = { listRecent: async () => { throw new Error("Gmail auth rejected (401)"); } };
    const { output, run: done } = run([], provider);
    await done;
    expect(output.join("")).toContain("Gmail auth rejected (401)");
    expect(process.exitCode).toBe(1);
    process.exitCode = prevExit;
  });

  it("without MUSE_GMAIL_TOKEN and no provider, prints a clear setup hint (exit 1)", async () => {
    const prevExit = process.exitCode;
    const prevTok = process.env.MUSE_GMAIL_TOKEN;
    delete process.env.MUSE_GMAIL_TOKEN;
    process.exitCode = 0;
    const { output, run: done } = run([]);
    await done;
    expect(output.join("")).toContain("set MUSE_GMAIL_TOKEN");
    expect(process.exitCode).toBe(1);
    process.exitCode = prevExit;
    if (prevTok !== undefined) process.env.MUSE_GMAIL_TOKEN = prevTok;
  });
});

describe("muse inbox <id> — read one message's full body", () => {
  const READER: EmailProvider & EmailReader = {
    listRecent: async () => INBOX,
    getMessage: async (id) => id === "m2"
      ? { body: "Lunch at noon?\n\n- Bob", date: "Mon, 1 Jun 2026 09:00:00", from: "Bob <b@y.com>", id: "m2", subject: "lunch?" }
      : undefined
  };

  it("resolves the short id, prints From/Subject/Date and the plain-text body", async () => {
    const { output, run: done } = run(["m2"], READER);
    await done;
    const text = output.join("");
    expect(text).toContain("From:    Bob <b@y.com>");
    expect(text).toContain("Subject: lunch?");
    expect(text).toContain("Date:    Mon, 1 Jun 2026 09:00:00");
    expect(text).toContain("Lunch at noon?");
  });

  it("--json emits the full message object", async () => {
    const { output, run: done } = run(["m2", "--json"], READER);
    await done;
    expect(JSON.parse(output.join(""))).toMatchObject({ body: "Lunch at noon?\n\n- Bob", id: "m2", subject: "lunch?" });
  });

  it("an unknown id exits 1 without reading anything", async () => {
    const prevExit = process.exitCode;
    process.exitCode = 0;
    const { output, run: done } = run(["nope"], READER);
    await done;
    expect(output.join("")).toContain("no message in your recent inbox matches id 'nope'");
    expect(process.exitCode).toBe(1);
    process.exitCode = prevExit;
  });

  it("a provider that can't read a single message exits 1 with a clear message", async () => {
    const prevExit = process.exitCode;
    process.exitCode = 0;
    const listOnly: EmailProvider = { listRecent: async () => INBOX };
    const { output, run: done } = run(["m2"], listOnly);
    await done;
    expect(output.join("")).toContain("can't read a single message");
    expect(process.exitCode).toBe(1);
    process.exitCode = prevExit;
  });
});

describe("formatEmailMessage", () => {
  it("renders headers + body, and falls back when the body is empty", () => {
    const m: EmailMessage = { body: "  hello  ", date: "today", from: "A <a@x.com>", id: "m1", subject: "hi" };
    expect(formatEmailMessage(m)).toBe("From:    A <a@x.com>\nSubject: hi\nDate:    today\n\nhello");
    expect(formatEmailMessage({ body: "", from: "A", id: "m1", subject: "hi" })).toContain("(no text body)");
    expect(formatEmailMessage({ body: "x", from: "A", id: "m1", subject: "hi" })).not.toContain("Date:");
  });
});

describe("muse inbox — people-first marker", () => {
  it("formatInboxLine adds a trailing ★ for a known contact, none otherwise", () => {
    const m: EmailSummary = { from: "Alice <a@x.com>", id: "m1", snippet: "", subject: "Q3 plan", unread: true };
    expect(formatInboxLine(m, true)).toBe("● Alice <a@x.com> — Q3 plan ★");
    expect(formatInboxLine(m, false)).toBe("● Alice <a@x.com> — Q3 plan");
    expect(formatInboxLine({ ...m, unread: false }, true)).toBe("  Alice <a@x.com> — Q3 plan ★");
  });

  it("flags a message from a known contact in the listing (injected predicate)", async () => {
    const output: string[] = [];
    const io = { stderr: (m: string) => output.push(m), stdout: (m: string) => output.push(m) };
    const provider: EmailProvider = { listRecent: async () => INBOX };
    const program = new Command();
    program.exitOverride();
    registerInboxCommand(program, io, provider, (from) => from.includes("a@x.com"));
    await program.parseAsync(["node", "muse", "inbox"]);
    const text = output.join("");
    expect(text).toContain("● Alice <a@x.com> — Q3 plan ★"); // known → starred
    expect(text).toContain("  Bob <b@y.com> — lunch?\n"); // unknown → no star
  });

  it("buildInboxKnownSender matches a sender against the contacts graph by email", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-inbox-known-"));
    const file = join(dir, "contacts.json");
    const contact: Contact = { email: "a@x.com", id: "c1", name: "Alice" };
    await writeContacts(file, [contact]);
    const known = await buildInboxKnownSender({ MUSE_CONTACTS_FILE: file });
    expect(known("Alice <a@x.com>")).toBe(true);
    expect(known("Bob <b@y.com>")).toBe(false);
  });

  it("buildInboxKnownSender is fail-soft on an unreadable contacts file (never throws)", async () => {
    const known = await buildInboxKnownSender({ MUSE_CONTACTS_FILE: "/no/such/dir/contacts.json" });
    expect(known("anyone <x@y.com>")).toBe(false);
  });
});
