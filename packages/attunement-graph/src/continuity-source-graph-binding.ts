import type {
  ArtifactReference,
  ContinuityEvidence,
  ResolvedArtifact
} from "@muse/attunement";
import type {
  ContinuityScopedSourceObservationReceipt
} from "@muse/attunement/continuity-source-observations";

import {
  deriveContinuityArtifactGraphRef,
  deriveContinuityPolicyGraphRef,
  deriveContinuityPolicySourceRef,
  deriveContinuityThreadGraphRef
} from "./continuity-projection-identity.js";
import type { ContinuityObservationReceipt } from "./continuity-observation.js";
import type { GraphAssertion, GraphRef } from "./types.js";
import { evidenceRefKey, graphRefKey } from "./validation.js";

function artifactReferenceKey(reference: ArtifactReference): string {
  return JSON.stringify([
    reference.artifactId,
    reference.artifactType,
    reference.providerId,
    reference.role
  ]);
}

function sameGraphRef(left: GraphRef, right: GraphRef): boolean {
  return graphRefKey(left) === graphRefKey(right);
}

function linkAssertionKey(assertion: GraphAssertion): string {
  return JSON.stringify([
    graphRefKey(assertion.subject),
    assertion.predicate,
    graphRefKey(assertion.object)
  ]);
}

function expectedLinkAssertionKey(
  sourceId: string,
  threadRef: GraphRef,
  reference: ArtifactReference
): string {
  return JSON.stringify([
    graphRefKey(deriveContinuityArtifactGraphRef(sourceId, reference)),
    reference.role === "next-step" ? "NEXT_STEP_FOR" : "CONTEXT_FOR",
    graphRefKey(threadRef)
  ]);
}

function exactLinkSetMatches(
  sourceId: string,
  threadRef: GraphRef,
  evidence: readonly Pick<ContinuityEvidence, "reference">[],
  assertions: readonly GraphAssertion[]
): boolean {
  const expected = new Set(
    evidence.map(({ reference }) =>
      expectedLinkAssertionKey(sourceId, threadRef, reference)
    )
  );
  if (expected.size !== evidence.length) return false;

  const links = assertions.filter((assertion) =>
    (assertion.predicate === "CONTEXT_FOR"
      || assertion.predicate === "NEXT_STEP_FOR")
    && sameGraphRef(assertion.object, threadRef)
  );
  if (links.length !== expected.size) return false;
  const actual = new Set(links.map(linkAssertionKey));
  return actual.size === links.length
    && [...expected].every((key) => actual.has(key));
}

function exactPolicyBindingMatches(
  sourceId: string,
  threadId: string,
  threadRef: GraphRef,
  policy: ContinuityScopedSourceObservationReceipt[
    "observation"
  ]["projection"]["policy"],
  assertions: readonly GraphAssertion[]
): boolean {
  const scoped = assertions.filter((assertion) =>
    assertion.predicate === "SCOPED_TO"
    && sameGraphRef(assertion.object, threadRef)
  );
  if (scoped.length !== 1) return false;
  const assertion = scoped[0]!;
  const expectedPolicyRef = deriveContinuityPolicyGraphRef(
    sourceId,
    threadId,
    policy.version
  );
  if (!sameGraphRef(assertion.subject, expectedPolicyRef)) return false;
  const expectedSource = deriveContinuityPolicySourceRef(
    sourceId,
    threadId,
    policy
  );
  const expectedSourceKey = evidenceRefKey(expectedSource);
  return assertion.sourceRefs.some((sourceRef) =>
    evidenceRefKey(sourceRef) === expectedSourceKey
  );
}

function resolvedNextStepMatches(
  evidence: readonly Pick<ContinuityEvidence, "reference">[],
  nextStep: ResolvedArtifact | undefined
): boolean {
  if (!nextStep) return true;
  const nextStepKey = artifactReferenceKey(nextStep);
  return nextStep.role === "next-step"
    && evidence.some(({ reference }) =>
      reference.role === "next-step"
      && artifactReferenceKey(reference) === nextStepKey
    );
}

/**
 * Compare already-verified projections only. Parsing, integrity checks, and error mapping
 * remain with the Source/Graph receipt Modules and the eventual Capsule compiler.
 */
export function continuitySourceGraphPairMatches(
  source: ContinuityScopedSourceObservationReceipt,
  graph: ContinuityObservationReceipt
): boolean {
  const { scope } = source;
  const sourceProjection = source.observation.projection;
  const graphProjection = graph.projection;
  if (
    source.observation.observedAt !== graph.observedAt
    || scope.sourceId !== graphProjection.scope.sourceId
    || scope.threadId !== graphProjection.scope.threadId
    || scope.threadId !== sourceProjection.thread.id
  ) {
    return false;
  }

  const threadRef = deriveContinuityThreadGraphRef(
    scope.sourceId,
    scope.threadId
  );
  return exactLinkSetMatches(
    scope.sourceId,
    threadRef,
    sourceProjection.evidence,
    graphProjection.assertions
  )
    && exactPolicyBindingMatches(
      scope.sourceId,
      scope.threadId,
      threadRef,
      sourceProjection.policy,
      graphProjection.assertions
    )
    && resolvedNextStepMatches(
      sourceProjection.evidence,
      sourceProjection.nextStep
    );
}
