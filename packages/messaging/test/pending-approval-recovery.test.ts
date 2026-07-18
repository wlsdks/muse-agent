import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CLAIM_RECOVERY_LEASE_MS,
  beginPendingApprovalExecution,
  claimPendingApproval,
  declinePendingApprovalClaim,
  finalizePendingApprovalExecution,
  inspectPendingApprovalStatus,
  recoverPendingApprovalClaim,
  recordPendingApproval,
  type PendingApproval
} from "../src/pending-approval-store.js";

let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(join(tmpdir(), "pending-approval-recovery-")); });
afterEach(async () => { await fs.rm(dir, { force: true, recursive: true }); });

const approval = (id: string, overrides: Partial<PendingApproval> = {}): PendingApproval => ({
  arguments: { title: "private task payload" },
  createdAt: "2026-07-18T00:00:00.000Z",
  draft: "x".repeat(300),
  expiresAt: "2030-01-01T00:00:00.000Z",
  id,
  providerId: "telegram",
  risk: "write",
  source: "42",
  tool: "muse.tasks.add",
  userId: "owner",
  ...overrides
});

describe("inspectPendingApprovalStatus", () => {
  it("returns bounded owner-safe metadata for a stale claimed task without sensitive execution fields", async () => {
    const file = join(dir, "pending.json");
    const claimedAt = new Date("2026-07-18T01:00:00.000Z");
    await recordPendingApproval(file, approval("status"));
    const claim = await claimPendingApproval(file, "status", { requestUserId: "owner", surface: "api" }, () => claimedAt);
    if (!claim.claimedByThisCall) throw new Error("expected claim");

    const result = await inspectPendingApprovalStatus(
      file,
      "status",
      { requestUserId: "owner", surface: "api" },
      () => new Date(claimedAt.getTime() + CLAIM_RECOVERY_LEASE_MS)
    );

    expect(result).toEqual({
      found: true,
      status: {
        claimedAt: claimedAt.toISOString(),
        createdAt: "2026-07-18T00:00:00.000Z",
        draft: "x".repeat(240),
        effectMayHaveOccurred: false,
        expiresAt: "2030-01-01T00:00:00.000Z",
        id: "status",
        recoverable: true,
        recoverableAt: new Date(claimedAt.getTime() + CLAIM_RECOVERY_LEASE_MS).toISOString(),
        risk: "write",
        state: "claimed",
        tool: "muse.tasks.add",
        updatedAt: claimedAt.toISOString()
      }
    });
    expect(JSON.stringify(result)).not.toContain("private task payload");
    expect(JSON.stringify(result)).not.toContain(claim.claimToken);
    expect(JSON.stringify(result)).not.toContain(file);
  });

  it("returns only forbidden for an owner mismatch", async () => {
    const file = join(dir, "owner.json");
    await recordPendingApproval(file, approval("owned"));
    await claimPendingApproval(file, "owned", { requestUserId: "owner", surface: "api" }, () => new Date("2026-07-18T01:00:00.000Z"));

    expect(await inspectPendingApprovalStatus(
      file,
      "owned",
      { requestUserId: "intruder", surface: "api" },
      () => new Date("2026-07-18T01:20:00.000Z")
    )).toEqual({ found: false, state: "forbidden" });
    expect(await inspectPendingApprovalStatus(
      file,
      "owned",
      { surface: "api" },
      () => new Date("2026-07-18T01:20:00.000Z")
    )).toEqual({ found: false, state: "forbidden" });
  });

  it("keeps expired approvals indistinguishable from unavailable metadata", async () => {
    const file = join(dir, "expired-status.json");
    await recordPendingApproval(file, approval("expired-status", { expiresAt: "2026-07-18T01:00:00.000Z" }));

    expect(await inspectPendingApprovalStatus(
      file,
      "expired-status",
      { requestUserId: "owner", surface: "api" },
      () => new Date("2026-07-18T01:00:00.000Z")
    )).toEqual({ found: false, state: "expired" });
  });

  it("marks only executing and effect-attempted terminal states as possibly effected", async () => {
    const claimedAt = () => new Date("2026-07-18T01:00:00.000Z");
    const statusFor = async (id: string) => inspectPendingApprovalStatus(
      join(dir, `${id}.json`), id, { surface: "cli" }, () => new Date("2026-07-18T01:01:00.000Z")
    );
    const seedClaim = async (id: string) => {
      const file = join(dir, `${id}.json`);
      await recordPendingApproval(file, approval(id));
      const claim = await claimPendingApproval(file, id, { surface: "cli" }, claimedAt);
      if (!claim.claimedByThisCall) throw new Error("expected claim");
      return { claim, file };
    };

    const pendingFile = join(dir, "pending-effect.json");
    await recordPendingApproval(pendingFile, approval("pending-effect"));
    const pendingStatus = await inspectPendingApprovalStatus(pendingFile, "pending-effect", { surface: "cli" }, claimedAt);
    expect(pendingStatus.found && pendingStatus.status.effectMayHaveOccurred).toBe(false);

    await seedClaim("claimed-effect");
    const claimedStatus = await statusFor("claimed-effect");
    expect(claimedStatus.found && claimedStatus.status.effectMayHaveOccurred).toBe(false);

    const denied = await seedClaim("denied-effect");
    await declinePendingApprovalClaim(denied.file, "denied-effect", denied.claim.claimToken);
    const deniedStatus = await statusFor("denied-effect");
    expect(deniedStatus.found && deniedStatus.status.effectMayHaveOccurred).toBe(false);

    for (const state of ["executing", "unknown", "succeeded"] as const) {
      const seeded = await seedClaim(`${state}-effect`);
      await beginPendingApprovalExecution(seeded.file, `${state}-effect`, seeded.claim.claimToken);
      if (state !== "executing") {
        await finalizePendingApprovalExecution(seeded.file, `${state}-effect`, seeded.claim.claimToken, state);
      }
      const result = await statusFor(`${state}-effect`);
      expect(result.found && result.status.effectMayHaveOccurred).toBe(true);
    }
  });
});

describe("recoverPendingApprovalClaim", () => {
  it("wins at the exact lease boundary, rotates authority, and invalidates the old token", async () => {
    const file = join(dir, "recover.json");
    const claimedAt = new Date("2026-07-18T01:00:00.000Z");
    await recordPendingApproval(file, approval("recover"));
    const original = await claimPendingApproval(file, "recover", { requestUserId: "owner", surface: "api" }, () => claimedAt);
    if (!original.claimedByThisCall) throw new Error("expected claim");

    const recovered = await recoverPendingApprovalClaim(
      file,
      "recover",
      { requestUserId: "owner", surface: "api" },
      () => new Date(claimedAt.getTime() + CLAIM_RECOVERY_LEASE_MS)
    );

    expect(recovered).toMatchObject({ approvalSnapshot: { id: "recover" }, claimedByThisCall: true, state: "claimed" });
    if (!recovered.claimedByThisCall) throw new Error("expected recovery");
    expect(recovered.claimToken).not.toBe(original.claimToken);
    expect(await beginPendingApprovalExecution(file, "recover", original.claimToken)).toEqual({ state: "claimed", transitioned: false });
    expect(await beginPendingApprovalExecution(
      file,
      "recover",
      recovered.claimToken,
      () => new Date(claimedAt.getTime() + CLAIM_RECOVERY_LEASE_MS)
    )).toEqual({ state: "executing", transitioned: true });
    const stored = JSON.parse(await fs.readFile(file, "utf8")) as { executions: Array<{ claimedAt: string; updatedAt: string }> };
    expect(stored.executions[0]).toMatchObject({
      claimedAt: claimedAt.toISOString(),
      updatedAt: new Date(claimedAt.getTime() + CLAIM_RECOVERY_LEASE_MS).toISOString()
    });
  });

  it("leaves a pending approval untouched and directs the caller to normal approval", async () => {
    const file = join(dir, "pending.json");
    await recordPendingApproval(file, approval("pending"));
    const before = await fs.readFile(file, "utf8");

    expect(await recoverPendingApprovalClaim(
      file,
      "pending",
      { requestUserId: "owner", surface: "api" },
      () => new Date("2026-07-18T01:20:00.000Z")
    )).toEqual({ claimedByThisCall: false, state: "pending" });
    expect(await fs.readFile(file, "utf8")).toBe(before);
  });

  it("loses one millisecond before the lease boundary without mutating the claim", async () => {
    const file = join(dir, "early.json");
    const claimedAt = new Date("2026-07-18T01:00:00.000Z");
    await recordPendingApproval(file, approval("early"));
    await claimPendingApproval(file, "early", { requestUserId: "owner", surface: "api" }, () => claimedAt);
    const before = await fs.readFile(file, "utf8");

    expect(await recoverPendingApprovalClaim(
      file,
      "early",
      { requestUserId: "owner", surface: "api" },
      () => new Date(claimedAt.getTime() + CLAIM_RECOVERY_LEASE_MS - 1)
    )).toEqual({ claimedByThisCall: false, state: "claimed" });
    expect(await fs.readFile(file, "utf8")).toBe(before);
  });

  it("allows exactly one of two simultaneous stale-claim recoveries to rotate authority", async () => {
    const file = join(dir, "recovery-race.json");
    const claimedAt = new Date("2026-07-18T01:00:00.000Z");
    await recordPendingApproval(file, approval("recovery-race"));
    await claimPendingApproval(file, "recovery-race", { requestUserId: "owner", surface: "api" }, () => claimedAt);
    const recoverAt = () => new Date(claimedAt.getTime() + CLAIM_RECOVERY_LEASE_MS + 1);

    const results = await Promise.all([
      recoverPendingApprovalClaim(file, "recovery-race", { requestUserId: "owner", surface: "api" }, recoverAt),
      recoverPendingApprovalClaim(file, "recovery-race", { requestUserId: "owner", surface: "api" }, recoverAt)
    ]);

    expect(results.filter((result) => result.claimedByThisCall)).toHaveLength(1);
    expect(results.filter((result) => !result.claimedByThisCall)).toEqual([{ claimedByThisCall: false, state: "claimed" }]);
  });

  it("serializes original begin against recovery so only one effect path can acquire authority", async () => {
    const file = join(dir, "begin-race.json");
    const claimedAt = new Date("2026-07-18T01:00:00.000Z");
    await recordPendingApproval(file, approval("begin-race"));
    const original = await claimPendingApproval(file, "begin-race", { requestUserId: "owner", surface: "api" }, () => claimedAt);
    if (!original.claimedByThisCall) throw new Error("expected claim");
    const recoverAt = () => new Date(claimedAt.getTime() + CLAIM_RECOVERY_LEASE_MS);

    const [begin, recovery] = await Promise.all([
      beginPendingApprovalExecution(file, "begin-race", original.claimToken, recoverAt),
      recoverPendingApprovalClaim(file, "begin-race", { requestUserId: "owner", surface: "api" }, recoverAt)
    ]);

    expect(Number(begin.transitioned) + Number(recovery.claimedByThisCall)).toBe(1);
    if (recovery.claimedByThisCall) {
      expect(await beginPendingApprovalExecution(file, "begin-race", original.claimToken)).toEqual({ state: "claimed", transitioned: false });
      expect(await beginPendingApprovalExecution(file, "begin-race", recovery.claimToken)).toEqual({ state: "executing", transitioned: true });
    } else {
      expect(recovery.state).toBe("executing");
    }
  });

  it("fails closed without mutation for rollback, owner mismatch, expiry, unsupported tools, and post-effect states", async () => {
    const claimedAt = new Date("2026-07-18T01:00:00.000Z");
    const staleAt = () => new Date(claimedAt.getTime() + CLAIM_RECOVERY_LEASE_MS);
    const seed = async (id: string, overrides: Partial<PendingApproval> = {}) => {
      const file = join(dir, `${id}.json`);
      await recordPendingApproval(file, approval(id, overrides));
      const claim = await claimPendingApproval(file, id, { requestUserId: "owner", surface: "api" }, () => claimedAt);
      if (!claim.claimedByThisCall) throw new Error("expected claim");
      return { claim, file };
    };

    const rollback = await seed("rollback");
    const rollbackBytes = await fs.readFile(rollback.file, "utf8");
    expect(await recoverPendingApprovalClaim(rollback.file, "rollback", { requestUserId: "owner", surface: "api" }, () => new Date(claimedAt.getTime() - 1))).toEqual({ claimedByThisCall: false, state: "claimed" });
    expect(await fs.readFile(rollback.file, "utf8")).toBe(rollbackBytes);

    const wrongOwner = await seed("wrong-owner");
    const wrongOwnerBytes = await fs.readFile(wrongOwner.file, "utf8");
    expect(await recoverPendingApprovalClaim(wrongOwner.file, "wrong-owner", { requestUserId: "intruder", surface: "api" }, staleAt)).toEqual({ claimedByThisCall: false, state: "forbidden" });
    expect(await fs.readFile(wrongOwner.file, "utf8")).toBe(wrongOwnerBytes);

    const expired = await seed("expired", { expiresAt: staleAt().toISOString() });
    const expiredBytes = await fs.readFile(expired.file, "utf8");
    expect(await recoverPendingApprovalClaim(expired.file, "expired", { requestUserId: "owner", surface: "api" }, staleAt)).toEqual({ claimedByThisCall: false, state: "expired" });
    expect(await fs.readFile(expired.file, "utf8")).toBe(expiredBytes);

    const unsupported = await seed("unsupported", { tool: "web_action" });
    const unsupportedBytes = await fs.readFile(unsupported.file, "utf8");
    expect(await recoverPendingApprovalClaim(unsupported.file, "unsupported", { requestUserId: "owner", surface: "api" }, staleAt)).toEqual({ claimedByThisCall: false, state: "claimed" });
    expect(await fs.readFile(unsupported.file, "utf8")).toBe(unsupportedBytes);

    const executing = await seed("executing");
    await beginPendingApprovalExecution(executing.file, "executing", executing.claim.claimToken, staleAt);
    expect(await recoverPendingApprovalClaim(executing.file, "executing", { requestUserId: "owner", surface: "api" }, staleAt)).toEqual({ claimedByThisCall: false, state: "executing" });

    const terminal = await seed("terminal");
    await beginPendingApprovalExecution(terminal.file, "terminal", terminal.claim.claimToken, staleAt);
    await finalizePendingApprovalExecution(terminal.file, "terminal", terminal.claim.claimToken, "succeeded", undefined, staleAt);
    expect(await recoverPendingApprovalClaim(terminal.file, "terminal", { requestUserId: "owner", surface: "api" }, staleAt)).toEqual({ claimedByThisCall: false, state: "succeeded" });
  });

  it("rejects invalid execution timestamps without rewriting the v2 store", async () => {
    const file = join(dir, "invalid-time.json");
    const raw = JSON.stringify({
      executions: [{
        actor: { effectiveUser: "owner", surface: "api" },
        approvalSnapshot: approval("invalid-time"),
        claimedAt: "2026-07-18T01:00:01.000Z",
        claimToken: "00000000-0000-4000-8000-000000000000",
        state: "claimed",
        updatedAt: "2026-07-18T01:00:00.000Z"
      }],
      pending: [],
      version: 2
    });
    await fs.writeFile(file, raw, "utf8");

    await expect(recoverPendingApprovalClaim(
      file,
      "invalid-time",
      { requestUserId: "owner", surface: "api" },
      () => new Date("2026-07-18T02:00:00.000Z")
    )).rejects.toThrow("invalid pending approval store version");
    expect(await fs.readFile(file, "utf8")).toBe(raw);
  });
});
