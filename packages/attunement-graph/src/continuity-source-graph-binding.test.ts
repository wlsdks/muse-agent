import type {
  ArtifactReference,
  AttunementState,
  ContinuityPack,
  ContinuityPolicy,
  ResolvedArtifact
} from "@muse/attunement";
import {
  captureScopedContinuitySourceObservation
} from "@muse/attunement/continuity-source-observations";
import { describe, expect, it } from "vitest";

import {
  captureContinuityObservation
} from "./continuity-observation.js";
import {
  continuitySourceGraphPairMatches
} from "./continuity-source-graph-binding.js";

const OBSERVED_AT = "2026-07-29T08:00:00.000Z";
const SCOPE = Object.freeze({
  sourceId: "default",
  threadId: "thread_binding"
});
const POLICY: ContinuityPolicy = Object.freeze({
  detail: "compact",
  nextStep: "direct",
  suppression: "none",
  version: 0
});
const TASK: ArtifactReference = Object.freeze({
  artifactId: "task_binding",
  artifactType: "task",
  providerId: "local",
  role: "next-step"
});
const NOTE: ArtifactReference = Object.freeze({
  artifactId: "binding/context.md",
  artifactType: "note",
  providerId: "local",
  role: "context"
});

function state(
  role: ArtifactReference["role"] = "context",
  policy: ContinuityPolicy = POLICY
): AttunementState {
  return {
    deliveries: [],
    interactionReceipts: [],
    nextPolicyVersion: 1,
    resetReceipts: [],
    schemaVersion: 11,
    threads: [{
      createdAt: "2026-07-29T00:00:00.000Z",
      id: SCOPE.threadId,
      kind: "work",
      links: [
        {
          ...TASK,
          role,
          linkedAt: "2026-07-29T01:00:00.000Z",
          linkedBy: "user",
          threadId: SCOPE.threadId
        },
        {
          ...NOTE,
          linkedAt: "2026-07-29T01:01:00.000Z",
          linkedBy: "user",
          threadId: SCOPE.threadId
        }
      ],
      policy,
      title: "Private binding thread"
    }],
    undoResetReceipts: []
  };
}

function graphReceipt(
  sourceId: string = SCOPE.sourceId,
  role: ArtifactReference["role"] = "context",
  policy: ContinuityPolicy = POLICY
) {
  return captureContinuityObservation({
    scope: { sourceId, threadId: SCOPE.threadId },
    sourceObservedAt: OBSERVED_AT,
    state: state(role, policy)
  });
}

function artifact(reference: ArtifactReference): ResolvedArtifact {
  return {
    ...reference,
    ...(reference.artifactType === "task" ? { taskStatus: "open" as const } : {}),
    title: `Exact ${reference.artifactType}`
  };
}

function sourceReceipt(
  sourceId: string = SCOPE.sourceId,
  role: ArtifactReference["role"] = "context",
  policy: ContinuityPolicy = POLICY
) {
  const references = [
    { ...TASK, role },
    NOTE
  ];
  const evidence = references.map((reference) => ({
    artifact: artifact(reference),
    reference,
    status: "available" as const
  }));
  const pack: ContinuityPack = {
    deliveryPolicyVersion: policy.version,
    evidence,
    evidenceRefs: evidence.map((entry) => entry.reference),
    policy,
    thread: {
      id: SCOPE.threadId,
      kind: "work",
      title: "Private binding thread"
    }
  };
  return captureScopedContinuitySourceObservation({
    scope: { sourceId, threadId: SCOPE.threadId },
    observedAt: OBSERVED_AT,
    pack
  });
}

describe("Continuity Source to Graph binding", () => {
  it("binds exact scoped link roles and policy provenance", () => {
    const graph = graphReceipt();
    expect(continuitySourceGraphPairMatches(sourceReceipt(), graph)).toBe(true);
    expect(continuitySourceGraphPairMatches(
      sourceReceipt("substituted"),
      graph
    )).toBe(false);
    expect(continuitySourceGraphPairMatches(
      sourceReceipt(),
      graphReceipt("substituted")
    )).toBe(false);
  });

  it("rejects link-role and policy drift between individually verified receipts", () => {
    const graph = graphReceipt();
    expect(continuitySourceGraphPairMatches(
      sourceReceipt(),
      graphReceipt(SCOPE.sourceId, "next-step")
    )).toBe(false);
    expect(continuitySourceGraphPairMatches(
      sourceReceipt(
        SCOPE.sourceId,
        "context",
        { ...POLICY, detail: "standard" }
      ),
      graph
    )).toBe(false);
  });
});
