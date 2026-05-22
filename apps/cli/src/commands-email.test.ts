import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { EmailApprovalGate, EmailSender } from "@muse/mcp";
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
