import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  rollbackExperienceLearningContinuityPolicyByHandleId,
  type ActiveAttunementPolicyWriteGate,
  type ApprovedExperienceLearningPromotionInput
} from "./index.js";

const roots: string[] = [];
const digest = (character: string) => character.repeat(64);
const gate: ActiveAttunementPolicyWriteGate = {
  run: async (operation) => operation()
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "muse-learning-policy-"));
  roots.push(root);
  const file = join(root, "attunement.json");
  const thread = await createPersonalThread(file, {
    kind: "work",
    title: "Reduce interruption"
  }, { idFactory: () => "thread-policy-1" });
  const learningCandidate = proposeExperienceLearningCandidate({
    activeBehaviorDigest: fingerprintContinuityPolicy(thread.policy),
    expectedBenefit: "Use a compact review.",
    expiresAt: "2026-08-01T00:00:00.000Z",
    experienceId: "experience-store-1",
    outcome: {
      authority: "owner-explicit",
      outcome: "adjusted",
      outcomeId: "outcome-store-1",
      recordedAt: "2026-07-29T03:05:00.000Z",
      runId: "run-store-1"
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
      runId: "run-store-1"
    }
  })!;
  const replayCases = Array.from({ length: 10 }, (_, index) => {
    const common = {
      caseId: `case-${index}`,
      evaluator: { id: "continuity-terminal-grader", version: "1.0.0" },
      inputHash: digest("f"),
      observedAt: "2026-07-29T03:06:30.000Z"
    } as const;
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
  const preview = buildExperienceLearningProposalPreview(learningCandidate)!;
  const replayBundle = buildExperienceLearningReplayBundle(learningCandidate, replayCases)!;
  const approvalReceipt = createExperienceLearningApprovalReceipt(
    preview,
    replayBundle,
    "2026-07-29T03:07:00.000Z"
  )!;
  const input: ApprovedExperienceLearningPromotionInput = {
    approvalReceipt,
    appliedAt: "2026-07-29T03:08:00.000Z",
    candidate: learningCandidate,
    currentPolicy: thread.policy,
    nextPolicyVersion: 1,
    preview,
    replayBundle
  };
  return { file, input, thread };
}

describe("experience learning continuity policy store", () => {
  it("atomically promotes the exact thread and advances the global version", async () => {
    const { file, input, thread } = await fixture();

    const receipt = await promoteApprovedExperienceLearningContinuityPolicy(file, input, gate);
    const state = await readAttunementState(file);

    expect(state.threads.find((entry) => entry.id === thread.id)?.policy).toEqual(receipt.policyAfter);
    expect(state.nextPolicyVersion).toBe(2);
    expect(receipt.activeBehaviorDigestAfter).toBe(fingerprintContinuityPolicy(receipt.policyAfter));
    expect(state.experienceLearningPromotionHandles).toMatchObject([{
      activeBehaviorDigestAfter: receipt.activeBehaviorDigestAfter,
      activeBehaviorDigestBefore: receipt.activeBehaviorDigestBefore,
      appliedAt: receipt.appliedAt,
      candidateId: receipt.candidateId,
      promotionAuditId: state.experienceLearningPolicyAudits?.[0]?.id,
      promotionId: receipt.promotionId,
      threadId: receipt.scope.threadId
    }]);
  });

  it("fails closed without the write gate or after a concurrent policy change", async () => {
    const missingGate = await fixture();
    await expect(promoteApprovedExperienceLearningContinuityPolicy(
      missingGate.file,
      missingGate.input,
      undefined
    )).rejects.toMatchObject({ name: "ActiveAttunementPolicyWriteBlockedError" });
    const missingGateState = await readAttunementState(missingGate.file);
    expect(missingGateState.nextPolicyVersion).toBe(1);
    expect(missingGateState.experienceLearningPromotionHandles).toEqual([]);

    const stale = await fixture();
    const first = await promoteApprovedExperienceLearningContinuityPolicy(stale.file, stale.input, gate);
    await expect(promoteApprovedExperienceLearningContinuityPolicy(stale.file, stale.input, gate))
      .rejects.toMatchObject({ code: "stale-active-policy" });
    const staleState = await readAttunementState(stale.file);
    expect(staleState.threads
      .find((entry) => entry.id === stale.thread.id)?.policy).toEqual(first.policyAfter);
    expect(staleState.experienceLearningPolicyAudits).toHaveLength(1);
    expect(staleState.experienceLearningPromotionHandles).toHaveLength(1);

    const expired = await fixture();
    const before = await readFile(expired.file, "utf8");
    await expect(promoteApprovedExperienceLearningContinuityPolicy(
      expired.file,
      {
        ...expired.input,
        appliedAt: expired.input.preview.expiresAt
      },
      gate
    )).rejects.toMatchObject({ code: "invalid-approval" });
    expect(await readFile(expired.file, "utf8")).toBe(before);
  });

  it("rolls back presentation with a new monotonic policy version", async () => {
    const { file, input, thread } = await fixture();
    const promotion = await promoteApprovedExperienceLearningContinuityPolicy(file, input, gate);

    const rollback = await rollbackExperienceLearningContinuityPolicy(
      file,
      promotion,
      "2026-07-29T03:09:00.000Z",
      gate
    );
    const state = await readAttunementState(file);
    const restored = state.threads.find((entry) => entry.id === thread.id)?.policy;

    expect(restored).toEqual({
      ...thread.policy,
      version: 2
    });
    expect(rollback.policyAfter).toEqual(restored);
    expect(rollback.activeBehaviorDigestAfter).toBe(fingerprintContinuityPolicy(rollback.policyAfter));
    expect(state.nextPolicyVersion).toBe(3);
    expect(state.experienceLearningPromotionHandles?.map((handle) =>
      handle.promotionId)).toEqual([promotion.promotionId]);

    await expect(rollbackExperienceLearningContinuityPolicy(
      file,
      promotion,
      "2026-07-29T03:10:00.000Z",
      gate
    )).rejects.toMatchObject({ code: "stale-active-policy" });
  });

  it("rolls back after restart from one exact persisted promotion handle", async () => {
    const { file, input, thread } = await fixture();
    const promotion = await promoteApprovedExperienceLearningContinuityPolicy(file, input, gate);
    const promotedState = await readAttunementState(file);
    const handle = promotedState.experienceLearningPromotionHandles?.[0];
    expect(handle).toBeDefined();

    // Resolve from a freshly reloaded file state using only the durable id;
    // the transient promotion receipt is intentionally not passed.
    const rollback = await rollbackExperienceLearningContinuityPolicyByHandleId(
      file,
      handle!.handleId,
      "2026-07-29T03:09:00.000Z",
      gate
    );
    const state = await readAttunementState(file);
    const restored = state.threads.find((entry) => entry.id === thread.id)?.policy;
    const rollbackAudit = state.experienceLearningPolicyAudits?.find((audit) =>
      audit.kind === "rollback"
    );

    expect(restored).toEqual({ ...thread.policy, version: 2 });
    expect(rollback.policyAfter).toEqual(restored);
    expect(rollback.promotionId).toBe(promotion.promotionId);
    expect(rollbackAudit?.sourceId).toBe(handle!.promotionAuditId);
    expect(state.experienceLearningPromotionHandles).toEqual([handle]);

    await expect(rollbackExperienceLearningContinuityPolicyByHandleId(
      file,
      handle!.handleId,
      "2026-07-29T03:10:00.000Z",
      gate
    )).rejects.toMatchObject({ code: "stale-active-policy" });
  });

  it("fails handle rollback closed for missing identity or missing write authority", async () => {
    const missing = await fixture();
    await promoteApprovedExperienceLearningContinuityPolicy(missing.file, missing.input, gate);
    const missingBefore = await readFile(missing.file, "utf8");
    await expect(rollbackExperienceLearningContinuityPolicyByHandleId(
      missing.file,
      "learning_promotion_handle_missing",
      "2026-07-29T03:09:00.000Z",
      gate
    )).rejects.toMatchObject({ code: "invalid-input" });
    expect(await readFile(missing.file, "utf8")).toBe(missingBefore);

    const gated = await fixture();
    await promoteApprovedExperienceLearningContinuityPolicy(gated.file, gated.input, gate);
    const gatedState = await readAttunementState(gated.file);
    const gatedBefore = await readFile(gated.file, "utf8");
    await expect(rollbackExperienceLearningContinuityPolicyByHandleId(
      gated.file,
      gatedState.experienceLearningPromotionHandles![0]!.handleId,
      "2026-07-29T03:09:00.000Z",
      undefined
    )).rejects.toMatchObject({ name: "ActiveAttunementPolicyWriteBlockedError" });
    expect(await readFile(gated.file, "utf8")).toBe(gatedBefore);
  });

  it("fails closed on duplicated or tampered persisted handles", async () => {
    const duplicate = await fixture();
    await promoteApprovedExperienceLearningContinuityPolicy(duplicate.file, duplicate.input, gate);
    const duplicateJson = JSON.parse(await readFile(duplicate.file, "utf8")) as {
      experienceLearningPromotionHandles: Array<Record<string, unknown>>;
    };
    const duplicateHandle = duplicateJson.experienceLearningPromotionHandles[0]!;
    duplicateJson.experienceLearningPromotionHandles.push({ ...duplicateHandle });
    await writeFile(duplicate.file, JSON.stringify(duplicateJson), "utf8");
    const duplicateBefore = await readFile(duplicate.file, "utf8");
    await expect(rollbackExperienceLearningContinuityPolicyByHandleId(
      duplicate.file,
      duplicateHandle.handleId as string,
      "2026-07-29T03:09:00.000Z",
      gate
    )).rejects.toThrow(/duplicate experience learning promotion handle ids/u);
    expect(await readFile(duplicate.file, "utf8")).toBe(duplicateBefore);

    const tampered = await fixture();
    await promoteApprovedExperienceLearningContinuityPolicy(tampered.file, tampered.input, gate);
    const tamperedJson = JSON.parse(await readFile(tampered.file, "utf8")) as {
      experienceLearningPromotionHandles: Array<Record<string, unknown>>;
    };
    const originalHandleId = tamperedJson.experienceLearningPromotionHandles[0]!.handleId as string;
    tamperedJson.experienceLearningPromotionHandles[0]!.activeBehaviorDigestAfter = digest("f");
    await writeFile(tampered.file, JSON.stringify(tamperedJson), "utf8");
    const tamperedBefore = await readFile(tampered.file, "utf8");
    await expect(rollbackExperienceLearningContinuityPolicyByHandleId(
      tampered.file,
      originalHandleId,
      "2026-07-29T03:09:00.000Z",
      gate
    )).rejects.toThrow();
    expect(await readFile(tampered.file, "utf8")).toBe(tamperedBefore);
  });

  it("rejects content or linkage tampering when persisted audits are reloaded", async () => {
    const promotionFixture = await fixture();
    await promoteApprovedExperienceLearningContinuityPolicy(
      promotionFixture.file,
      promotionFixture.input,
      gate
    );
    const promotedJson = JSON.parse(await readFile(promotionFixture.file, "utf8")) as {
      experienceLearningPolicyAudits: Array<Record<string, unknown>>;
    };
    promotedJson.experienceLearningPolicyAudits[0]!.candidateId = "forged-candidate";
    await writeFile(promotionFixture.file, JSON.stringify(promotedJson), "utf8");
    await expect(readAttunementState(promotionFixture.file)).rejects.toThrow();

    const rollbackFixture = await fixture();
    const promotion = await promoteApprovedExperienceLearningContinuityPolicy(
      rollbackFixture.file,
      rollbackFixture.input,
      gate
    );
    await rollbackExperienceLearningContinuityPolicy(
      rollbackFixture.file,
      promotion,
      "2026-07-29T03:09:00.000Z",
      gate
    );
    const rollbackJson = JSON.parse(await readFile(rollbackFixture.file, "utf8")) as {
      experienceLearningPolicyAudits: Array<Record<string, unknown>>;
    };
    const rollbackAudit = rollbackJson.experienceLearningPolicyAudits[1]!;
    rollbackAudit.candidateId = "different-candidate";
    await writeFile(rollbackFixture.file, JSON.stringify(rollbackJson), "utf8");
    await expect(readAttunementState(rollbackFixture.file)).rejects.toThrow();
  });
});
