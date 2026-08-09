import {
  buildExperienceLearningProposalPreview,
  buildExperienceLearningReplayBundle,
  buildExperienceLearningReviewQueue,
  fingerprintContinuityPolicy,
  proposeExperienceLearningFromDelivery,
  readAttunementState,
  type AttunementState
} from "@muse/attunement";
import { createLocalAttunementSnapshotProvider } from "@muse/attunement/testing";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  createOwnerTaughtPolicyCardPreviewService
} from "./owner-taught-policy-card-preview-service.js";
import type {
  ContinuityLearningPolicyCardPreviewInput
} from "./continuity-learning-policy-card-preview-service.js";
import {
  createContinuityLearningPolicyCardPreviewService
} from "./continuity-learning-policy-card-preview-service.js";

const NOW = new Date("2026-07-31T10:06:00.000Z");
const RECORDED_AT = "2026-07-31T10:05:00.000Z";

function state(): AttunementState {
  const policy = {
    detail: "compact" as const,
    nextStep: "hidden" as const,
    suppression: "acknowledge-previous" as const,
    version: 1
  };
  const deliveryPolicy = {
    detail: "standard" as const,
    nextStep: "direct" as const,
    suppression: "none" as const,
    version: 0
  };
  const delivery = {
    evidenceClass: "organic" as const,
    evidenceRefs: [],
    id: "delivery-owner-1",
    openedAt: "2026-07-31T10:00:00.000Z",
    policyDigest: fingerprintContinuityPolicy(deliveryPolicy),
    policyVersion: 0,
    runId: "run-owner-1",
    threadId: "thread-owner-1"
  };
  const outcomeId = `continuity_outcome_${createHash("sha256")
    .update(JSON.stringify([
      "muse.continuity-outcome.v1",
      delivery.id,
      delivery.runId,
      "rejected",
      null,
      RECORDED_AT,
      "organic"
    ]))
    .digest("hex")}`;
  return {
    deliveries: [{
      ...delivery,
      outcome: {
        authority: "owner-explicit",
        evidenceClass: "organic",
        id: outcomeId,
        outcome: "rejected",
        policyVersion: 1,
        recordedAt: RECORDED_AT
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
      title: "Owner fixture"
    }],
    undoResetReceipts: []
  };
}

describe("OwnerTaughtPolicyCardPreviewService", () => {
  it("renders through a real local head revalidation and AttuneGraph compiler", async () => {
    const directory = await mkdtemp(join(tmpdir(), "muse-owner-policy-card-"));
    const file = join(directory, "attunement.json");
    try {
      const current = state();
      const completeState = {
        ...await readAttunementState(file),
        ...current
      };
      await writeFile(file, JSON.stringify(completeState), "utf8");
      expect((await readAttunementState(file)).threads).toHaveLength(1);
      const before = await readFile(file, "utf8");
      const provider = createLocalAttunementSnapshotProvider({
        attunementFile: file,
        sourceId: "muse.attunement.local-state.v1"
      });
      const rawPreview = createContinuityLearningPolicyCardPreviewService({
        captureHeadRevalidation: provider.captureHeadRevalidation,
        readState: () => readAttunementState(file),
        sourceId: "muse.attunement.local-state.v1"
      });
      const opportunity = buildExperienceLearningReviewQueue(current).items[0]!;
      const result = await createOwnerTaughtPolicyCardPreviewService({
        now: () => new Date(NOW),
        policyCardPreview: rawPreview,
        readState: () => readAttunementState(file)
      }).preview({
        detail: "compact",
        locale: "en",
        nextStep: "contextual",
        opportunityId: opportunity.opportunityId
      });

      expect(result).toMatchObject({
        assessedPolicy: {
          detail: "compact",
          nextStep: "hidden",
          suppression: "acknowledge-previous",
          version: 1
        },
        card: {
          boundary: { activation: "none", approval: "none", effect: "none" },
          evidence: {
            authoritativeExperience: {
              authority: "owner-explicit",
              evidenceClass: "organic-production"
            },
            callerSuppliedReplayClaims: {
              executionProvenanceVerified: false,
              recommendation: "eligible-for-review"
            },
            graphExplanation: {
              providerAttested: false,
              provenance:
                "locally-derived-from-provider-head-matched-assessed-snapshot"
            }
          },
          proposal: {
            proposedChange: {
              detail: "compact",
              kind: "thread-display",
              nextStep: "contextual"
            }
          },
          scope: { kind: "thread-only", threadId: "thread-owner-1" },
          status: "review-preview"
        },
        review: {
          draft: {
            proposedChange: {
              detail: "compact",
              kind: "thread-display",
              nextStep: "contextual"
            },
            scope: { kind: "thread-display", threadId: "thread-owner-1" }
          },
          evidenceCases: expect.arrayContaining([
            expect.objectContaining({ caseId: "desired-detail" }),
            expect.objectContaining({ caseId: "no-activation" })
          ]),
          opportunityId: opportunity.opportunityId,
          previewId: expect.stringMatching(/^learning_preview_[a-f0-9]{64}$/u),
          replayInputHash: expect.stringMatching(/^[a-f0-9]{64}$/u)
        },
        schemaVersion: 1,
        status: "rendered"
      });
      if (result.status !== "rendered") throw new Error("expected rendered Policy Card");
      expect(result.review.previewId).toBe(result.card.proposal.previewId);
      expect(result.review.replayInputHash).toBe(
        result.card.evidence.callerSuppliedReplayClaims.replayInputHash
      );
      expect(result.review.draft.proposedChange).toEqual(
        result.card.proposal.proposedChange
      );
      expect(result.review.opportunityId).toBe(opportunity.opportunityId);

      for (const mismatch of ["preview-id", "proposal-copy"] as const) {
        const mismatched = await createOwnerTaughtPolicyCardPreviewService({
          now: () => new Date(NOW),
          policyCardPreview: {
            preview: async (input) => {
              const compiled = await rawPreview.preview(input);
              return compiled.status === "held"
                ? compiled
                : {
                    ...compiled,
                    card: {
                      ...compiled.card,
                      proposal: {
                        ...compiled.card.proposal,
                        ...(mismatch === "preview-id"
                          ? { previewId: `learning_preview_${"f".repeat(64)}` }
                          : { expectedBenefit: "Different text than the owner reviewed." })
                      }
                    }
                  };
            }
          },
          readState: () => readAttunementState(file)
        }).preview({
          detail: "compact",
          locale: "en",
          nextStep: "contextual",
          opportunityId: opportunity.opportunityId
        });
        expect(mismatched).toEqual({
          reason: "review-binding-mismatch",
          schemaVersion: 1,
          status: "held"
        });
      }
      expect(await readFile(file, "utf8")).toBe(before);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("builds a bounded deterministic draft and ten-case contract replay", async () => {
    const current = state();
    const opportunity = buildExperienceLearningReviewQueue(current).items[0]!;
    let received: ContinuityLearningPolicyCardPreviewInput | undefined;
    const preview = vi.fn(async (
      request: ContinuityLearningPolicyCardPreviewInput
    ) => {
      received = request;
      return {
      reason: "budget-exceeded" as const,
      status: "held" as const
      };
    });
    const service = createOwnerTaughtPolicyCardPreviewService({
      now: () => new Date(NOW),
      policyCardPreview: { preview },
      readState: async () => current
    });
    const before = JSON.stringify(current);
    const result = await service.preview({
      detail: "compact",
      locale: "ko",
      nextStep: "contextual",
      opportunityId: opportunity.opportunityId
    });

    expect(result).toEqual({
      reason: "budget-exceeded",
      schemaVersion: 1,
      status: "held"
    });
    expect(preview).toHaveBeenCalledTimes(1);
    const request = received!;
    expect(request).toMatchObject({
      draft: {
        expectedBenefit:
          "이 thread에 사용자가 명시적으로 선택한 표시 형식만 적용합니다.",
        proposedChange: {
          detail: "compact",
          kind: "thread-display",
          nextStep: "contextual"
        },
        scope: { kind: "thread-display", threadId: "thread-owner-1" }
      },
      locale: "ko",
      opportunityId: opportunity.opportunityId
    });
    expect(request.evidenceCases).toHaveLength(10);
    expect(request.evidenceCases).toEqual(expect.arrayContaining([
      expect.objectContaining({ caseId: "desired-detail" }),
      expect.objectContaining({ caseId: "no-activation" })
    ]));
    expect(JSON.stringify(current)).toBe(before);
  });

  it("holds when the post-compile policy no longer matches the assessed digest", async () => {
    const current = state();
    const opportunity = buildExperienceLearningReviewQueue(current).items[0]!;
    const changed = {
      ...current,
      threads: current.threads.map((thread) => ({
        ...thread,
        policy: {
          ...thread.policy,
          detail: "standard" as const,
          version: thread.policy.version + 1
        }
      }))
    };
    const readState = vi.fn()
      .mockResolvedValueOnce(current)
      .mockResolvedValueOnce(current)
      .mockResolvedValueOnce(current)
      .mockResolvedValueOnce(changed);
    const result = await createOwnerTaughtPolicyCardPreviewService({
      now: () => new Date(NOW),
      policyCardPreview: {
        preview: vi.fn(async (input) => {
          const proposed = proposeExperienceLearningFromDelivery({
            activeBehaviorDigest:
              fingerprintContinuityPolicy(current.threads[0]!.policy),
            delivery: current.deliveries[0]!,
            draft: input.draft
          });
          if (proposed.status === "held") throw new Error("expected proposal");
          const preparedPreview = buildExperienceLearningProposalPreview(
            proposed.candidate
          )!;
          const replayBundle = buildExperienceLearningReplayBundle(
            proposed.candidate,
            input.evidenceCases
          )!;
          return {
            card: {
              evidence: {
                authoritativeExperience: {
                  deliveryId: opportunity.deliveryId,
                  evidenceClass: opportunity.sourceRun.evidenceClass,
                  outcome: opportunity.outcome.outcome,
                  outcomeId: opportunity.outcome.outcomeId,
                  recordedAt: opportunity.outcome.recordedAt,
                  sourceRunId: opportunity.sourceRun.runId
                },
                callerSuppliedReplayClaims: {
                  replayBundleId: replayBundle.bundleId,
                  replayInputHash: replayBundle.replay.inputHash
                }
              },
              proposal: {
                activeBehaviorDigestAfter:
                  preparedPreview.activeBehaviorDigestAfter,
                activeBehaviorDigestBefore:
                  preparedPreview.activeBehaviorDigestBefore,
                candidateId: preparedPreview.candidateId,
                expectedBenefit: preparedPreview.expectedBenefit,
                expiresAt: preparedPreview.expiresAt,
                previewId: preparedPreview.previewId,
                proposedAt: preparedPreview.proposedAt,
                proposedBehavior: preparedPreview.proposedBehavior,
                proposedChange: preparedPreview.proposedChange
              },
              scope: { threadId: "thread-owner-1" }
            } as never,
            status: "rendered" as const
          };
        })
      },
      readState
    }).preview({
      detail: "compact",
      locale: "en",
      nextStep: "contextual",
      opportunityId: opportunity.opportunityId
    });

    expect(result).toEqual({
      reason: "state-drift",
      schemaVersion: 1,
      status: "held"
    });
    expect(readState).toHaveBeenCalledTimes(4);
  });

  it("holds a no-op and never invokes the compiler seam", async () => {
    const current = state();
    const opportunity = buildExperienceLearningReviewQueue(current).items[0]!;
    const preview = vi.fn();
    const result = await createOwnerTaughtPolicyCardPreviewService({
      now: () => new Date(NOW),
      policyCardPreview: { preview },
      readState: async () => current
    }).preview({
      detail: "compact",
      locale: "en",
      nextStep: "hidden",
      opportunityId: opportunity.opportunityId
    });

    expect(result).toEqual({ reason: "no-op", schemaVersion: 1, status: "held" });
    expect(preview).not.toHaveBeenCalled();
  });

  it("rejects malformed or stale owner selections before replay", async () => {
    const readState = vi.fn(async () => state());
    const preview = vi.fn();
    const service = createOwnerTaughtPolicyCardPreviewService({
      now: () => new Date(NOW),
      policyCardPreview: { preview },
      readState
    });

    await expect(service.preview({
      detail: "compact",
      locale: "en",
      nextStep: "contextual",
      opportunityId: "bad"
    })).resolves.toEqual({
      reason: "invalid-request",
      schemaVersion: 1,
      status: "unavailable"
    });
    await expect(service.preview({
      detail: "compact",
      locale: "en",
      nextStep: "contextual",
      opportunityId: `learning_opportunity_${"f".repeat(64)}`
    })).resolves.toEqual({
      reason: "no-opportunity",
      schemaVersion: 1,
      status: "unavailable"
    });
    expect(readState).toHaveBeenCalledTimes(1);
    expect(preview).not.toHaveBeenCalled();
  });
});
