import type {
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
    handleId: string
  ) => Promise<ContinuityLearningRollbackResult | undefined>;
}

const HANDLE_ID = /^learning_promotion_handle_[a-f0-9]{64}$/u;

function parseInput(args: JsonObject): string {
  assertPlainDataTree(args, "continuityLearningRollbackInput");
  if (!isRecord(args)
    || Reflect.ownKeys(args).length !== 1
    || !Object.hasOwn(args, "handleId")
    || typeof args.handleId !== "string"
    || !HANDLE_ID.test(args.handleId)) {
    throw new Error("continuity learning rollback requires one exact promotion handleId");
  }
  return args.handleId;
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
          handleId: {
            description:
              "The exact durable promotion handle ID whose bounded thread policy should be restored.",
            pattern: "^learning_promotion_handle_[a-f0-9]{64}$",
            type: "string"
          }
        },
        required: ["handleId"],
        type: "object"
      },
      keywords: ["continuity", "learning", "rollback", "restore", "학습", "되돌리기"],
      name: "muse.continuity.learning.rollback",
      risk: "write"
    },
    execute: async (args): Promise<JsonObject> => {
      const handleId = parseInput(args);
      const result = await deps.rollback(handleId);
      if (!result) {
        throw new Error("continuity learning rollback held: promotion is stale or mismatched");
      }
      return projectResult(result);
    }
  };
}
