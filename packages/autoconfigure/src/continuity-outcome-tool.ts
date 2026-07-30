import type {
  ContinuityOutcome,
  ContinuityOutcomeRecord,
  ExperienceLearningReviewOpportunity
} from "@muse/attunement";
import type { JsonObject } from "@muse/shared";
import type { MuseTool } from "@muse/tools";

const DELIVERY_ID_PATTERN = /^delivery_[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/u;
const OUTCOMES = ["used", "adjusted", "ignored", "rejected"] as const;
const MAX_OWNER_NOTE_CHARACTERS = 500;
const OWNER_NOTE_CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/u;

export interface ContinuityOutcomeToolResult {
  readonly applied: boolean;
  readonly delivery: {
    readonly id: string;
    readonly outcome?: ContinuityOutcomeRecord;
  };
  readonly learningOpportunity?: ExperienceLearningReviewOpportunity;
  readonly policy: {
    readonly version: number;
  };
}

export interface ContinuityOutcomeToolDeps {
  readonly recordOutcome: (
    deliveryId: string,
    outcome: ContinuityOutcome,
    ownerNote: string | undefined
  ) => Promise<ContinuityOutcomeToolResult>;
}

interface ContinuityOutcomeInput {
  readonly deliveryId: string;
  readonly outcome: ContinuityOutcome;
  readonly ownerNote?: string;
}

export function projectLearningOpportunity(
  value: ExperienceLearningReviewOpportunity
): JsonObject {
  return {
    activation: value.activation,
    boundary: {
      actionScope: value.boundary.actionScope,
      permission: value.boundary.permission,
      recipient: value.boundary.recipient,
      retention: value.boundary.retention,
      source: value.boundary.source
    },
    deliveryId: value.deliveryId,
    opportunityId: value.opportunityId,
    outcome: {
      outcome: value.outcome.outcome,
      outcomeId: value.outcome.outcomeId,
      recordedAt: value.outcome.recordedAt
    },
    requiredReview: {
      boundedDraft: value.requiredReview.boundedDraft,
      explicitApproval: value.requiredReview.explicitApproval,
      frozenReplayEvidence: value.requiredReview.frozenReplayEvidence
    },
    schemaVersion: value.schemaVersion,
    scope: { threadId: value.scope.threadId },
    sourceRun: {
      behaviorDigest: value.sourceRun.behaviorDigest,
      completedAt: value.sourceRun.completedAt,
      evidenceClass: value.sourceRun.evidenceClass,
      runId: value.sourceRun.runId
    },
    status: value.status
  };
}

function dataValue(
  descriptors: PropertyDescriptorMap,
  key: keyof ContinuityOutcomeInput
): unknown {
  const descriptor = descriptors[key];
  if (!descriptor || !("value" in descriptor)) {
    throw new Error(`continuity outcome ${key} must be a plain data property`);
  }
  return descriptor.value;
}

function parseInput(args: JsonObject): ContinuityOutcomeInput {
  const prototype = Object.getPrototypeOf(args);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error("continuity outcome input must be a plain object");
  }
  const keys = Reflect.ownKeys(args);
  if (
    (keys.length !== 2 && keys.length !== 3)
    || keys.some((key) => typeof key !== "string")
    || !keys.includes("deliveryId")
    || !keys.includes("outcome")
    || (keys.length === 3 && !keys.includes("ownerNote"))
  ) {
    throw new Error("continuity outcome requires exactly deliveryId, outcome, and optional ownerNote");
  }
  const descriptors = Object.getOwnPropertyDescriptors(args);
  const deliveryId = dataValue(descriptors, "deliveryId");
  const outcome = dataValue(descriptors, "outcome");
  if (typeof deliveryId !== "string" || !DELIVERY_ID_PATTERN.test(deliveryId)) {
    throw new Error("continuity outcome requires a full exact deliveryId");
  }
  if (
    typeof outcome !== "string"
    || !OUTCOMES.includes(outcome as ContinuityOutcome)
  ) {
    throw new Error("continuity outcome must be exactly used, adjusted, ignored, or rejected");
  }
  if (!keys.includes("ownerNote")) {
    return { deliveryId, outcome: outcome as ContinuityOutcome };
  }
  const ownerNote = dataValue(descriptors, "ownerNote");
  if (
    typeof ownerNote !== "string"
    || ownerNote.length === 0
    || ownerNote !== ownerNote.trim()
    || Array.from(ownerNote).length > MAX_OWNER_NOTE_CHARACTERS
    || OWNER_NOTE_CONTROL_CHARACTERS.test(ownerNote)
  ) {
    throw new Error(
      "continuity outcome ownerNote must be 1-500 exact owner-authored characters with no surrounding whitespace or control characters"
    );
  }
  return {
    deliveryId,
    outcome: outcome as ContinuityOutcome,
    ownerNote
  };
}

export function createContinuityOutcomeTool(
  deps: ContinuityOutcomeToolDeps
): MuseTool {
  return {
    definition: {
      description:
        "Request approval to record one explicit owner-reported outcome for one exact Continuity delivery: used, adjusted, ignored, or rejected, with an optional exact owner-authored note. Call only when the owner directly states the outcome; never infer it from timeout, silence, sentiment, task receipts, assistant guesses, or tool output. Outcomes cannot be overwritten and this tool grants no timing or policy-reset authority.",
      domain: "core",
      inputSchema: {
        additionalProperties: false,
        properties: {
          deliveryId: {
            description: "Full exact delivery ID returned by the approved Pack open.",
            maxLength: 264,
            minLength: 10,
            type: "string"
          },
          outcome: {
            description: "Exact outcome explicitly selected by the owner.",
            enum: [...OUTCOMES],
            type: "string"
          },
          ownerNote: {
            description:
              "Optional exact owner-authored note. Omit unless the owner supplied it.",
            maxLength: MAX_OWNER_NOTE_CHARACTERS,
            minLength: 1,
            type: "string"
          }
        },
        required: ["deliveryId", "outcome"],
        type: "object"
      },
      keywords: [
        "continuity",
        "outcome",
        "feedback",
        "used",
        "adjusted",
        "ignored",
        "rejected",
        "결과",
        "피드백"
      ],
      name: "muse.continuity.delivery.outcome",
      risk: "write"
    },
    execute: async (args): Promise<JsonObject> => {
      const input = parseInput(args);
      const result = await deps.recordOutcome(
        input.deliveryId,
        input.outcome,
        input.ownerNote
      );
      const recorded = result.delivery.outcome;
      if (
        result.delivery.id !== input.deliveryId
        || !recorded
        || recorded.outcome !== input.outcome
        || recorded.ownerNote !== input.ownerNote
      ) {
        throw new Error("recorded continuity outcome did not preserve the explicit owner input");
      }
      return {
        applied: result.applied,
        deliveryId: result.delivery.id,
        outcome: recorded.outcome,
        ownerNoteRecorded: recorded.ownerNote !== undefined,
        policyVersion: result.policy.version,
        ...(result.learningOpportunity
          ? { learningOpportunity: projectLearningOpportunity(result.learningOpportunity) }
          : {}),
        success: true
      };
    }
  };
}
