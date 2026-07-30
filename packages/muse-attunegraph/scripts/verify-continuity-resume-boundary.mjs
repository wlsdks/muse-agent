import { createHash } from "node:crypto";

import { fingerprintContinuityTaskState } from "@muse/attunement";
import {
  captureScopedContinuitySourceObservation
} from "@muse/attunement/continuity-source-observations";

import {
  BOUNDARY_ID_PREFIX,
  CONTINUITY_RESUME_BOUNDARY_LIMITS,
  ContinuityResumeBoundaryError,
  captureContinuityResumeBoundary,
  verifyContinuityResumeBoundary,
  verifyContinuityResumeBoundaryWithDependencies
} from "../dist/continuity-resume-boundary.js";
import {
  captureContinuityObservation
} from "../dist/continuity-observation.js";

const OBSERVED_AT = "2026-07-30T08:00:00.000Z";
const POLICY = Object.freeze({
  detail: "compact",
  nextStep: "direct",
  suppression: "none",
  version: 0
});
const EXPECTED_KEYS = Object.freeze([
  "schemaVersion",
  "boundaryVersion",
  "authority",
  "scope",
  "observedAt",
  "sourceObservationReceiptId",
  "graphObservationReceiptId",
  "graphSourceVersion",
  "graphProjectionVersion",
  "previousNextStep",
  "boundaryId"
]);
const EXPECTED_FIXED_IDS = Object.freeze({
  boundaryId:
    "muse-continuity-resume-boundary:v1:sha256:49d9776b12ffde07baaf5af369767576a872680e4fbf29b6bd49bdca06c3f010",
  graphObservationReceiptId:
    "muse-continuity-observation:v1:sha256:a57c11c029a2234e8d5c33b44708b1212da41ba2793ce0e4518140b8e50264b1",
  sourceObservationReceiptId:
    "muse-continuity-scoped-source-observation:v1:sha256:1d8ca125d0d716d04f0ade5c42033d87bb4d4f10e0eb13611f605290018322e9"
});

function fail(message) {
  throw new Error(`continuity resume boundary verification failed: ${message}`);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function reference(artifactId = "task_resume") {
  return {
    artifactId,
    artifactType: "task",
    providerId: "local",
    role: "next-step"
  };
}

function resolved(task) {
  return {
    ...task,
    taskStatus: "open",
    title: "Exact next task"
  };
}

function pair({
  artifactId = "task_resume",
  sourceId = "default",
  threadId = "thread_resume"
} = {}) {
  const task = reference(artifactId);
  const state = {
    deliveries: [],
    interactionReceipts: [],
    nextPolicyVersion: 1,
    resetReceipts: [],
    schemaVersion: 11,
    threads: [{
      createdAt: "2026-07-30T00:00:00.000Z",
      id: threadId,
      kind: "work",
      links: [{
        ...task,
        linkedAt: "2026-07-30T01:00:00.000Z",
        linkedBy: "user",
        threadId
      }],
      policy: POLICY,
      title: "Resume boundary thread"
    }],
    undoResetReceipts: []
  };
  const artifact = resolved(task);
  const pack = {
    deliveryPolicyVersion: POLICY.version,
    evidence: [{ artifact, reference: task, status: "available" }],
    evidenceRefs: [task],
    interactionAnchor: {
      artifactId: task.artifactId,
      linkedAt: "2026-07-30T01:00:00.000Z",
      observedStatus: "open",
      openStateFingerprint: fingerprintContinuityTaskState({
        artifactId: task.artifactId,
        status: "open",
        updatedAt: ""
      }),
      providerId: "local",
      role: "next-step"
    },
    nextStep: artifact,
    policy: POLICY,
    thread: {
      id: threadId,
      kind: "work",
      title: "Resume boundary thread"
    }
  };
  return {
    graph: captureContinuityObservation({
      scope: { sourceId, threadId },
      sourceObservedAt: OBSERVED_AT,
      state
    }),
    source: captureScopedContinuitySourceObservation({
      observedAt: OBSERVED_AT,
      pack,
      scope: { sourceId, threadId }
    })
  };
}

function expectCode(operation, code) {
  try {
    operation();
  } catch (error) {
    assert(error instanceof ContinuityResumeBoundaryError, `expected boundary error for ${code}`);
    assert(error.code === code, `expected ${code}, received ${error.code}`);
    assert(Object.isFrozen(error), `${code} error must be frozen`);
    assert(
      JSON.stringify(error.details).length < 600,
      `${code} details must remain bounded`
    );
    return;
  }
  fail(`expected ${code}`);
}

function independentHash(body) {
  return `${BOUNDARY_ID_PREFIX}${createHash("sha256")
    .update("muse.attunement.continuity-resume-boundary.v1\0", "utf8")
    .update(JSON.stringify(body), "utf8")
    .digest("hex")}`;
}

function resign(boundary, changes) {
  const body = {
    schemaVersion: boundary.schemaVersion,
    boundaryVersion: boundary.boundaryVersion,
    authority: boundary.authority,
    scope: {
      sourceId: changes.scope?.sourceId ?? boundary.scope.sourceId,
      threadId: changes.scope?.threadId ?? boundary.scope.threadId
    },
    observedAt: boundary.observedAt,
    sourceObservationReceiptId: boundary.sourceObservationReceiptId,
    graphObservationReceiptId: boundary.graphObservationReceiptId,
    graphSourceVersion:
      changes.graphSourceVersion ?? boundary.graphSourceVersion,
    graphProjectionVersion:
      changes.graphProjectionVersion ?? boundary.graphProjectionVersion,
    previousNextStep: {
      artifactId:
        changes.artifactId ?? boundary.previousNextStep.artifactId,
      artifactType: "task",
      providerId: "local",
      role: "next-step"
    }
  };
  return { ...body, boundaryId: independentHash(body) };
}

const previous = pair();
const boundary = captureContinuityResumeBoundary({
  previousSourceObservationReceipt: previous.source,
  previousGraphObservationReceipt: previous.graph
});
assert(
  JSON.stringify(Object.keys(boundary)) === JSON.stringify(EXPECTED_KEYS),
  "ordered wire fields drifted"
);
assert(boundary.schemaVersion === 1, "schemaVersion literal drifted");
assert(
  boundary.boundaryVersion === "muse.continuity-resume-boundary.v1",
  "boundaryVersion literal drifted"
);
assert(
  boundary.authority === "caller-declared-resume-boundary",
  "authority literal drifted"
);
assert(
  boundary.sourceObservationReceiptId === previous.source.receiptId,
  "boundary must bind the outer scoped Source receipt ID"
);
assert(
  boundary.sourceObservationReceiptId !== previous.source.observation.receiptId,
  "boundary must not bind the inner Source observation receipt ID"
);
assert(
  boundary.graphObservationReceiptId === previous.graph.receiptId,
  "boundary must bind the Graph receipt ID"
);
assert(
  boundary.graphSourceVersion === previous.graph.projection.sourceVersion
    && boundary.graphProjectionVersion
      === previous.graph.projection.projectionVersion,
  "boundary must bind both descriptive Graph versions"
);
assert(
  JSON.stringify(boundary.previousNextStep)
    === JSON.stringify(reference()),
  "boundary must expose only the exact ArtifactReference"
);
const { boundaryId: omittedId, ...body } = boundary;
void omittedId;
assert(
  boundary.boundaryId === independentHash(body),
  "boundary ID must use the exact ordered domain-separated preimage"
);
assert(
  boundary.boundaryId === EXPECTED_FIXED_IDS.boundaryId
    && boundary.graphObservationReceiptId
      === EXPECTED_FIXED_IDS.graphObservationReceiptId
    && boundary.sourceObservationReceiptId
      === EXPECTED_FIXED_IDS.sourceObservationReceiptId,
  "deterministic fixed fixture IDs drifted"
);
const sortedBody = Object.fromEntries(
  Object.entries(body).sort(([left], [right]) => left < right ? -1 : 1)
);
assert(
  independentHash(sortedBody) !== boundary.boundaryId,
  "sorted-key hashing must not verify"
);
assert(
  `${BOUNDARY_ID_PREFIX}${createHash("sha256")
    .update("muse.attunement.continuity-resume-boundary.v1\0", "utf8")
    .update(JSON.stringify(boundary), "utf8")
    .digest("hex")}` !== boundary.boundaryId,
  "self-inclusive boundary-ID hashing must not verify"
);

const portable = verifyContinuityResumeBoundary(
  JSON.parse(JSON.stringify(boundary))
);
assert(
  JSON.stringify(portable) === JSON.stringify(boundary),
  "portable JSON round-trip changed canonical bytes"
);
const verified = verifyContinuityResumeBoundaryWithDependencies({
  boundary: portable,
  previousSourceObservationReceipt: JSON.parse(JSON.stringify(previous.source)),
  previousGraphObservationReceipt: JSON.parse(JSON.stringify(previous.graph))
});
assert(
  verified.previousSourceObservationReceipt.receiptId
    === previous.source.receiptId
    && verified.previousGraphObservationReceipt.receiptId
      === previous.graph.receiptId,
  "dependency-aware verification did not return verified dependencies"
);
assert(
  Object.isFrozen(verified)
    && Object.isFrozen(verified.boundary)
    && Object.isFrozen(verified.previousSourceObservationReceipt)
    && Object.isFrozen(verified.previousGraphObservationReceipt),
  "dependency-aware result is not deeply frozen"
);

expectCode(
  () => verifyContinuityResumeBoundary({
    ...boundary,
    observedAt: "2026-07-30T09:00:00.000Z"
  }),
  "INTEGRITY_MISMATCH"
);
const other = pair({ artifactId: "task_other" });
expectCode(
  () => verifyContinuityResumeBoundaryWithDependencies({
    boundary,
    previousSourceObservationReceipt: previous.source,
    previousGraphObservationReceipt: other.graph
  }),
  "DEPENDENCY_MISMATCH"
);

const exactPair = pair({
  artifactId: "\0".repeat(16_384),
  sourceId: "s".repeat(128),
  threadId: `${"\"".repeat(162)}${"t".repeat(350)}`
});
const exact = captureContinuityResumeBoundary({
  previousSourceObservationReceipt: exactPair.source,
  previousGraphObservationReceipt: exactPair.graph
});
assert(
  new TextEncoder().encode(JSON.stringify(exact)).byteLength === 100_000,
  "exact reachable fixture must serialize to 100,000 bytes"
);
const tooLarge = resign(exact, {
  scope: {
    sourceId: exact.scope.sourceId,
    threadId: `${"\"".repeat(163)}${"t".repeat(349)}`
  }
});
assert(
  new TextEncoder().encode(JSON.stringify(tooLarge)).byteLength === 100_001,
  "exact over-limit fixture must serialize to 100,001 bytes"
);
expectCode(() => verifyContinuityResumeBoundary(tooLarge), "BUDGET_EXCEEDED");

const alias = {
  sourceId: "default",
  threadId: "thread_resume",
  artifactId: "task_resume",
  artifactType: "task",
  providerId: "local",
  role: "next-step"
};
expectCode(
  () => verifyContinuityResumeBoundary({
    ...boundary,
    scope: alias,
    previousNextStep: alias
  }),
  "INVALID_RECEIPT"
);
const hostile = new Proxy({}, {
  ownKeys() {
    throw new Error("hostile secret");
  }
});
expectCode(() => captureContinuityResumeBoundary(hostile), "INVALID_INPUT");
expectCode(() => verifyContinuityResumeBoundary(hostile), "INVALID_RECEIPT");

const mutationA = resign(boundary, {
  graphSourceVersion: `sha256:${"1".repeat(64)}`
});
const mutationB = resign(boundary, {
  artifactId: "task_mutated"
});
assert(
  mutationA.boundaryId !== boundary.boundaryId
    && mutationB.boundaryId !== boundary.boundaryId
    && mutationA.boundaryId !== mutationB.boundaryId,
  "independent hash oracle is not mutation-sensitive"
);
assert(
  CONTINUITY_RESUME_BOUNDARY_LIMITS.maxReceiptBytes === 100_000
    && CONTINUITY_RESUME_BOUNDARY_LIMITS.maxArtifactIdBytes === 16_384
    && CONTINUITY_RESUME_BOUNDARY_LIMITS.maxThreadIdBytes === 512
    && CONTINUITY_RESUME_BOUNDARY_LIMITS.maxSourceIdCharacters === 128,
  "boundary limits drifted"
);

console.log("continuity resume boundary built probes passed");
