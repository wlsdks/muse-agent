import {
  fingerprintContinuityPolicy,
  type AttunementState,
  type ContinuityPolicy,
  type ExperienceLearningProposalDraft
} from "@muse/attunement";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import {
  createContinuityLearningPreparationService,
  type ContinuityLearningHeldOutCase
} from "./continuity-learning-preparation-service.js";

const POLICY: ContinuityPolicy = Object.freeze({
  detail: "standard",
  nextStep: "direct",
  suppression: "none",
  version: 1
});
const OUTCOME_AT = "2026-07-31T10:05:00.000Z";
const NOW = new Date("2026-07-31T10:06:00.000Z");

function outcomeId(input: {
  readonly deliveryId: string;
  readonly recordedAt: string;
  readonly runId: string;
}): string {
  return `continuity_outcome_${createHash("sha256")
    .update(JSON.stringify([
      "muse.continuity-outcome.v1",
      input.deliveryId,
      input.runId,
      "rejected",
      null,
      input.recordedAt,
      "organic"
    ]))
    .digest("hex")}`;
}

function state(policy: ContinuityPolicy = POLICY): AttunementState {
  const delivery = {
    evidenceClass: "organic" as const,
    evidenceRefs: [],
    id: "delivery-hill-1",
    openedAt: "2026-07-31T10:00:00.000Z",
    policyDigest: fingerprintContinuityPolicy(POLICY),
    policyVersion: 1,
    runId: "run-hill-1",
    threadId: "thread-hill-1"
  };
  return {
    deliveries: [{
      ...delivery,
      outcome: {
        authority: "owner-explicit",
        evidenceClass: "organic",
        id: outcomeId({
          deliveryId: delivery.id,
          recordedAt: OUTCOME_AT,
          runId: delivery.runId
        }),
        outcome: "rejected",
        policyVersion: 1,
        recordedAt: OUTCOME_AT
      }
    }],
    experienceLearningPolicyAudits: [],
    interactionReceipts: [],
    nextPolicyVersion: 2,
    resetReceipts: [],
    schemaVersion: 13,
    threads: [{
      createdAt: "2026-07-31T09:00:00.000Z",
      id: delivery.threadId,
      kind: "work",
      links: [],
      policy,
      title: "Hill-climbing fixture"
    }],
    undoResetReceipts: []
  };
}

function draft(): ExperienceLearningProposalDraft {
  return {
    expectedBenefit: "Interrupt less often.",
    expiresAt: "2026-08-01T10:06:00.000Z",
    experienceId: "experience-hill-1",
    proposedAt: NOW.toISOString(),
    proposedBehavior: "Wait longer before offering this thread.",
    proposedChange: {
      adjustment: "increase-cooldown",
      kind: "thread-timing"
    },
    scope: {
      kind: "thread-timing",
      threadId: "thread-hill-1"
    }
  };
}

function cases(order: "forward" | "reverse" = "forward"): readonly ContinuityLearningHeldOutCase[] {
  const entries = [
    { caseId: "case-a", input: "A fixed transition-window scenario." },
    { caseId: "case-b", input: "A fixed quiet-hours scenario." }
  ] as const;
  return order === "forward" ? entries : [...entries].reverse();
}

function service(input: Readonly<{
  evaluator?: (args: {
    readonly caseId: string;
    readonly variant: "baseline" | "challenger";
  }, signal: AbortSignal) => Promise<unknown>;
  heldOutCases?: unknown;
  readState?: () => Promise<AttunementState>;
  timeoutMs?: number;
}> = {}) {
  return createContinuityLearningPreparationService({
    evaluator: {
      evaluate: input.evaluator ?? (async ({ caseId, variant }) =>
        caseId === "case-a" ? variant === "challenger" : true),
      id: "deterministic-held-out",
      version: "1"
    },
    heldOutCases: input.heldOutCases ?? cases(),
    now: () => NOW,
    readState: input.readState ?? (async () => state()),
    timeoutMs: input.timeoutMs ?? 1_000
  });
}

describe("Continuity learning preparation service", () => {
  it("runs sorted baseline→challenger cases and returns controlled review-only evidence", async () => {
    const calls: string[] = [];
    const initial = state();
    const before = JSON.stringify(initial);
    const result = await service({
      heldOutCases: cases("reverse"),
      readState: async () => initial,
      evaluator: async ({ caseId, variant }) => {
        calls.push(`${caseId}:${variant}`);
        return caseId === "case-a" ? variant === "challenger" : true;
      }
    }).prepare({ draft: draft() });

    expect(calls).toEqual([
      "case-a:baseline",
      "case-a:challenger",
      "case-b:baseline",
      "case-b:challenger"
    ]);
    expect(result).toMatchObject({
      authority: {
        canApprove: false,
        canPromote: false,
        canRollback: false,
        canWritePolicy: false
      },
      preview: { boundary: { activation: "none" } },
      provenance: {
        evidenceClass: "controlled",
        evaluator: { id: "deterministic-held-out", version: "1" }
      },
      replayBundle: {
        replay: {
          aggregate: { improvements: 1, regressions: 0 },
          promotionApplied: false,
          recommendation: "eligible-for-review"
        },
        status: "frozen"
      },
      status: "prepared"
    });
    expect(JSON.stringify(initial)).toBe(before);
  });

  it("holds a regression or all-tie replay without granting authority", async () => {
    const result = await service({
      evaluator: async ({ variant }) => variant === "baseline"
    }).prepare({ draft: draft() });

    expect(result).toMatchObject({
      authority: { canPromote: false, canWritePolicy: false },
      reason: "replay-not-eligible",
      replayBundle: {
        replay: {
          aggregate: { regressions: 2 },
          recommendation: "hold"
        }
      },
      status: "held"
    });
  });

  it.each([
    ["throw", async () => { throw new Error("grader failed"); }],
    ["malformed result", async () => "yes"]
  ])("returns no partial bundle when the evaluator has a %s", async (_label, evaluator) => {
    const result = await service({ evaluator }).prepare({ draft: draft() });

    expect(result).toEqual({
      reason: "evaluation-failed",
      schemaVersion: 1,
      status: "unavailable"
    });
    expect(result).not.toHaveProperty("replayBundle");
  });

  it("aborts a timed-out evaluator and returns no partial bundle", async () => {
    let signal: AbortSignal | undefined;
    const result = await service({
      evaluator: async (_input, receivedSignal) => {
        signal = receivedSignal;
        return new Promise(() => undefined);
      },
      timeoutMs: 5
    }).prepare({ draft: draft() });

    expect(result).toEqual({
      reason: "evaluation-failed",
      schemaVersion: 1,
      status: "unavailable"
    });
    expect(signal?.aborted).toBe(true);
    expect(result).not.toHaveProperty("replayBundle");
  });

  it("holds if the first opportunity or active policy drifts before return", async () => {
    const reads = vi.fn()
      .mockResolvedValueOnce(state())
      .mockResolvedValueOnce(state({
        ...POLICY,
        detail: "compact",
        version: 2
      }));
    const result = await service({ readState: reads }).prepare({ draft: draft() });

    expect(reads).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      reason: "state-drift",
      status: "held"
    });
    expect(result).not.toHaveProperty("replayBundle");
  });

  it("rejects empty, duplicate, sparse, accessor, and non-plain registries before evaluation", async () => {
    const evaluate = vi.fn(async () => true);
    const accessor = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(accessor, "caseId", {
      enumerable: true,
      get: () => { throw new Error("must not invoke"); }
    });
    Object.defineProperty(accessor, "input", {
      enumerable: true,
      value: "x"
    });
    const sparse = Array(1);
    const invalid = [
      [],
      [cases()[0], cases()[0]],
      sparse,
      [accessor],
      [Object.assign(Object.create(null), cases()[0])]
    ];

    for (const heldOutCases of invalid) {
      await expect(service({ evaluator: evaluate, heldOutCases }).prepare({ draft: draft() }))
        .resolves.toEqual({
          reason: "invalid-configuration",
          schemaVersion: 1,
          status: "unavailable"
        });
    }
    expect(evaluate).not.toHaveBeenCalled();
  });

  it("rejects an accessor draft before state or evaluator work", async () => {
    const readState = vi.fn(async () => state());
    const evaluate = vi.fn(async () => true);
    const request = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(request, "draft", {
      enumerable: true,
      get: () => { throw new Error("must not invoke"); }
    });

    await expect(service({ evaluator: evaluate, readState }).prepare(request as never))
      .resolves.toEqual({
        reason: "invalid-request",
        schemaVersion: 1,
        status: "unavailable"
      });
    expect(readState).not.toHaveBeenCalled();
    expect(evaluate).not.toHaveBeenCalled();
  });

  it("produces stable bundle hashes regardless of registry insertion order", async () => {
    const forward = await service({ heldOutCases: cases("forward") })
      .prepare({ draft: draft() });
    const reverse = await service({ heldOutCases: cases("reverse") })
      .prepare({ draft: draft() });

    expect(forward.status).toBe("prepared");
    expect(reverse.status).toBe("prepared");
    expect(forward).toHaveProperty("replayBundle.bundleId");
    expect((forward as { replayBundle: { bundleId: string } }).replayBundle.bundleId)
      .toBe((reverse as { replayBundle: { bundleId: string } }).replayBundle.bundleId);
  });
});
