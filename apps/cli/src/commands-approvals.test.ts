import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { listPendingApprovals, recordPendingApproval, type PendingApproval } from "@muse/messaging";
import { Command } from "commander";
import { describe, expect, it } from "vitest";

import { approvePendingApproval, registerApprovalsCommands } from "./commands-approvals.js";
import type { ProgramIO } from "./program.js";

function fakeIo(): ProgramIO {
  return { stderr: () => {}, stdout: () => {} };
}

function recordingFetch(): { fetchImpl: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl = (async (url: string | URL) => {
    calls.push(String(url));
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

function webEntry(overrides: Partial<PendingApproval> = {}): PendingApproval {
  return {
    arguments: { summary: "Book a table", url: "http://x.test/book" },
    createdAt: new Date().toISOString(),
    draft: "POST http://x.test/book",
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    id: "w1",
    providerId: "telegram",
    risk: "execute",
    source: "42",
    tool: "web_action",
    ...overrides
  };
}

async function run(file: string, args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number | undefined }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io = { stderr: (m: string) => stderr.push(m), stdout: (m: string) => stdout.push(m) };
  const prev = process.env.MUSE_PENDING_APPROVALS_FILE;
  process.env.MUSE_PENDING_APPROVALS_FILE = file;
  let exitCode: number | undefined;
  try {
    const program = new Command();
    program.exitOverride();
    registerApprovalsCommands(program, io);
    await program.parseAsync(["node", "muse", "approvals", ...args]);
  } catch (cause) {
    exitCode = (cause as { exitCode?: number }).exitCode ?? 1;
  } finally {
    if (prev === undefined) delete process.env.MUSE_PENDING_APPROVALS_FILE;
    else process.env.MUSE_PENDING_APPROVALS_FILE = prev;
  }
  return { exitCode, stderr: stderr.join(""), stdout: stdout.join("") };
}

function file(): string {
  return join(mkdtempSync(join(tmpdir(), "muse-cli-approvals-")), "pending-approvals.json");
}

function entry(overrides: Partial<PendingApproval> = {}): PendingApproval {
  const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  return {
    arguments: { subject: "Q3", to: "bob" },
    createdAt: new Date().toISOString(),
    draft: 'to bob, subject "Q3"',
    expiresAt: future,
    id: "p1",
    providerId: "telegram",
    risk: "execute",
    source: "42",
    tool: "email_send",
    ...overrides
  };
}

describe("muse approvals", () => {
  it("lists un-expired pending approvals (default subcommand), newest first", async () => {
    const f = file();
    await recordPendingApproval(f, entry({ id: "old", createdAt: "2026-05-22T10:00:00.000Z" }));
    await recordPendingApproval(f, entry({ id: "new", createdAt: "2026-05-22T10:05:00.000Z" }));
    const r = await run(f, []);
    expect(r.stdout.indexOf("new")).toBeLessThan(r.stdout.indexOf("old"));
    expect(r.stdout).toContain("email_send");
    expect(r.stdout).toContain('to bob, subject "Q3"');
  });

  it("empty worklist → friendly message", async () => {
    expect((await run(file(), [])).stdout).toBe("No pending approvals.\n");
  });

  it("hides an expired entry from the list", async () => {
    const f = file();
    await recordPendingApproval(f, entry({ id: "stale", expiresAt: "2020-01-01T00:00:00.000Z" }));
    expect((await run(f, [])).stdout).toBe("No pending approvals.\n");
  });

  it("clear <id> dismisses a pending approval; unknown id exits 1", async () => {
    const f = file();
    await recordPendingApproval(f, entry({ id: "abc" }));
    const ok = await run(f, ["clear", "abc"]);
    expect(ok.stdout).toContain("Dismissed pending approval abc");
    expect((await run(f, [])).stdout).toBe("No pending approvals.\n");
    const miss = await run(f, ["clear", "ghost"]);
    expect(miss.stderr).toBe("muse approvals clear: No pending approval with id 'ghost'.\n");
    expect(miss.stdout).toBe("");
    expect(miss.exitCode).toBe(1);
  });

  it("approve <unknown id> → `muse approvals approve:`-prefixed stderr, exit 1, stdout empty", async () => {
    const miss = await run(file(), ["approve", "ghost"]);
    expect(miss.stderr).toBe("muse approvals approve: No pending approval with id 'ghost' (it may have expired).\n");
    expect(miss.stdout).toBe("");
    expect(miss.exitCode).toBe(1);
  });

  it("--json emits a machine-readable envelope", async () => {
    const f = file();
    await recordPendingApproval(f, entry({ id: "j1" }));
    const r = await run(f, ["list", "--json"]);
    const payload = JSON.parse(r.stdout) as { total: number; pending: PendingApproval[] };
    expect(payload.total).toBe(1);
    expect(payload.pending[0]?.id).toBe("j1");
  });
});

describe("approvePendingApproval — re-run completion", () => {
  const env = {} as Record<string, string | undefined>;

  it("CONFIRM: re-runs the gated tool (one request fires) and clears it (replay-guard)", async () => {
    const f = file();
    await recordPendingApproval(f, webEntry({ id: "go" }));
    const { fetchImpl, calls } = recordingFetch();
    const result = await approvePendingApproval({ isInteractive: () => true,
      confirmAction: async () => true,
      env,
      fetchImpl,
      id: "go",
      io: fakeIo(),
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      pendingFile: f
    });
    expect(result.status).toBe("ran");
    expect(calls).toEqual(["http://x.test/book"]);
    // Cleared → a second approve can't re-fire.
    expect(await listPendingApprovals(f)).toHaveLength(0);
    const replay = await approvePendingApproval({ isInteractive: () => true, confirmAction: async () => true, env, fetchImpl, id: "go", io: fakeIo(), pendingFile: f });
    expect(replay.status).toBe("not-found");
    expect(calls).toHaveLength(1); // no second request
  });

  it("DENY at the confirm: no request fires and the entry stays pending", async () => {
    const f = file();
    await recordPendingApproval(f, webEntry({ id: "no" }));
    const { fetchImpl, calls } = recordingFetch();
    const result = await approvePendingApproval({ isInteractive: () => true, confirmAction: async () => false, env, fetchImpl, id: "no", io: fakeIo(), pendingFile: f });
    expect(result.status).toBe("declined");
    expect(calls).toHaveLength(0);
    expect((await listPendingApprovals(f)).map((e) => e.id)).toEqual(["no"]); // still pending
  });

  it("unknown / expired id → not-found, nothing fired", async () => {
    const f = file();
    await recordPendingApproval(f, webEntry({ expiresAt: "2020-01-01T00:00:00.000Z", id: "stale" }));
    const { fetchImpl, calls } = recordingFetch();
    expect((await approvePendingApproval({ isInteractive: () => true, confirmAction: async () => true, env, fetchImpl, id: "ghost", io: fakeIo(), pendingFile: f })).status).toBe("not-found");
    expect((await approvePendingApproval({ isInteractive: () => true, confirmAction: async () => true, env, fetchImpl, id: "stale", io: fakeIo(), pendingFile: f })).status).toBe("not-found");
    expect(calls).toHaveLength(0);
  });

  it("a pending entry for a non-actuator tool → no-tool, not cleared", async () => {
    const f = file();
    await recordPendingApproval(f, webEntry({ id: "x", tool: "muse.notes.save" }));
    const result = await approvePendingApproval({ isInteractive: () => true, confirmAction: async () => true, env, id: "x", io: fakeIo(), pendingFile: f });
    expect(result.status).toBe("no-tool");
    expect((await listPendingApprovals(f)).map((e) => e.id)).toEqual(["x"]);
  });

  it("local-only keeps a pending Gmail approval and never reads its credential or sends", async () => {
    const f = file();
    await recordPendingApproval(f, entry({ id: "gmail-local" }));
    let gmailReads = 0;
    const localEnv: Record<string, string | undefined> = { MUSE_LOCAL_ONLY: "true" };
    Object.defineProperty(localEnv, "MUSE_GMAIL_TOKEN", {
      configurable: true,
      enumerable: true,
      get: () => {
        gmailReads += 1;
        throw new Error("Gmail credential must not be read while local-only");
      }
    });
    const { calls, fetchImpl } = recordingFetch();

    const result = await approvePendingApproval({
      confirmAction: async () => true,
      env: localEnv,
      fetchImpl,
      id: "gmail-local",
      io: fakeIo(),
      isInteractive: () => true,
      pendingFile: f
    });

    expect(result).toEqual({ status: "no-tool", tool: "email_send" });
    expect(gmailReads).toBe(0);
    expect(calls).toEqual([]);
    expect((await listPendingApprovals(f)).map((item) => item.id)).toEqual(["gmail-local"]);
  });

  it("local-only keeps a pending remote Home Assistant approval without reading its token or sending", async () => {
    const f = file();
    await recordPendingApproval(f, webEntry({
      arguments: { entity: "light.living_room", service: "light.turn_off" },
      id: "home-local",
      tool: "home_action"
    }));
    let tokenReads = 0;
    const localEnv: Record<string, string | undefined> = {
      MUSE_HOMEASSISTANT_URL: "http://ha.local:8123",
      MUSE_LOCAL_ONLY: "true"
    };
    Object.defineProperty(localEnv, "MUSE_HOMEASSISTANT_TOKEN", {
      configurable: true,
      enumerable: true,
      get: () => {
        tokenReads += 1;
        throw new Error("HA token must not be read while remote local-only is blocked");
      }
    });
    const { calls, fetchImpl } = recordingFetch();
    const result = await approvePendingApproval({
      confirmAction: async () => true,
      env: localEnv,
      fetchImpl,
      id: "home-local",
      io: fakeIo(),
      isInteractive: () => true,
      pendingFile: f
    });
    expect(result).toEqual({ status: "no-tool", tool: "home_action" });
    expect(tokenReads).toBe(0);
    expect(calls).toEqual([]);
    expect((await listPendingApprovals(f)).map((item) => item.id)).toEqual(["home-local"]);
  });
});
