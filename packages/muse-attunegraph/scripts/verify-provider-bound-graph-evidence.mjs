import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stdout } from "node:process";

import {
  createLocalAttunementSnapshotProvider
} from "@muse/attunement/testing";
import {
  compileProviderBoundGraphEvidence,
  verifyProviderGraphBindingReceipt
} from "../dist/provider-bound-graph-evidence.js";

const AT = "2026-07-30T00:00:00.000Z";
const SOURCE_ID = "provider-graph-verifier";
const THREAD_ID = "thread_provider_graph_verifier";
const CANARY = "PRIVATE_PROVIDER_GRAPH_VERIFIER_CANARY_91d2";

function assert(condition, message) {
  if (!condition) {
    throw new Error(`provider-bound graph evidence verification failed: ${message}`);
  }
}

function assertDeepFrozen(value, path = "$", seen = new Set()) {
  if (value === null || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  assert(Object.isFrozen(value), `${path} must be frozen`);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    assert(
      descriptor !== undefined && "value" in descriptor,
      `${path}/${String(key)} must be a data property`
    );
    assertDeepFrozen(descriptor.value, `${path}/${String(key)}`, seen);
  }
}

function state() {
  return {
    deliveries: [],
    interactionReceipts: [],
    nextPolicyVersion: 1,
    resetReceipts: [],
    schemaVersion: 11,
    threads: [{
      createdAt: "2026-07-29T23:00:00.000Z",
      id: THREAD_ID,
      kind: "work",
      links: [],
      policy: {
        detail: "compact",
        nextStep: "direct",
        suppression: "none",
        version: 0
      },
      title: CANARY
    }],
    undoResetReceipts: []
  };
}

const directory = await mkdtemp(
  join(tmpdir(), "muse-attunegraph-provider-graph-verifier-")
);
const attunementFile = join(directory, "attunement.json");

try {
  await writeFile(attunementFile, `${JSON.stringify(state())}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
  const provider = createLocalAttunementSnapshotProvider({
    attunementFile,
    clock: () => new Date(AT),
    sourceId: SOURCE_ID
  });
  const capture = await provider.capture({
    sourceId: SOURCE_ID,
    threadId: THREAD_ID
  });
  assert(capture.status === "available", "fixture capture must be available");
  const result = await compileProviderBoundGraphEvidence(capture);
  assert(result.stage === "graph-evidence", "available capture must reach graph evidence");
  assert(result.status === "abstained", "unassessed capture must abstain");
  if (result.stage !== "graph-evidence" || capture.status !== "available") {
    throw new Error("graph-stage result required");
  }
  assert(
    result.receipt.providerReceiptId === capture.receipt.receiptId,
    "binding receipt must bind Provider receipt"
  );
  assert(
    result.receipt.graphObservationReceiptId
      === result.graphObservationReceipt.receiptId,
    "binding receipt must bind Observation receipt"
  );
  assert(
    result.receipt.graphEvidenceReceiptId
      === result.graphEvidence.receipt.receiptId,
    "binding receipt must bind Graph evidence receipt"
  );
  assert(
    result.receipt.snapshot.authority === "receipt-integrity-only"
      && result.receipt.snapshot.kind
        === "process-local-provider-capture"
      && !Object.hasOwn(result.receipt.snapshot, "commitHash")
      && !Object.hasOwn(result.receipt.snapshot, "generationId"),
    "Provider provenance must not invent Graph commits or generations"
  );
  assert(
    result.receipt.declaredFreshness.status === "unassessed",
    "freshness must remain unassessed"
  );
  assert(
    result.receipt.coverage.canAssertAbsenceWithinSnapshot === false
      && result.receipt.coverage.canAssertCurrentWorldAbsence === false
      && result.receipt.coverage.canAssertFreshness === false
      && result.receipt.coverage.canAssertDurableProviderAuthority === false,
    "binding receipt must retain all authority refusals"
  );
  assert(
    result.graphEvidence.receipt.coverage.reasons.includes(
      "source-authority-unverified"
    )
      && result.graphEvidence.receipt.coverage.reasons.includes(
        "freshness-unassessed"
      ),
    "Graph receipt must retain source and freshness uncertainty"
  );
  assert(
    result.graphEvidence.receipt.actualSeed.id !== THREAD_ID
      && !result.graphEvidence.receipt.actualSeed.id.includes(THREAD_ID),
    "thread seed must remain opaque"
  );
  assert(
    !JSON.stringify(result).includes(CANARY),
    "private state canary must not enter Graph artifacts"
  );
  assertDeepFrozen(result);
  const verified = verifyProviderGraphBindingReceipt(
    JSON.parse(JSON.stringify(result.receipt))
  );
  assert(
    verified.receiptId === result.receipt.receiptId,
    "serialized receipt must retain integrity only"
  );

  const unavailable = await provider.capture({
    sourceId: SOURCE_ID,
    threadId: "missing_thread"
  });
  const abstained = await compileProviderBoundGraphEvidence(unavailable);
  assert(
    abstained.stage === "provider"
      && abstained.status === "abstained",
    "missing scope must stop at Provider abstention"
  );
  try {
    await import("@muse/attunegraph");
    assert(false, "integration root must not resolve");
  } catch (error) {
    assert(
      error && typeof error === "object" && error.code === "ERR_PACKAGE_PATH_NOT_EXPORTED",
      "integration root must be blocked by the export map"
    );
  }
} finally {
  await rm(directory, { force: true, recursive: true });
}

stdout.write("PASS provider-bound graph evidence verifier\n");
