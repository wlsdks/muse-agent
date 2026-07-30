import { describe, expect, it, vi } from "vitest";

import {
  createContinuityLearningPolicyCardTool
} from "../src/continuity-learning-policy-card-tool.js";

const opportunityId = `learning_opportunity_${"a".repeat(64)}`;
const draft = {
  expectedBenefit: "Reduce interruption recovery.",
  expiresAt: "2026-08-01T00:00:00.000Z",
  experienceId: "experience-policy-card-tool",
  proposedAt: "2026-07-31T00:00:00.000Z",
  proposedBehavior: "Wait for a review window.",
  proposedChange: {
    adjustment: "increase-cooldown",
    kind: "thread-timing"
  },
  scope: {
    kind: "thread-timing",
    threadId: "thread-policy-card-tool"
  }
};
const evidenceCases = [{
  baseline: {},
  caseId: "case-1",
  challenger: {}
}];

function renderedResult() {
  return {
    status: "rendered" as const,
    card: {
      schemaVersion: 1,
      cardVersion: "attunegraph-policy-card.v1",
      cardId: `attunegraph_policy_card_${"a".repeat(64)}`,
      renderId: `attunegraph_policy_card_render_${"b".repeat(64)}`,
      locale: "en",
      status: "review-preview",
      title: "Policy Card",
      scope: {
        kind: "thread-only",
        sourceId: "muse.local-attunement",
        threadId: "thread-policy-card-tool"
      },
      assessedSnapshot: {
        assessedAt: "2026-07-31T00:10:00.000Z",
        currentWorldFreshness: false,
        freshness: "provider-head-matched-at-assessment",
        headProviderReceiptId: "head-receipt",
        providerAttestedDerivedGraph: false,
        revalidationReceiptId: "revalidation-receipt",
        stateDigest: "c".repeat(64),
        subjectProviderReceiptId: "subject-receipt"
      },
      proposal: {
        activeBehaviorDigestAfter: "d".repeat(64),
        activeBehaviorDigestBefore: "e".repeat(64),
        candidateId: "candidate",
        expectedBenefit: "Reduce interruption recovery.",
        expiresAt: "2026-08-01T00:00:00.000Z",
        previewId: "preview",
        proposedAt: "2026-07-31T00:06:00.000Z",
        proposedBehavior: "Wait for a review window.",
        proposedChange: {
          adjustment: "increase-cooldown",
          kind: "thread-timing"
        }
      },
      evidence: {
        authoritativeExperience: {
          authority: "owner-explicit",
          deliveryId: "delivery",
          evidenceClass: "organic-production",
          label: "Owner-use outcome",
          outcome: "ignored",
          outcomeId: "outcome",
          recordedAt: "2026-07-31T00:05:00.000Z",
          sourceRunId: "run"
        },
        callerSuppliedReplayClaims: {
          aggregate: {
            baselinePassed: 0,
            challengerPassed: 1,
            improvements: 1,
            regressions: 0,
            ties: 0,
            total: 1
          },
          executionProvenanceVerified: false,
          label: "Caller-supplied replay claims",
          recommendation: "eligible-for-review",
          replayBundleId: "replay-bundle",
          replayInputHash: "f".repeat(64),
          receiptHashes: [{
            baseline: "1".repeat(64),
            caseId: "case-1",
            challenger: "2".repeat(64)
          }],
          validation:
            "structurally-validated-self-consistent-caller-claims"
        },
        graphExplanation: {
          assertionIds: ["assertion-1", "assertion-2", "assertion-3", "assertion-4"],
          label: "AttuneGraph explanation",
          observationReceiptId: "observation-receipt",
          projectionVersion: "projection-version",
          provenance:
            "locally-derived-from-provider-head-matched-assessed-snapshot",
          providerAttested: false,
          sourceVersion: "source-version"
        }
      },
      controls: [
        {
          approvalGranted: false,
          availability: "unavailable_in_preview",
          effectPerformed: false,
          kind: "trial",
          label: "Trial unavailable",
          note: "Caller claims only."
        },
        {
          approvalGranted: false,
          availability: "unavailable_in_preview",
          effectPerformed: false,
          kind: "edit",
          label: "Edit unavailable",
          note: "No edit surface."
        },
        {
          approvalGranted: false,
          availability: "unavailable_in_preview",
          effectPerformed: false,
          kind: "reject",
          label: "Reject unavailable",
          note: "No reject surface."
        },
        {
          approvalGranted: false,
          availability: "external_to_preview",
          effectPerformed: false,
          externalSurface: "muse.continuity.learning.apply",
          kind: "apply",
          label: "Apply separately",
          note: "Separate stale-safe approval."
        },
        {
          approvalGranted: false,
          availability: "unavailable_in_preview",
          effectPerformed: false,
          externalSurface: "muse.continuity.learning.rollback",
          kind: "rollback",
          label: "Rollback unavailable",
          note: "Requires an applied promotion."
        }
      ],
      boundary: {
        activation: "none",
        approval: "none",
        effect: "none"
      },
      labels: {
        assessedSnapshot: "Assessed snapshot",
        authoritativeExperience: "Authoritative experience",
        callerSuppliedReplayClaims: "Caller claims",
        graphExplanation: "Graph explanation",
        proposedChange: "Proposed change"
      }
    }
  };
}

describe("continuity learning Policy Card tool", () => {
  it("exposes one read-only exact schema and calls only the injected preview", async () => {
    const previewPolicyCard = vi.fn(async () => ({
      reason: "provider-not-fresh" as const,
      status: "held" as const
    }));
    const tool = createContinuityLearningPolicyCardTool({
      previewPolicyCard
    });

    expect(tool.definition).toMatchObject({
      name: "muse.continuity.learning.policy-card.preview",
      risk: "read"
    });
    expect(tool.definition.inputSchema).toMatchObject({
      additionalProperties: false,
      required: ["opportunityId", "draft", "evidenceCases", "locale"]
    });
    const result = await tool.execute({
      draft,
      evidenceCases,
      locale: "ko",
      opportunityId
    }, { runId: "policy-card-tool" });

    expect(result).toEqual({
      reason: "provider-not-fresh",
      status: "held"
    });
    expect(previewPolicyCard).toHaveBeenCalledTimes(1);
    expect(previewPolicyCard).toHaveBeenCalledWith({
      draft,
      evidenceCases,
      locale: "ko",
      opportunityId
    });
  });

  it("returns finite held results for invalid input and callback failure", async () => {
    const previewPolicyCard = vi.fn(async () => {
      throw new Error("/private/path owner payload");
    });
    const tool = createContinuityLearningPolicyCardTool({
      previewPolicyCard
    });

    expect(await tool.execute({
      draft,
      evidenceCases,
      locale: "fr",
      opportunityId
    }, {} as never)).toEqual({
      reason: "invalid-input",
      status: "held"
    });
    expect(previewPolicyCard).not.toHaveBeenCalled();

    expect(await tool.execute({
      draft,
      evidenceCases,
      locale: "en",
      opportunityId
    }, {} as never)).toEqual({
      reason: "internal-error",
      status: "held"
    });
    expect(previewPolicyCard).toHaveBeenCalledTimes(1);
  });

  it("fails closed on malformed callback envelopes instead of relaying content", async () => {
    const previewPolicyCard = vi.fn()
      .mockResolvedValueOnce({
        extra: "/private/path owner payload",
        reason: "/private/path owner payload",
        status: "held"
      })
      .mockResolvedValueOnce({
        card: {
          secret: "/private/path owner payload"
        },
        status: "rendered"
      });
    const tool = createContinuityLearningPolicyCardTool({
      previewPolicyCard: previewPolicyCard as never
    });
    const args = {
      draft,
      evidenceCases,
      locale: "en",
      opportunityId
    } as const;

    expect(await tool.execute(args, {} as never)).toEqual({
      reason: "internal-error",
      status: "held"
    });
    expect(await tool.execute(args, {} as never)).toEqual({
      reason: "internal-error",
      status: "held"
    });
  });

  it("rejects semantically malformed rendered cards at the callback boundary", async () => {
    const invalidCards = [
      (() => {
        const value = structuredClone(renderedResult());
        value.card.proposal.proposedAt = "not-a-date";
        return value;
      })(),
      (() => {
        const value = structuredClone(renderedResult());
        value.card.proposal.proposedChange.adjustment = "send-money";
        return value;
      })(),
      (() => {
        const value = structuredClone(renderedResult());
        value.card.evidence.callerSuppliedReplayClaims.aggregate.baselinePassed = 1;
        return value;
      })(),
      (() => {
        const value = structuredClone(renderedResult());
        const replay = value.card.evidence.callerSuppliedReplayClaims;
        replay.aggregate = {
          baselinePassed: 0,
          challengerPassed: 0,
          improvements: 1,
          regressions: 1,
          ties: 0,
          total: 2
        };
        replay.recommendation = "hold";
        replay.receiptHashes = [
          ...replay.receiptHashes,
          {
            baseline: "baseline-2",
            caseId: "case-2",
            challenger: "challenger-2"
          }
        ];
        return value;
      })(),
      (() => {
        const value = structuredClone(renderedResult());
        const replay = value.card.evidence.callerSuppliedReplayClaims;
        replay.aggregate = {
          baselinePassed: 3,
          challengerPassed: 3,
          improvements: 1,
          regressions: 1,
          ties: 1,
          total: 3
        };
        replay.recommendation = "hold";
        replay.receiptHashes = [
          ...replay.receiptHashes,
          {
            baseline: "baseline-2",
            caseId: "case-2",
            challenger: "challenger-2"
          },
          {
            baseline: "baseline-3",
            caseId: "case-3",
            challenger: "challenger-3"
          }
        ];
        return value;
      })(),
      (() => {
        const value = structuredClone(renderedResult());
        value.card.evidence.graphExplanation.assertionIds[3] = "assertion-1";
        return value;
      })()
    ];
    const previewPolicyCard = vi.fn();
    for (const value of invalidCards) previewPolicyCard.mockResolvedValueOnce(value);
    const tool = createContinuityLearningPolicyCardTool({
      previewPolicyCard: previewPolicyCard as never
    });
    const args = {
      draft,
      evidenceCases,
      locale: "en",
      opportunityId
    } as const;

    for (const _value of invalidCards) {
      expect(await tool.execute(args, {} as never)).toEqual({
        reason: "internal-error",
        status: "held"
      });
    }
  });
});
