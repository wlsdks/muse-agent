import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { completePendingApproval } from "../src/pending-approval-coordinator.js";
import { recordPendingApproval, type PendingApproval } from "../src/pending-approval-store.js";

let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(join(tmpdir(), "pending-coordinator-")); });
afterEach(async () => { await fs.rm(dir, { force: true, recursive: true }); });

const approval = (id: string): PendingApproval => ({
  arguments: { url: "https://example.com" },
  createdAt: "2026-07-18T00:00:00.000Z",
  draft: "POST https://example.com",
  expiresAt: "2030-01-01T00:00:00.000Z",
  id,
  providerId: "telegram",
  risk: "execute",
  source: "42",
  tool: "web_action",
  userId: "owner"
});

describe("completePendingApproval", () => {
  const now = () => new Date("2026-07-18T12:00:00.000Z");

  it("executes only after begin, persists success, and blocks replay", async () => {
    const file = join(dir, "pending.json");
    await recordPendingApproval(file, approval("success"));
    let effects = 0;
    const first = await completePendingApproval({
      actor: { requestUserId: "owner", surface: "api" },
      file,
      id: "success",
      now: () => new Date("2026-07-18T12:00:00.000Z"),
      prepare: async (snapshot) => ({
        execute: async () => {
          effects += 1;
          return { performed: true, snapshotId: snapshot.id };
        },
        kind: "execute"
      })
    });
    const replay = await completePendingApproval({
      actor: { requestUserId: "owner", surface: "api" },
      file,
      id: "success",
      now: () => new Date("2026-07-18T12:00:01.000Z"),
      prepare: async () => {
        throw new Error("replay must not prepare");
      }
    });

    expect(first).toMatchObject({
      approvalSnapshot: { id: "success" },
      kind: "succeeded",
      output: { performed: true, snapshotId: "success" }
    });
    expect(replay).toEqual({ kind: "conflict", phase: "claim", state: "succeeded" });
    expect(effects).toBe(1);
  });

  it.each([
    ["decline", async () => ({ detail: "user said no", kind: "decline" } as const), "denied", false],
    ["unknown", async () => ({ detail: "tool unavailable", kind: "unknown" } as const), "unknown", false],
    ["prepare-throw", async () => { throw new Error("resolver exploded"); }, "denied", false]
  ] as const)("closes %s preparation without attempting an effect", async (id, prepare, expectedKind, effectAttempted) => {
    const file = join(dir, `${id}.json`);
    await recordPendingApproval(file, approval(id));
    const result = await completePendingApproval({ actor: { surface: "cli" }, file, id, now, prepare });
    expect(result).toMatchObject({ kind: expectedKind, ...(expectedKind === "unknown" ? { effectAttempted } : {}) });
    if (id === "prepare-throw") {
      expect(result).toMatchObject({ detail: "preparation failed: resolver exploded" });
    }
  });

  it.each(["not-found", "expired", "forbidden"] as const)("maps claim %s to unavailable without preparing", async (state) => {
    let prepared = 0;
    const result = await completePendingApproval({
      actor: { surface: "cli" },
      file: join(dir, `${state}.json`),
      id: state,
      now,
      operations: { claim: async () => ({ claimedByThisCall: false, state }) },
      prepare: async () => {
        prepared += 1;
        return { detail: "no", kind: "decline" };
      }
    });
    expect(result).toEqual({ kind: "unavailable", state });
    expect(prepared).toBe(0);
  });

  it("distinguishes store throws by phase and best-effort durable observation", async () => {
    const cases = [
      {
        effectAttempted: false,
        id: "claim-throw",
        operations: { claim: async () => { throw new Error("claim write failed"); } },
        phase: "claim",
        prepare: async () => ({ detail: "no", kind: "decline" } as const),
        state: "pending"
      },
      {
        effectAttempted: false,
        id: "decline-throw",
        operations: { decline: async () => { throw new Error("decline write failed"); } },
        phase: "decline",
        prepare: async () => ({ detail: "no", kind: "decline" } as const),
        state: "claimed"
      },
      {
        effectAttempted: false,
        id: "begin-throw",
        operations: { begin: async () => { throw new Error("begin write failed"); } },
        phase: "begin",
        prepare: async () => ({ execute: async () => ({ performed: true }), kind: "execute" } as const),
        state: "claimed"
      },
      {
        effectAttempted: true,
        id: "finalize-throw",
        operations: { finalize: async () => { throw new Error("finalize write failed"); } },
        phase: "finalize",
        prepare: async () => ({ execute: async () => ({ performed: true }), kind: "execute" } as const),
        state: "executing"
      }
    ] as const;
    for (const testCase of cases) {
      const file = join(dir, `${testCase.id}.json`);
      await recordPendingApproval(file, approval(testCase.id));
      const result = await completePendingApproval({
        actor: { surface: "cli" },
        file,
        id: testCase.id,
        now,
        operations: testCase.operations,
        prepare: testCase.prepare
      });
      expect(result).toMatchObject({
        certainty: "observed",
        effectAttempted: testCase.effectAttempted,
        kind: "persistence-uncertain",
        phase: testCase.phase,
        state: testCase.state
      });
    }

    const unobserved = await completePendingApproval({
      actor: { surface: "cli" },
      file: join(dir, "unobserved.json"),
      id: "unobserved",
      operations: {
        claim: async () => { throw new Error("claim failed"); },
        observe: async () => { throw new Error("observation failed"); }
      },
      prepare: async () => ({ detail: "no", kind: "decline" })
    });
    expect(unobserved).toMatchObject({ certainty: "unobserved", effectAttempted: false, kind: "persistence-uncertain", phase: "claim" });
  });

  it("reports CAS losers with their exact phase/state and never executes before begin wins", async () => {
    const claimConflict = await completePendingApproval({
      actor: { surface: "cli" },
      file: join(dir, "claim-conflict.json"),
      id: "claim-conflict",
      operations: { claim: async () => ({ claimedByThisCall: false, state: "executing" }) },
      prepare: async () => { throw new Error("must not prepare"); }
    });
    expect(claimConflict).toEqual({ kind: "conflict", phase: "claim", state: "executing" });

    const declineFile = join(dir, "decline-conflict.json");
    await recordPendingApproval(declineFile, approval("decline-conflict"));
    const declineConflict = await completePendingApproval({
      actor: { surface: "cli" },
      file: declineFile,
      id: "decline-conflict",
      now,
      operations: { decline: async () => ({ state: "executing", transitioned: false }) },
      prepare: async () => ({ detail: "no", kind: "decline" })
    });
    expect(declineConflict).toEqual({ kind: "conflict", phase: "decline", state: "executing" });

    const beginFile = join(dir, "begin-conflict.json");
    await recordPendingApproval(beginFile, approval("begin-conflict"));
    let effects = 0;
    const beginConflict = await completePendingApproval({
      actor: { surface: "cli" },
      file: beginFile,
      id: "begin-conflict",
      now,
      operations: { begin: async () => ({ state: "denied", transitioned: false }) },
      prepare: async () => ({ execute: async () => { effects += 1; }, kind: "execute" })
    });
    expect(beginConflict).toEqual({ kind: "conflict", phase: "begin", state: "denied" });
    expect(effects).toBe(0);

    const finalizeFile = join(dir, "finalize-conflict.json");
    await recordPendingApproval(finalizeFile, approval("finalize-conflict"));
    const finalizeConflict = await completePendingApproval({
      actor: { surface: "cli" },
      file: finalizeFile,
      id: "finalize-conflict",
      now,
      operations: { finalize: async () => ({ state: "executing", transitioned: false }) },
      prepare: async () => ({ execute: async () => { effects += 1; return { performed: true }; }, kind: "execute" })
    });
    expect(finalizeConflict).toEqual({ kind: "conflict", phase: "finalize", state: "executing" });
    expect(effects).toBe(1);
  });

  it.each([
    ["execute-throw", async () => { throw new Error("provider exploded"); }, "execution failed: provider exploded"],
    ["contradictory", async () => ({ performed: false, sent: true }), "tool result did not prove success"],
    ["unproven", async () => "plain text", "tool result did not prove success"]
  ] as const)("durably closes %s output as effect-attempted unknown", async (id, execute, detail) => {
    const file = join(dir, `${id}.json`);
    await recordPendingApproval(file, approval(id));
    let calls = 0;
    const result = await completePendingApproval({
      actor: { surface: "cli" },
      file,
      id,
      now,
      prepare: async () => ({
        execute: async () => {
          calls += 1;
          return execute();
        },
        kind: "execute"
      })
    });
    expect(result).toMatchObject({ approvalSnapshot: { id }, detail, effectAttempted: true, kind: "unknown" });
    expect(calls).toBe(1);
  });
});
