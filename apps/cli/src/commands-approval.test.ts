import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Command } from "commander";
import { describe, expect, it } from "vitest";

import { approvalsPath, registerApprovalCommands, trustPath } from "./commands-approval.js";

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

describe("muse approval — typo-tolerant id resolution", () => {
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

  it("approval list --json envelope carries `total` (convention parity with goals 552/553/565)", async () => {
    const { approvals, trust } = pendingFile("req-abc123");
    process.exitCode = undefined;
    const r = await run(approvals, trust, ["list", "--user", "u", "--json"]);
    const parsed = JSON.parse(r.stdout) as { entries: Array<{ id: string }>; total: number; userKey: string };
    expect(parsed.entries.map((e) => e.id)).toEqual(["req-abc123"]);
    expect(parsed.total, "list --json must carry `total` — convention parity").toBe(1);
    expect(parsed.userKey).toBe("u");
    process.exitCode = undefined;
  });
});

describe("muse approval approve — malformed trust.json must not corrupt on-disk state", () => {
  it("a trust.json lacking a top-level `users` object does not flip the approval before failing", async () => {
    const { approvals, trust } = pendingFile("req-malformed1");
    // {} parses fine but has no `users` — the unvalidated old code would
    // overwrite the safe default with {} then throw on `.users[...]`,
    // AFTER the approval entry had already been flipped to "approved".
    writeFileSync(trust, "{}\n");
    process.exitCode = undefined;
    const r = await run(approvals, trust, ["approve", "req-malformed1"]);

    // The approval must succeed cleanly (no unhandled rejection / crash) ...
    expect(r.stdout).toContain("Approved req-malformed1");
    expect(r.exitCode ?? process.exitCode).toBeFalsy();

    // ... the trust file must hold a valid, granted shape ...
    const trustDoc = JSON.parse(readFileSync(trust, "utf8")) as {
      version: number;
      users: Record<string, { trustedTools: string[]; blockedTools: string[] }>;
    };
    expect(trustDoc.version).toBe(1);
    expect(trustDoc.users.u?.trustedTools).toContain("fs.write");

    // ... and the on-disk approval entry must be consistently "approved".
    const approvalLine = JSON.parse(readFileSync(approvals, "utf8").trim()) as { status: string };
    expect(approvalLine.status).toBe("approved");
    process.exitCode = undefined;
  });
});

describe("approvalsPath / trustPath — empty-env-shadow defence", () => {
  it("uses the env value when MUSE_APPROVALS_FILE / MUSE_TRUST_FILE is set non-empty", () => {
    const prevA = process.env.MUSE_APPROVALS_FILE;
    const prevT = process.env.MUSE_TRUST_FILE;
    process.env.MUSE_APPROVALS_FILE = "/tmp/custom-pending.jsonl";
    process.env.MUSE_TRUST_FILE = "/tmp/custom-trust.json";
    try {
      expect(approvalsPath()).toBe("/tmp/custom-pending.jsonl");
      expect(trustPath()).toBe("/tmp/custom-trust.json");
    } finally {
      if (prevA === undefined) delete process.env.MUSE_APPROVALS_FILE;
      else process.env.MUSE_APPROVALS_FILE = prevA;
      if (prevT === undefined) delete process.env.MUSE_TRUST_FILE;
      else process.env.MUSE_TRUST_FILE = prevT;
    }
  });

  it("falls back to ~/.muse defaults when MUSE_APPROVALS_FILE / MUSE_TRUST_FILE is whitespace-only — does NOT return empty path that would crash fs ops", () => {
    const prevA = process.env.MUSE_APPROVALS_FILE;
    const prevT = process.env.MUSE_TRUST_FILE;
    process.env.MUSE_APPROVALS_FILE = "   ";
    process.env.MUSE_TRUST_FILE = "";
    try {
      const apath = approvalsPath();
      const tpath = trustPath();
      expect(apath.replaceAll("\\", "/")).toMatch(/\/\.muse\/pending-approvals\.jsonl$/u);
      expect(apath, "the whitespace-only env value must NOT leak through as the resolved path").not.toBe("");
      expect(apath).not.toBe("   ");
      expect(tpath.replaceAll("\\", "/")).toMatch(/\/\.muse\/trust\.json$/u);
      expect(tpath).not.toBe("");
    } finally {
      if (prevA === undefined) delete process.env.MUSE_APPROVALS_FILE;
      else process.env.MUSE_APPROVALS_FILE = prevA;
      if (prevT === undefined) delete process.env.MUSE_TRUST_FILE;
      else process.env.MUSE_TRUST_FILE = prevT;
    }
  });
});
