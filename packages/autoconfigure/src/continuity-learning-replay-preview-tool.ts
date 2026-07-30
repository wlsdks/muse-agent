import type {
  ExperienceLearningProposalDraft,
  ExperienceLearningProposalPreview,
  ExperienceLearningReplayBundle
} from "@muse/attunement";
import {
  assertPlainDataTree,
  isRecord,
  type JsonObject
} from "@muse/shared";
import type { MuseTool } from "@muse/tools";

import {
  parseLearningPreviewInput,
  projectLearningPreview
} from "./continuity-learning-preview-tool.js";

export interface ContinuityLearningReplayPreviewToolDeps {
  readonly previewReplay: (input: Readonly<{
    readonly draft: ExperienceLearningProposalDraft;
    readonly evidenceCases: unknown;
    readonly opportunityId: string;
  }>) => Promise<Readonly<{
    readonly preview: ExperienceLearningProposalPreview;
    readonly replayBundle: ExperienceLearningReplayBundle;
  }> | undefined>;
}

export function parseLearningReplayPreviewInput(args: JsonObject): Readonly<{
  readonly draft: ExperienceLearningProposalDraft;
  readonly evidenceCases: unknown;
  readonly opportunityId: string;
}> {
  assertPlainDataTree(args, "continuityLearningReplayPreviewInput");
  if (!isRecord(args)) {
    throw new Error("continuity learning replay preview input must be a plain object");
  }
  const keys = Reflect.ownKeys(args);
  if (keys.length !== 3
    || keys.some((key) =>
      typeof key !== "string"
      || !["draft", "evidenceCases", "opportunityId"].includes(key))
    || !Array.isArray(args.evidenceCases)) {
    throw new Error("continuity learning replay preview requires exact draft, evidenceCases, and opportunityId");
  }
  const previewInput = parseLearningPreviewInput({
    draft: args.draft as never,
    opportunityId: args.opportunityId as never
  });
  return {
    ...previewInput,
    evidenceCases: args.evidenceCases
  };
}

function projectResult(value: Readonly<{
  readonly preview: ExperienceLearningProposalPreview;
  readonly replayBundle: ExperienceLearningReplayBundle;
}>): JsonObject {
  const output = {
    preview: projectLearningPreview(value.preview),
    replayBundle: value.replayBundle
  };
  assertPlainDataTree(output, "continuityLearningReplayPreviewOutput");
  return output as unknown as JsonObject;
}

export function createContinuityLearningReplayPreviewTool(
  deps: ContinuityLearningReplayPreviewToolDeps
): MuseTool {
  return {
    definition: {
      description:
        "Compare caller-supplied strict frozen baseline/challenger evidence for one exact current Continuity learning opportunity and explicit draft. This read-only tool never creates evidence, approves, activates, or promotes a policy.",
      domain: "core",
      inputSchema: {
        additionalProperties: false,
        properties: {
          draft: { type: "object" },
          evidenceCases: {
            items: { type: "object" },
            minItems: 1,
            type: "array"
          },
          opportunityId: {
            pattern: "^learning_opportunity_[a-f0-9]{64}$",
            type: "string"
          }
        },
        required: ["opportunityId", "draft", "evidenceCases"],
        type: "object"
      },
      keywords: [
        "continuity",
        "learning",
        "replay",
        "verification",
        "학습",
        "검증"
      ],
      name: "muse.continuity.learning.replay-preview",
      risk: "read"
    },
    execute: async (args): Promise<JsonObject> => {
      const input = parseLearningReplayPreviewInput(args);
      const result = await deps.previewReplay(input);
      if (!result) {
        throw new Error("continuity learning replay preview held: stale opportunity, invalid draft, or invalid evidence");
      }
      return projectResult(result);
    }
  };
}
