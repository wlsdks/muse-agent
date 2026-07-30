import type {
  ExperienceLearningPromotionReceipt,
  ExperienceLearningRollbackReceipt
} from "@muse/attunement";
import {
  assertPlainDataTree,
  isRecord,
  type JsonObject
} from "@muse/shared";
import type { MuseTool } from "@muse/tools";

export interface ContinuityLearningRollbackResult {
  readonly policyAuditId: string;
  readonly rollback: ExperienceLearningRollbackReceipt;
}

export interface ContinuityLearningRollbackToolDeps {
  readonly rollback: (
    promotion: ExperienceLearningPromotionReceipt
  ) => Promise<ContinuityLearningRollbackResult | undefined>;
}

function parseInput(args: JsonObject): ExperienceLearningPromotionReceipt {
  assertPlainDataTree(args, "continuityLearningRollbackInput");
  if (!isRecord(args)
    || Reflect.ownKeys(args).length !== 1
    || !Object.hasOwn(args, "promotion")
    || !isRecord(args.promotion)) {
    throw new Error("continuity learning rollback requires one exact promotion receipt");
  }
  return args.promotion as unknown as ExperienceLearningPromotionReceipt;
}

function projectResult(value: ContinuityLearningRollbackResult): JsonObject {
  const output = {
    policyAuditId: value.policyAuditId,
    rollback: value.rollback
  };
  assertPlainDataTree(output, "continuityLearningRollbackOutput");
  return output as unknown as JsonObject;
}

export function createContinuityLearningRollbackTool(
  deps: ContinuityLearningRollbackToolDeps
): MuseTool {
  return {
    definition: {
      description:
        "Roll back one exact previously promoted Continuity collaboration-policy receipt after owner approval. This stale-safe write restores only the bounded prior thread policy and records a durable rollback audit.",
      domain: "core",
      inputSchema: {
        additionalProperties: false,
        properties: {
          promotion: { type: "object" }
        },
        required: ["promotion"],
        type: "object"
      },
      keywords: ["continuity", "learning", "rollback", "restore", "학습", "되돌리기"],
      name: "muse.continuity.learning.rollback",
      risk: "write"
    },
    execute: async (args): Promise<JsonObject> => {
      const promotion = parseInput(args);
      const result = await deps.rollback(promotion);
      if (!result) {
        throw new Error("continuity learning rollback held: promotion is stale or mismatched");
      }
      return projectResult(result);
    }
  };
}
