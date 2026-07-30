import {
  DETAIL_LEVELS,
  EXPERIENCE_TIMING_ADJUSTMENTS,
  NEXT_STEP_PRESENTATIONS,
  SUPPRESSION_MODES,
  type ExperienceLearningProposalDraft
} from "@muse/attunement";
import type {
  AttuneGraphPolicyCardHeldReasonV1,
  AttuneGraphPolicyCardCompileResultV1,
  AttuneGraphPolicyCardLocaleV1
} from "@muse/attunegraph/policy-card";
import {
  assertPlainDataTree,
  isRecord,
  type JsonObject
} from "@muse/shared";
import type { MuseTool } from "@muse/tools";

import {
  parseLearningReplayPreviewInput
} from "./continuity-learning-replay-preview-tool.js";

export interface ContinuityLearningPolicyCardToolDeps {
  readonly previewPolicyCard: (input: Readonly<{
    readonly draft: ExperienceLearningProposalDraft;
    readonly evidenceCases: unknown;
    readonly locale: AttuneGraphPolicyCardLocaleV1;
    readonly opportunityId: string;
  }>) => Promise<AttuneGraphPolicyCardCompileResultV1>;
}

const HELD_REASONS = new Set<AttuneGraphPolicyCardHeldReasonV1>([
  "invalid-input",
  "untrusted-revalidation",
  "provider-not-fresh",
  "scope-mismatch",
  "opportunity-not-found",
  "proposal-held",
  "replay-invalid",
  "graph-invalid",
  "graph-proof-missing",
  "graph-proof-ambiguous",
  "temporal-mismatch",
  "budget-exceeded",
  "internal-error"
]);

function exactRecord(
  value: unknown,
  keys: readonly string[]
): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const ownKeys = Reflect.ownKeys(value);
  return ownKeys.length === keys.length
    && ownKeys.every((key) => typeof key === "string" && keys.includes(key))
    ? value
    : undefined;
}

function stringFields(
  record: Record<string, unknown>,
  keys: readonly string[]
): boolean {
  return keys.every((key) => typeof record[key] === "string");
}

function canonicalInstant(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds)
    && new Date(milliseconds).toISOString() === value;
}

function validProposedChange(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.kind === "thread-display") {
    const change = exactRecord(value, ["detail", "kind", "nextStep"]);
    return !!change
      && DETAIL_LEVELS.includes(change.detail as never)
      && NEXT_STEP_PRESENTATIONS.includes(change.nextStep as never);
  }
  if (value.kind === "thread-suppression") {
    const change = exactRecord(value, ["kind", "suppression"]);
    return !!change
      && SUPPRESSION_MODES.includes(change.suppression as never);
  }
  if (value.kind === "thread-timing") {
    const change = exactRecord(value, ["adjustment", "kind"]);
    return !!change
      && EXPERIENCE_TIMING_ADJUSTMENTS.includes(change.adjustment as never);
  }
  return false;
}

function validRenderedCard(value: unknown): boolean {
  const card = exactRecord(value, [
    "schemaVersion",
    "cardVersion",
    "cardId",
    "renderId",
    "locale",
    "status",
    "title",
    "scope",
    "assessedSnapshot",
    "proposal",
    "evidence",
    "controls",
    "boundary",
    "labels"
  ]);
  if (
    !card
    || card.schemaVersion !== 1
    || card.cardVersion !== "attunegraph-policy-card.v1"
    || (card.locale !== "en" && card.locale !== "ko")
    || card.status !== "review-preview"
    || !stringFields(card, ["cardId", "renderId", "title"])
  ) {
    return false;
  }
  const scope = exactRecord(card.scope, [
    "kind", "sourceId", "threadId"
  ]);
  const assessed = exactRecord(card.assessedSnapshot, [
    "assessedAt",
    "currentWorldFreshness",
    "freshness",
    "headProviderReceiptId",
    "providerAttestedDerivedGraph",
    "revalidationReceiptId",
    "stateDigest",
    "subjectProviderReceiptId"
  ]);
  const proposal = exactRecord(card.proposal, [
    "activeBehaviorDigestAfter",
    "activeBehaviorDigestBefore",
    "candidateId",
    "expectedBenefit",
    "expiresAt",
    "previewId",
    "proposedAt",
    "proposedBehavior",
    "proposedChange"
  ]);
  const evidence = exactRecord(card.evidence, [
    "authoritativeExperience",
    "callerSuppliedReplayClaims",
    "graphExplanation"
  ]);
  const boundary = exactRecord(card.boundary, [
    "activation", "approval", "effect"
  ]);
  const labels = exactRecord(card.labels, [
    "assessedSnapshot",
    "authoritativeExperience",
    "callerSuppliedReplayClaims",
    "graphExplanation",
    "proposedChange"
  ]);
  if (
    !scope
    || scope.kind !== "thread-only"
    || !stringFields(scope, ["sourceId", "threadId"])
    || !assessed
    || assessed.currentWorldFreshness !== false
    || assessed.providerAttestedDerivedGraph !== false
    || assessed.freshness !== "provider-head-matched-at-assessment"
    || !stringFields(assessed, [
      "headProviderReceiptId",
      "revalidationReceiptId",
      "stateDigest",
      "subjectProviderReceiptId"
    ])
    || !canonicalInstant(assessed.assessedAt)
    || !proposal
    || !stringFields(proposal, [
      "activeBehaviorDigestAfter",
      "activeBehaviorDigestBefore",
      "candidateId",
      "expectedBenefit",
      "previewId",
      "proposedBehavior"
    ])
    || !canonicalInstant(proposal.expiresAt)
    || !canonicalInstant(proposal.proposedAt)
    || Date.parse(proposal.proposedAt) >= Date.parse(proposal.expiresAt)
    || !validProposedChange(proposal.proposedChange)
    || !evidence
    || !boundary
    || boundary.activation !== "none"
    || boundary.approval !== "none"
    || boundary.effect !== "none"
    || !labels
    || !stringFields(labels, Object.keys(labels))
  ) {
    return false;
  }

  const authoritative = exactRecord(evidence.authoritativeExperience, [
    "authority",
    "deliveryId",
    "evidenceClass",
    "label",
    "outcome",
    "outcomeId",
    "recordedAt",
    "sourceRunId"
  ]);
  const replay = exactRecord(evidence.callerSuppliedReplayClaims, [
    "aggregate",
    "executionProvenanceVerified",
    "label",
    "recommendation",
    "replayBundleId",
    "replayInputHash",
    "receiptHashes",
    "validation"
  ]);
  const graph = exactRecord(evidence.graphExplanation, [
    "assertionIds",
    "label",
    "observationReceiptId",
    "projectionVersion",
    "provenance",
    "providerAttested",
    "sourceVersion"
  ]);
  const aggregate = replay
    ? exactRecord(replay.aggregate, [
      "baselinePassed",
      "challengerPassed",
      "improvements",
      "regressions",
      "ties",
      "total"
    ])
    : undefined;
  if (
    !authoritative
    || authoritative.authority !== "owner-explicit"
    || !["controlled", "organic-production"].includes(
      authoritative.evidenceClass as string
    )
    || !["adjusted", "ignored", "rejected"].includes(
      authoritative.outcome as string
    )
    || !stringFields(authoritative, [
      "deliveryId", "label", "outcomeId", "sourceRunId"
    ])
    || !canonicalInstant(authoritative.recordedAt)
    || Date.parse(authoritative.recordedAt) > Date.parse(proposal.proposedAt)
    || !replay
    || replay.executionProvenanceVerified !== false
    || replay.validation
      !== "structurally-validated-self-consistent-caller-claims"
    || !["eligible-for-review", "hold"].includes(
      replay.recommendation as string
    )
    || !stringFields(replay, [
      "label", "replayBundleId", "replayInputHash"
    ])
    || !aggregate
    || !Object.values(aggregate).every((count) =>
      typeof count === "number" && Number.isSafeInteger(count) && count >= 0)
    || !Array.isArray(replay.receiptHashes)
    || !replay.receiptHashes.every((entry) => {
      const receipt = exactRecord(entry, ["baseline", "caseId", "challenger"]);
      return !!receipt
        && stringFields(receipt, ["baseline", "caseId", "challenger"]);
    })
    || !graph
    || graph.providerAttested !== false
    || graph.provenance
      !== "locally-derived-from-provider-head-matched-assessed-snapshot"
    || !stringFields(graph, [
      "label", "observationReceiptId", "projectionVersion", "sourceVersion"
    ])
    || !Array.isArray(graph.assertionIds)
    || graph.assertionIds.length !== 4
    || !graph.assertionIds.every((id) => typeof id === "string")
  ) {
    return false;
  }
  const baselinePassed = aggregate.baselinePassed as number;
  const challengerPassed = aggregate.challengerPassed as number;
  const improvements = aggregate.improvements as number;
  const regressions = aggregate.regressions as number;
  const ties = aggregate.ties as number;
  const total = aggregate.total as number;
  const receiptCount = replay.receiptHashes.length;
  const baselineTiePassed = baselinePassed - regressions;
  const challengerTiePassed = challengerPassed - improvements;
  if (
    total !== receiptCount
    || baselinePassed > total
    || challengerPassed > total
    || improvements + regressions + ties !== total
    || challengerPassed - baselinePassed !== improvements - regressions
    || improvements > challengerPassed
    || regressions > baselinePassed
    || improvements > total - baselinePassed
    || regressions > total - challengerPassed
    || baselineTiePassed !== challengerTiePassed
    || baselineTiePassed < 0
    || baselineTiePassed > ties
    || replay.recommendation !== (
      regressions === 0 && improvements > 0
        ? "eligible-for-review"
        : "hold"
    )
    || new Set(graph.assertionIds).size !== graph.assertionIds.length
  ) {
    return false;
  }

  const controls = card.controls;
  if (!Array.isArray(controls) || controls.length !== 5) return false;
  const expectedControls = [
    ["trial", "unavailable_in_preview", undefined],
    ["edit", "unavailable_in_preview", undefined],
    ["reject", "unavailable_in_preview", undefined],
    ["apply", "external_to_preview", "muse.continuity.learning.apply"],
    [
      "rollback",
      "unavailable_in_preview",
      "muse.continuity.learning.rollback"
    ]
  ] as const;
  return controls.every((entry, index) => {
    const externalSurface = expectedControls[index]![2];
    const control = exactRecord(entry, externalSurface
      ? [
        "approvalGranted",
        "availability",
        "effectPerformed",
        "externalSurface",
        "kind",
        "label",
        "note"
      ]
      : [
        "approvalGranted",
        "availability",
        "effectPerformed",
        "kind",
        "label",
        "note"
      ]);
    return !!control
      && control.approvalGranted === false
      && control.effectPerformed === false
      && control.kind === expectedControls[index]![0]
      && control.availability === expectedControls[index]![1]
      && control.externalSurface === externalSurface
      && stringFields(control, ["label", "note"]);
  });
}

function parseInput(args: JsonObject): Readonly<{
  readonly draft: ExperienceLearningProposalDraft;
  readonly evidenceCases: unknown;
  readonly locale: AttuneGraphPolicyCardLocaleV1;
  readonly opportunityId: string;
}> {
  assertPlainDataTree(args, "continuityLearningPolicyCardInput");
  if (!isRecord(args)) {
    throw new Error("continuity learning policy card input must be plain data");
  }
  const keys = Reflect.ownKeys(args);
  if (
    keys.length !== 4
    || keys.some((key) =>
      typeof key !== "string"
      || !["draft", "evidenceCases", "locale", "opportunityId"].includes(key))
    || (args.locale !== "en" && args.locale !== "ko")
  ) {
    throw new Error(
      "continuity learning policy card requires exact opportunityId, draft, evidenceCases, and locale"
    );
  }
  const replayInput = parseLearningReplayPreviewInput({
    draft: args.draft as never,
    evidenceCases: args.evidenceCases as never,
    opportunityId: args.opportunityId as never
  });
  return Object.freeze({
    ...replayInput,
    locale: args.locale
  });
}

function projectResult(
  value: AttuneGraphPolicyCardCompileResultV1
): JsonObject {
  assertPlainDataTree(value, "continuityLearningPolicyCardOutput");
  const result = exactRecord(value, value.status === "held"
    ? ["reason", "status"]
    : ["card", "status"]);
  if (!result) throw new TypeError("invalid Policy Card result envelope");
  if (result.status === "held") {
    if (
      typeof result.reason !== "string"
      || !HELD_REASONS.has(
        result.reason as AttuneGraphPolicyCardHeldReasonV1
      )
    ) {
      throw new TypeError("invalid Policy Card held result");
    }
  } else if (result.status !== "rendered" || !validRenderedCard(result.card)) {
    throw new TypeError("invalid Policy Card rendered result");
  }
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}

export function createContinuityLearningPolicyCardTool(
  deps: ContinuityLearningPolicyCardToolDeps
): MuseTool {
  return {
    definition: {
      description:
        "Render one read-only AttuneGraph Policy Card for an exact current Continuity learning opportunity and explicit draft. It separates the authoritative owner experience, caller-supplied replay claims whose execution provenance is not verified, and a locally derived graph explanation. It never approves, edits, rejects, applies, rolls back, or records anything.",
      domain: "core",
      inputSchema: {
        additionalProperties: false,
        properties: {
          draft: {
            description:
              "The exact bounded collaboration-policy draft to explain.",
            type: "object"
          },
          evidenceCases: {
            description:
              "Caller-supplied baseline/challenger receipt claims. Their structure is validated, but their execution provenance is not attested by this preview.",
            items: { type: "object" },
            minItems: 1,
            type: "array"
          },
          locale: {
            description: "Deterministic display language for the inert card.",
            enum: ["en", "ko"],
            type: "string"
          },
          opportunityId: {
            description:
              "The exact current learning opportunity to bind to the assessed snapshot.",
            pattern: "^learning_opportunity_[a-f0-9]{64}$",
            type: "string"
          }
        },
        required: ["opportunityId", "draft", "evidenceCases", "locale"],
        type: "object"
      },
      keywords: [
        "attunegraph",
        "continuity",
        "learning",
        "policy card",
        "explanation",
        "정책 카드",
        "관계 근거",
        "검토"
      ],
      name: "muse.continuity.learning.policy-card.preview",
      risk: "read"
    },
    execute: async (args): Promise<JsonObject> => {
      let input;
      try {
        input = parseInput(args);
      } catch {
        return { reason: "invalid-input", status: "held" };
      }
      try {
        return projectResult(await deps.previewPolicyCard(input));
      } catch {
        return { reason: "internal-error", status: "held" };
      }
    }
  };
}
