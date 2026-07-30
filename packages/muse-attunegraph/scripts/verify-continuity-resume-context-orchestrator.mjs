import {
  createLocalAttunementSnapshotProviderForTesting
} from "@muse/attunement/testing";
import { fingerprintContinuityTaskState } from "@muse/attunement";
import {
  captureScopedContinuitySourceObservation
} from "@muse/attunement/continuity-source-observations";

import {
  compileContinuityResumeContext,
  getContinuityResumeContextAudit
} from "../dist/continuity-resume-context-orchestrator.js";
import {
  captureContinuityResumeBoundary
} from "../dist/continuity-resume-boundary.js";
import {
  captureContinuityObservation
} from "../dist/continuity-observation.js";
import {
  compileHeadRevalidatedProviderBoundGraphEvidence
} from "../dist/provider-head-revalidated-graph-evidence.js";

const SOURCE_ID = "resume-orchestrator-verifier";
const THREAD_ID = "thread_resume_orchestrator_verifier";
const PREVIOUS_AT = "2026-07-30T03:00:00.000Z";
const CURRENT_AT = "2026-07-30T04:00:00.000Z";
const POLICY = Object.freeze({
  detail: "compact",
  nextStep: "direct",
  suppression: "none",
  version: 0
});
const NEXT_STEP = Object.freeze({
  artifactId: "task_resume_orchestrator_verifier",
  artifactType: "task",
  providerId: "local",
  role: "next-step"
});
const BUDGET = Object.freeze({
  maxAssertions: 32,
  maxConsideredAssertions: 256,
  maxDepth: 4,
  maxEstimatedTokens: 4096,
  maxOutputBytes: 262_144,
  maxVisitedRefs: 128
});

function invariant(condition, message) {
  if (!condition) {
    throw new Error(
      `continuity resume-context orchestrator verification failed: ${message}`
    );
  }
}

function state(title = "Resume orchestrator verifier") {
  return {
    deliveries: [],
    interactionReceipts: [],
    nextPolicyVersion: 1,
    resetReceipts: [],
    schemaVersion: 11,
    threads: [{
      createdAt: "2026-07-30T02:00:00.000Z",
      id: THREAD_ID,
      kind: "work",
      links: [{
        ...NEXT_STEP,
        linkedAt: "2026-07-30T02:30:00.000Z",
        linkedBy: "user",
        threadId: THREAD_ID
      }],
      policy: POLICY,
      title
    }],
    undoResetReceipts: []
  };
}

function pack() {
  const nextStep = {
    ...NEXT_STEP,
    taskStatus: "open",
    title: "Resume verifier task"
  };
  return {
    deliveryPolicyVersion: POLICY.version,
    evidence: [{
      artifact: nextStep,
      reference: NEXT_STEP,
      status: "available"
    }],
    evidenceRefs: [NEXT_STEP],
    interactionAnchor: {
      artifactId: NEXT_STEP.artifactId,
      linkedAt: "2026-07-30T02:30:00.000Z",
      observedStatus: "open",
      openStateFingerprint: fingerprintContinuityTaskState({
        artifactId: NEXT_STEP.artifactId,
        status: "open",
        updatedAt: ""
      }),
      providerId: "local",
      role: "next-step"
    },
    nextStep,
    policy: POLICY,
    thread: {
      id: THREAD_ID,
      kind: "work",
      title: "Resume orchestrator verifier"
    }
  };
}

function previous() {
  const scope = { sourceId: SOURCE_ID, threadId: THREAD_ID };
  const previousSourceObservationReceipt =
    captureScopedContinuitySourceObservation({
      observedAt: PREVIOUS_AT,
      pack: pack(),
      scope
    });
  const previousGraphObservationReceipt = captureContinuityObservation({
    scope,
    sourceObservedAt: PREVIOUS_AT,
    state: state()
  });
  return {
    boundary: captureContinuityResumeBoundary({
      previousSourceObservationReceipt,
      previousGraphObservationReceipt
    }),
    previousSourceObservationReceipt,
    previousGraphObservationReceipt
  };
}

async function providerEvidence(changed = false) {
  let reads = 0;
  let clocks = 0;
  const provider = createLocalAttunementSnapshotProviderForTesting(
    {
      attunementFile: "/configured/resume-orchestrator.json",
      sourceId: SOURCE_ID
    },
    {
      readState: async () => ({
        state: state(changed && reads++ > 0 ? "Changed head" : undefined),
        status: "available"
      }),
      clock: () => new Date(
        Date.parse(CURRENT_AT) + (clocks++ === 0 ? 0 : 25)
      )
    }
  );
  const artifact = await provider.captureHeadRevalidation(
    { sourceId: SOURCE_ID, threadId: THREAD_ID },
    { maxCaptureSpanMs: 25 }
  );
  return compileHeadRevalidatedProviderBoundGraphEvidence(artifact);
}

const hostileTraps = {
  get: 0,
  getOwnPropertyDescriptor: 0,
  getPrototypeOf: 0,
  ownKeys: 0
};
const hostile = new Proxy({}, {
  get() {
    hostileTraps.get++;
    throw new Error("provider get trap");
  },
  getOwnPropertyDescriptor() {
    hostileTraps.getOwnPropertyDescriptor++;
    throw new Error("provider descriptor trap");
  },
  getPrototypeOf() {
    hostileTraps.getPrototypeOf++;
    throw new Error("provider prototype trap");
  },
  ownKeys() {
    hostileTraps.ownKeys++;
    throw new Error("provider ownKeys trap");
  }
});
let hostileRejected = false;
try {
  compileContinuityResumeContext({
    schemaVersion: 1,
    boundary: {},
    previousSourceObservationReceipt: {},
    previousGraphObservationReceipt: {},
    currentProviderResult: hostile,
    budget: BUDGET
  });
} catch (error) {
  hostileRejected = error?.code === "INVALID_DEPENDENCY"
    && error?.details?.reason === "provider-result-not-process-minted";
}
invariant(hostileRejected, "hostile Provider must reject as unminted");
invariant(
  Object.values(hostileTraps).every((count) => count === 0),
  "hostile Provider traps must remain zero"
);

const stale = await providerEvidence(true);
let staleUndefinedRejected = false;
try {
  compileContinuityResumeContext({
    schemaVersion: 1,
    ...previous(),
    currentProviderResult: stale,
    currentSourceObservationReceipt: undefined,
    budget: BUDGET
  });
} catch (error) {
  staleUndefinedRejected = error?.code === "INVALID_INPUT"
    && error?.details?.reason === "current-source-must-be-absent";
}
invariant(staleUndefinedRejected, "stale present-as-undefined Source must reject");

const currentProviderResult = await providerEvidence();
const currentSourceObservationReceipt =
  captureScopedContinuitySourceObservation({
    observedAt: CURRENT_AT,
    pack: pack(),
    scope: { sourceId: SOURCE_ID, threadId: THREAD_ID }
  });
const result = compileContinuityResumeContext({
  schemaVersion: 1,
  ...previous(),
  currentProviderResult,
  currentSourceObservationReceipt,
  budget: BUDGET
});
invariant(result.status === "partial", "no-change must remain usable partial");
invariant(
  result.comparisonStatus === "no-change",
  "equal exact observations must compare no-change"
);
invariant(
  result.witnessStatus === "partial",
  "full budget must settle a partial witness"
);
invariant(
  Object.keys(result.agentContext).join(",")
    === "resumeContextFacts,supportingFacts,contextStream",
  "agent context must expose only semantic fields"
);
invariant(
  !/receiptId|sourceRefs|derivation|manifestId|nominationId|entryId/u
    .test(JSON.stringify(result.agentContext)),
  "agent context must remain provenance-free"
);
invariant(
  Object.getPrototypeOf(result) === null
    && Object.getPrototypeOf(result.agentContext) === null
    && Object.getPrototypeOf(result.agentContext.supportingFacts)
      === Array.prototype,
  "records and arrays must preserve canonical prototypes"
);
invariant(
  Object.isFrozen(result)
    && Object.isFrozen(result.agentContext)
    && Object.isFrozen(result.agentContext.supportingFacts),
  "outputs must be frozen"
);
const audit = getContinuityResumeContextAudit(result);
invariant(audit !== undefined, "exact usable result must retrieve audit");
invariant(
  Object.isFrozen(audit)
    && JSON.stringify(audit.currentSourceObservationReceipt)
      === JSON.stringify(currentSourceObservationReceipt)
    && audit.currentProviderResult === currentProviderResult
    && JSON.stringify(audit.currentGraphObservationReceipt)
      === JSON.stringify(currentProviderResult.graphObservationReceipt)
    && audit.reservation === result.reservation
    && audit.combinedCost === result.combinedCost,
  "audit must retain exact frozen orchestration dependencies"
);
invariant(
  !Object.hasOwn(result, "orchestrationEvidence")
    && !Object.keys(result).includes("currentGraphObservationReceipt"),
  "enumerable result must not expose raw orchestration evidence"
);
for (const copy of [
  { ...result },
  JSON.parse(JSON.stringify(result)),
  structuredClone(result),
  { result },
  new Proxy(result, {})
]) {
  invariant(
    getContinuityResumeContextAudit(copy) === undefined,
    "only the exact result object may retrieve audit"
  );
}
const auditTraps = { get: 0, getOwnPropertyDescriptor: 0, ownKeys: 0 };
const auditHostile = new Proxy({}, {
  get() {
    auditTraps.get++;
    throw new Error("audit get trap");
  },
  getOwnPropertyDescriptor() {
    auditTraps.getOwnPropertyDescriptor++;
    throw new Error("audit descriptor trap");
  },
  ownKeys() {
    auditTraps.ownKeys++;
    throw new Error("audit keys trap");
  }
});
const auditRevoked = Proxy.revocable({}, {});
auditRevoked.revoke();
for (const value of [null, undefined, auditHostile, auditRevoked.proxy]) {
  invariant(
    getContinuityResumeContextAudit(value) === undefined,
    "non-exact values must not retrieve audit"
  );
}
invariant(
  Object.values(auditTraps).every((count) => count === 0),
  "audit lookup must trigger zero hostile or revoked Proxy traps"
);
invariant(
  audit.frontier.receipt.metrics
    .settlementInvocations >= 1,
  "single top-level settlement must retain internal trial metrics"
);

console.log("continuity resume-context orchestrator verification passed");
