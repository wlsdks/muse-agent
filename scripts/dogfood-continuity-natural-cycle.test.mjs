import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  invokePublicContinueOnce,
  runContinuityNaturalCollectionCycle,
  validateContinuityNaturalCollectionArtifact
} from "./dogfood-continuity-natural-cycle.mjs";

const openedAt = "2026-07-18T08:00:00.000Z";
const task = {
  createdAt: "2026-07-18T07:00:00.000Z",
  id: "task_private",
  status: "open",
  title: "Private task title"
};
const link = {
  artifactId: task.id,
  artifactType: "task",
  linkedAt: "2026-07-18T07:30:00.000Z",
  linkedBy: "user",
  providerId: "local",
  role: "next-step",
  threadId: "thread_private"
};

function normalizedState(raw) {
  return { ...raw, interactionReceipts: raw.interactionReceipts ?? [], schemaVersion: 2 };
}

function preparedDelivery({ id = "delivery_private", outcome, runId = "run_private" } = {}) {
  const openStateFingerprint = createHash("sha256").update(JSON.stringify({
    artifactId: task.id,
    status: "open",
    updatedAt: task.createdAt
  })).digest("hex");
  return {
    evidenceRefs: [{ artifactId: task.id, artifactType: "task", providerId: "local", role: "next-step" }],
    id,
    interactionAnchor: {
      artifactId: task.id,
      linkedAt: link.linkedAt,
      observedAt: openedAt,
      observedStatus: "open",
      openStateFingerprint,
      providerId: "local",
      role: "next-step"
    },
    openedAt,
    ...(outcome ? { outcome } : {}),
    policyVersion: 0,
    runId,
    threadId: link.threadId
  };
}

function expectedArtifact() {
  return {
    after: { deliveries: 1, exactInteractions: 0, noneInteractions: 1 },
    before: { deliveries: 0, exactInteractions: 0, noneInteractions: 0 },
    classification: "actual-local-collection-start",
    commandAttempts: 1,
    commandSucceeded: true,
    delta: { deliveries: 1 },
    invariants: {
      canonicalStructuralDiff: true,
      freshPreflight: true,
      newDeliveryIsOpenNone: true,
      noPermissionExpansion: true,
      outboxBytesUnchanged: true,
      outboxExistenceUnchanged: true,
      tasksBytesUnchanged: true,
      uniqueUserLinkedCandidate: true
    },
    naturalLongitudinalEvidence: false,
    permissionExpansion: false,
    schema: "muse.continuity-natural-collection-start/v1",
    syntheticDataUsed: false
  };
}

async function fixture({
  existingOutcomeBearingDelivery = false,
  extraAttunementField = false,
  failAfterWrite = false,
  failBeforeWrite = false
} = {}) {
  const dir = await mkdtemp(join(tmpdir(), "muse-natural-cycle-"));
  const attunementFile = join(dir, "attunement.json");
  const tasksFile = join(dir, "tasks.json");
  const outboxFile = join(dir, "attunement.interaction-outbox.json");
  await writeFile(tasksFile, JSON.stringify({ tasks: [task] }));
  await writeFile(attunementFile, JSON.stringify({
    ...(extraAttunementField ? { legacyPrivatePayload: "must not be silently discarded" } : {}),
    deliveries: existingOutcomeBearingDelivery ? [preparedDelivery({
      id: "delivery_existing",
      outcome: { outcome: "used", policyVersion: 1, recordedAt: "2026-07-18T08:30:00.000Z" },
      runId: "run_existing"
    })] : [],
    nextPolicyVersion: 1,
    resetReceipts: [],
    schemaVersion: 1,
    threads: [{
      createdAt: "2026-07-18T07:00:00.000Z",
      id: link.threadId,
      kind: "work",
      links: [link],
      policy: { detail: "standard", nextStep: "direct", suppression: "none", version: 0 },
      title: "Private thread title"
    }],
    undoResetReceipts: []
  }));

  let invocations = 0;
  const runtime = {
    buildReport: async (state) => ({
      audit: {
        byThreadKind: {
          life: { distinctUtcOpenedDates: 0, distinctUtcOpenedDatesTarget: 2, exactInteractions: 0, exactInteractionsTarget: 10, remainingDates: 2, remainingExactInteractions: 10 },
          work: { distinctUtcOpenedDates: 0, distinctUtcOpenedDatesTarget: 2, exactInteractions: 0, exactInteractionsTarget: 10, remainingDates: 2, remainingExactInteractions: 10 }
        },
        reason: "collect",
        status: "collecting"
      },
      digest: {
        byThreadKind: {},
        overall: { states: { exact: { count: 0 }, none: { count: state.deliveries.length }, unavailable: { count: 0 } }, totalDeliveries: state.deliveries.length }
      },
      interactions: state.deliveries.map((delivery) => ({
        deliveryId: delivery.id,
        interaction: { state: "none" },
        openedAt: delivery.openedAt,
        runId: delivery.runId,
        threadId: delivery.threadId,
        threadKind: "work"
      })),
      schemaVersion: 1
    }),
    invokeContinue: async () => {
      invocations += 1;
      if (failBeforeWrite) throw new Error("boundary failed before write");
      const raw = JSON.parse(await readFile(attunementFile, "utf8"));
      await writeFile(attunementFile, JSON.stringify({
        ...raw,
        deliveries: [...raw.deliveries, preparedDelivery()],
        interactionReceipts: [],
        schemaVersion: 2
      }));
      if (failAfterWrite) throw new Error("ambiguous boundary failure");
    },
    readAttunementState: async () => normalizedState(JSON.parse(await readFile(attunementFile, "utf8"))),
    readTasks: async () => JSON.parse(await readFile(tasksFile, "utf8")).tasks
  };
  return {
    dir,
    files: { attunementFile, outboxFile, tasksFile },
    invocations: () => invocations,
    readPersisted: async () => JSON.parse(await readFile(attunementFile, "utf8")),
    runtime
  };
}

test("one public continue opens one aggregate-only collection cycle without changing tasks or outbox", async () => {
  const f = await fixture();
  const artifact = await runContinuityNaturalCollectionCycle({ files: f.files, runtime: f.runtime });

  assert.equal(f.invocations(), 1);
  assert.deepEqual(artifact, expectedArtifact());
  const serialized = JSON.stringify(artifact);
  for (const secret of [task.id, task.title, link.threadId, "delivery_private", "run_private", openedAt, f.dir]) {
    assert.equal(serialized.includes(secret), false);
  }
  await assert.rejects(
    runContinuityNaturalCollectionCycle({ files: f.files, runtime: f.runtime }),
    /receipt-incomplete collection delivery already exists/iu
  );
  assert.equal(f.invocations(), 1);
});

test("an ambiguous command failure inspects post-state once and never retries", async () => {
  const f = await fixture({ failAfterWrite: true });
  await assert.rejects(
    runContinuityNaturalCollectionCycle({ files: f.files, runtime: f.runtime }),
    /post-state applied=true; no retry was attempted/iu
  );
  assert.equal(f.invocations(), 1);
  assert.equal((await f.readPersisted()).deliveries.length, 1);
});

test("aggregate artifact rejects unknown fields that could leak local evidence", () => {
  assert.throws(
    () => validateContinuityNaturalCollectionArtifact({ ...expectedArtifact(), notes: "secret local context" }),
    /unexpected aggregate artifact field/iu
  );
  const artifact = expectedArtifact();
  assert.throws(
    () => validateContinuityNaturalCollectionArtifact({
      ...artifact,
      after: { ...artifact.after, exactInteractions: 1 }
    }),
    /aggregate counts do not describe one none collection start/iu
  );
});

test("unexpected persisted fields stop the cycle before the public command", async () => {
  const f = await fixture({ extraAttunementField: true });
  await assert.rejects(
    runContinuityNaturalCollectionCycle({ files: f.files, runtime: f.runtime }),
    /unexpected persisted attunement field/iu
  );
  assert.equal(f.invocations(), 0);
});

test("source drift between preflight snapshots stops before the public command", async () => {
  const f = await fixture();
  const readState = f.runtime.readAttunementState;
  let reads = 0;
  f.runtime.readAttunementState = async () => {
    const state = await readState();
    reads += 1;
    if (reads === 1) {
      await writeFile(f.files.tasksFile, `${await readFile(f.files.tasksFile, "utf8")}\n`);
    }
    return state;
  };
  await assert.rejects(
    runContinuityNaturalCollectionCycle({ files: f.files, runtime: f.runtime }),
    /sources drifted during the preflight/iu
  );
  assert.equal(f.invocations(), 0);
});

test("an outcome-bearing same-anchor delivery still blocks duplicate collection", async () => {
  const f = await fixture({ existingOutcomeBearingDelivery: true });
  await assert.rejects(
    runContinuityNaturalCollectionCycle({ files: f.files, runtime: f.runtime }),
    /receipt-incomplete collection delivery already exists/iu
  );
  assert.equal(f.invocations(), 0);
  assert.equal((await f.readPersisted()).deliveries.length, 1);
});

test("nonzero or timeout boundary failures never retry or write", async () => {
  for (const failure of ["nonzero", "timeout"]) {
    const f = await fixture({ failBeforeWrite: true });
    await assert.rejects(
      runContinuityNaturalCollectionCycle({ files: f.files, runtime: f.runtime }),
      /post-state applied=false; no retry was attempted/iu,
      failure
    );
    assert.equal(f.invocations(), 1, failure);
    assert.equal((await f.readPersisted()).deliveries.length, 0, failure);
  }
});

test("the default public boundary rejects distinct nonzero and timeout results after one spawn", async () => {
  for (const result of [
    { error: undefined, signal: null, status: 1 },
    { error: Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }), signal: "SIGTERM", status: null }
  ]) {
    let spawns = 0;
    assert.throws(
      () => invokePublicContinueOnce({
        env: {},
        spawn: () => {
          spawns += 1;
          return result;
        },
        threadId: "thread_private"
      }),
      /public continue command did not finish successfully/iu
    );
    assert.equal(spawns, 1);
  }
});
