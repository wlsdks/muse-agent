import {
  captureContinuityObservation,
  sealContinuityObservation,
  verifyContinuityObservation
} from "../dist/continuity-observation.js";
import {
  continuityThreadGraphRef,
  projectContinuityState
} from "../dist/continuity-projection.js";
import { stdout } from "node:process";
import {
  compileReceiptBoundGraphEvidence
} from "../dist/receipt-bound-graph-evidence.js";

function fail(message) {
  throw new Error(`receipt-bound graph evidence verification failed: ${message}`);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function assertDeepFrozen(value, path = "$", seen = new Set()) {
  if (value === null || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  assert(Object.isFrozen(value), `${path} must be frozen`);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    assert(descriptor !== undefined && "value" in descriptor, `${path} must use data properties`);
    assertDeepFrozen(descriptor.value, `${path}/${String(key)}`, seen);
  }
}

const observedAt = "2026-07-29T10:00:00.000Z";
const scope = {
  sourceId: "controlled-fixture",
  threadId: "thread_receipt_bound_controlled"
};
const state = {
  deliveries: [],
  interactionReceipts: [],
  nextPolicyVersion: 1,
  resetReceipts: [],
  schemaVersion: 11,
  threads: [{
    createdAt: "2026-07-29T09:00:00.000Z",
    id: scope.threadId,
    kind: "work",
    links: [{
      artifactId: "task_receipt_bound",
      artifactType: "task",
      linkedAt: "2026-07-29T09:05:00.000Z",
      linkedBy: "user",
      providerId: "local",
      role: "next-step",
      threadId: scope.threadId
    }],
    policy: {
      detail: "compact",
      nextStep: "direct",
      suppression: "none",
      version: 0
    },
    title: "Resume private planning"
  }],
  undoResetReceipts: []
};

const projection = projectContinuityState({ scope, sourceObservedAt: observedAt, state });
const captured = captureContinuityObservation({ scope, sourceObservedAt: observedAt, state });
const observation = verifyContinuityObservation(sealContinuityObservation({
  authority: "caller-declared-observation",
  diagnostics: captured.diagnostics,
  observedAt,
  projection,
  schemaVersion: 1
}));
assert(
  observation.projection.projectionVersion === captured.projection.projectionVersion,
  "sealed observation must preserve the controlled projection"
);

const core = observation.projection.assertions.find((assertion) =>
  assertion.predicate === "NEXT_STEP_FOR"
);
assert(core !== undefined, "controlled observation must project a next-step assertion");

const result = await compileReceiptBoundGraphEvidence({
  currentGraphObservationReceipt: JSON.parse(JSON.stringify(observation)),
  declaredFreshness: { assessedAt: observedAt, observedAt, status: "fresh" },
  legacyBudget: {
    maxAssertions: 16,
    maxConsideredAssertions: 16,
    maxDepth: 2,
    maxEstimatedTokens: 1024,
    maxOutputBytes: 16384,
    maxVisitedRefs: 64
  },
  nominations: {
    core: { assertionId: core.id, nominationId: "core", role: "core" },
    optionals: []
  },
  operatorVersion: "muse.receipt-bound-graph-evidence.v1",
  recordedAtOrBefore: observedAt,
  schemaVersion: 1,
  scope,
  snapshot: {
    authority: "caller-declared-read-snapshot",
    commitHash: `sha256:${"a".repeat(64)}`,
    commitSequence: 1,
    generationId: "controlled-fixture"
  }
});

const expectedSeed = continuityThreadGraphRef(scope);
assert(sameJson(result.receipt.actualSeed, expectedSeed), "receipt must link the derived seed");
assert(
  result.receipt.actualSeed.id !== scope.threadId,
  "derived seed must remain opaque rather than expose the raw thread ID"
);
assert(
  result.receipt.activationEvidenceId === result.activationEvidence.evidenceId,
  "receipt must contain exactly the linked activation evidence ID"
);
assert(
  result.receipt.sourceObservationReceiptId === observation.receiptId,
  "receipt must link its verified source observation"
);
assert(
  result.receipt.sourceProjectionVersion === observation.projection.projectionVersion,
  "receipt must link its verified projection version"
);
assert(
  result.receipt.legacyWitnessReceiptId === result.legacyCompilation.receipt.receiptId,
  "receipt must link the legacy witness receipt"
);
assert(
  result.receipt.status === result.legacyCompilation.status
    && result.receipt.coverage.status === result.receipt.status,
  "receipt and coverage status must agree with legacy compilation"
);
assert(result.receipt.authority === "receipt-integrity-only", "receipt must not claim source authority");
assert(
  result.receipt.coverage.canAssertAbsenceWithinSnapshot === false
    && result.receipt.coverage.canAssertCurrentWorldAbsence === false,
  "receipt coverage must not make absence-authority claims"
);
assertDeepFrozen(result);

stdout.write("PASS receipt-bound graph evidence verifier\n");
