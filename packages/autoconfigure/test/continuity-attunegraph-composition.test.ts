import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  evaluateTimingSession,
  recordAttuneGraphShadowReturn,
  startTimingSession
} from "@muse/attunement";
import {
  captureContinuityObservation
} from "@muse/attunegraph/continuity-observations";
import {
  continuityCompositeSourceId,
  readContinuityShadowReturnWorkingGraph
} from "@muse/attunegraph/continuity-shadow-returns";
import { expect, it } from "vitest";

import {
  createConfiguredContinuityAttuneGraphProjector,
  projectConfiguredContinuityAttuneGraphCurrentState
} from "../src/continuity-attunegraph-composition.js";

it("keeps absent and exactly empty AttuneGraph configuration disabled", () => {
  expect(createConfiguredContinuityAttuneGraphProjector({})).toBeUndefined();
  expect(createConfiguredContinuityAttuneGraphProjector({
    MUSE_ATTUNEGRAPH_DATABASE: ""
  })).toBeUndefined();
});

it("creates only an explicit absolute projector and fails invalid non-empty configuration closed", () => {
  expect(createConfiguredContinuityAttuneGraphProjector({
    MUSE_ATTUNEGRAPH_DATABASE: "/tmp/muse-attunegraph.sqlite"
  })).toMatchObject({ project: expect.any(Function) });
  expect(() =>
    createConfiguredContinuityAttuneGraphProjector({
      MUSE_ATTUNEGRAPH_DATABASE: " "
    })
  ).toThrow(expect.objectContaining({ code: "INVALID_CONFIGURATION" }));
  expect(() =>
    createConfiguredContinuityAttuneGraphProjector({
      MUSE_ATTUNEGRAPH_DATABASE: "relative.sqlite"
    })
  ).toThrow(expect.objectContaining({ code: "INVALID_CONFIGURATION" }));
});

it("rebuilds the reserved composite scope from the current Attunement and timing ledgers", async () => {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "muse-configured-return-graph-"))
  );
  const attunementFile = join(directory, "attunement.json");
  const databasePath = join(directory, "attunegraph.sqlite");
  const timingFile = `${attunementFile}.timing.json`;
  const threadId = "thread_configured_return";
  const openedAt = "2026-07-31T01:00:00.000Z";
  const state = {
    deliveries: [{
      evidenceClass: "organic",
      evidenceRefs: [],
      id: "delivery_configured_return",
      openedAt,
      policyVersion: 0,
      runId: "run_configured_return",
      threadId
    }],
    experienceLearningPolicyAudits: [],
    interactionReceipts: [],
    nextPolicyVersion: 1,
    resetReceipts: [],
    schemaVersion: 12,
    threads: [{
      createdAt: "2026-07-31T00:00:00.000Z",
      id: threadId,
      kind: "work",
      links: [],
      policy: {
        detail: "standard",
        nextStep: "direct",
        suppression: "none",
        version: 0
      },
      title: "Configured return graph"
    }],
    undoResetReceipts: []
  };
  await writeFile(attunementFile, JSON.stringify(state));
  let sequence = 0;
  const timingOptions = {
    idFactory: () => `configured-${(++sequence).toString()}`,
    now: () => new Date("2026-07-31T00:30:00.000Z")
  };
  const session = await startTimingSession(
    timingFile,
    { consentVersion: 1, threadId },
    async () => undefined,
    timingOptions
  );
  await evaluateTimingSession(timingFile, session.id, timingOptions);
  await recordAttuneGraphShadowReturn(timingFile, {
    id: "delivery_configured_return",
    openedAt,
    threadId
  });
  const base = captureContinuityObservation({
    scope: {
      sourceId: "muse.local-attunement",
      threadId
    },
    sourceObservedAt: "2026-07-31T01:01:00.000Z",
    state
  });
  const configuredEnvironment = {
    HOME: directory,
    MUSE_ATTUNEGRAPH_DATABASE: databasePath,
    MUSE_ATTUNEMENT_FILE: attunementFile
  };

  await expect(projectConfiguredContinuityAttuneGraphCurrentState(
    configuredEnvironment,
    {
      sourceObservedAt: base.observedAt,
      threadId
    }
  )).resolves.toMatchObject({
    status: "projected",
    snapshot: {
      scope: {
        sourceId: continuityCompositeSourceId,
        threadId
      }
    }
  });
  const workingGraph = await readContinuityShadowReturnWorkingGraph({
    databasePath,
    maxEstimatedTokens: 8_192,
    now: "2026-07-31T02:00:00.000Z",
    threadId
  });
  expect(workingGraph.workingGraph.assertions.map((assertion) =>
    assertion.predicate
  )).toEqual(expect.arrayContaining(["OBSERVED_DURING", "PRECEDED"]));
});

it("rejects hostile configured-current-state inputs before source materialization", async () => {
  const valid = {
    sourceObservedAt: "2026-07-31T01:01:00.000Z",
    threadId: "thread_hostile_input"
  };
  const accessor = { ...valid };
  Object.defineProperty(accessor, "threadId", {
    enumerable: true,
    get: () => valid.threadId
  });
  const inherited = Object.assign(Object.create({ inherited: true }), valid);
  const withSymbol = Object.assign(
    { ...valid },
    { [Symbol("hidden")]: "value" }
  );
  const hostileInputs = [
    new Proxy(valid, {}),
    accessor,
    inherited,
    { ...valid, extra: true },
    withSymbol,
    { threadId: valid.threadId }
  ];
  const environment = {
    MUSE_ATTUNEGRAPH_DATABASE: "/never-opened-attunegraph.sqlite",
    MUSE_ATTUNEMENT_FILE: "/never-read-attunement.json"
  };

  for (const input of hostileInputs) {
    await expect(projectConfiguredContinuityAttuneGraphCurrentState(
      environment,
      input as never
    )).rejects.toBeInstanceOf(TypeError);
  }
});
