import {
  buildExperienceLearningReviewQueue,
  type AttunementState,
  type ExperienceLearningProposalDraft
} from "@muse/attunement";
import type {
  AttuneGraphPolicyCardCompileResultV1,
  AttuneGraphPolicyCardLocaleV1
} from "@muse/attunegraph/policy-card";
import { compileAttuneGraphPolicyCard } from "@muse/attunegraph/policy-card";

export interface ContinuityLearningPolicyCardPreviewInput {
  readonly draft: ExperienceLearningProposalDraft;
  readonly evidenceCases: unknown;
  readonly locale: AttuneGraphPolicyCardLocaleV1;
  readonly opportunityId: string;
}

export interface ContinuityLearningPolicyCardPreviewService {
  preview(
    input: ContinuityLearningPolicyCardPreviewInput
  ): Promise<AttuneGraphPolicyCardCompileResultV1>;
}

export interface CreateContinuityLearningPolicyCardPreviewServiceOptions {
  readonly captureHeadRevalidation: (
    scope: Readonly<{ readonly sourceId: string; readonly threadId: string }>,
    options: Readonly<{ readonly maxCaptureSpanMs: number }>
  ) => Promise<unknown>;
  readonly readState: () => Promise<AttunementState>;
  readonly sourceId: string;
}

/**
 * The single read-only AttuneGraph Policy Card compiler seam shared by the
 * loopback tool and HTTP API. It resolves an exact current opportunity and
 * captures a provider-head revalidation immediately before compilation.
 */
export function createContinuityLearningPolicyCardPreviewService(
  options: CreateContinuityLearningPolicyCardPreviewServiceOptions
): ContinuityLearningPolicyCardPreviewService {
  return Object.freeze({
    async preview(
      input: ContinuityLearningPolicyCardPreviewInput
    ): Promise<AttuneGraphPolicyCardCompileResultV1> {
      try {
        const queue = buildExperienceLearningReviewQueue(
          await options.readState()
        );
        const matches = queue.items.filter((item) =>
          item.opportunityId === input.opportunityId
        );
        if (matches.length !== 1) {
          return Object.freeze({
            reason: "opportunity-not-found" as const,
            status: "held" as const
          });
        }
        const headRevalidation = await options.captureHeadRevalidation(
          {
            sourceId: options.sourceId,
            threadId: matches[0]!.scope.threadId
          },
          { maxCaptureSpanMs: 1_000 }
        );
        return compileAttuneGraphPolicyCard({
          schemaVersion: 1,
          draft: input.draft,
          evidenceCases: input.evidenceCases,
          headRevalidation,
          locale: input.locale,
          opportunityId: input.opportunityId
        });
      } catch {
        return Object.freeze({
          reason: "internal-error" as const,
          status: "held" as const
        });
      }
    }
  });
}
