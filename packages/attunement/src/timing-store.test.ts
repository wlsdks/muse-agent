import { mkdtempSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { AttunementStoreError } from "./attunement-store.js";
import {
  evaluateTimingSession,
  forgetTimingSession,
  pauseTimingSession,
  projectAttuneGraphShadowTimingDecision,
  readTimingState,
  recordTimingFeedback as recordTimingFeedbackImpl,
  recordTimingObservation,
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
    const legacy = {
      ...state,
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

    expect(await readTimingState(file)).toEqual({ ...legacy, schemaVersion: 2 });
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
    const legacyV2 = {
      ...state,
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
    expect(persisted).toEqual(legacyV2);
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
    const legacy = {
      ...state,
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
      schemaVersion: 2
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
    const deleted = await forgetTimingSession(file, session.id);
    expect(deleted).toEqual({ deletedCandidates: 1, deletedFeedback: 0, deletedObservations: 1 });
    expect(await readTimingState(file)).toEqual({ candidates: [], feedback: [], observations: [], schemaVersion: 2, sessions: [] });
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
