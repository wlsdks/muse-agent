import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  buildExperienceLearningProposalPreview,
  buildExperienceLearningReplayBundle,
  createExperienceLearningApprovalReceipt,
  createExperienceReplayEvidenceReceipt,
  createPersonalThread,
  fingerprintContinuityPolicy,
  promoteApprovedExperienceLearningContinuityPolicy,
  proposeExperienceLearningCandidate,
  readAttunementState,
  rollbackExperienceLearningContinuityPolicy,
  verifyExperienceLearningApprovalReceipt,
  type ActiveAttunementPolicyWriteGate
} from "./index.js";

const roots: string[] = [];
const digest = (character: string) => character.repeat(64);
const gate: ActiveAttunementPolicyWriteGate = {
  run: async (operation) => operation()
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("deterministic experience learning journey", () => {
  it("replays, explicitly approves, applies once, rolls back monotonically, and survives reload", async () => {
    const root = await mkdtemp(join(tmpdir(), "muse-learning-journey-"));
    roots.push(root);
    const file = join(root, "attunement.json");
    const thread = await createPersonalThread(file, {
      kind: "work",
      title: "Deterministic learning journey"
    }, { idFactory: () => "journey-thread" });
    const candidate = proposeExperienceLearningCandidate({
      activeBehaviorDigest: fingerprintContinuityPolicy(thread.policy),
      expectedBenefit: "Use a compact review.",
      expiresAt: "2026-08-01T00:00:00.000Z",
      experienceId: "journey-experience",
      outcome: {
        authority: "owner-explicit",
        outcome: "adjusted",
        outcomeId: "journey-outcome",
        recordedAt: "2026-07-29T03:05:00.000Z",
        runId: "journey-run"
      },
      proposedAt: "2026-07-29T03:06:00.000Z",
      proposedBehavior: "Use compact contextual presentation.",
      proposedChange: {
        detail: "compact",
        kind: "thread-display",
        nextStep: "contextual"
      },
      scope: { kind: "thread-display", threadId: thread.id },
      sourceRun: {
        behaviorDigest: digest("b"),
        completedAt: "2026-07-29T03:00:00.000Z",
        evidenceClass: "controlled",
        runId: "journey-run"
      }
    })!;
    const evidenceCases = Array.from({ length: 10 }, (_, index) => {
      const common = {
        caseId: `journey-case-${index}`,
        evaluator: { id: "continuity-terminal-grader", version: "1.0.0" },
        inputHash: digest("f"),
        observedAt: "2026-07-29T03:06:30.000Z"
      };
      return {
        baseline: createExperienceReplayEvidenceReceipt({
          ...common,
          passed: index !== 0,
          variant: "baseline"
        })!,
        caseId: common.caseId,
        challenger: createExperienceReplayEvidenceReceipt({
          ...common,
          passed: true,
          variant: "challenger"
        })!
      };
    });
    const beforePreview = await readFile(file, "utf8");
    const preview = buildExperienceLearningProposalPreview(candidate)!;
    const replayBundle = buildExperienceLearningReplayBundle(candidate, evidenceCases)!;

    expect(replayBundle.replay.recommendation).toBe("eligible-for-review");
    expect(replayBundle.replay.aggregate).toEqual({
      baselinePassed: 9,
      challengerPassed: 10,
      improvements: 1,
      regressions: 0,
      ties: 9,
      total: 10
    });
    expect(await readFile(file, "utf8")).toBe(beforePreview);
    const approval = createExperienceLearningApprovalReceipt(
      preview,
      replayBundle,
      "2026-07-29T03:07:00.000Z"
    )!;
    expect(verifyExperienceLearningApprovalReceipt(
      structuredClone(approval),
      preview,
      replayBundle,
      "2026-07-29T03:08:00.000Z"
    )).toEqual(approval);
    expect(await readFile(file, "utf8")).toBe(beforePreview);

    const input = {
      approvalReceipt: approval,
      appliedAt: "2026-07-29T03:08:00.000Z",
      candidate,
      currentPolicy: thread.policy,
      nextPolicyVersion: 1,
      preview,
      replayBundle
    };
    let getterCalls = 0;
    const hostile = { ...input } as Record<string, unknown>;
    Object.defineProperty(hostile, "approvalReceipt", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return approval;
      }
    });
    await expect(promoteApprovedExperienceLearningContinuityPolicy(
      file,
      hostile as unknown as typeof input,
      gate
    )).rejects.toMatchObject({ code: "invalid-input" });
    expect(getterCalls).toBe(0);
    expect(await readFile(file, "utf8")).toBe(beforePreview);

    await expect(promoteApprovedExperienceLearningContinuityPolicy(file, {
      ...input,
      approvalReceipt: { ...approval, approvedAt: "2026-07-29T03:07:01.000Z" }
    }, gate)).rejects.toMatchObject({ code: "invalid-approval" });
    expect(await readFile(file, "utf8")).toBe(beforePreview);

    const promotion = await promoteApprovedExperienceLearningContinuityPolicy(file, input, gate);
    await expect(promoteApprovedExperienceLearningContinuityPolicy(file, input, gate))
      .rejects.toMatchObject({ code: "stale-active-policy" });
    let restarted = await readAttunementState(file);
    expect(restarted.experienceLearningPolicyAudits?.map((audit) => audit.kind))
      .toEqual(["promotion"]);
    expect(restarted.threads[0]?.policy).toEqual(promotion.policyAfter);

    const rollback = await rollbackExperienceLearningContinuityPolicy(
      file,
      promotion,
      "2026-07-29T03:09:00.000Z",
      gate
    );
    restarted = await readAttunementState(file);
    expect(restarted.experienceLearningPolicyAudits?.map((audit) => audit.kind))
      .toEqual(["promotion", "rollback"]);
    expect(restarted.threads[0]?.policy).toEqual({
      ...thread.policy,
      version: 2
    });
    expect(rollback.activeBehaviorDigestAfter)
      .toBe(fingerprintContinuityPolicy(restarted.threads[0]!.policy));
    expect(restarted.nextPolicyVersion).toBe(3);
  });
});
