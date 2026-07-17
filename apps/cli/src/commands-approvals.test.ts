import { mkdtempSync, promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beginPendingApprovalExecution, claimPendingApproval, declinePendingApprovalClaim, listPendingApprovals, recordPendingApproval, type PendingApproval } from "@muse/messaging";
import { readActionLog } from "@muse/stores";
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

async function run(
  file: string,
  args: string[],
  approve?: typeof approvePendingApproval
): Promise<{ stdout: string; stderr: string; exitCode: number | undefined }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io = { stderr: (m: string) => stderr.push(m), stdout: (m: string) => stdout.push(m) };
  const prev = process.env.MUSE_PENDING_APPROVALS_FILE;
  process.env.MUSE_PENDING_APPROVALS_FILE = file;
  let exitCode: number | undefined;
  try {
    const program = new Command();
    program.exitOverride();
    registerApprovalsCommands(program, io, approve ? { approvePendingApproval: approve } : undefined);
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
    await recordPendingApproval(f, entry({ createdAt: "2019-01-01T00:00:00.000Z", id: "stale", expiresAt: "2020-01-01T00:00:00.000Z" }));
    expect((await run(f, [])).stdout).toBe("No pending approvals.\n");
  });

  it("clear <id> durably denies a pending approval; unknown id exits 1", async () => {
    const f = file();
    await recordPendingApproval(f, entry({ id: "abc" }));
    const ok = await run(f, ["clear", "abc"]);
    expect(ok.stdout).toBe("Denied pending approval abc; it will not retry.\n");
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

  it("reports a durable denial as non-retryable instead of still pending", async () => {
    const result = await run(file(), ["approve", "denied"], async () => ({ detail: "user did not confirm", status: "declined", tool: "web_action" }));
    expect(result.stderr).toBe("muse approvals approve: Denied (user did not confirm); this approval will not retry automatically.\n");
    expect(result.stdout).toBe("");
    expect(result.exitCode).toBe(1);
  });

  it("reports successful completion as recorded and replay-blocked instead of dismissed", async () => {
    const result = await run(file(), ["approve", "done"], async () => ({ status: "ran", tool: "email_send" }));
    expect(result.stdout).toBe("Completed email_send and recorded the result; replay is blocked.\n");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBeUndefined();
  });

  it("prints the actual durable state for an approval conflict", async () => {
    const result = await run(file(), ["approve", "race"], async () => ({ state: "denied", status: "conflict", tool: "web_action" }));
    expect(result.stderr).toContain("Approval state changed to 'denied'");
    expect(result.stderr).toContain("no additional retry will be attempted");
    expect(result.exitCode).toBe(1);
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

  it("reports the actual executing conflict and keeps replay blocked when success cannot be durably finalized", async () => {
    const f = file();
    await recordPendingApproval(f, webEntry({ id: "finalize-false" }));
    const { fetchImpl, calls } = recordingFetch();
    const result = await approvePendingApproval({
      confirmAction: async () => true,
      env,
      fetchImpl,
      finalizeExecution: async () => ({ state: "executing", transitioned: false }),
      id: "finalize-false",
      io: fakeIo(),
      isInteractive: () => true,
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      pendingFile: f
    });
    expect(result).toMatchObject({ state: "executing", status: "conflict" });
    expect(calls).toHaveLength(1);
    expect((await claimPendingApproval(f, "finalize-false", { surface: "cli" })).state).toBe("executing");
    expect((await approvePendingApproval({ confirmAction: async () => true, env, fetchImpl, id: "finalize-false", io: fakeIo(), isInteractive: () => true, pendingFile: f })).status).toBe("not-found");
    expect(calls).toHaveLength(1);
  });

  it("rebuilds the executing actuator from the immutable claim snapshot after a valid store swap", async () => {
    const f = file();
    const actionLogFile = join(f, "..", "actions.json");
    await recordPendingApproval(f, webEntry({ id: "swap", userId: "old-owner" }));
    const { fetchImpl, calls } = recordingFetch();
    const swapped = webEntry({
      arguments: { summary: "Claimed action", url: "http://claimed.test/action" },
      id: "swap",
      userId: "new-owner"
    });
    const result = await approvePendingApproval({
      claimApproval: async (pendingFile, id, actor, now) => {
        await fs.writeFile(pendingFile, JSON.stringify({ pending: [swapped] }), "utf8");
        return claimPendingApproval(pendingFile, id, actor, now);
      },
      confirmAction: async () => true,
      env: { MUSE_ACTION_LOG_FILE: actionLogFile },
      fetchImpl,
      id: "swap",
      io: fakeIo(),
      isInteractive: () => true,
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      pendingFile: f
    });

    expect(result.status).toBe("ran");
    expect(calls).toEqual(["http://claimed.test/action"]);
    expect((await readActionLog(actionLogFile)).at(-1)).toMatchObject({ userId: "new-owner" });
  });

  it("treats explicit error evidence as unknown even when the tool also reports sent", async () => {
    const f = file();
    await recordPendingApproval(f, webEntry({ id: "contradictory-result" }));
    const { fetchImpl, calls } = recordingFetch();
    const result = await approvePendingApproval({
      confirmAction: async () => true,
      env,
      executeTool: async () => ({ error: "provider failed", sent: true }),
      fetchImpl,
      id: "contradictory-result",
      io: fakeIo(),
      isInteractive: () => true,
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      pendingFile: f
    });

    expect(result).toMatchObject({ status: "unknown", tool: "web_action" });
    expect(calls).toEqual([]);
    expect((await claimPendingApproval(f, "contradictory-result", { surface: "cli" })).state).toBe("unknown");
  });

  it("treats a recognized false marker as unknown even when another marker reports success", async () => {
    const f = file();
    await recordPendingApproval(f, webEntry({ id: "contradictory-markers" }));
    const result = await approvePendingApproval({
      confirmAction: async () => true,
      env,
      executeTool: async () => ({ performed: false, sent: true }),
      id: "contradictory-markers",
      io: fakeIo(),
      isInteractive: () => true,
      pendingFile: f
    });

    expect(result).toMatchObject({ status: "unknown", tool: "web_action" });
    expect((await claimPendingApproval(f, "contradictory-markers", { surface: "cli" })).state).toBe("unknown");
  });

  it.each([
    ["null-result", null],
    ["string-result", "provider returned text only"]
  ] as const)("durably finalizes the non-object %s as unknown", async (id, toolResult) => {
    const f = file();
    await recordPendingApproval(f, webEntry({ id }));
    const result = await approvePendingApproval({
      confirmAction: async () => true,
      env,
      executeTool: async () => toolResult,
      id,
      io: fakeIo(),
      isInteractive: () => true,
      pendingFile: f
    });

    expect(result).toMatchObject({ state: "unknown", status: "unknown", tool: "web_action" });
    expect((await claimPendingApproval(f, id, { surface: "cli" })).state).toBe("unknown");
  });

  it("does not read a hostile reason getter before durably finalizing unknown", async () => {
    const f = file();
    await recordPendingApproval(f, webEntry({ id: "hostile-reason" }));
    const toolResult = Object.defineProperty({}, "reason", {
      get: () => {
        throw new Error("hostile reason getter");
      }
    });
    const result = await approvePendingApproval({
      confirmAction: async () => true,
      env,
      executeTool: async () => toolResult,
      id: "hostile-reason",
      io: fakeIo(),
      isInteractive: () => true,
      pendingFile: f
    });

    expect(result).toMatchObject({ state: "unknown", status: "unknown" });
    expect((await claimPendingApproval(f, "hostile-reason", { surface: "cli" })).state).toBe("unknown");
  });

  it("reports the actual denied state when confirmation races with a claimed-to-denied transition", async () => {
    const f = file();
    await recordPendingApproval(f, webEntry({ id: "confirm-race" }));
    let effects = 0;
    const result = await approvePendingApproval({
      confirmAction: async () => {
        const persisted = JSON.parse(await fs.readFile(f, "utf8")) as { executions: Array<{ claimToken: string }> };
        await declinePendingApprovalClaim(f, "confirm-race", persisted.executions[0]!.claimToken, "racing denial");
        return true;
      },
      env,
      executeTool: async () => {
        effects += 1;
        return { performed: true };
      },
      id: "confirm-race",
      io: fakeIo(),
      isInteractive: () => true,
      pendingFile: f
    });

    expect(result).toMatchObject({ state: "denied", status: "conflict", tool: "web_action" });
    expect(effects).toBe(0);
    expect((await claimPendingApproval(f, "confirm-race", { surface: "cli" })).state).toBe("denied");
  });

  it("preserves actual durable states across claim, decline, and finalize CAS losses", async () => {
    const claimFile = file();
    await recordPendingApproval(claimFile, webEntry({ id: "claim-loss" }));
    const claimLoss = await approvePendingApproval({
      claimApproval: async (pendingFile, id, actor, now) => {
        const winner = await claimPendingApproval(pendingFile, id, actor, now);
        if (!winner.claimedByThisCall) return winner;
        await beginPendingApprovalExecution(pendingFile, id, winner.claimToken, now);
        return claimPendingApproval(pendingFile, id, actor, now);
      },
      confirmAction: async () => true,
      env,
      id: "claim-loss",
      io: fakeIo(),
      isInteractive: () => true,
      pendingFile: claimFile
    });
    expect(claimLoss).toMatchObject({ state: "executing", status: "conflict" });

    const declineFile = file();
    await recordPendingApproval(declineFile, webEntry({ id: "decline-loss" }));
    const declineLoss = await approvePendingApproval({
      confirmAction: async () => false,
      declineClaim: async (pendingFile, id, token, _detail, now) => {
        await beginPendingApprovalExecution(pendingFile, id, token, now);
        return declinePendingApprovalClaim(pendingFile, id, token, undefined, now);
      },
      env,
      id: "decline-loss",
      io: fakeIo(),
      isInteractive: () => true,
      pendingFile: declineFile
    });
    expect(declineLoss).toMatchObject({ state: "executing", status: "conflict" });

    for (const [id, executeTool] of [
      ["throw-finalize-loss", async () => { throw new Error("boom"); }],
      ["unknown-finalize-loss", async () => ({ performed: false })]
    ] as const) {
      const pendingFile = file();
      await recordPendingApproval(pendingFile, webEntry({ id }));
      const result = await approvePendingApproval({
        confirmAction: async () => true,
        env,
        executeTool,
        finalizeExecution: async () => ({ state: "executing", transitioned: false }),
        id,
        io: fakeIo(),
        isInteractive: () => true,
        pendingFile
      });
      expect(result).toMatchObject({ state: "executing", status: "conflict" });
      expect((await claimPendingApproval(pendingFile, id, { surface: "cli" })).state).toBe("executing");
    }
  });

  it("reports the durable state when a claimed no-tool denial CAS loses", async () => {
    const f = file();
    await recordPendingApproval(f, webEntry({ id: "no-tool-loss" }));
    const swapped = webEntry({ id: "no-tool-loss", tool: "muse.unknown" });
    const result = await approvePendingApproval({
      claimApproval: async (pendingFile, id, actor, now) => {
        await fs.writeFile(pendingFile, JSON.stringify({ pending: [swapped] }), "utf8");
        return claimPendingApproval(pendingFile, id, actor, now);
      },
      confirmAction: async () => true,
      declineClaim: async (pendingFile, id, token, _detail, now) => {
        await beginPendingApprovalExecution(pendingFile, id, token, now);
        return declinePendingApprovalClaim(pendingFile, id, token, undefined, now);
      },
      env,
      id: "no-tool-loss",
      io: fakeIo(),
      isInteractive: () => true,
      pendingFile: f
    });
    expect(result).toMatchObject({ state: "executing", status: "conflict", tool: "muse.unknown" });
  });

  it("DENY at the confirm: no request fires and the approval becomes durably denied", async () => {
    const f = file();
    await recordPendingApproval(f, webEntry({ id: "no" }));
    const { fetchImpl, calls } = recordingFetch();
    const result = await approvePendingApproval({ isInteractive: () => true, confirmAction: async () => false, env, fetchImpl, id: "no", io: fakeIo(), pendingFile: f });
    expect(result.status).toBe("declined");
    expect(calls).toHaveLength(0);
    expect(await listPendingApprovals(f)).toEqual([]);
    expect((await claimPendingApproval(f, "no", { surface: "cli" })).state).toBe("denied");
    expect((await approvePendingApproval({ isInteractive: () => true, confirmAction: async () => true, env, fetchImpl, id: "no", io: fakeIo(), pendingFile: f })).status).toBe("not-found");
    expect(calls).toHaveLength(0);
  });

  it("unknown / expired id → not-found, nothing fired", async () => {
    const f = file();
    await recordPendingApproval(f, webEntry({ createdAt: "2019-01-01T00:00:00.000Z", expiresAt: "2020-01-01T00:00:00.000Z", id: "stale" }));
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
