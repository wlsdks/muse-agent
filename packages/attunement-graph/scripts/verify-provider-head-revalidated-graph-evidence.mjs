import {
  createLocalAttunementSnapshotProviderForTesting
} from "../../attunement/dist/local-attunement-snapshot-provider.js";
import {
  compileHeadRevalidatedProviderBoundGraphEvidence,
  isProcessMintedProviderHeadRevalidatedGraphEvidence,
  verifyProviderHeadRevalidatedGraphBindingReceipt
} from "../dist/provider-head-revalidated-graph-evidence.js";
import {
  canonicalizeImmutableEnvelope
} from "../dist/canonical-immutable-envelope.js";

const SUBJECT_AT = "2026-07-30T00:00:00.000Z";
const SCOPE = Object.freeze({
  sourceId: "provider-head-verifier",
  threadId: "thread_provider_head_verifier"
});
const RECEIPT_SPEC = Object.freeze({
  hashDomain:
    "muse.attunement-graph.provider-head-revalidated-graph-evidence-receipt.v1",
  idField: "receiptId",
  idPrefix: "muse-provider-head-revalidated-graph-evidence:sha256:"
});

function invariant(condition, message) {
  if (!condition) {
    throw new Error(
      `provider head-revalidated graph evidence verification failed: ${message}`
    );
  }
}

function nominationMutation(receipt, change, support) {
  const body = JSON.parse(JSON.stringify(receipt));
  delete body.receiptId;
  body.nominations = {
    core: 1,
    change,
    support,
    omitted: 0,
    omittedAssertionIdsDigest: null
  };
  return JSON.parse(JSON.stringify(
    canonicalizeImmutableEnvelope(
      body,
      "external-mutable",
      RECEIPT_SPEC
    ).envelope
  ));
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
  isProcessMintedProviderHeadRevalidatedGraphEvidence(fresh.evidence),
  "fresh exact result must be process minted"
);
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
invariant(
  verifyProviderHeadRevalidatedGraphBindingReceipt(
    nominationMutation(fresh.evidence.receipt, 128, 127)
  ).nominations.change === 128,
  "255 retained optionals must verify"
);
let nominationOverflowRejected = false;
try {
  verifyProviderHeadRevalidatedGraphBindingReceipt(
    nominationMutation(fresh.evidence.receipt, 128, 128)
  );
} catch {
  nominationOverflowRejected = true;
}
invariant(nominationOverflowRejected, "256 retained optionals must reject");

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
invariant(
  isProcessMintedProviderHeadRevalidatedGraphEvidence(changed.evidence),
  "changed exact result must be process minted"
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
invariant(
  isProcessMintedProviderHeadRevalidatedGraphEvidence(exceeded.evidence),
  "span exact result must be process minted"
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
invariant(
  isProcessMintedProviderHeadRevalidatedGraphEvidence(
    headUnavailable.evidence
  ),
  "head unavailable exact result must be process minted"
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
invariant(
  isProcessMintedProviderHeadRevalidatedGraphEvidence(
    subjectUnavailable.evidence
  ),
  "subject unavailable exact result must be process minted"
);

const trapCounts = {
  get: 0,
  getOwnPropertyDescriptor: 0,
  getPrototypeOf: 0,
  ownKeys: 0
};
const hostile = new Proxy(fresh.evidence, {
  get() {
    trapCounts.get++;
    throw new Error("get trap must not run");
  },
  getOwnPropertyDescriptor() {
    trapCounts.getOwnPropertyDescriptor++;
    throw new Error("descriptor trap must not run");
  },
  getPrototypeOf() {
    trapCounts.getPrototypeOf++;
    throw new Error("prototype trap must not run");
  },
  ownKeys() {
    trapCounts.ownKeys++;
    throw new Error("ownKeys trap must not run");
  }
});
const revoked = Proxy.revocable(fresh.evidence, {});
revoked.revoke();
const mintForgeries = [
  null,
  undefined,
  false,
  0,
  "",
  Symbol("forgery"),
  { ...fresh.evidence },
  JSON.parse(JSON.stringify(fresh.evidence)),
  structuredClone(fresh.evidence),
  Object.assign(Object.create(null), fresh.evidence),
  Object.create(fresh.evidence),
  {
    receipt: fresh.evidence.receipt,
    stage: fresh.evidence.stage,
    status: fresh.evidence.status
  },
  new Proxy(fresh.evidence, {}),
  hostile,
  revoked.proxy
];
for (const forgery of mintForgeries) {
  let accepted;
  try {
    accepted = isProcessMintedProviderHeadRevalidatedGraphEvidence(forgery);
  } catch {
    throw new Error(
      "provider head-revalidated graph evidence verification failed: mint predicate must be total"
    );
  }
  invariant(!accepted, "copies, wrappers, and proxies must not be minted");
}
invariant(
  Object.values(trapCounts).every((count) => count === 0),
  "hostile Proxy traps must remain at zero"
);

const beforeJson = JSON.stringify(fresh.evidence);
const beforeReceiptId = fresh.evidence.receipt.receiptId;
const beforePrototype = Reflect.getPrototypeOf(fresh.evidence);
const beforeDescriptors =
  Reflect.ownKeys(fresh.evidence).map((key) => [
    key,
    Reflect.getOwnPropertyDescriptor(fresh.evidence, key)
  ]);
const beforeFrozen = Object.isFrozen(fresh.evidence);
invariant(
  isProcessMintedProviderHeadRevalidatedGraphEvidence(fresh.evidence),
  "exact result must remain minted"
);
invariant(JSON.stringify(fresh.evidence) === beforeJson, "JSON bytes changed");
invariant(
  fresh.evidence.receipt.receiptId === beforeReceiptId,
  "receipt ID changed"
);
invariant(
  Reflect.getPrototypeOf(fresh.evidence) === beforePrototype,
  "result prototype changed"
);
invariant(
  Object.isFrozen(fresh.evidence) === beforeFrozen,
  "result frozen state changed"
);
for (const [key, descriptor] of beforeDescriptors) {
  const after = Reflect.getOwnPropertyDescriptor(fresh.evidence, key);
  invariant(
    after?.configurable === descriptor.configurable
      && after?.enumerable === descriptor.enumerable
      && after?.value === descriptor.value
      && after?.writable === descriptor.writable,
    "result descriptor or nested identity changed"
  );
}

const poisonProvider = provider(
  [
    { state: state(), status: "available" },
    { state: state(), status: "available" }
  ],
  [SUBJECT_AT, "2026-07-30T00:00:00.025Z"]
);
const poisonArtifact = await poisonProvider.captureHeadRevalidation(
  SCOPE,
  { maxCaptureSpanMs: 25 }
);
const originalWeakSetAdd = WeakSet.prototype.add;
const originalWeakSetHas = WeakSet.prototype.has;
const forgedResult = {};
let poisonForgeryAccepted;
let poisonExactAccepted;
try {
  WeakSet.prototype.add = function poisonedAdd(value) {
    if (
      value?.receipt?.receiptVersion
        === "muse.provider-head-revalidated-graph-evidence-receipt.v1"
      && value.revalidationReceipt !== undefined
    ) {
      return this;
    }
    return originalWeakSetAdd.call(this, value);
  };
  WeakSet.prototype.has = function poisonedHas(value) {
    return value === forgedResult || originalWeakSetHas.call(this, value);
  };
  poisonForgeryAccepted =
    isProcessMintedProviderHeadRevalidatedGraphEvidence(forgedResult);
  const poisonedResult =
    await compileHeadRevalidatedProviderBoundGraphEvidence(poisonArtifact);
  poisonExactAccepted =
    isProcessMintedProviderHeadRevalidatedGraphEvidence(poisonedResult);
} finally {
  WeakSet.prototype.add = originalWeakSetAdd;
  WeakSet.prototype.has = originalWeakSetHas;
}
invariant(!poisonForgeryAccepted, "poisoned has accepted forgery");
invariant(poisonExactAccepted, "poisoned add prevented exact mint");
invariant(
  WeakSet.prototype.add === originalWeakSetAdd
    && WeakSet.prototype.has === originalWeakSetHas,
  "WeakSet prototype methods were not restored"
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
