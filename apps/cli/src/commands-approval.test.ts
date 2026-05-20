import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Command } from "commander";
import { describe, expect, it } from "vitest";

import { registerApprovalCommands } from "./commands-approval.js";

async function run(approvalsFile: string, trustFile: string, args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number | undefined }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io = { stderr: (m: string) => stderr.push(m), stdout: (m: string) => stdout.push(m) };
  const prevAppr = process.env.MUSE_APPROVALS_FILE;
  const prevTrust = process.env.MUSE_TRUST_FILE;
  process.env.MUSE_APPROVALS_FILE = approvalsFile;
  process.env.MUSE_TRUST_FILE = trustFile;
  let exitCode: number | undefined;
  try {
    const program = new Command();
    program.exitOverride();
    registerApprovalCommands(program, io);
    await program.parseAsync(["node", "muse", "approval", ...args]);
  } catch (cause) {
    exitCode = (cause as { exitCode?: number }).exitCode ?? 1;
  } finally {
    if (prevAppr === undefined) delete process.env.MUSE_APPROVALS_FILE;
    else process.env.MUSE_APPROVALS_FILE = prevAppr;
    if (prevTrust === undefined) delete process.env.MUSE_TRUST_FILE;
    else process.env.MUSE_TRUST_FILE = prevTrust;
  }
  return { exitCode, stderr: stderr.join(""), stdout: stdout.join("") };
}

function pendingFile(id: string): { approvals: string; trust: string } {
  const dir = mkdtempSync(join(tmpdir(), "muse-cli-approval-"));
  const approvals = join(dir, "pending-approvals.jsonl");
  const trust = join(dir, "trust.json");
  const entry = {
    askedAtIso: "2026-05-20T12:00:00.000Z",
    id,
    status: "pending",
    toolName: "fs.write",
    userKey: "u"
  };
  writeFileSync(approvals, `${JSON.stringify(entry)}\n`);
  return { approvals, trust };
}

describe("muse approval — typo-tolerant id resolution (goal-468/472 sibling)", () => {
  it("suggests the closest pending id when `approve <typo>` does not match", async () => {
    const { approvals, trust } = pendingFile("req-abc123");
    process.exitCode = undefined;
    const r = await run(approvals, trust, ["approve", "req-abc12"]);
    expect(r.stderr).toContain("Request 'req-abc12' not found.");
    expect(r.stderr).toContain("did you mean 'req-abc123'");
    expect(r.stderr).toContain("muse approval list");
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;
  });

  it("suggests the closest pending id when `deny <typo>` does not match", async () => {
    const { approvals, trust } = pendingFile("req-xyz999");
    process.exitCode = undefined;
    const r = await run(approvals, trust, ["deny", "req-xyz99"]);
    expect(r.stderr).toContain("did you mean 'req-xyz999'");
    process.exitCode = undefined;
  });

  it("offers NO guess when no id is close — `did you mean` would be misleading noise", async () => {
    const { approvals, trust } = pendingFile("req-abc123");
    process.exitCode = undefined;
    const r = await run(approvals, trust, ["approve", "totallydifferent"]);
    expect(r.stderr).toContain("Request 'totallydifferent' not found.");
    expect(r.stderr).not.toContain("did you mean");
    process.exitCode = undefined;
  });
});
