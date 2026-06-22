import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { EmailApprovalGate, EmailSender } from "@muse/domain-tools";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { registerContactsCommands } from "./commands-contacts.js";
import { registerEmailCommands } from "./commands-email.js";

// P11 seam: a contact ADDED via `muse contacts` must resolve as the
// recipient of `muse email send` over the SAME ~/.muse/contacts.json —
// and the never-guess rule must hold end-to-end (two same-name contacts
// ⇒ no send). Composes the real contacts store + resolveContact + the
// fail-closed send gate through the actual CLI commands, which are
// tested separately elsewhere.

const approve: EmailApprovalGate = () => ({ approved: true });

function recordingSender(): { sender: EmailSender; sends: { to: string }[] } {
  const sends: { to: string }[] = [];
  return { sender: { sendEmail: async (to) => { sends.push({ to }); } }, sends };
}

let saved: { contacts?: string; log?: string };

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "muse-p11-seam-"));
  saved = { contacts: process.env.MUSE_CONTACTS_FILE, log: process.env.MUSE_ACTION_LOG_FILE };
  process.env.MUSE_CONTACTS_FILE = join(dir, "contacts.json");
  process.env.MUSE_ACTION_LOG_FILE = join(dir, "action-log.json");
});

afterEach(() => {
  if (saved.contacts === undefined) delete process.env.MUSE_CONTACTS_FILE;
  else process.env.MUSE_CONTACTS_FILE = saved.contacts;
  if (saved.log === undefined) delete process.env.MUSE_ACTION_LOG_FILE;
  else process.env.MUSE_ACTION_LOG_FILE = saved.log;
});

async function run(sender: EmailSender, args: string[]): Promise<{ output: string; exitCode: number | undefined }> {
  const output: string[] = [];
  const io = { stderr: (m: string) => output.push(m), stdout: (m: string) => output.push(m) };
  const prevExit = process.exitCode;
  process.exitCode = 0;
  const program = new Command();
  program.exitOverride();
  registerContactsCommands(program, io);
  registerEmailCommands(program, io, { approvalGate: approve, sender });
  try {
    await program.parseAsync(["node", "muse", ...args]);
  } catch { /* commander exitOverride */ }
  const exitCode = process.exitCode === 0 ? undefined : process.exitCode;
  process.exitCode = prevExit;
  return { exitCode, output: output.join("") };
}

describe("P11 seam — contacts → gated email send over one store", () => {
  it("a contact added via `muse contacts` resolves as the recipient and the send fires on confirm", async () => {
    const { sender, sends } = recordingSender();
    await run(sender, ["contacts", "add", "Bob", "--email", "bob@example.com"]);
    const r = await run(sender, ["email", "send", "--to", "Bob", "--subject", "Hi", "--body", "hello"]);
    expect(r.output).toContain("Sent to bob@example.com");
    expect(sends).toEqual([{ to: "bob@example.com" }]);
  });

  it("never-guess holds end-to-end: two same-name contacts ⇒ ambiguous, NO send (even with an approving gate)", async () => {
    const { sender, sends } = recordingSender();
    await run(sender, ["contacts", "add", "Bob", "--email", "bob1@example.com"]);
    await run(sender, ["contacts", "add", "Bob", "--email", "bob2@example.com"]);
    const r = await run(sender, ["email", "send", "--to", "Bob", "--subject", "Hi", "--body", "hello"]);
    expect(sends).toHaveLength(0);
    expect(r.output).toContain("is ambiguous");
    expect(r.exitCode).toBe(1);
  });
});
