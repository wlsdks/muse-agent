import { lstat, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stdout } from "node:process";

import { openLocalAttuneGraph } from "@attunegraph/core/local";
import {
  ContinuityAttuneGraphProjectionError,
  createContinuityAttuneGraphProjector
} from "@muse/attunegraph/continuity-durable-projection";
import {
  captureContinuityObservation
} from "@muse/attunegraph/continuity-observations";

const SOURCE_ID = "muse.local-attunement";
const THREAD_ID = "thread_durable_verifier";
const FIRST_AT = "2026-07-31T03:00:00.000Z";
const SECOND_AT = "2026-07-31T04:00:00.000Z";

function check(condition, message) {
  if (!condition) {
    throw new Error(`Continuity durable projection verification failed: ${message}`);
  }
}

function state(version) {
  const links = version === 1
    ? []
    : [{
        artifactId: "artifact_durable_verifier",
        artifactType: "resource",
        linkedAt: SECOND_AT,
        linkedBy: "user",
        providerId: "mcp:verifier-provider",
        role: "context",
        threadId: THREAD_ID
      }];
  return {
    deliveries: [],
    experienceLearningPolicyAudits: [],
    interactionReceipts: [],
    nextPolicyVersion: 1,
    resetReceipts: [],
    schemaVersion: 12,
    threads: [{
      createdAt: "2026-07-30T00:00:00.000Z",
      id: THREAD_ID,
      kind: "work",
      links,
      policy: {
        detail: "compact",
        nextStep: "direct",
        suppression: "none",
        version: 0
      },
      title: "private verifier title"
    }],
    undoResetReceipts: []
  };
}

function receipt(observedAt, version) {
  return captureContinuityObservation({
    scope: { sourceId: SOURCE_ID, threadId: THREAD_ID },
    sourceObservedAt: observedAt,
    state: state(version)
  });
}

const directory = await realpath(
  await mkdtemp(join(tmpdir(), "muse-continuity-attunegraph-verifier-"))
);
const databasePath = join(directory, "attunegraph.sqlite");
let verificationMode = "projection";

try {
  const firstReceipt = receipt(FIRST_AT, 1);
  const firstProjector = createContinuityAttuneGraphProjector({ databasePath });
  let first;
  try {
    first = await firstProjector.project(firstReceipt);
  } catch (error) {
    const cause = error instanceof Error ? error.cause : undefined;
    const unsupportedProfile = error instanceof ContinuityAttuneGraphProjectionError
      && error.code === "PROJECTION_FAILED"
      && cause !== null
      && typeof cause === "object"
      && cause.code === "UNSUPPORTED_STORE_PROFILE";
    if (!unsupportedProfile) throw error;
    verificationMode = "unsupported-profile";
    const databaseExists = await lstat(databasePath).then(
      () => true,
      () => false
    );
    check(!databaseExists, "unsupported profile rejection must not create a database");
  }

  if (verificationMode === "projection") {
    const replay = await firstProjector.project(firstReceipt);
    check(first?.status === "projected" && first.snapshot.generation === 1,
      "first projection must create generation one");
    check(replay.status === "replayed" && replay.snapshot.generation === 1,
      "same-process replay must not advance the generation");
    check(first.sourceFreshness.state === "unknown",
      "caller-declared receipt must not become fresh");

    const restarted = createContinuityAttuneGraphProjector({ databasePath });
    const restartedReplay = await restarted.project(firstReceipt);
    check(
      restartedReplay.status === "replayed"
        && restartedReplay.snapshot.generation === 1,
      "restart replay must recover the persisted exact head"
    );
    const second = await restarted.project(receipt(SECOND_AT, 2));
    check(second.status === "projected" && second.snapshot.generation === 2,
      "a distinct receipt must advance exactly one generation");

    const graph = await openLocalAttuneGraph({
      databasePath,
      scope: { sourceId: SOURCE_ID, threadId: THREAD_ID }
    });
    const head = await graph.head();
    await graph.close();
    check(
      head?.generation === 2 && head.commitId === second.snapshot.commitId,
      "the durable Store head must survive a second independent reopen"
    );
  }
} finally {
  await rm(directory, { force: true, recursive: true });
}

stdout.write(
  verificationMode === "projection"
    ? "PASS Continuity durable AttuneGraph projection verifier\n"
    : "PASS Continuity durable AttuneGraph unsupported-profile rejection verifier\n"
);
