import type {
  ExperienceLearningProposalDraft,
  ExperienceLearningProposalPreview
} from "@muse/attunement";
import {
  assertPlainDataTree,
  isRecord,
  type JsonObject
} from "@muse/shared";
import type { MuseTool } from "@muse/tools";

const OPPORTUNITY_ID = /^learning_opportunity_[a-f0-9]{64}$/u;

export interface ContinuityLearningPreviewToolDeps {
  readonly preview: (input: Readonly<{
    readonly draft: ExperienceLearningProposalDraft;
    readonly opportunityId: string;
  }>) => Promise<ExperienceLearningProposalPreview | undefined>;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const ownKeys = Reflect.ownKeys(value);
  return ownKeys.length === keys.length
    && ownKeys.every((key) => typeof key === "string" && keys.includes(key));
}

export function parseLearningPreviewInput(args: JsonObject): Readonly<{
  readonly draft: ExperienceLearningProposalDraft;
  readonly opportunityId: string;
}> {
  assertPlainDataTree(args, "continuityLearningPreviewInput");
  if (!isRecord(args)
    || !hasExactKeys(args, ["draft", "opportunityId"])
    || typeof args.opportunityId !== "string"
    || !OPPORTUNITY_ID.test(args.opportunityId)
    || !isRecord(args.draft)
    || !hasExactKeys(args.draft, [
      "expectedBenefit",
      "expiresAt",
      "experienceId",
      "proposedAt",
      "proposedBehavior",
      "proposedChange",
      "scope"
    ])
    || !isRecord(args.draft.scope)
    || !hasExactKeys(args.draft.scope, ["kind", "threadId"])
    || !isRecord(args.draft.proposedChange)
    || !hasExactLearningChange(args.draft.proposedChange)) {
    throw new Error("continuity learning preview requires one exact opportunityId and bounded draft");
  }
  return {
    draft: args.draft as unknown as ExperienceLearningProposalDraft,
    opportunityId: args.opportunityId
  };
}

function hasExactLearningChange(value: Record<string, unknown>): boolean {
  if (value.kind === "thread-display") {
    return hasExactKeys(value, ["detail", "kind", "nextStep"]);
  }
  if (value.kind === "thread-suppression") {
    return hasExactKeys(value, ["kind", "suppression"]);
  }
  return value.kind === "thread-timing"
    && hasExactKeys(value, ["adjustment", "kind"]);
}

export function projectLearningPreview(value: ExperienceLearningProposalPreview): JsonObject {
  return {
    activeBehaviorDigestAfter: value.activeBehaviorDigestAfter,
    activeBehaviorDigestBefore: value.activeBehaviorDigestBefore,
    boundary: {
      actionScope: value.boundary.actionScope,
      activation: value.boundary.activation,
      permission: value.boundary.permission,
      recipient: value.boundary.recipient,
      source: value.boundary.source
    },
    candidateId: value.candidateId,
    evidence: {
      outcome: { ...value.evidence.outcome },
      sourceRun: { ...value.evidence.sourceRun }
    },
    expectedBenefit: value.expectedBenefit,
    expiresAt: value.expiresAt,
    experienceId: value.experienceId,
    previewId: value.previewId,
    proposedAt: value.proposedAt,
    proposedBehavior: value.proposedBehavior,
    proposedChange: { ...value.proposedChange },
    schemaVersion: value.schemaVersion,
    scope: { ...value.scope }
  };
}

export function createContinuityLearningPreviewTool(
  deps: ContinuityLearningPreviewToolDeps
): MuseTool {
  return {
    definition: {
      description:
        "Preview one explicit bounded collaboration-policy draft for one exact current Continuity learning opportunity. This is read-only: it never generates a draft or replay, approves, activates, or promotes a policy.",
      domain: "core",
      inputSchema: {
        additionalProperties: false,
        properties: {
          draft: {
            additionalProperties: false,
            properties: {
              expectedBenefit: { maxLength: 500, minLength: 1, type: "string" },
              expiresAt: { type: "string" },
              experienceId: { maxLength: 160, minLength: 1, type: "string" },
              proposedAt: { type: "string" },
              proposedBehavior: { maxLength: 500, minLength: 1, type: "string" },
              proposedChange: { type: "object" },
              scope: {
                additionalProperties: false,
                properties: {
                  kind: {
                    enum: ["thread-display", "thread-timing", "thread-suppression"],
                    type: "string"
                  },
                  threadId: { minLength: 1, type: "string" }
                },
                required: ["kind", "threadId"],
                type: "object"
              }
            },
            required: [
              "expectedBenefit",
              "expiresAt",
              "experienceId",
              "proposedAt",
              "proposedBehavior",
              "proposedChange",
              "scope"
            ],
            type: "object"
          },
          opportunityId: {
            pattern: "^learning_opportunity_[a-f0-9]{64}$",
            type: "string"
          }
        },
        required: ["opportunityId", "draft"],
        type: "object"
      },
      keywords: ["continuity", "learning", "preview", "policy", "학습", "검토"],
      name: "muse.continuity.learning.preview",
      risk: "read"
    },
    execute: async (args): Promise<JsonObject> => {
      const input = parseLearningPreviewInput(args);
      const preview = await deps.preview(input);
      if (!preview) {
        throw new Error("continuity learning preview held: stale opportunity or invalid draft");
      }
      return projectLearningPreview(preview);
    }
  };
}
