import type {
  ExperienceLearningApprovalReceipt,
  ExperienceLearningProposalDraft,
  ExperienceLearningPromotionReceipt
} from "@muse/attunement";
import {
  assertPlainDataTree,
  isRecord,
  type JsonObject
} from "@muse/shared";
import type { MuseTool } from "@muse/tools";

import {
  parseLearningReplayPreviewInput
} from "./continuity-learning-replay-preview-tool.js";

const PREVIEW_ID = /^learning_preview_[a-f0-9]{64}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;

export interface ContinuityLearningApplyResult {
  readonly approval: ExperienceLearningApprovalReceipt;
  readonly policyAuditId: string;
  readonly promotion: ExperienceLearningPromotionReceipt;
}

export interface ContinuityLearningApplyToolDeps {
  readonly apply: (input: Readonly<{
    readonly draft: ExperienceLearningProposalDraft;
    readonly evidenceCases: unknown;
    readonly opportunityId: string;
    readonly previewId: string;
    readonly replayInputHash: string;
  }>) => Promise<ContinuityLearningApplyResult | undefined>;
}

function parseInput(args: JsonObject): Readonly<{
  readonly draft: ExperienceLearningProposalDraft;
  readonly evidenceCases: unknown;
  readonly opportunityId: string;
  readonly previewId: string;
  readonly replayInputHash: string;
}> {
  assertPlainDataTree(args, "continuityLearningApplyInput");
  if (!isRecord(args)) {
    throw new Error("continuity learning apply input must be a plain object");
  }
  const keys = Reflect.ownKeys(args);
  if (keys.length !== 5
    || keys.some((key) =>
      typeof key !== "string"
      || ![
        "draft",
        "evidenceCases",
        "opportunityId",
        "previewId",
        "replayInputHash"
      ].includes(key))
    || typeof args.previewId !== "string"
    || !PREVIEW_ID.test(args.previewId)
    || typeof args.replayInputHash !== "string"
    || !SHA256.test(args.replayInputHash)) {
    throw new Error("continuity learning apply requires exact preview and replay bindings");
  }
  const replayInput = parseLearningReplayPreviewInput({
    draft: args.draft as never,
    evidenceCases: args.evidenceCases as never,
    opportunityId: args.opportunityId as never
  });
  return {
    ...replayInput,
    previewId: args.previewId,
    replayInputHash: args.replayInputHash
  };
}

function projectResult(value: ContinuityLearningApplyResult): JsonObject {
  const output = {
    approval: value.approval,
    policyAuditId: value.policyAuditId,
    promotion: value.promotion
  };
  assertPlainDataTree(output, "continuityLearningApplyOutput");
  return output as unknown as JsonObject;
}

export function createContinuityLearningApplyTool(
  deps: ContinuityLearningApplyToolDeps
): MuseTool {
  return {
    definition: {
      description:
        "Apply one exact owner-approved Continuity collaboration-policy preview after strict frozen replay. Requires the exact previewId and replayInputHash shown during review. This write is stale-safe, bounded to the thread policy, and never expands permissions, sources, recipients, retention, or actions.",
      domain: "core",
      inputSchema: {
        additionalProperties: false,
        properties: {
          draft: { type: "object" },
          evidenceCases: { items: { type: "object" }, minItems: 10, type: "array" },
          opportunityId: {
            pattern: "^learning_opportunity_[a-f0-9]{64}$",
            type: "string"
          },
          previewId: {
            pattern: "^learning_preview_[a-f0-9]{64}$",
            type: "string"
          },
          replayInputHash: {
            pattern: "^[a-f0-9]{64}$",
            type: "string"
          }
        },
        required: [
          "opportunityId",
          "draft",
          "evidenceCases",
          "previewId",
          "replayInputHash"
        ],
        type: "object"
      },
      keywords: ["continuity", "learning", "apply", "promote", "학습", "적용"],
      name: "muse.continuity.learning.apply",
      risk: "write"
    },
    execute: async (args): Promise<JsonObject> => {
      const input = parseInput(args);
      const result = await deps.apply(input);
      if (!result) {
        throw new Error("continuity learning apply held: approval target is stale or mismatched");
      }
      return projectResult(result);
    }
  };
}
