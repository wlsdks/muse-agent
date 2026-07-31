import type {
  ExperienceLearningDegradationAssessment,
  ExperienceLearningRollbackProposal
} from "@muse/attunement";
import {
  assertPlainDataTree,
  isRecord,
  type JsonObject
} from "@muse/shared";
import type { MuseTool } from "@muse/tools";

export interface ContinuityLearningDegradationToolDeps {
  readonly assess: (
    handleId: string
  ) => Promise<ExperienceLearningDegradationAssessment | undefined>;
  readonly observeProposal?: (
    proposal: ExperienceLearningRollbackProposal
  ) => void;
}

const HANDLE_ID = /^learning_promotion_handle_[a-f0-9]{64}$/u;

function parseInput(args: JsonObject): string {
  assertPlainDataTree(args, "continuityLearningDegradationInput");
  if (!isRecord(args)
    || Reflect.ownKeys(args).length !== 1
    || !Object.hasOwn(args, "handleId")
    || typeof args.handleId !== "string"
    || !HANDLE_ID.test(args.handleId)) {
    throw new Error("continuity learning degradation requires one exact promotion handleId");
  }
  return args.handleId;
}

export function createContinuityLearningDegradationTool(
  deps: ContinuityLearningDegradationToolDeps
): MuseTool {
  return {
    definition: {
      description:
        "Read the current organic post-promotion outcome window for one exact durable learning handle. Returns an inert hold or owner-review rollback proposal and never applies, approves, or rolls back policy.",
      domain: "core",
      inputSchema: {
        additionalProperties: false,
        properties: {
          handleId: {
            description:
              "The exact durable promotion handle ID whose organic post-promotion outcome window should be assessed.",
            pattern: "^learning_promotion_handle_[a-f0-9]{64}$",
            type: "string"
          }
        },
        required: ["handleId"],
        type: "object"
      },
      keywords: ["continuity", "learning", "degradation", "rollback", "학습", "검토"],
      name: "muse.continuity.learning.degradation",
      risk: "read"
    },
    execute: async (args): Promise<JsonObject> => {
      const result = await deps.assess(parseInput(args));
      if (!result) {
        throw new Error("continuity learning degradation held: promotion handle is unavailable");
      }
      assertPlainDataTree(result, "continuityLearningDegradationOutput");
      if (result.proposal) {
        try {
          deps.observeProposal?.(result.proposal);
        } catch {
          // Health observation is deliberately fail-open for this read result.
        }
      }
      return result as unknown as JsonObject;
    }
  };
}
