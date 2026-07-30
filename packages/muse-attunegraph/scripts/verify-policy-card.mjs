import { createHash } from "node:crypto";
import assert from "node:assert/strict";

import {
  buildExperienceLearningReviewQueue,
  createExperienceReplayEvidenceReceipt,
  fingerprintContinuityPolicy,
  policyForOutcome
} from "@muse/attunement";
import {
  createLocalAttunementSnapshotProviderForTesting
} from "@muse/attunement/testing";
import { parseAttunementState } from "@muse/attunement/state-validation";
import {
  compileAttuneGraphPolicyCard
} from "@muse/attunegraph/policy-card";

const sourceId = "muse.local-attunement";
const threadId = "thread_policy_card_verifier";
const deliveryId = "delivery_policy_card_verifier";
const runId = "continuity_run_policy_card_verifier";
const openedAt = "2026-07-31T02:00:00.000Z";
const outcomeAt = "2026-07-31T02:05:00.000Z";
const deliveryPolicy = {
  detail: "compact",
  nextStep: "direct",
  suppression: "none",
  version: 0
};
const currentPolicy = policyForOutcome("rejected", 1);
const outcomeId = `continuity_outcome_${createHash("sha256")
  .update(JSON.stringify([
    "muse.continuity-outcome.v1",
    deliveryId,
    runId,
    "rejected",
    null,
    outcomeAt,
    "organic"
  ]))
  .digest("hex")}`;
const state = parseAttunementState({
  deliveries: [{
    evidenceClass: "organic",
    evidenceRefs: [],
    id: deliveryId,
    openedAt,
    outcome: {
      authority: "owner-explicit",
      evidenceClass: "organic",
      id: outcomeId,
      outcome: "rejected",
      policyVersion: 1,
      recordedAt: outcomeAt
    },
    policyDigest: fingerprintContinuityPolicy(deliveryPolicy),
    policyVersion: 0,
    runId,
    threadId
  }],
  interactionReceipts: [],
  nextPolicyVersion: 2,
  resetReceipts: [],
  schemaVersion: 11,
  threads: [{
    createdAt: "2026-07-31T01:00:00.000Z",
    id: threadId,
    kind: "work",
    links: [],
    policy: currentPolicy,
    title: "Policy Card public verifier"
  }],
  undoResetReceipts: []
});
let clock = 0;
const provider = createLocalAttunementSnapshotProviderForTesting(
  {
    attunementFile: "/configured/attunement.json",
    sourceId
  },
  {
    clock: () => new Date(
      Date.parse("2026-07-31T03:00:00.000Z") + clock++ * 25
    ),
    readState: async () => ({ state, status: "available" })
  }
);
const scope = { sourceId, threadId };
const headRevalidation = await provider.captureHeadRevalidation(
  scope,
  { maxCaptureSpanMs: 25 }
);
const opportunityId =
  buildExperienceLearningReviewQueue(state).items[0].opportunityId;
const receipt = (caseId, variant, passed) =>
  createExperienceReplayEvidenceReceipt({
    caseId,
    evaluator: { id: "caller-controlled-grader", version: "1.0.0" },
    inputHash: "f".repeat(64),
    observedAt: "2026-07-31T02:30:00.000Z",
    passed,
    variant
  });
const caseId = "public-policy-card-case";
const input = {
  schemaVersion: 1,
  draft: {
    expectedBenefit: "Reduce poorly timed interruptions.",
    expiresAt: "2026-08-01T02:06:00.000Z",
    experienceId: "public-policy-card-verifier",
    proposedAt: "2026-07-31T02:06:00.000Z",
    proposedBehavior: "Wait for an explicit review window.",
    proposedChange: {
      adjustment: "increase-cooldown",
      kind: "thread-timing"
    },
    scope: { kind: "thread-timing", threadId }
  },
  evidenceCases: [{
    baseline: receipt(caseId, "baseline", false),
    caseId,
    challenger: receipt(caseId, "challenger", true)
  }],
  headRevalidation,
  locale: "en",
  opportunityId
};

const rendered = compileAttuneGraphPolicyCard(input);
assert.equal(rendered.status, "rendered");
assert.equal(rendered.card.evidence.graphExplanation.assertionIds.length, 4);
assert.equal(
  rendered.card.evidence.callerSuppliedReplayClaims
    .executionProvenanceVerified,
  false
);
assert.equal(rendered.card.assessedSnapshot.currentWorldFreshness, false);
assert.equal(rendered.card.boundary.effect, "none");
assert.equal(Object.isFrozen(rendered.card), true);

const copied = compileAttuneGraphPolicyCard({
  ...input,
  headRevalidation: JSON.parse(JSON.stringify(headRevalidation))
});
assert.deepEqual(copied, {
  reason: "untrusted-revalidation",
  status: "held"
});

process.stdout.write(JSON.stringify({
  cardId: rendered.card.cardId,
  heldCopy: copied.reason,
  proofAssertions: rendered.card.evidence.graphExplanation.assertionIds.length,
  status: "verified"
}));
