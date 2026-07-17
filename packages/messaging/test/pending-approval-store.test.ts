import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  beginPendingApprovalExecution,
  claimPendingApproval,
  clearPendingApproval,
  declinePendingApprovalClaim,
  denyPendingApproval,
  filterUnexpired,
  listPendingApprovals,
  finalizePendingApprovalExecution,
  type PendingApproval,
  readPendingApprovals,
  recordPendingApproval
} from "../src/pending-approval-store.js";

let dir: string;
let counter = 0;
beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), "pending-approval-"));
  counter = 0;
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});
const freshFile = () => join(dir, `pa-${counter++}.json`);

const entry = (id: string, over: Partial<PendingApproval> = {}): PendingApproval => ({
  arguments: { to: "x@example.com" },
  createdAt: "2026-01-01T00:00:00Z",
  draft: "Send the email?",
  expiresAt: "2030-01-01T00:00:00Z",
  id,
  providerId: "slack",
  risk: "write",
  source: "C1",
  tool: "email_send",
  ...over
});

describe("claimPendingApproval — durable v1 migration and replay guard", () => {
  it("moves a v1 pending entry to a v2 claimed tombstone and grants only one caller execution authority", async () => {
    const file = freshFile();
    const approval = entry("claim-once", { userId: "owner" });
    await fs.writeFile(file, `${JSON.stringify({ pending: [approval] }, null, 2)}\n`, "utf8");

    const first = await claimPendingApproval(file, approval.id, { requestUserId: "owner", surface: "api" }, () => new Date("2026-06-01T00:00:00Z"));
    const replay = await claimPendingApproval(file, approval.id, { requestUserId: "owner", surface: "api" }, () => new Date("2026-06-01T00:00:01Z"));

    expect(first).toMatchObject({
      approvalSnapshot: approval,
      claimedByThisCall: true,
      state: "claimed"
    });
    expect(first.claimedByThisCall && first.claimToken).toEqual(expect.any(String));
    expect(replay).toEqual({ claimedByThisCall: false, state: "claimed" });
    expect(JSON.parse(await fs.readFile(file, "utf8"))).toMatchObject({
      executions: [{
        actor: { effectiveUser: "owner", surface: "api" },
        approvalSnapshot: approval,
        claimToken: first.claimedByThisCall ? first.claimToken : "",
        claimedAt: "2026-06-01T00:00:00.000Z",
        state: "claimed",
        updatedAt: "2026-06-01T00:00:00.000Z"
      }],
      pending: [],
      version: 2
    });
  });

  it("preserves unknown legacy pending fields while migrating and executing v1 state", async () => {
    const file = freshFile();
    const legacy = { ...entry("legacy-extra"), legacyMetadata: { imported: true } };
    await fs.writeFile(file, JSON.stringify({ pending: [legacy] }), "utf8");
    const claim = await claimPendingApproval(file, legacy.id, { surface: "cli" }, () => new Date("2026-06-01T00:00:00.000Z"));
    if (!claim.claimedByThisCall) throw new Error("expected claim");
    expect(claim.approvalSnapshot).toMatchObject({ legacyMetadata: { imported: true } });
    expect((await beginPendingApprovalExecution(file, legacy.id, claim.claimToken)).transitioned).toBe(true);
    const persisted = JSON.parse(await fs.readFile(file, "utf8")) as { executions: Array<{ approvalSnapshot: Record<string, unknown> }> };
    expect(persisted.executions[0]?.approvalSnapshot["legacyMetadata"]).toEqual({ imported: true });
  });

  it("allows only the winning token to begin and finalize execution", async () => {
    const file = freshFile();
    await fs.writeFile(file, JSON.stringify({ pending: [entry("cas")] }), "utf8");
    const claim = await claimPendingApproval(file, "cas", { surface: "cli" }, () => new Date("2026-06-01T00:00:00Z"));
    expect(claim.claimedByThisCall).toBe(true);
    if (!claim.claimedByThisCall) throw new Error("expected claim");

    const beforeWrongToken = await fs.readFile(file, "utf8");
    expect(await beginPendingApprovalExecution(file, "cas", "wrong-token", () => new Date("2026-06-01T00:00:01Z"))).toEqual({ state: "claimed", transitioned: false });
    expect(await fs.readFile(file, "utf8")).toBe(beforeWrongToken);
    expect(await beginPendingApprovalExecution(file, "cas", claim.claimToken, () => new Date("2026-06-01T00:00:02Z"))).toEqual({ state: "executing", transitioned: true });
    expect(await finalizePendingApprovalExecution(file, "cas", claim.claimToken, "succeeded", undefined, () => new Date("2026-06-01T00:00:03Z"))).toEqual({ state: "succeeded", transitioned: true });

    const terminalBytes = await fs.readFile(file, "utf8");
    expect(await beginPendingApprovalExecution(file, "cas", claim.claimToken)).toEqual({ state: "succeeded", transitioned: false });
    expect(await finalizePendingApprovalExecution(file, "cas", claim.claimToken, "unknown", "late", () => new Date("2026-06-01T00:00:04Z"))).toEqual({ state: "succeeded", transitioned: false });
    expect(await fs.readFile(file, "utf8")).toBe(terminalBytes);
  });

  it("keeps execution timestamps monotonic when begin and finalize receive an older clock", async () => {
    const file = freshFile();
    await fs.writeFile(file, JSON.stringify({ pending: [entry("clock-rollback")] }), "utf8");
    const claimedAt = "2026-06-01T00:00:03.000Z";
    const claim = await claimPendingApproval(file, "clock-rollback", { surface: "cli" }, () => new Date(claimedAt));
    if (!claim.claimedByThisCall) throw new Error("expected claim");

    expect(await beginPendingApprovalExecution(file, "clock-rollback", claim.claimToken, () => new Date("2026-06-01T00:00:02.000Z"))).toEqual({ state: "executing", transitioned: true });
    expect(await finalizePendingApprovalExecution(file, "clock-rollback", claim.claimToken, "succeeded", undefined, () => new Date("2026-06-01T00:00:01.000Z"))).toEqual({ state: "succeeded", transitioned: true });
    expect(await claimPendingApproval(file, "clock-rollback", { surface: "cli" })).toEqual({ claimedByThisCall: false, state: "succeeded" });

    const stored = JSON.parse(await fs.readFile(file, "utf8")) as { executions: Array<{ claimedAt: string; updatedAt: string }> };
    expect(stored.executions[0]).toMatchObject({ claimedAt, updatedAt: claimedAt });
  });

  it("allows a CLI No only while claimed and never after execution begins", async () => {
    const file = freshFile();
    await fs.writeFile(file, JSON.stringify({ pending: [entry("decline")] }), "utf8");
    const claim = await claimPendingApproval(file, "decline", { surface: "cli" });
    if (!claim.claimedByThisCall) throw new Error("expected claim");
    expect(await declinePendingApprovalClaim(file, "decline", claim.claimToken, "user declined")).toEqual({ state: "denied", transitioned: true });
    expect(await beginPendingApprovalExecution(file, "decline", claim.claimToken)).toEqual({ state: "denied", transitioned: false });
  });

  it("serializes approve-vs-deny so exactly one pending transition wins", async () => {
    const file = freshFile();
    await fs.writeFile(file, JSON.stringify({ pending: [entry("race")] }), "utf8");
    const [claim, deny] = await Promise.all([
      claimPendingApproval(file, "race", { surface: "cli" }),
      denyPendingApproval(file, "race", { surface: "cli" }, "dismissed")
    ]);
    expect(Number(claim.claimedByThisCall) + Number(deny.transitioned)).toBe(1);
    expect(claim.state).toBe(deny.state);
    expect(["claimed", "denied"]).toContain(claim.state);
  });

  it("returns the persisted immutable snapshot to the direct-deny winner", async () => {
    const file = freshFile();
    const approval = entry("deny-snapshot", { userId: "owner" });
    await fs.writeFile(file, JSON.stringify({ pending: [approval] }), "utf8");

    expect(await denyPendingApproval(file, approval.id, { requestUserId: "owner", surface: "api" }, "user denied")).toMatchObject({
      approvalSnapshot: approval,
      state: "denied",
      transitioned: true
    });
  });
});

describe("readPendingApprovals — tolerant display read", () => {
  it("returns [] for a missing file", async () => {
    expect(await readPendingApprovals(join(dir, "nope.json"))).toEqual([]);
  });

  it("preserves an unparseable file and returns []", async () => {
    const file = freshFile();
    const raw = "{not valid json";
    await fs.writeFile(file, raw);
    expect(await readPendingApprovals(file)).toEqual([]);
    expect(await fs.readFile(file, "utf8")).toBe(raw);
    expect((await fs.readdir(dir)).some((f) => f.includes(".corrupt-"))).toBe(false);
  });

  it("preserves valid JSON that lacks a pending array", async () => {
    const file = freshFile();
    const raw = JSON.stringify({ pending: "not-an-array" });
    await fs.writeFile(file, raw);
    expect(await readPendingApprovals(file)).toEqual([]);
    expect(await fs.readFile(file, "utf8")).toBe(raw);
  });

  it("drops malformed entries, keeping only well-formed ones", async () => {
    const file = freshFile();
    await fs.writeFile(
      file,
      JSON.stringify({
        pending: [
          entry("ok"),
          { id: "missing-fields" },
          { ...entry("bad-risk"), risk: "delete" },
          { ...entry("array-args"), arguments: [] },
          { ...entry("null-args"), arguments: null }
        ]
      })
    );
    expect((await readPendingApprovals(file)).map((e) => e.id)).toEqual(["ok"]);
  });
});

describe("strict mutation parser and tombstones", () => {
  it("rejects mixed-invalid state without rewriting or quarantining it", async () => {
    const file = freshFile();
    const raw = JSON.stringify({ pending: [entry("valid"), { id: "broken" }] });
    await fs.writeFile(file, raw, "utf8");

    await expect(claimPendingApproval(file, "valid", { surface: "cli" })).rejects.toThrow("invalid pending approval store");
    await expect(recordPendingApproval(file, entry("new"))).rejects.toThrow("invalid pending approval store");
    await expect(clearPendingApproval(file, "valid")).rejects.toThrow("invalid pending approval store");
    expect(await fs.readFile(file, "utf8")).toBe(raw);
    expect((await fs.readdir(dir)).some((name) => name.includes(".corrupt-"))).toBe(false);
  });

  it("fails closed on an unparseable expiry at the mutation boundary", async () => {
    const file = freshFile();
    const raw = JSON.stringify({ pending: [entry("bad-date", { expiresAt: "not-a-date" })] });
    await fs.writeFile(file, raw, "utf8");
    await expect(claimPendingApproval(file, "bad-date", { surface: "cli" })).rejects.toThrow("invalid pending approval store");
    expect(await fs.readFile(file, "utf8")).toBe(raw);
  });

  it("rejects a tampered v2 execution with invalid timestamps and empty authority fields without rewriting it", async () => {
    const file = freshFile();
    const raw = JSON.stringify({
      executions: [{
        actor: { effectiveUser: "", surface: "cli" },
        approvalSnapshot: entry("tampered-execution"),
        claimedAt: "not-a-date",
        claimToken: "",
        state: "claimed",
        updatedAt: "not-a-date"
      }],
      pending: [],
      version: 2
    });
    await fs.writeFile(file, raw, "utf8");

    await expect(beginPendingApprovalExecution(file, "tampered-execution", "")).rejects.toThrow("invalid pending approval store version");
    expect(await fs.readFile(file, "utf8")).toBe(raw);
    expect((await fs.readdir(dir)).some((name) => name.includes(".corrupt-"))).toBe(false);
  });

  it("rejects unknown execution schema fields and timestamps that move backwards", async () => {
    const invalidExecutions = [
      {
        actor: { effectiveUser: "owner", role: "injected", surface: "cli" },
        approvalSnapshot: entry("extra-actor"),
        claimedAt: "2026-06-01T00:00:00.000Z",
        claimToken: "token",
        state: "claimed",
        updatedAt: "2026-06-01T00:00:00.000Z"
      },
      {
        actor: { effectiveUser: "owner", surface: "cli" },
        approvalSnapshot: entry("extra-execution"),
        claimedAt: "2026-06-01T00:00:00.000Z",
        claimToken: "token",
        injected: true,
        state: "claimed",
        updatedAt: "2026-06-01T00:00:00.000Z"
      },
      {
        actor: { effectiveUser: "owner", surface: "cli" },
        approvalSnapshot: entry("backwards-time"),
        claimedAt: "2026-06-01T00:00:01.000Z",
        claimToken: "token",
        state: "claimed",
        updatedAt: "2026-06-01T00:00:00.000Z"
      }
    ];
    for (const execution of invalidExecutions) {
      const file = freshFile();
      const raw = JSON.stringify({ executions: [execution], pending: [], version: 2 });
      await fs.writeFile(file, raw, "utf8");
      await expect(beginPendingApprovalExecution(file, execution.approvalSnapshot.id, "token")).rejects.toThrow("invalid pending approval store version");
      expect(await fs.readFile(file, "utf8")).toBe(raw);
    }
  });

  it("rejects executions claimed before creation or at/after expiry without rewriting them", async () => {
    const invalidClaims = [
      { claimedAt: "2025-12-31T23:59:59.000Z", id: "before-created" },
      { claimedAt: "2031-01-01T00:00:00.000Z", id: "after-expiry" }
    ];
    for (const invalid of invalidClaims) {
      const file = freshFile();
      const execution = {
        actor: { effectiveUser: "owner", surface: "cli" },
        approvalSnapshot: entry(invalid.id),
        claimedAt: invalid.claimedAt,
        claimToken: "token",
        state: "claimed",
        updatedAt: invalid.claimedAt
      };
      const raw = JSON.stringify({ executions: [execution], pending: [], version: 2 });
      await fs.writeFile(file, raw, "utf8");
      await expect(beginPendingApprovalExecution(file, invalid.id, "token")).rejects.toThrow("invalid pending approval store version");
      expect(await fs.readFile(file, "utf8")).toBe(raw);
    }
  });

  it("rejects execution actors that do not match the persisted approval owner", async () => {
    const invalidBindings = [
      { approval: entry("owned-binding", { userId: "owner" }), effectiveUser: "intruder" },
      { approval: entry("cli-binding"), effectiveUser: "different-channel" }
    ];
    for (const invalid of invalidBindings) {
      const file = freshFile();
      const execution = {
        actor: { effectiveUser: invalid.effectiveUser, surface: "cli" },
        approvalSnapshot: invalid.approval,
        claimedAt: "2026-06-01T00:00:00.000Z",
        claimToken: "token",
        state: "claimed",
        updatedAt: "2026-06-01T00:00:00.000Z"
      };
      const raw = JSON.stringify({ executions: [execution], pending: [], version: 2 });
      await fs.writeFile(file, raw, "utf8");
      await expect(beginPendingApprovalExecution(file, invalid.approval.id, "token")).rejects.toThrow("invalid pending approval store version");
      expect(await fs.readFile(file, "utf8")).toBe(raw);
    }
  });

  it("rejects non-UUID and duplicate execution claim tokens without rewriting", async () => {
    const execution = (id: string, claimToken: string) => ({
      actor: { effectiveUser: "slack:C1", surface: "cli" },
      approvalSnapshot: entry(id),
      claimedAt: "2026-06-01T00:00:00.000Z",
      claimToken,
      state: "claimed",
      updatedAt: "2026-06-01T00:00:00.000Z"
    });
    const duplicateToken = "00000000-0000-4000-8000-000000000000";
    const cases = [
      [execution("non-uuid", "token")],
      [execution("duplicate-a", duplicateToken), execution("duplicate-b", duplicateToken)]
    ];
    for (const executions of cases) {
      const file = freshFile();
      const raw = JSON.stringify({ executions, pending: [], version: 2 });
      await fs.writeFile(file, raw, "utf8");
      await expect(beginPendingApprovalExecution(file, executions[0]!.approvalSnapshot.id, executions[0]!.claimToken)).rejects.toThrow("invalid pending approval store version");
      expect(await fs.readFile(file, "utf8")).toBe(raw);
    }
  });

  it("preserves bytes for not-found, expired, and forbidden claims", async () => {
    const cases = [
      { actor: { surface: "cli" as const }, approval: entry("present"), id: "missing", state: "not-found" },
      { actor: { surface: "cli" as const }, approval: entry("expired", { expiresAt: "2020-01-01T00:00:00Z" }), id: "expired", state: "expired" },
      { actor: { requestUserId: "intruder", surface: "api" as const }, approval: entry("owned", { userId: "owner" }), id: "owned", state: "forbidden" }
    ];
    for (const testCase of cases) {
      const file = freshFile();
      const raw = JSON.stringify({ pending: [testCase.approval] });
      await fs.writeFile(file, raw, "utf8");
      expect(await claimPendingApproval(file, testCase.id, testCase.actor, () => new Date("2026-06-01T00:00:00Z"))).toEqual({ claimedByThisCall: false, state: testCase.state });
      expect(await fs.readFile(file, "utf8")).toBe(raw);
    }
  });

  it("never permits an execution id to be cleared or re-added", async () => {
    const file = freshFile();
    await recordPendingApproval(file, entry("tombstone"));
    const claim = await claimPendingApproval(file, "tombstone", { surface: "cli" });
    if (!claim.claimedByThisCall) throw new Error("expected claim");
    expect(await clearPendingApproval(file, "tombstone")).toBe(false);
    await expect(recordPendingApproval(file, entry("tombstone"))).rejects.toThrow("approval id has already been used");
    expect((await claimPendingApproval(file, "tombstone", { surface: "cli" })).state).toBe("claimed");
  });
});

describe("filterUnexpired — the live worklist (expired dropped, newest first, optional channel scope)", () => {
  const now = new Date("2026-06-01T00:00:00Z");

  it("drops expired entries and sorts the rest newest-createdAt first", () => {
    const out = filterUnexpired(
      [
        entry("old", { createdAt: "2026-01-01T00:00:00Z" }),
        entry("new", { createdAt: "2026-05-01T00:00:00Z" }),
        entry("expired", { expiresAt: "2026-01-01T00:00:00Z" })
      ],
      now
    );
    expect(out.map((e) => e.id)).toEqual(["new", "old"]);
  });

  it("treats an entry expiring exactly at now as expired (strict >)", () => {
    expect(filterUnexpired([entry("boundary", { expiresAt: now.toISOString() })], now)).toHaveLength(0);
  });

  it("keeps only entries matching the channel scope when one is given", () => {
    const out = filterUnexpired(
      [entry("slack-one"), entry("other", { providerId: "discord" }), entry("wrong-source", { source: "C2" })],
      now,
      { providerId: "slack", source: "C1" }
    );
    expect(out.map((e) => e.id)).toEqual(["slack-one"]);
  });

  it("returns an empty list unchanged", () => {
    expect(filterUnexpired([], now)).toEqual([]);
  });

  it("does not mutate the input array", () => {
    const input = [entry("a", { createdAt: "2026-01-01T00:00:00Z" }), entry("b", { createdAt: "2026-05-01T00:00:00Z" })];
    const snapshot = input.map((e) => e.id);
    filterUnexpired(input, now);
    expect(input.map((e) => e.id)).toEqual(snapshot);
  });
});

describe("recordPendingApproval — append with a most-recent cap", () => {
  it("creates the file (and parent dir) and appends preserving order", async () => {
    const file = join(dir, "nested", "deep", "pa.json");
    await recordPendingApproval(file, entry("first"));
    await recordPendingApproval(file, entry("second"));
    expect((await readPendingApprovals(file)).map((e) => e.id)).toEqual(["first", "second"]);
  });

  it("caps the file to the 200 most recent entries", async () => {
    const file = freshFile();
    // Seed e0..e203 in ONE write (the store reads `{ pending: [...] }`), then a
    // single record of e204 pushes the count to 205 and triggers the cap — same
    // outcome as 205 sequential records but without the ~5s of disk round-trips
    // that flaked at the 5000ms boundary under concurrent-loop load.
    const seeded = Array.from({ length: 204 }, (_, i) => entry(`e${i}`));
    await fs.writeFile(file, JSON.stringify({ pending: seeded }), "utf8");
    await recordPendingApproval(file, entry("e204"));
    const stored = await readPendingApprovals(file);
    expect(stored).toHaveLength(200);
    expect(stored[0]!.id).toBe("e5"); // oldest 5 (e0..e4) dropped by the cap
    expect(stored[stored.length - 1]!.id).toBe("e204");
  });

  it("rejects runtime-invalid new candidates without changing valid persisted state", async () => {
    const invalidCandidates = [
      { ...entry("extra-field"), injected: true } as PendingApproval,
      entry("invalid-created-at", { createdAt: "not-a-date" }),
      entry("inverted-lifetime", { createdAt: "2031-01-01T00:00:00Z", expiresAt: "2030-01-01T00:00:00Z" })
    ];
    for (const candidate of invalidCandidates) {
      const file = freshFile();
      await recordPendingApproval(file, entry(`existing-${candidate.id}`));
      const before = await fs.readFile(file, "utf8");
      await expect(recordPendingApproval(file, candidate)).rejects.toThrow("invalid pending approval entry");
      expect(await fs.readFile(file, "utf8")).toBe(before);
      expect((await claimPendingApproval(file, `existing-${candidate.id}`, { surface: "cli" })).claimedByThisCall).toBe(true);
    }
  });
});

describe("listPendingApprovals — read + filter in one call", () => {
  const now = () => new Date("2026-06-01T00:00:00Z");

  it("returns the unexpired worklist, round-tripping the re-run payload (tool + arguments)", async () => {
    const file = freshFile();
    await recordPendingApproval(file, entry("live", { arguments: { subject: "Q3", to: "bob" }, tool: "email_send" }));
    await recordPendingApproval(file, entry("dead", { createdAt: "2019-01-01T00:00:00Z", expiresAt: "2020-01-01T00:00:00Z" }));
    const list = await listPendingApprovals(file, now);
    expect(list.map((e) => e.id)).toEqual(["live"]);
    // The re-run payload must survive read+filter so the action can be replayed on approval.
    expect(list[0]).toMatchObject({ arguments: { subject: "Q3", to: "bob" }, tool: "email_send" });
  });

  it("scopes to one channel when asked", async () => {
    const file = freshFile();
    await recordPendingApproval(file, entry("slack-one"));
    await recordPendingApproval(file, entry("discord-one", { providerId: "discord" }));
    expect((await listPendingApprovals(file, now, { providerId: "slack", source: "C1" })).map((e) => e.id)).toEqual(["slack-one"]);
  });

  it("returns [] for a missing file", async () => {
    expect(await listPendingApprovals(join(dir, "absent.json"), now)).toEqual([]);
  });
});

describe("clearPendingApproval — durable explicit dismissal", () => {
  const now = () => new Date("2026-06-01T00:00:00Z");

  it("removes the matching id and reports true", async () => {
    const file = freshFile();
    await recordPendingApproval(file, entry("keep"));
    await recordPendingApproval(file, entry("remove"));
    expect(await clearPendingApproval(file, "remove", now)).toBe(true);
    expect((await readPendingApprovals(file)).map((e) => e.id)).toEqual(["keep"]);
    expect((await claimPendingApproval(file, "remove", { surface: "cli" })).state).toBe("denied");
  });

  it("reports false and changes nothing when the id is absent and nothing is expired", async () => {
    const file = freshFile();
    await recordPendingApproval(file, entry("only"));
    expect(await clearPendingApproval(file, "ghost", now)).toBe(false);
    expect((await readPendingApprovals(file)).map((e) => e.id)).toEqual(["only"]);
  });

  it("does not prune an expired entry as a side effect of a missing-id no-op", async () => {
    const file = freshFile();
    await recordPendingApproval(file, entry("live"));
    await recordPendingApproval(file, entry("expired", { createdAt: "2019-01-01T00:00:00Z", expiresAt: "2020-01-01T00:00:00Z" }));
    const before = await fs.readFile(file, "utf8");
    expect(await clearPendingApproval(file, "ghost", now)).toBe(false);
    expect(await fs.readFile(file, "utf8")).toBe(before);
  });
});
