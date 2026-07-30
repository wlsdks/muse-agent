import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  compareExperienceLearningReplay,
  createPersonalThread,
  fingerprintContinuityPolicy,
  promoteExperienceLearningContinuityPolicy,
  proposeExperienceLearningCandidate,
  readAttunementState,
  rollbackExperienceLearningContinuityPolicy,
  type ActiveAttunementPolicyWriteGate,
  type ExperienceLearningPromotionInput,
  type ExperienceReplayCase
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
  const replayCases: ExperienceReplayCase[] = Array.from({ length: 10 }, (_, index) => ({
    baseline: { evidenceHash: digest("c"), passed: index !== 0 },
    caseId: `case-${index}`,
    challenger: { evidenceHash: digest("d"), passed: true }
  }));
  const replay = compareExperienceLearningReplay(learningCandidate, replayCases)!;
  const input: ExperienceLearningPromotionInput = {
    approval: {
      approvedAt: "2026-07-29T03:07:00.000Z",
      authority: "owner-explicit",
      candidateId: learningCandidate.candidateId,
      replayInputHash: replay.inputHash
    },
    appliedAt: "2026-07-29T03:08:00.000Z",
    candidate: learningCandidate,
    currentPolicy: thread.policy,
    nextPolicyVersion: 1,
    replay,
    replayCases
  };
  return { file, input, thread };
}

describe("experience learning continuity policy store", () => {
  it("atomically promotes the exact thread and advances the global version", async () => {
    const { file, input, thread } = await fixture();

    const receipt = await promoteExperienceLearningContinuityPolicy(file, input, gate);
    const state = await readAttunementState(file);

    expect(state.threads.find((entry) => entry.id === thread.id)?.policy).toEqual(receipt.policyAfter);
    expect(state.nextPolicyVersion).toBe(2);
    expect(receipt.activeBehaviorDigestAfter).toBe(fingerprintContinuityPolicy(receipt.policyAfter));
  });

  it("fails closed without the write gate or after a concurrent policy change", async () => {
    const missingGate = await fixture();
    await expect(promoteExperienceLearningContinuityPolicy(
      missingGate.file,
      missingGate.input,
      undefined
    )).rejects.toMatchObject({ name: "ActiveAttunementPolicyWriteBlockedError" });
    expect((await readAttunementState(missingGate.file)).nextPolicyVersion).toBe(1);

    const stale = await fixture();
    const first = await promoteExperienceLearningContinuityPolicy(stale.file, stale.input, gate);
    await expect(promoteExperienceLearningContinuityPolicy(stale.file, stale.input, gate))
      .rejects.toMatchObject({ code: "stale-active-policy" });
    expect((await readAttunementState(stale.file)).threads
      .find((entry) => entry.id === stale.thread.id)?.policy).toEqual(first.policyAfter);
  });

  it("rolls back presentation with a new monotonic policy version", async () => {
    const { file, input, thread } = await fixture();
    const promotion = await promoteExperienceLearningContinuityPolicy(file, input, gate);

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

    await expect(rollbackExperienceLearningContinuityPolicy(
      file,
      promotion,
      "2026-07-29T03:10:00.000Z",
      gate
    )).rejects.toMatchObject({ code: "stale-active-policy" });
  });

  it("rejects content or linkage tampering when persisted audits are reloaded", async () => {
    const promotionFixture = await fixture();
    await promoteExperienceLearningContinuityPolicy(
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
    const promotion = await promoteExperienceLearningContinuityPolicy(
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
