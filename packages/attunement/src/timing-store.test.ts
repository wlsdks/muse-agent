import { mkdtempSync } from "node:fs";
import { chmod, mkdir, readFile, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { AttunementStoreError } from "./attunement-store.js";
import {
  evaluateTimingSession,
  forgetTimingSession,
  inspectTimingSession,
  pauseTimingSession,
  projectAttuneGraphShadowTimingDecision,
  readTimingState,
  recordAttuneGraphShadowReturn,
  recordTimingFeedback as recordTimingFeedbackImpl,
  recordTimingObservation,
  resolveTimingPreV3BackupFile,
  startTimingSession,
  verifyAttuneGraphShadowTimingProjection
} from "./timing-store.js";

const recordTimingFeedback = (
  file: string,
  candidateId: string,
  outcome: Parameters<typeof recordTimingFeedbackImpl>[2],
  options: Parameters<typeof recordTimingFeedbackImpl>[4] = {}
) => recordTimingFeedbackImpl(
  file,
  candidateId,
  outcome,
  { run: (operation) => operation() },
  options
);

function fixture(): { readonly file: string; readonly options: { readonly idFactory: () => string; readonly now: () => Date } } {
  let sequence = 0;
  return {
    file: join(mkdtempSync(join(tmpdir(), "muse-timing-")), "timing.json"),
    options: {
      idFactory: () => `id-${(++sequence).toString()}`,
      now: () => new Date("2026-07-15T09:00:00.000Z")
    }
  };
}

const knownThread = async (): Promise<void> => undefined;

describe("thread-scoped continuity timing store", () => {
  it("permits only one explicit active thread and rejects observations while paused", async () => {
    const { file, options } = fixture();
    const session = await startTimingSession(file, { consentVersion: 1, threadId: "thread_work" }, knownThread, options);
    await expect(startTimingSession(file, { consentVersion: 1, threadId: "thread_life" }, knownThread, options)).rejects.toThrow("already active");
    await pauseTimingSession(file, session.id, options);
    await expect(recordTimingObservation(file, session.id, {
      appCategory: "building",
      durationMs: 25 * 60_000,
      endedAt: "2026-07-15T09:25:00.000Z",
      startedAt: "2026-07-15T09:00:00.000Z"
    }, options)).rejects.toThrow("paused");
  });

  it("offers only at a stable category boundary and digests during the learned cooldown", async () => {
    const { file, options } = fixture();
    const session = await startTimingSession(file, { consentVersion: 1, threadId: "thread_work" }, knownThread, options);
    await recordTimingObservation(file, session.id, {
      appCategory: "building",
      durationMs: 25 * 60_000,
      endedAt: "2026-07-15T09:25:00.000Z",
      startedAt: "2026-07-15T09:00:00.000Z"
    }, options);
    await recordTimingObservation(file, session.id, {
      appCategory: "planning",
      durationMs: 25 * 60_000,
      endedAt: "2026-07-15T09:50:00.000Z",
      startedAt: "2026-07-15T09:25:00.000Z"
    }, options);
    const first = await evaluateTimingSession(file, session.id, options);
    expect(first).toMatchObject({
      counterfactual: {
        action: "present-offer",
        evaluatedAt: "2026-07-15T09:00:00.000Z"
      },
      decision: "offer",
      reason: "stable-focus-category-boundary",
      ruleVersion: 3
    });

    await recordTimingFeedback(file, first.id, "ignored", options);
    await recordTimingObservation(file, session.id, {
      appCategory: "research",
      durationMs: 25 * 60_000,
      endedAt: "2026-07-15T10:15:00.000Z",
      startedAt: "2026-07-15T09:50:00.000Z"
    }, options);
    const second = await evaluateTimingSession(file, session.id, options);
    expect(second).toMatchObject({
      counterfactual: {
        action: "queue-digest",
        evaluatedAt: "2026-07-15T09:00:00.000Z"
      },
      decision: "digest",
      reason: "offer-cooldown-active",
      ruleVersion: 3
    });
  });

  it("records a bounded stay-silent counterfactual without notification or action surfaces", async () => {
    const { file, options } = fixture();
    const session = await startTimingSession(file, { consentVersion: 1, threadId: "thread_work" }, knownThread, options);

    const candidate = await evaluateTimingSession(file, session.id, options);

    expect(candidate).toEqual({
      counterfactual: {
        action: "stay-silent",
        evaluatedAt: "2026-07-15T09:00:00.000Z"
      },
      createdAt: "2026-07-15T09:00:00.000Z",
      decision: "silent",
      evidenceObservationIds: [],
      id: "candidate_id-2",
      policySnapshot: {
        offerCooldownMs: 90 * 60_000,
        stableFocusMs: 25 * 60_000,
        version: 0
      },
      reason: "no-observation",
      ruleVersion: 3,
      sessionId: "timing_id-1",
      threadId: "thread_work"
    });
    expect(Object.keys(await readTimingState(file))).toEqual([
      "candidates",
      "feedback",
      "observations",
      "returns",
      "schemaVersion",
      "sessions"
    ]);
  });

  it("projects only the exact v3 candidate, ordered category receipts, and consent version", async () => {
    const { file, options } = fixture();
    const session = await startTimingSession(file, { consentVersion: 2, threadId: "thread_work" }, knownThread, options);
    await recordTimingObservation(file, session.id, {
      appCategory: "writing",
      durationMs: 25 * 60_000,
      endedAt: "2026-07-15T08:30:00.000Z",
      startedAt: "2026-07-15T08:05:00.000Z"
    }, options);
    await recordTimingObservation(file, session.id, {
      appCategory: "research",
      durationMs: 25 * 60_000,
      endedAt: "2026-07-15T09:00:00.000Z",
      startedAt: "2026-07-15T08:35:00.000Z"
    }, options);
    const candidate = await evaluateTimingSession(file, session.id, options);
    if (candidate.ruleVersion !== 3) throw new Error("fresh timing candidate must be v3");
    const timing = await readTimingState(file);
    const observations = timing.observations.filter((entry) => entry.sessionId === session.id);
    const projection = projectAttuneGraphShadowTimingDecision(timing, candidate.id);
    expect(projection).toMatchObject({
      candidate: {
        evidenceObservationIds: observations.map((entry) => entry.id),
        policySnapshot: session.policy,
        ruleVersion: 3
      },
      observations: observations.map((entry) => ({ id: entry.id })),
      sessionConsentVersion: 2
    });
    expect(Object.isFrozen(projection?.candidate.policySnapshot)).toBe(true);
    expect(verifyAttuneGraphShadowTimingProjection(projection)).toBe(projection);
    expect(projectAttuneGraphShadowTimingDecision(structuredClone(timing), candidate.id)).toBeUndefined();
    expect(verifyAttuneGraphShadowTimingProjection(structuredClone(projection))).toBeUndefined();
    const restarted = await readTimingState(file);
    const restartedProjection = projectAttuneGraphShadowTimingDecision(restarted, candidate.id);
    expect(restartedProjection).toBeDefined();
    expect(verifyAttuneGraphShadowTimingProjection(restartedProjection)).toBe(restartedProjection);
    const traps = { get: 0, getOwnPropertyDescriptor: 0, ownKeys: 0 };
    const proxy = new Proxy(timing, {
      get() {
        traps.get += 1;
        throw new Error("projection must not inspect a cloned timing state");
      },
      getOwnPropertyDescriptor() {
        traps.getOwnPropertyDescriptor += 1;
        throw new Error("projection must not inspect descriptors");
      },
      ownKeys() {
        traps.ownKeys += 1;
        throw new Error("projection must not inspect keys");
      }
    });
    expect(projectAttuneGraphShadowTimingDecision(proxy, candidate.id)).toBeUndefined();
    expect(traps).toEqual({ get: 0, getOwnPropertyDescriptor: 0, ownKeys: 0 });
  });

  it("records one content-addressed explicit CLI return without inferring authority", async () => {
    const { file, options } = fixture();
    const session = await startTimingSession(
      file,
      { consentVersion: 2, threadId: "thread_work" },
      knownThread,
      options
    );
    const candidate = await evaluateTimingSession(file, session.id, options);
    const preV3 = await readFile(file, "utf8");
    expect(JSON.parse(preV3)).toMatchObject({ schemaVersion: 2 });

    const result = await recordAttuneGraphShadowReturn(file, {
      id: "delivery_exact",
      openedAt: "2026-07-15T10:00:00.000Z",
      threadId: "thread_work"
    });

    expect(result).toMatchObject({
      receipt: {
        authority: {
          actionGranted: false,
          causality: "not-claimed",
          feedback: "not-inferred",
          outcome: "not-inferred",
          reconstructionBenefit: "unassessed"
        },
        candidateId: candidate.id,
        decisionAt: candidate.createdAt,
        deliveryId: "delivery_exact",
        elapsedMs: 60 * 60_000,
        formatVersion: "muse.attunegraph.shadow-return.v1",
        matchRule: "latest-prior-unreturned-thread-candidate@1",
        openedAt: "2026-07-15T10:00:00.000Z",
        schemaVersion: 1,
        sessionId: session.id,
        threadId: session.threadId,
        trigger: "cli-continue"
      },
      status: "recorded"
    });
    if (result.status !== "recorded") throw new Error("return must be recorded");
    expect(result.receipt.id).toMatch(/^shadow_return_[a-f0-9]{64}$/u);
    const persisted = await readTimingState(file);
    expect(inspectTimingSession(persisted, session.id).returns).toEqual([result.receipt]);
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({
      returns: [{ id: result.receipt.id }],
      schemaVersion: 3
    });
    expect(await readFile(resolveTimingPreV3BackupFile(file), "utf8")).toBe(preV3);
  });

  it("replays by exact delivery and never backfills an older candidate", async () => {
    const { file, options } = fixture();
    const session = await startTimingSession(
      file,
      { consentVersion: 1, threadId: "thread_work" },
      knownThread,
      options
    );
    await evaluateTimingSession(file, session.id, options);
    const first = await recordAttuneGraphShadowReturn(file, {
      id: "delivery_one",
      openedAt: "2026-07-15T10:00:00.000Z",
      threadId: session.threadId
    });
    if (first.status !== "recorded") throw new Error("first return must record");
    const raw = await readFile(file, "utf8");

    expect(await recordAttuneGraphShadowReturn(file, {
      id: "delivery_one",
      openedAt: "2026-07-15T10:00:00.000Z",
      threadId: session.threadId
    })).toEqual({ receipt: first.receipt, status: "already-linked" });
    expect(await recordAttuneGraphShadowReturn(file, {
      id: "delivery_two",
      openedAt: "2026-07-15T11:00:00.000Z",
      threadId: session.threadId
    })).toEqual({ receipt: first.receipt, status: "already-linked" });
    expect(await readFile(file, "utf8")).toBe(raw);
    await expect(recordAttuneGraphShadowReturn(file, {
      id: "delivery_one",
      openedAt: "2026-07-15T10:01:00.000Z",
      threadId: session.threadId
    })).rejects.toThrow("conflicts with its immutable Shadow return receipt");
  });

  it("abstains on missing, simultaneous, or non-prior candidates", async () => {
    const { file, options } = fixture();
    const session = await startTimingSession(
      file,
      { consentVersion: 1, threadId: "thread_work" },
      knownThread,
      options
    );
    expect(await recordAttuneGraphShadowReturn(file, {
      id: "delivery_before",
      openedAt: "2026-07-15T08:00:00.000Z",
      threadId: session.threadId
    })).toEqual({ reason: "no-eligible-candidate", status: "unmatched" });

    await evaluateTimingSession(file, session.id, options);
    expect(await recordAttuneGraphShadowReturn(file, {
      id: "delivery_equal",
      openedAt: "2026-07-15T09:00:00.000Z",
      threadId: session.threadId
    })).toEqual({ reason: "no-eligible-candidate", status: "unmatched" });

    await recordTimingObservation(file, session.id, {
      appCategory: "writing",
      durationMs: 1,
      endedAt: "2026-07-15T08:30:00.000Z",
      startedAt: "2026-07-15T08:29:59.999Z"
    }, options);
    await evaluateTimingSession(file, session.id, options);
    expect(await recordAttuneGraphShadowReturn(file, {
      id: "delivery_ambiguous",
      openedAt: "2026-07-15T10:00:00.000Z",
      threadId: session.threadId
    })).toEqual({ reason: "ambiguous-latest-candidate", status: "unmatched" });
  });

  it("fails closed on raw fields or weakened authority in a return receipt", async () => {
    const { file, options } = fixture();
    const session = await startTimingSession(
      file,
      { consentVersion: 1, threadId: "thread_work" },
      knownThread,
      options
    );
    await evaluateTimingSession(file, session.id, options);
    await recordAttuneGraphShadowReturn(file, {
      id: "delivery_exact",
      openedAt: "2026-07-15T10:00:00.000Z",
      threadId: session.threadId
    });
    const state = JSON.parse(await readFile(file, "utf8")) as {
      returns: Array<{
        authority: { feedback: string };
        rawContent?: string;
      }>;
    };
    state.returns[0]!.rawContent = "private window title";
    await writeFile(file, JSON.stringify(state));
    await expect(readTimingState(file)).rejects.toBeInstanceOf(AttunementStoreError);

    delete state.returns[0]!.rawContent;
    state.returns[0]!.authority.feedback = "inferred-positive";
    await writeFile(file, JSON.stringify(state));
    await expect(readTimingState(file)).rejects.toBeInstanceOf(AttunementStoreError);

    state.returns[0]!.authority.feedback = "not-inferred";
    (state.returns[0] as { deliveryId?: string }).deliveryId = "x".repeat(257);
    await writeFile(file, JSON.stringify(state));
    await expect(readTimingState(file)).rejects.toBeInstanceOf(AttunementStoreError);
  });

  it("restores the exact pre-v3 state for a bounded rollback", async () => {
    const { file, options } = fixture();
    const session = await startTimingSession(
      file,
      { consentVersion: 1, threadId: "thread_work" },
      knownThread,
      options
    );
    await evaluateTimingSession(file, session.id, options);
    const preV3 = await readFile(file, "utf8");
    await recordAttuneGraphShadowReturn(file, {
      id: "delivery_exact",
      openedAt: "2026-07-15T10:00:00.000Z",
      threadId: session.threadId
    });

    await writeFile(file, await readFile(resolveTimingPreV3BackupFile(file), "utf8"));
    expect(await readFile(file, "utf8")).toBe(preV3);
    expect(await readTimingState(file)).toMatchObject({
      candidates: [{ id: expect.any(String) }],
      returns: [],
      schemaVersion: 3
    });
  });

  it("refuses the first v3 write when the rollback backup is malformed", async () => {
    const { file, options } = fixture();
    const session = await startTimingSession(
      file,
      { consentVersion: 1, threadId: "thread_work" },
      knownThread,
      options
    );
    await evaluateTimingSession(file, session.id, options);
    const before = await readFile(file, "utf8");
    const backup = resolveTimingPreV3BackupFile(file);
    await writeFile(backup, "{\"schemaVersion\":2}", { mode: 0o600 });
    if (process.platform !== "win32") await chmod(backup, 0o600);

    await expect(recordAttuneGraphShadowReturn(file, {
      id: "delivery_exact",
      openedAt: "2026-07-15T10:00:00.000Z",
      threadId: session.threadId
    })).rejects.toThrow("timing pre-v3 backup is malformed");
    expect(await readFile(file, "utf8")).toBe(before);
    expect((await readTimingState(file)).returns).toEqual([]);
  });

  it("rejects permissive or symlinked pre-v3 rollback backups", async () => {
    const { file, options } = fixture();
    const session = await startTimingSession(
      file,
      { consentVersion: 1, threadId: "thread_work" },
      knownThread,
      options
    );
    await evaluateTimingSession(file, session.id, options);
    const preV3 = await readFile(file, "utf8");
    const backup = resolveTimingPreV3BackupFile(file);
    const delivery = {
      id: "delivery_exact",
      openedAt: "2026-07-15T10:00:00.000Z",
      threadId: session.threadId
    };

    if (process.platform !== "win32") {
      await writeFile(backup, preV3, { mode: 0o644 });
      await chmod(backup, 0o644);
      await expect(recordAttuneGraphShadowReturn(file, delivery)).rejects.toThrow(
        "must not grant group or other permissions"
      );
      expect(await readFile(file, "utf8")).toBe(preV3);
      await unlink(backup);
    }
    if (process.platform === "win32") {
      const target = `${backup}.target-directory`;
      await mkdir(target);
      await symlink(target, backup, "junction");
    } else {
      const target = `${backup}.target`;
      await writeFile(target, preV3, { mode: 0o600 });
      await symlink(target, backup);
    }
    await expect(recordAttuneGraphShadowReturn(file, delivery)).rejects.toThrow(
      "must be a regular non-symlink file"
    );
    expect(await readFile(file, "utf8")).toBe(preV3);
  });

  it("rejects persisted timing collections above their declared bounds", async () => {
    const { file, options } = fixture();
    const session = await startTimingSession(
      file,
      { consentVersion: 1, threadId: "thread_work" },
      knownThread,
      options
    );
    const state = JSON.parse(await readFile(file, "utf8")) as {
      candidates: unknown[];
      observations: unknown[];
    };
    state.observations = Array.from({ length: 501 }, (_, index) => ({
      appCategory: "writing",
      durationMs: 1,
      endedAt: "2026-07-15T08:30:00.000Z",
      id: `observation_overflow_${index.toString()}`,
      sessionId: session.id,
      startedAt: "2026-07-15T08:29:59.999Z",
      threadId: session.threadId
    }));
    await writeFile(file, JSON.stringify(state));
    await expect(readTimingState(file)).rejects.toThrow(
      "timing state is malformed or uses an unsupported schema"
    );

    state.observations = [];
    state.candidates = Array.from({ length: 201 }, (_, index) => {
      const createdAt = new Date(Date.parse("2026-07-14T00:00:00.000Z") + index).toISOString();
      return {
        counterfactual: { action: "stay-silent", evaluatedAt: createdAt },
        createdAt,
        decision: "silent",
        evidenceObservationIds: [],
        id: `candidate_overflow_${index.toString()}`,
        policySnapshot: session.policy,
        reason: "no-observation",
        ruleVersion: 3,
        sessionId: session.id,
        threadId: session.threadId
      };
    });
    await writeFile(file, JSON.stringify(state));
    await expect(readTimingState(file)).rejects.toThrow(
      "timing state is malformed or uses an unsupported schema"
    );
  });

  it("fails before mutation when candidate capacity has no dependency-safe eviction", async () => {
    const { file, options } = fixture();
    const session = await startTimingSession(
      file,
      { consentVersion: 1, threadId: "thread_work" },
      knownThread,
      options
    );
    const candidates = Array.from({ length: 200 }, (_, index) => {
      const createdAt = new Date(Date.parse("2026-07-14T00:00:00.000Z") + index).toISOString();
      return {
        counterfactual: { action: "stay-silent", evaluatedAt: createdAt },
        createdAt,
        decision: "silent",
        evidenceObservationIds: [],
        id: `candidate_protected_${index.toString()}`,
        policySnapshot: session.policy,
        reason: "no-observation",
        ruleVersion: 3,
        sessionId: session.id,
        threadId: session.threadId
      };
    });
    await writeFile(file, JSON.stringify({
      candidates,
      feedback: candidates.map((candidate) => ({
        candidateId: candidate.id,
        outcome: "used",
        recordedAt: candidate.createdAt,
        resultingCooldownMs: session.policy.offerCooldownMs,
        resultingPolicyVersion: session.policy.version,
        sessionId: session.id,
        threadId: session.threadId
      })),
      observations: [],
      schemaVersion: 2,
      sessions: [session]
    }));
    await recordTimingObservation(file, session.id, {
      appCategory: "writing",
      durationMs: 1,
      endedAt: "2026-07-15T08:30:00.000Z",
      startedAt: "2026-07-15T08:29:59.999Z"
    }, options);
    const before = await readFile(file, "utf8");

    await expect(evaluateTimingSession(file, session.id, {
      idFactory: () => "capacity",
      now: () => new Date("2026-07-15T09:00:00.000Z")
    })).rejects.toThrow(
      "timing candidate capacity is full and every candidate has dependent receipts"
    );
    expect(await readFile(file, "utf8")).toBe(before);
    expect((await readTimingState(file)).candidates).toHaveLength(200);
  });

  it("turns rejected timing feedback into a bounded rollback proposal without policy mutation", async () => {
    const { file, options } = fixture();
    const session = await startTimingSession(file, { consentVersion: 1, threadId: "thread_work" }, knownThread, options);
    const candidate = await evaluateTimingSession(file, session.id, options);
    const before = await readTimingState(file);
    let policyMutationAttempts = 0;
    const result = await recordTimingFeedbackImpl(
      file,
      candidate.id,
      "rejected",
      {
        run: () => {
          policyMutationAttempts += 1;
          throw new Error("rejected feedback must not enter the active-policy mutation gate");
        }
      },
      options
    );

    expect(result).toMatchObject({
      applied: false,
      feedback: {
        candidateId: candidate.id,
        outcome: "rejected",
        resultingCooldownMs: before.sessions[0]!.policy.offerCooldownMs,
        resultingPolicyVersion: before.sessions[0]!.policy.version,
        rollbackProposal: {
          baseCooldownMs: before.sessions[0]!.policy.offerCooldownMs,
          basePolicyVersion: before.sessions[0]!.policy.version,
          boundary: {
            actionScope: "not-expanded",
            permission: "unchanged",
            recipient: "unchanged",
            source: "unchanged"
          },
          candidateId: candidate.id,
          proposedCooldownMs: 24 * 60 * 60_000,
          reason: "negative-outcome-rejected",
          scope: "thread-display-timing",
          sessionId: session.id,
          threadId: session.threadId
        }
      },
      session
    });
    expect(policyMutationAttempts).toBe(0);
    const after = await readTimingState(file);
    expect(after.sessions).toEqual(before.sessions);
    expect(after.candidates).toEqual(before.candidates);
    expect(after.observations).toEqual(before.observations);
    expect(after.feedback).toEqual([result.feedback]);

    const raw = await readFile(file, "utf8");
    const replay = await recordTimingFeedbackImpl(
      file,
      candidate.id,
      "rejected",
      { run: () => { throw new Error("replay must not enter mutation gate"); } },
      options
    );
    expect(replay).toEqual(result);
    expect(await readFile(file, "utf8")).toBe(raw);

    const missingProposal = JSON.parse(raw) as { feedback: Array<{ rollbackProposal?: unknown }> };
    delete missingProposal.feedback[0]!.rollbackProposal;
    await writeFile(file, JSON.stringify(missingProposal));
    await expect(readTimingState(file)).rejects.toBeInstanceOf(AttunementStoreError);

    const reboundBase = JSON.parse(raw) as {
      feedback: Array<{
        resultingCooldownMs: number;
        resultingPolicyVersion: number;
        rollbackProposal?: {
          baseCooldownMs: number;
          basePolicyVersion: number;
        };
      }>;
    };
    reboundBase.feedback[0]!.resultingCooldownMs = 60 * 60_000;
    reboundBase.feedback[0]!.resultingPolicyVersion = 1;
    reboundBase.feedback[0]!.rollbackProposal!.baseCooldownMs = 60 * 60_000;
    reboundBase.feedback[0]!.rollbackProposal!.basePolicyVersion = 1;
    await writeFile(file, JSON.stringify(reboundBase));
    await expect(readTimingState(file)).rejects.toBeInstanceOf(AttunementStoreError);

    const tampered = JSON.parse(raw) as { feedback: Array<{ rollbackProposal?: { boundary: { actionScope: string } } }> };
    tampered.feedback[0]!.rollbackProposal!.boundary.actionScope = "expanded";
    await writeFile(file, JSON.stringify(tampered));
    await expect(readTimingState(file)).rejects.toBeInstanceOf(AttunementStoreError);

    const weakened = JSON.parse(raw) as { feedback: Array<{ rollbackProposal?: { proposedCooldownMs: number } }> };
    weakened.feedback[0]!.rollbackProposal!.proposedCooldownMs = 1;
    await writeFile(file, JSON.stringify(weakened));
    await expect(readTimingState(file)).rejects.toBeInstanceOf(AttunementStoreError);
  });

  it("reads legacy rule-v1 candidates without rewriting their bytes", async () => {
    const { file, options } = fixture();
    const session = await startTimingSession(file, { consentVersion: 1, threadId: "thread_work" }, knownThread, options);
    const state = await readTimingState(file);
    const { returns: _returns, ...preV3State } = state;
    const legacy = {
      ...preV3State,
      candidates: [{
        createdAt: "2026-07-15T09:00:00.000Z",
        decision: "silent",
        evidenceObservationIds: [],
        id: "candidate_legacy",
        reason: "no-observation",
        ruleVersion: 1,
        sessionId: session.id,
        threadId: session.threadId
      }],
      schemaVersion: 1
    };
    const raw = `${JSON.stringify(legacy, null, 2)}\n`;
    await writeFile(file, raw);

    expect(await readTimingState(file)).toEqual({
      ...legacy,
      returns: [],
      schemaVersion: 3
    });
    expect(await readFile(file, "utf8")).toBe(raw);
  });

  it("reads legacy rule-v2 candidates byte-for-byte and keeps them AttuneGraph-ineligible", async () => {
    const { file, options } = fixture();
    const session = await startTimingSession(
      file,
      { consentVersion: 1, threadId: "thread_work" },
      knownThread,
      options
    );
    const state = await readTimingState(file);
    const { returns: _returns, ...preV3State } = state;
    const legacyV2 = {
      ...preV3State,
      candidates: [{
        counterfactual: {
          action: "stay-silent",
          evaluatedAt: "2026-07-15T09:00:00.000Z"
        },
        createdAt: "2026-07-15T09:00:00.000Z",
        decision: "silent",
        evidenceObservationIds: [],
        id: "candidate_legacy_v2",
        reason: "no-observation",
        ruleVersion: 2,
        sessionId: session.id,
        threadId: session.threadId
      }],
      schemaVersion: 2
    };
    const raw = `${JSON.stringify(legacyV2, null, 2)}\n`;
    await writeFile(file, raw);

    const persisted = await readTimingState(file);
    expect(persisted).toEqual({ ...legacyV2, returns: [], schemaVersion: 3 });
    expect(await readFile(file, "utf8")).toBe(raw);
    expect(
      projectAttuneGraphShadowTimingDecision(persisted, "candidate_legacy_v2")
    ).toBeUndefined();
  });

  it("migrates a schema-v1 rejected receipt to an explicit legacy marker", async () => {
    const { file, options } = fixture();
    const session = await startTimingSession(file, { consentVersion: 1, threadId: "thread_work" }, knownThread, options);
    const candidate = await evaluateTimingSession(file, session.id, options);
    const state = await readTimingState(file);
    const { returns: _returns, ...preV3State } = state;
    const legacy = {
      ...preV3State,
      feedback: [{
        candidateId: candidate.id,
        outcome: "rejected",
        recordedAt: "2026-07-15T09:00:00.000Z",
        resultingCooldownMs: 24 * 60 * 60_000,
        resultingPolicyVersion: 1,
        sessionId: session.id,
        threadId: session.threadId
      }],
      schemaVersion: 1,
      sessions: [{
        ...session,
        policy: {
          ...session.policy,
          offerCooldownMs: 24 * 60 * 60_000,
          version: 1
        }
      }]
    };
    const raw = `${JSON.stringify(legacy, null, 2)}\n`;
    await writeFile(file, raw);

    expect((await readTimingState(file)).feedback[0]).toMatchObject({
      candidateId: candidate.id,
      legacyUnproposedRejection: true,
      outcome: "rejected"
    });
    expect(await readFile(file, "utf8")).toBe(raw);

    await pauseTimingSession(file, session.id, options);
    expect(await readTimingState(file)).toMatchObject({
      feedback: [{ legacyUnproposedRejection: true }],
      returns: [],
      schemaVersion: 3
    });
  });

  it("forgets every receipt for a session", async () => {
    const { file, options } = fixture();
    const session = await startTimingSession(file, { consentVersion: 1, threadId: "thread_life" }, knownThread, options);
    await recordTimingObservation(file, session.id, {
      appCategory: "writing",
      durationMs: 25 * 60_000,
      endedAt: "2026-07-15T09:25:00.000Z",
      startedAt: "2026-07-15T09:00:00.000Z"
    }, options);
    await evaluateTimingSession(file, session.id, options);
    await recordAttuneGraphShadowReturn(file, {
      id: "delivery_forget",
      openedAt: "2026-07-15T10:00:00.000Z",
      threadId: session.threadId
    });
    const deleted = await forgetTimingSession(file, session.id);
    expect(deleted).toEqual({
      deletedCandidates: 1,
      deletedFeedback: 0,
      deletedObservations: 1,
      deletedReturns: 1
    });
    expect(await readTimingState(file)).toEqual({
      candidates: [],
      feedback: [],
      observations: [],
      returns: [],
      schemaVersion: 3,
      sessions: []
    });
  });

  it("fails closed when persisted state contains a raw desktop field", async () => {
    const { file } = fixture();
    await writeFile(file, JSON.stringify({
      candidates: [],
      feedback: [],
      observations: [{
        appCategory: "building",
        durationMs: 1,
        endedAt: "2026-07-15T09:00:01.000Z",
        id: "observation_1",
        sessionId: "timing_1",
        startedAt: "2026-07-15T09:00:00.000Z",
        threadId: "thread_work",
        windowTitle: "secret document"
      }],
      schemaVersion: 2,
      sessions: []
    }));
    await expect(readTimingState(file)).rejects.toBeInstanceOf(AttunementStoreError);
  });

  it("fails closed on unbounded or reasoning-bearing counterfactual fields", async () => {
    const { file, options } = fixture();
    const session = await startTimingSession(file, { consentVersion: 1, threadId: "thread_work" }, knownThread, options);
    const candidate = await evaluateTimingSession(file, session.id, options);
    if (!("counterfactual" in candidate)) throw new Error("fresh candidate must carry a counterfactual");
    const state = await readTimingState(file);
    await writeFile(file, JSON.stringify({
      ...state,
      candidates: [{
        ...candidate,
        counterfactual: {
          ...candidate.counterfactual,
          chainOfThought: "private reasoning"
        }
      }]
    }));

    await expect(readTimingState(file)).rejects.toBeInstanceOf(AttunementStoreError);

    await writeFile(file, JSON.stringify({
      ...state,
      candidates: [{
        ...candidate,
        reason: "arbitrary model-generated explanation"
      }]
    }));
    await expect(readTimingState(file)).rejects.toBeInstanceOf(AttunementStoreError);

    await writeFile(file, JSON.stringify({
      ...state,
      candidates: [{
        ...candidate,
        counterfactual: {
          ...candidate.counterfactual,
          action: "present-offer"
        }
      }]
    }));
    await expect(readTimingState(file)).rejects.toBeInstanceOf(AttunementStoreError);

    await writeFile(file, JSON.stringify({
      ...state,
      candidates: [{
        ...candidate,
        counterfactual: {
          ...candidate.counterfactual,
          evaluatedAt: "2026-07-15T09:01:00.000Z"
        }
      }]
    }));
    await expect(readTimingState(file)).rejects.toBeInstanceOf(AttunementStoreError);
  });
});
