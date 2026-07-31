import { existsSync, mkdtempSync } from "node:fs";
import {
  chmod,
  mkdtemp,
  readFile,
  readdir,
  realpath
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  evaluateTimingSession,
  pauseTimingSession,
  readTimingState,
  recordAttuneGraphShadowReturn,
  recordTimingObservation,
  startTimingSession,
  type AttuneGraphShadowReturnReceipt
} from "@muse/attunement";
import {
  openAttuneGraph,
  type AttuneGraphOperatorResult,
  type GraphAssertion
} from "@attunegraph/core";
import {
  createAttuneGraphStore,
  type AttuneGraphStoredProjection
} from "@attunegraph/core/backend";
import { describe, expect, it } from "vitest";

import {
  deriveContinuityDeliveryGraphRef,
  deriveContinuityShadowDecisionGraphRef,
  deriveContinuityShadowReturnEvidenceGraphRef,
  deriveContinuityShadowReturnSourceRef,
  deriveContinuityThreadGraphRef
} from "./continuity-projection-identity.js";
import {
  continuityCompositeSourceId,
  ContinuityShadowReturnObservationError,
  inspectContinuityShadowReturns,
  inspectContinuityShadowReturnsWithDependenciesForInternalUse,
  readContinuityShadowReturnWorkingGraph
} from "./continuity-shadow-return-observation.js";
import { continuityShadowReturnProjectionRuleVersion } from "./continuity-projection.js";

const THREAD_ID = "thread_shadow_return";
const DELIVERY_ID = "delivery_shadow_return";
const DECISION_AT = "2026-07-15T09:00:00.000Z";
const OPENED_AT = "2026-07-15T10:00:00.000Z";

async function fixture() {
  const file = join(mkdtempSync(join(tmpdir(), "muse-shadow-return-inspection-")), "timing.json");
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
  const recorded = await recordAttuneGraphShadowReturn(file, {
    id: DELIVERY_ID,
    openedAt: OPENED_AT,
    threadId: THREAD_ID
  });
  if (recorded.status !== "recorded") throw new Error("expected shadow return");
  return { receipt: recorded.receipt, timingState: await readTimingState(file) };
}

async function multiFixture() {
  const file = join(mkdtempSync(join(tmpdir(), "muse-shadow-return-inspection-")), "timing.json");
  let sequence = 0;
  const receiptFor = async (
    threadId: string,
    deliveryId: string,
    openedAt: string,
    decisionAt: string
  ) => {
    const options = {
      idFactory: () => `id-${(++sequence).toString()}`,
      now: () => new Date(decisionAt)
    };
    const session = await startTimingSession(
      file,
      { consentVersion: 1, threadId },
      async () => undefined,
      options
    );
    await recordTimingObservation(file, session.id, {
      appCategory: "other",
      durationMs: 1,
      startedAt: decisionAt,
      endedAt: decisionAt
    }, options);
    await evaluateTimingSession(file, session.id, options);
    const result = await recordAttuneGraphShadowReturn(file, {
      id: deliveryId,
      openedAt,
      threadId
    });
    if (result.status !== "recorded") throw new Error("expected shadow return");
    await pauseTimingSession(file, session.id, options);
    return result.receipt;
  };
  const first = await receiptFor(
    THREAD_ID,
    "delivery_first",
    "2026-07-15T10:00:00.000Z",
    DECISION_AT
  );
  const second = await receiptFor(
    "thread_other",
    "delivery_second",
    "2026-07-15T11:00:00.000Z",
    "2026-07-15T09:30:00.000Z"
  );
  const third = await receiptFor(
    THREAD_ID,
    "delivery_third",
    "2026-07-15T11:00:00.000Z",
    "2026-07-15T09:45:00.000Z"
  );
  return {
    receipts: [first, second, third],
    timingState: await readTimingState(file)
  };
}

function exactAssertions(receipt: AttuneGraphShadowReturnReceipt): readonly GraphAssertion[] {
  const sourceRef = deriveContinuityShadowReturnSourceRef(
    continuityCompositeSourceId,
    receipt
  );
  const base = {
    schemaVersion: 1 as const,
    epistemicClass: "source-observed" as const,
    sourceRefs: [sourceRef],
    validFrom: receipt.openedAt,
    recordedAt: receipt.openedAt,
    derivation: {
      kind: "projection" as const,
      version: continuityShadowReturnProjectionRuleVersion
    }
  };
  return [
    {
      ...base,
      id: "preceded",
      subject: deriveContinuityShadowDecisionGraphRef(
        continuityCompositeSourceId,
        receipt.candidateId
      ),
      predicate: "PRECEDED" as const,
      object: deriveContinuityDeliveryGraphRef(
        continuityCompositeSourceId,
        receipt.deliveryId
      )
    },
    {
      ...base,
      id: "observed",
      subject: deriveContinuityShadowReturnEvidenceGraphRef(
        continuityCompositeSourceId,
        receipt.id
      ),
      predicate: "OBSERVED_DURING" as const,
      object: deriveContinuityThreadGraphRef(
        continuityCompositeSourceId,
        receipt.threadId
      )
    }
  ];
}

function completeGraph(
  receipt: AttuneGraphShadowReturnReceipt,
  assertions = exactAssertions(receipt)
): AttuneGraphOperatorResult {
  return {
    operator: "working-graph@1",
    status: "complete",
    snapshot: {
      schemaVersion: 1,
      scope: { sourceId: continuityCompositeSourceId, threadId: receipt.threadId },
      generation: 1,
      commitId: "commit"
    },
    sourceFreshness: { state: "unknown", observedAt: receipt.openedAt },
    workingGraph: {
      assertions,
      refs: [],
      seed: deriveContinuityThreadGraphRef(
        continuityCompositeSourceId,
        receipt.threadId
      ),
      diagnostics: {
        consideredAssertions: assertions.length,
        estimatedTokens: 1,
        maxDepthReached: 1,
        visitedRefs: 1,
        truncationReasons: []
      }
    }
  };
}

function completeGraphForThread(
  threadId: string,
  receipts: readonly AttuneGraphShadowReturnReceipt[]
): AttuneGraphOperatorResult {
  const selected = receipts.filter((receipt) => receipt.threadId === threadId);
  if (selected.length === 0) throw new Error("missing thread receipt");
  return completeGraph(selected[0]!, selected.flatMap(exactAssertions));
}

async function inspect(
  timingState: unknown,
  readWorkingGraph: Parameters<
    typeof inspectContinuityShadowReturnsWithDependenciesForInternalUse
  >[1]["readWorkingGraph"],
  limit = 20
) {
  return inspectContinuityShadowReturnsWithDependenciesForInternalUse({
    databasePath: "/configured.sqlite",
    limit,
    maxEstimatedTokens: 8_192,
    now: "2026-07-15T12:00:00.000Z",
    timingState
  }, { readWorkingGraph });
}

async function physicalState(directory: string): Promise<Readonly<{
  readonly entries: readonly string[];
  readonly bytes: Readonly<Record<string, string>>;
}>> {
  const entries = (await readdir(directory)).sort();
  return {
    entries,
    bytes: Object.fromEntries(await Promise.all(entries.map(async (entry) => [
      entry,
      (await readFile(join(directory, entry))).toString("base64")
    ])))
  };
}

async function projectReceipts(
  databasePath: string,
  receipts: readonly AttuneGraphShadowReturnReceipt[]
): Promise<void> {
  const threadId = receipts[0]?.threadId;
  if (
    threadId === undefined
    || receipts.some((receipt) => receipt.threadId !== threadId)
  ) {
    throw new Error("projection fixture requires one thread");
  }
  let stored: AttuneGraphStoredProjection | undefined;
  const graph = await openAttuneGraph({
    scope: {
      sourceId: continuityCompositeSourceId,
      threadId
    },
    store: createAttuneGraphStore({
      async read() {
        return stored;
      },
      async compareAndSwap(_scope, _expected, proposed) {
        stored = proposed;
        return true;
      }
    })
  });
  try {
    await graph.project({
      operator: "canonical-projection@1",
      observation: {
        schemaVersion: 1,
        observationKey: `shadow-return-inspection:${threadId}`,
        scope: {
          sourceId: continuityCompositeSourceId,
          threadId
        },
        observedAt: OPENED_AT,
        sourceFreshness: {
          state: "unknown",
          observedAt: OPENED_AT
        },
        assertions: receipts.flatMap((receipt) =>
          [
            ...exactAssertions(receipt).map((assertion) => ({
              ...structuredClone(assertion),
              id: `${receipt.id}:${assertion.id}`
            })),
            {
              schemaVersion: 1 as const,
              id: `${receipt.id}:delivery`,
              subject: deriveContinuityDeliveryGraphRef(
                continuityCompositeSourceId,
                receipt.deliveryId
              ),
              predicate: "DELIVERED_FOR" as const,
              object: deriveContinuityThreadGraphRef(
                continuityCompositeSourceId,
                receipt.threadId
              ),
              epistemicClass: "source-observed" as const,
              sourceRefs: [deriveContinuityShadowReturnSourceRef(
                continuityCompositeSourceId,
                receipt
              )],
              validFrom: receipt.openedAt,
              recordedAt: receipt.openedAt,
              derivation: {
                kind: "projection" as const,
                version: continuityShadowReturnProjectionRuleVersion
              }
            }
          ].map((assertion) => structuredClone(assertion))
        )
      }
    });
  } finally {
    await graph.close();
  }
  if (stored === undefined) throw new Error("projection fixture was not stored");

  const database = new DatabaseSync(databasePath, { readBigInts: true });
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE attunegraph_projection_journal (
      source_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      generation INTEGER NOT NULL CHECK (generation >= 1),
      commit_id TEXT NOT NULL,
      projection_json TEXT NOT NULL CHECK (length(projection_json) BETWEEN 1 AND 1048576),
      projection_fingerprint TEXT NOT NULL,
      PRIMARY KEY (source_id, thread_id, generation, commit_id)
    ) STRICT, WITHOUT ROWID;
    CREATE UNIQUE INDEX attunegraph_projection_journal_generation
      ON attunegraph_projection_journal (source_id, thread_id, generation);
    CREATE TABLE attunegraph_projection_head (
      source_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      generation INTEGER NOT NULL CHECK (generation >= 1),
      commit_id TEXT NOT NULL,
      PRIMARY KEY (source_id, thread_id),
      FOREIGN KEY (source_id, thread_id, generation, commit_id)
        REFERENCES attunegraph_projection_journal (source_id, thread_id, generation, commit_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT
    ) STRICT, WITHOUT ROWID;
    PRAGMA application_id = 1096042289;
    PRAGMA user_version = 1;
  `);
  database.prepare(`
    INSERT INTO attunegraph_projection_journal (
      source_id, thread_id, generation, commit_id,
      projection_json, projection_fingerprint
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    stored.snapshot.scope.sourceId,
    stored.snapshot.scope.threadId,
    BigInt(stored.snapshot.generation),
    stored.snapshot.commitId,
    JSON.stringify(stored),
    stored.projectionFingerprint
  );
  database.prepare(`
    INSERT INTO attunegraph_projection_head (
      source_id, thread_id, generation, commit_id
    ) VALUES (?, ?, ?, ?)
  `).run(
    stored.snapshot.scope.sourceId,
    stored.snapshot.scope.threadId,
    BigInt(stored.snapshot.generation),
    stored.snapshot.commitId
  );
  database.close();
  await chmod(databasePath, 0o600);
}

describe("Continuity Shadow-return inspection", () => {
  it("returns a detached frozen factual receipt and reads each selected thread once", async () => {
    const source = await fixture();
    let calls = 0;
    const report = await inspectContinuityShadowReturnsWithDependenciesForInternalUse({
      databasePath: "/configured.sqlite",
      limit: 20,
      maxEstimatedTokens: 8_192,
      now: "2026-07-15T11:00:00.000Z",
      timingState: source.timingState
    }, {
      readWorkingGraph: async () => {
        calls += 1;
        return completeGraph(source.receipt);
      }
    });

    expect(calls).toBe(1);
    expect(report).toMatchObject({ schemaVersion: 1, limit: 20 });
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]?.graph.status).toBe("linked");
    expect(report.rows[0]?.receipt).toEqual(source.receipt);
    expect(report.rows[0]?.receipt).not.toBe(source.receipt);
    expect(Object.isFrozen(report)).toBe(true);
    expect(Object.isFrozen(report.rows)).toBe(true);
    expect(Object.isFrozen(report.rows[0]?.receipt ?? {})).toBe(true);
  });

  it("sorts openedAt descending then id ascending, bounds selection, and isolates one selected thread failure", async () => {
    const source = await multiFixture();
    const expected = source.timingState.returns.slice().sort((left, right) =>
      right.openedAt.localeCompare(left.openedAt) || left.id.localeCompare(right.id)
    );
    const calls: string[] = [];
    const report = await inspect(source.timingState, async (options) => {
      calls.push(options.threadId);
      if (options.threadId === "thread_other") throw new Error("isolated failure");
      return completeGraphForThread(options.threadId, source.receipts);
    }, 3);

    expect(report.rows.map((row) => row.receipt.id))
      .toEqual(expected.map((receipt) => receipt.id));
    expect(report.rows).toHaveLength(3);
    expect(calls.sort()).toEqual([THREAD_ID, "thread_other"].sort());
    expect(report.rows.filter((row) => row.receipt.threadId === THREAD_ID)
      .every((row) => row.graph.status === "linked")).toBe(true);
    expect(report.rows.find((row) => row.receipt.threadId === "thread_other")?.graph.status)
      .toBe("unavailable");

    const bounded = await inspect(source.timingState, async (options) =>
      completeGraphForThread(options.threadId, source.receipts), 2);
    expect(bounded.rows.map((row) => row.receipt.id))
      .toEqual(expected.slice(0, 2).map((receipt) => receipt.id));
  });

  it("uses not-configured only for undefined or exactly empty paths", async () => {
    const source = await fixture();
    for (const databasePath of [undefined, ""] as const) {
      const report = await inspectContinuityShadowReturnsWithDependenciesForInternalUse({
        databasePath,
        limit: 1,
        maxEstimatedTokens: 1,
        now: OPENED_AT,
        timingState: source.timingState
      }, {
        readWorkingGraph: async () => {
          throw new Error("not configured must not read");
        }
      });
      expect(report.rows[0]?.graph.status).toBe("not-configured");
    }
  });

  it("degrades configured graph failures and incomplete output without losing the receipt", async () => {
    const source = await fixture();
    const unavailable = await inspectContinuityShadowReturnsWithDependenciesForInternalUse({
      databasePath: " ",
      limit: 1,
      maxEstimatedTokens: 1,
      now: OPENED_AT,
      timingState: source.timingState
    }, { readWorkingGraph: async () => { throw new Error("bad graph path"); } });
    expect(unavailable.rows[0]?.graph.status).toBe("unavailable");

    const incomplete = await inspectContinuityShadowReturnsWithDependenciesForInternalUse({
      databasePath: "/configured.sqlite",
      limit: 1,
      maxEstimatedTokens: 1,
      now: OPENED_AT,
      timingState: source.timingState
    }, {
      readWorkingGraph: async () => ({
        ...completeGraph(source.receipt),
        status: "partial" as const
      })
    });
    expect(incomplete.rows[0]?.receipt).toEqual(source.receipt);
    expect(incomplete.rows[0]?.graph.status).toBe("incomplete");
  });

  it("requires exactly one active assertion of each receipt-derived relation", async () => {
    const source = await fixture();
    const assertions = exactAssertions(source.receipt);
    const notLinked = await inspectContinuityShadowReturnsWithDependenciesForInternalUse({
      databasePath: "/configured.sqlite",
      limit: 1,
      maxEstimatedTokens: 1,
      now: OPENED_AT,
      timingState: source.timingState
    }, {
      readWorkingGraph: async () => completeGraph(source.receipt, [
        assertions[0]!,
        { ...assertions[1]!, validTo: "2026-07-15T11:00:00.000Z" }
      ])
    });
    expect(notLinked.rows[0]?.graph.status).toBe("not-linked");

    const duplicate = await inspectContinuityShadowReturnsWithDependenciesForInternalUse({
      databasePath: "/configured.sqlite",
      limit: 1,
      maxEstimatedTokens: 1,
      now: OPENED_AT,
      timingState: source.timingState
    }, {
      readWorkingGraph: async () => completeGraph(source.receipt, [
        ...assertions,
        { ...assertions[0]!, id: "duplicate" }
      ])
    });
    expect(duplicate.rows[0]?.graph.status).toBe("not-linked");
  });

  it("rejects every exact relation mismatch as not-linked", async () => {
    const source = await fixture();
    const assertions = exactAssertions(source.receipt);
    const variants: readonly [string, (value: readonly GraphAssertion[]) => readonly GraphAssertion[]][] = [
      ["subject", (value) => [{ ...value[0]!, subject: { ...value[0]!.subject, id: "other" } }, value[1]!]],
      ["object", (value) => [{ ...value[0]!, object: { ...value[0]!.object, id: "other" } }, value[1]!]],
      ["source namespace", (value) => [{ ...value[0]!, sourceRefs: [{ ...value[0]!.sourceRefs[0]!, namespace: "other" }] }, value[1]!]],
      ["source id", (value) => [{ ...value[0]!, sourceRefs: [{ ...value[0]!.sourceRefs[0]!, id: "other" }] }, value[1]!]],
      ["source version", (value) => [{ ...value[0]!, sourceRefs: [{ ...value[0]!.sourceRefs[0]!, version: "other" }] }, value[1]!]],
      ["source cardinality", (value) => [{ ...value[0]!, sourceRefs: [value[0]!.sourceRefs[0]!, value[0]!.sourceRefs[0]!] }, value[1]!]],
      ["recordedAt", (value) => [{ ...value[0]!, recordedAt: "2026-07-15T10:00:00.001Z" }, value[1]!]],
      ["validFrom", (value) => [{ ...value[0]!, validFrom: "2026-07-15T10:00:00.001Z" }, value[1]!]],
      ["validTo", (value) => [{ ...value[0]!, validTo: "2026-07-15T11:00:00.000Z" }, value[1]!]],
      ["supersededAt", (value) => [{ ...value[0]!, supersededAt: "2026-07-15T11:00:00.000Z" }, value[1]!]],
      ["epistemic class", (value) => [{ ...value[0]!, epistemicClass: "deterministic-derived" }, value[1]!]],
      ["derivation kind", (value) => [{ ...value[0]!, derivation: { ...value[0]!.derivation, kind: "rule" } }, value[1]!]],
      ["derivation version", (value) => [{ ...value[0]!, derivation: { ...value[0]!.derivation, version: "other" } }, value[1]!]]
    ];
    for (const [name, mutate] of variants) {
      const report = await inspect(source.timingState, async () =>
        completeGraph(source.receipt, mutate(assertions)), 1);
      expect(report.rows[0]?.graph.status, name).toBe("not-linked");
    }
  });

  it("classifies wrong reserved scope, seed, and a complete truncated read as incomplete", async () => {
    const source = await fixture();
    const variants: readonly [string, (value: AttuneGraphOperatorResult) => AttuneGraphOperatorResult][] = [
      ["snapshot scope", (value) => ({
        ...value,
        snapshot: { ...value.snapshot, scope: { ...value.snapshot.scope, sourceId: "other" } }
      })],
      ["snapshot thread", (value) => ({
        ...value,
        snapshot: { ...value.snapshot, scope: { ...value.snapshot.scope, threadId: "other" } }
      })],
      ["seed", (value) => ({
        ...value,
        workingGraph: { ...value.workingGraph, seed: { ...value.workingGraph.seed, id: "other" } }
      })],
      ["truncation", (value) => ({
        ...value,
        workingGraph: {
          ...value.workingGraph,
          diagnostics: { ...value.workingGraph.diagnostics, truncationReasons: ["token-budget"] }
        }
      })]
    ];
    for (const [name, mutate] of variants) {
      const report = await inspect(source.timingState, async () =>
        mutate(completeGraph(source.receipt)), 1);
      expect(report.rows[0]?.graph.status, name).toBe("incomplete");
    }
  });

  it("rejects hostile input before reading its source capability", async () => {
    const source = await fixture();
    await expect(inspectContinuityShadowReturnsWithDependenciesForInternalUse(new Proxy({
      databasePath: undefined,
      limit: 1,
      maxEstimatedTokens: 1,
      now: OPENED_AT,
      timingState: source.timingState
    }, {}), { readWorkingGraph: async () => completeGraph(source.receipt) }))
      .rejects.toBeInstanceOf(ContinuityShadowReturnObservationError);
    await expect(inspectContinuityShadowReturnsWithDependenciesForInternalUse({
      databasePath: undefined,
      limit: 21,
      maxEstimatedTokens: 1,
      now: OPENED_AT,
      timingState: source.timingState
    }, { readWorkingGraph: async () => completeGraph(source.receipt) }))
      .rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("leaves a missing configured graph path absent and reports unavailable", async () => {
    const source = await fixture();
    const directory = await realpath(
      await mkdtemp(join(tmpdir(), "muse-shadow-return-missing-"))
    );
    const databasePath = join(directory, "missing.sqlite");
    const before = await physicalState(directory);

    const report = await inspectContinuityShadowReturns({
      databasePath,
      limit: 1,
      maxEstimatedTokens: 8_192,
      now: "2026-07-15T12:00:00.000Z",
      timingState: source.timingState
    });

    expect(report.rows[0]?.graph.status).toBe("unavailable");
    expect(existsSync(databasePath)).toBe(false);
    expect(await physicalState(directory)).toEqual(before);
  });

  it("keeps source bytes and entries unchanged across repeated reads and one per-thread failure", async () => {
    const source = await multiFixture();
    const directory = await realpath(
      await mkdtemp(join(tmpdir(), "muse-shadow-return-readonly-"))
    );
    const databasePath = join(directory, "source.sqlite");
    const projected = source.receipts.filter((receipt) =>
      receipt.threadId === THREAD_ID
    );
    await projectReceipts(databasePath, projected);
    const before = await physicalState(directory);
    await expect(readContinuityShadowReturnWorkingGraph({
      databasePath,
      maxEstimatedTokens: 8_192,
      now: "2026-07-15T12:00:00.000Z",
      threadId: THREAD_ID
    })).resolves.toMatchObject({
      operator: "working-graph@1",
      status: "complete"
    });
    expect(await physicalState(directory)).toEqual(before);

    for (let index = 0; index < 2; index += 1) {
      const report = await inspectContinuityShadowReturns({
        databasePath,
        limit: 3,
        maxEstimatedTokens: 8_192,
        now: "2026-07-15T12:00:00.000Z",
        timingState: source.timingState
      });
      expect(report.rows.filter((row) => row.receipt.threadId === THREAD_ID)
        .map((row) => row.graph.status)).toEqual(["linked", "linked"]);
      expect(report.rows.find((row) =>
        row.receipt.threadId === "thread_other"
      )?.graph.status).toBe("unavailable");
      expect(await physicalState(directory)).toEqual(before);
    }
  });

  it("does not expose the test seam through the public Shadow Return facade", async () => {
    const facade = await import("./continuity-shadow-returns.js");
    expect("inspectContinuityShadowReturnsForTests" in facade).toBe(false);
    expect("inspectContinuityShadowReturnsWithDependenciesForInternalUse" in facade).toBe(false);
  });
});
