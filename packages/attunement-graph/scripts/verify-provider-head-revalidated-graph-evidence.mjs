import {
  createLocalAttunementSnapshotProviderForTesting
} from "../../attunement/dist/local-attunement-snapshot-provider.js";
import {
  compileHeadRevalidatedProviderBoundGraphEvidence
} from "../dist/provider-head-revalidated-graph-evidence.js";

const SUBJECT_AT = "2026-07-30T00:00:00.000Z";
const SCOPE = Object.freeze({
  sourceId: "provider-head-verifier",
  threadId: "thread_provider_head_verifier"
});

function invariant(condition, message) {
  if (!condition) {
    throw new Error(
      `provider head-revalidated graph evidence verification failed: ${message}`
    );
  }
}

function state(title = "Private verifier canary") {
  return {
    deliveries: [],
    interactionReceipts: [],
    nextPolicyVersion: 1,
    resetReceipts: [],
    schemaVersion: 11,
    threads: [{
      createdAt: "2026-07-29T23:00:00.000Z",
      id: SCOPE.threadId,
      kind: "work",
      links: [],
      policy: {
        detail: "compact",
        nextStep: "direct",
        suppression: "none",
        version: 0
      },
      title
    }],
    undoResetReceipts: []
  };
}

function provider(reads, times) {
  let readIndex = 0;
  let clockIndex = 0;
  return createLocalAttunementSnapshotProviderForTesting(
    {
      attunementFile: "/configured/private-attunement.json",
      sourceId: SCOPE.sourceId
    },
    {
      readState: async () =>
        reads[readIndex++] ?? { status: "missing" },
      clock: () => new Date(times[clockIndex++] ?? times.at(-1))
    }
  );
}

async function compose(reads, times, maxCaptureSpanMs = 25) {
  const source = provider(reads, times);
  const artifact = await source.captureHeadRevalidation(
    SCOPE,
    { maxCaptureSpanMs }
  );
  return {
    artifact,
    evidence:
      await compileHeadRevalidatedProviderBoundGraphEvidence(artifact)
  };
}

const fresh = await compose(
  [
    { state: state(), status: "available" },
    { state: state(), status: "available" }
  ],
  [SUBJECT_AT, "2026-07-30T00:00:00.025Z"]
);
invariant(fresh.evidence.status === "partial", "fresh must settle partial");
invariant(
  fresh.evidence.receipt.canAssertFreshAtAssessment === true,
  "fresh assessment flag"
);
invariant(
  fresh.evidence.receipt.canAssertAbsenceWithinSnapshot === false
  && fresh.evidence.receipt.canAssertCurrentWorldAbsence === false
  && fresh.evidence.receipt.canAssertDurableProviderAuthority === false,
  "false-continuity authority claims"
);

const changed = await compose(
  [
    { state: state(), status: "available" },
    { state: state("Changed"), status: "available" }
  ],
  [SUBJECT_AT, "2026-07-30T00:00:00.025Z"]
);
invariant(changed.evidence.status === "stale", "changed must be stale");
invariant(
  changed.evidence.receipt.providerFreshness.reason
    === "head-state-changed",
  "changed reason"
);
invariant(
  !Object.hasOwn(changed.evidence, "graphEvidence"),
  "changed must not compile Graph"
);

const exceeded = await compose(
  [
    { state: state(), status: "available" },
    { state: state(), status: "available" }
  ],
  [SUBJECT_AT, "2026-07-30T00:00:00.026Z"]
);
invariant(
  exceeded.evidence.receipt.providerFreshness.reason
    === "capture-span-exceeded",
  "span reason"
);
invariant(
  !Object.hasOwn(exceeded.evidence, "graphEvidence"),
  "span must not compile Graph"
);

const headUnavailable = await compose(
  [
    { state: state(), status: "available" },
    { status: "missing" }
  ],
  [SUBJECT_AT, "2026-07-30T00:00:00.025Z"]
);
invariant(
  headUnavailable.evidence.status === "abstained"
  && headUnavailable.evidence.stage === "revalidation",
  "head unavailable classification"
);
invariant(
  headUnavailable.artifact.receipt.mintVerification
    === "provider-owned-two-capture-pair-verified-in-composing-process",
  "head unavailable pair mint wording"
);

const subjectUnavailable = await compose(
  [{ status: "missing" }],
  [SUBJECT_AT]
);
invariant(
  subjectUnavailable.evidence.status === "abstained"
  && subjectUnavailable.evidence.stage === "provider",
  "subject unavailable classification"
);
invariant(
  subjectUnavailable.artifact.receipt.mintVerification
    === "provider-owned-revalidation-artifact-verified-in-composing-process",
  "subject unavailable one-read mint wording"
);

let cloneRejected = false;
try {
  await compileHeadRevalidatedProviderBoundGraphEvidence(
    JSON.parse(JSON.stringify(fresh.artifact))
  );
} catch {
  cloneRejected = true;
}
invariant(cloneRejected, "serialized artifact must be rejected");

process.stdout.write(
  "PASS provider head-revalidated graph evidence verifier\n"
);
