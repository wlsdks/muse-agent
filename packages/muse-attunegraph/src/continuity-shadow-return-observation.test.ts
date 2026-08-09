import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  evaluateTimingSession,
  forgetTimingSession,
  readTimingState,
  recordAttuneGraphShadowReturn,
  startTimingSession
} from "@muse/attunement";
import { describe, expect, it } from "vitest";

import {
  createContinuityAttuneGraphProjector
} from "./continuity-durable-projection-internal.js";
import {
  captureContinuityObservation,
  verifyContinuityObservation
} from "./continuity-observation.js";
import {
  captureContinuityShadowReturnObservation,
  continuityCompositeSourceId,
  ContinuityShadowReturnObservationError,
  readContinuityShadowReturnWorkingGraph
} from "./continuity-shadow-return-observation.js";
import {
  CONTINUITY_PROJECTION_RULE_VERSION,
  continuityShadowReturnProjectionRuleVersion
} from "./continuity-projection.js";

const THREAD_ID = "thread_work";
const DELIVERY_ID = "delivery_exact";
const DECISION_AT = "2026-07-15T09:00:00.000Z";
const OPENED_AT = "2026-07-15T10:00:00.000Z";
const OBSERVED_AT = "2026-07-15T10:01:00.000Z";
const PROVIDER_SOURCE_ID = "muse.local-attunement";
const HAS_REVIEWED_LOCAL_PROFILE = process.platform === "darwin"
  || process.platform === "linux";

function state(openedAt = OPENED_AT) {
  return {
    deliveries: [{
      evidenceClass: "organic",
      evidenceRefs: [],
      id: DELIVERY_ID,
      openedAt,
      policyVersion: 0,
      runId: "continuity_run_exact",
      threadId: THREAD_ID
    }],
    experienceLearningPolicyAudits: [],
    interactionReceipts: [],
    nextPolicyVersion: 1,
    resetReceipts: [],
    schemaVersion: 12,
    threads: [{
      createdAt: "2026-07-15T08:00:00.000Z",
      id: THREAD_ID,
      kind: "work",
      links: [],
      policy: {
        detail: "standard",
        nextStep: "direct",
        suppression: "none",
        version: 0
      },
      title: "Return relation fixture"
    }],
    undoResetReceipts: []
  };
}

function baseObservation(sourceState: unknown = state()) {
  return captureContinuityObservation({
    scope: {
      sourceId: PROVIDER_SOURCE_ID,
      threadId: THREAD_ID
    },
    sourceObservedAt: OBSERVED_AT,
    state: sourceState
  });
}

async function timingFixture() {
  const file = join(
    mkdtempSync(join(tmpdir(), "muse-shadow-return-graph-")),
    "timing.json"
  );
  let sequence = 0;
  const options = {
    idFactory: () => `id-${(++sequence).toString()}`,
    now: () => new Date(DECISION_AT)
  };
  const session = await startTimingSession(
    file,
    { consentVersion: 1, threadId: THREAD_ID },
    async () => undefined,
    options
  );
  await evaluateTimingSession(file, session.id, options);
  const result = await recordAttuneGraphShadowReturn(file, {
    id: DELIVERY_ID,
    openedAt: OPENED_AT,
    threadId: THREAD_ID
  });
  if (result.status !== "recorded") {
    throw new Error("fixture return must be recorded");
  }
  return {
    file,
    receipt: result.receipt,
    session,
    timingState: await readTimingState(file)
  };
}

describe("Continuity Shadow-return observation", () => {
  it("emits exactly factual temporal/thread relations in a reserved composite scope", async () => {
    const fixture = await timingFixture();
    const base = baseObservation();
    const receipt = captureContinuityShadowReturnObservation({
      baseObservationReceipt: base,
      state: state(),
      timingState: fixture.timingState
    });

    expect(receipt.projection.scope).toEqual({
      sourceId: continuityCompositeSourceId,
      threadId: THREAD_ID
    });
    expect(receipt.projection.ruleVersion)
      .toBe(continuityShadowReturnProjectionRuleVersion);
    expect(base.projection.ruleVersion).toBe(CONTINUITY_PROJECTION_RULE_VERSION);
    expect(verifyContinuityObservation(receipt)).toEqual(receipt);

    const returnAssertions = receipt.projection.assertions.filter((assertion) =>
      assertion.derivation.version
      === continuityShadowReturnProjectionRuleVersion
    );
    expect(returnAssertions).toHaveLength(2);
    expect(returnAssertions.map((assertion) => assertion.predicate).sort())
      .toEqual(["OBSERVED_DURING", "PRECEDED"]);
    expect(returnAssertions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        epistemicClass: "source-observed",
        object: expect.objectContaining({ kind: "delivery" }),
        predicate: "PRECEDED",
        recordedAt: OPENED_AT,
        subject: expect.objectContaining({ kind: "decision" }),
        validFrom: OPENED_AT
      }),
      expect.objectContaining({
        epistemicClass: "source-observed",
        object: expect.objectContaining({ kind: "thread" }),
        predicate: "OBSERVED_DURING",
        recordedAt: OPENED_AT,
        subject: expect.objectContaining({ kind: "evidence" }),
        validFrom: OPENED_AT
      })
    ]));
    expect(new Set(
      returnAssertions.flatMap((assertion) =>
        assertion.sourceRefs.map((sourceRef) => sourceRef.namespace)
      )
    )).toEqual(new Set(["muse.attunement.shadow-return"]));
    expect(returnAssertions.some((assertion) => [
      "AUTHORIZED_BY",
      "GOVERNED_BY",
      "PERFORMED",
      "PRODUCED_OUTCOME",
      "PROPOSES_POLICY",
      "SCOPED_TO"
    ].includes(assertion.predicate))).toBe(false);

    const replay = captureContinuityShadowReturnObservation({
      baseObservationReceipt: base,
      state: state(),
      timingState: fixture.timingState
    });
    expect(replay).toEqual(receipt);
    expect(replay.receiptId).toBe(receipt.receiptId);
  });

  it("requires an exact persisted ledger capability and exact source Delivery join", async () => {
    const fixture = await timingFixture();
    const base = baseObservation();
    expect(() => captureContinuityShadowReturnObservation({
      baseObservationReceipt: base,
      state: state(),
      timingState: structuredClone(fixture.timingState)
    })).toThrow(expect.objectContaining({
      code: "INVALID_INPUT"
    }));
    expect(() => captureContinuityShadowReturnObservation({
      baseObservationReceipt: base,
      state: state("2026-07-15T10:00:00.001Z"),
      timingState: fixture.timingState
    })).toThrow(expect.objectContaining({
      code: "SOURCE_MISMATCH"
    }));

    const mismatchedBase = baseObservation(
      state("2026-07-15T10:00:00.001Z")
    );
    expect(() => captureContinuityShadowReturnObservation({
      baseObservationReceipt: mismatchedBase,
      state: state("2026-07-15T10:00:00.001Z"),
      timingState: fixture.timingState
    })).toThrow(expect.objectContaining({
      code: "DELIVERY_MISMATCH"
    }));
  });

  it("keeps v1 receipts verifiable and removes forgotten returns on the next full rebuild", async () => {
    const fixture = await timingFixture();
    const base = baseObservation();
    const withReturn = captureContinuityShadowReturnObservation({
      baseObservationReceipt: base,
      state: state(),
      timingState: fixture.timingState
    });

    await forgetTimingSession(fixture.file, fixture.session.id);
    const afterForget = captureContinuityShadowReturnObservation({
      baseObservationReceipt: base,
      state: state(),
      timingState: await readTimingState(fixture.file)
    });

    expect(verifyContinuityObservation(base)).toEqual(base);
    expect(afterForget.projection.ruleVersion)
      .toBe(continuityShadowReturnProjectionRuleVersion);
    expect(afterForget.projection.assertions.every((assertion) =>
      assertion.derivation.version
      !== continuityShadowReturnProjectionRuleVersion
    )).toBe(true);
    expect(afterForget.projection.assertions)
      .toEqual(expect.arrayContaining(
        withReturn.projection.assertions.filter((assertion) =>
          assertion.derivation.version
          !== continuityShadowReturnProjectionRuleVersion
        )
      ));
    expect(afterForget.projection.sourceVersion)
      .not.toBe(withReturn.projection.sourceVersion);
    expect(afterForget.projection.projectionVersion)
      .not.toBe(withReturn.projection.projectionVersion);
  });

  it.runIf(HAS_REVIEWED_LOCAL_PROFILE)("persists a queryable full snapshot and actively removes forgotten relations", async () => {
    const fixture = await timingFixture();
    const databasePath = join(
      realpathSync(mkdtempSync(join(tmpdir(), "muse-shadow-return-durable-"))),
      "attunegraph.sqlite"
    );
    const projector = createContinuityAttuneGraphProjector({ databasePath });
    const firstObservation = captureContinuityShadowReturnObservation({
      baseObservationReceipt: baseObservation(),
      state: state(),
      timingState: fixture.timingState
    });
    const first = await projector.project(firstObservation);
    expect(first).toMatchObject({
      status: "projected",
      snapshot: {
        generation: 1,
        scope: {
          sourceId: continuityCompositeSourceId,
          threadId: THREAD_ID
        }
      }
    });

    const withReturn = await readContinuityShadowReturnWorkingGraph({
      databasePath,
      maxEstimatedTokens: 8_192,
      now: "2026-07-15T11:00:00.000Z",
      threadId: THREAD_ID
    });
    expect(withReturn.workingGraph.assertions.filter((assertion) =>
      assertion.derivation.version
      === continuityShadowReturnProjectionRuleVersion
    ).map((assertion) => assertion.predicate).sort())
      .toEqual(["OBSERVED_DURING", "PRECEDED"]);

    await forgetTimingSession(fixture.file, fixture.session.id);
    const laterBase = captureContinuityObservation({
      scope: {
        sourceId: PROVIDER_SOURCE_ID,
        threadId: THREAD_ID
      },
      sourceObservedAt: "2026-07-15T10:02:00.000Z",
      state: state()
    });
    const withoutReturn = captureContinuityShadowReturnObservation({
      baseObservationReceipt: laterBase,
      state: state(),
      timingState: await readTimingState(fixture.file)
    });
    await expect(projector.project(withoutReturn)).resolves.toMatchObject({
      status: "projected",
      snapshot: { generation: 2 }
    });

    const afterForget = await readContinuityShadowReturnWorkingGraph({
      databasePath,
      maxEstimatedTokens: 8_192,
      now: "2026-07-15T11:00:00.000Z",
      threadId: THREAD_ID
    });
    expect(afterForget.workingGraph.assertions.some((assertion) =>
      assertion.derivation.version
      === continuityShadowReturnProjectionRuleVersion
    )).toBe(false);
  });

  it("rejects proxies and accessor-bearing envelopes before source materialization", async () => {
    const fixture = await timingFixture();
    expect(() => captureContinuityShadowReturnObservation(
      new Proxy({
        baseObservationReceipt: baseObservation(),
        state: state(),
        timingState: fixture.timingState
      }, {})
    )).toThrow(ContinuityShadowReturnObservationError);

    const accessor = {
      baseObservationReceipt: baseObservation(),
      state: state(),
      timingState: fixture.timingState
    };
    Object.defineProperty(accessor, "timingState", {
      enumerable: true,
      get: () => fixture.timingState
    });
    expect(() => captureContinuityShadowReturnObservation(accessor))
      .toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));

    await expect(readContinuityShadowReturnWorkingGraph(
      new Proxy({
        databasePath: "/never-opened.sqlite",
        maxEstimatedTokens: 1,
        now: OBSERVED_AT,
        threadId: THREAD_ID
      }, {})
    )).rejects.toMatchObject({ code: "INVALID_INPUT" });

    const queryOptions = {
      databasePath: "/never-opened.sqlite",
      maxEstimatedTokens: 1,
      now: OBSERVED_AT,
      threadId: THREAD_ID
    };
    Object.defineProperty(queryOptions, "threadId", {
      enumerable: true,
      get: () => THREAD_ID
    });
    await expect(readContinuityShadowReturnWorkingGraph(queryOptions))
      .rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
});
