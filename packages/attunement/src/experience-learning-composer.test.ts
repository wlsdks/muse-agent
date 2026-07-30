import { describe, expect, it } from "vitest";

import { continuityOutcomeId } from "./outcome-id.js";
import {
  proposeExperienceLearningFromDelivery,
  type ExperienceLearningProposalDraft
} from "./experience-learning-composer.js";
import type { ContinuityDelivery } from "./types.js";

function delivery(): ContinuityDelivery {
  const base = {
    evidenceClass: "organic" as const,
    evidenceRefs: [],
    id: "delivery-1",
    openedAt: "2026-07-29T03:00:00.000Z",
    policyDigest: "a".repeat(64),
    policyVersion: 1,
    runId: "run-1",
    threadId: "thread-1"
  };
  const recordedAt = "2026-07-29T03:05:00.000Z";
  return {
    ...base,
    outcome: {
      authority: "owner-explicit",
      evidenceClass: "organic",
      id: continuityOutcomeId({
        deliveryId: base.id,
        evidenceClass: "organic",
        outcome: "rejected",
        recordedAt,
        runId: base.runId
      }),
      outcome: "rejected",
      policyVersion: 2,
      recordedAt
    }
  };
}

function draft(): ExperienceLearningProposalDraft {
  return {
    expectedBenefit: "Interrupt less often.",
    expiresAt: "2026-08-01T00:00:00.000Z",
    experienceId: "experience-1",
    proposedAt: "2026-07-29T03:06:00.000Z",
    proposedBehavior: "Wait longer before offering this thread.",
    proposedChange: {
      adjustment: "increase-cooldown",
      kind: "thread-timing"
    },
    scope: {
      kind: "thread-timing",
      threadId: "thread-1"
    }
  };
}

describe("proposeExperienceLearningFromDelivery", () => {
  it("composes exact production evidence into a detached proposal only", () => {
    const source = delivery();
    const proposal = draft();
    const before = JSON.stringify({ proposal, source });

    const result = proposeExperienceLearningFromDelivery({
      delivery: source,
      draft: proposal
    });

    expect(result).toMatchObject({
      candidate: {
        activation: "none",
        activeBehaviorDigestAfter: source.policyDigest,
        activeBehaviorDigestBefore: source.policyDigest,
        outcome: {
          authority: "owner-explicit",
          outcome: "rejected",
          runId: source.runId
        },
        proposedChange: proposal.proposedChange,
        sourceRun: {
          evidenceClass: "organic-production",
          runId: source.runId
        },
        status: "proposed"
      },
      status: "proposed"
    });
    expect(JSON.stringify({ proposal, source })).toBe(before);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it.each([
    ["held source", {
      delivery: { ...delivery(), policyDigest: undefined },
      draft: draft()
    }, "missing-policy-provenance"],
    ["wrong thread", {
      delivery: delivery(),
      draft: { ...draft(), scope: { ...draft().scope, threadId: "thread-2" } }
    }, "scope-mismatch"],
    ["scope/change mismatch", {
      delivery: delivery(),
      draft: {
        ...draft(),
        proposedChange: {
          detail: "compact",
          kind: "thread-display",
          nextStep: "direct"
        }
      }
    }, "invalid-proposal"],
    ["expired proposal", {
      delivery: delivery(),
      draft: { ...draft(), expiresAt: draft().proposedAt }
    }, "invalid-proposal"]
  ] as const)("holds %s without activation", (_label, input, reason) => {
    expect(proposeExperienceLearningFromDelivery(input as never)).toEqual({
      reason,
      status: "held"
    });
  });
});
