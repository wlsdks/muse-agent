import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AttuneGraphError,
  type AttuneGraphSnapshot
} from "@attunegraph/core";
import { openLocalAttuneGraph } from "@attunegraph/core/local";
import type { AttunementState } from "@muse/attunement";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ContinuityAttuneGraphProjectionError,
  createContinuityAttuneGraphProjector,
  createContinuityAttuneGraphSessionProjector,
  createContinuityAttuneGraphSessionProjectorWithDependencies,
  createContinuityAttuneGraphProjectorWithDependencies,
  type ContinuityAttuneGraphProjectorDependencies,
  type ContinuityAttuneGraphSessionProjectorDependencies
} from "./continuity-durable-projection-internal.js";
import {
  captureContinuityObservation,
  type ContinuityObservationReceipt
} from "./continuity-observation.js";
import { continuityThreadGraphRef } from "./continuity-projection.js";

const SOURCE_ID = "muse.local-attunement";
const THREAD_ID = "thread_durable_projection";
const FIRST_AT = "2026-07-31T01:00:00.000Z";
const SECOND_AT = "2026-07-31T02:00:00.000Z";
const temporaryDirectories: string[] = [];

function state(version = 1): AttunementState {
  const links = version === 1
    ? []
    : [{
        artifactId: "artifact_durable_projection",
        artifactType: "resource" as const,
        linkedAt: SECOND_AT,
        linkedBy: "user" as const,
        providerId: "mcp:fixture-provider",
        role: "context" as const,
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
      title: "Durable projection fixture"
    }],
    undoResetReceipts: []
  };
}

function observation(
  observedAt = FIRST_AT,
  version = 1
): ContinuityObservationReceipt {
  return captureContinuityObservation({
    scope: { sourceId: SOURCE_ID, threadId: THREAD_ID },
    sourceObservedAt: observedAt,
    state: state(version)
  });
}

function historicalResetObservation(): ContinuityObservationReceipt {
  const historicalState: AttunementState = {
    ...state(),
    nextPolicyVersion: 11,
    resetReceipts: [
      {
        basePolicyVersion: 4,
        beforePolicy: {
          detail: "compact",
          nextStep: "direct",
          suppression: "none",
          version: 4
        },
        id: "historical_reset_five",
        resetPolicyVersion: 5,
        threadId: THREAD_ID
      },
      {
        basePolicyVersion: 9,
        beforePolicy: {
          detail: "compact",
          nextStep: "direct",
          suppression: "none",
          version: 9
        },
        id: "current_reset_ten",
        resetPolicyVersion: 10,
        threadId: THREAD_ID
      }
    ],
    threads: [{
      ...state().threads[0]!,
      policy: {
        detail: "compact",
        nextStep: "direct",
        suppression: "none",
        version: 10
      }
    }]
  };
  return captureContinuityObservation({
    scope: { sourceId: SOURCE_ID, threadId: THREAD_ID },
    sourceObservedAt: SECOND_AT,
    state: historicalState
  });
}

async function temporaryDatabase(): Promise<string> {
  const directory = await mkdtemp(
    join(tmpdir(), "muse-continuity-attunegraph-")
  );
  const canonical = await realpath(directory);
  temporaryDirectories.push(canonical);
  return join(canonical, "attunegraph.sqlite");
}

function snapshot(generation: number): AttuneGraphSnapshot {
  return Object.freeze({
    schemaVersion: 1,
    scope: Object.freeze({
      sourceId: SOURCE_ID,
      threadId: THREAD_ID
    }),
    generation,
    commitId: `attunegraph-commit:test-${generation.toString()}`
  });
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true })
    )
  );
  vi.restoreAllMocks();
});

describe("Continuity durable AttuneGraph projection", () => {
  it("projects, replays, restarts, and advances from the persisted exact head", async () => {
    const databasePath = await temporaryDatabase();
    const firstReceipt = observation();
    const firstProjector = createContinuityAttuneGraphProjector({
      databasePath
    });

    const first = await firstProjector.project(firstReceipt);
    const replay = await firstProjector.project(firstReceipt);
    expect(first).toMatchObject({
      status: "projected",
      sourceFreshness: { state: "unknown", observedAt: FIRST_AT },
      snapshot: { generation: 1 }
    });
    expect(replay).toEqual({ ...first, status: "replayed" });

    const restarted = createContinuityAttuneGraphProjector({ databasePath });
    await expect(restarted.project(firstReceipt)).resolves.toMatchObject({
      status: "replayed",
      snapshot: { generation: 1 }
    });
    const second = await restarted.project(observation(SECOND_AT, 2));
    expect(second).toMatchObject({
      status: "projected",
      sourceFreshness: { state: "unknown", observedAt: SECOND_AT },
      snapshot: { generation: 2 }
    });

    const graph = await openLocalAttuneGraph({
      databasePath,
      scope: { sourceId: SOURCE_ID, threadId: THREAD_ID }
    });
    await expect(graph.head()).resolves.toEqual(second.snapshot);
    await graph.close();
  });

  it("projects historical policy components through the exact declared thread root", async () => {
    const databasePath = await temporaryDatabase();
    const projector = createContinuityAttuneGraphProjector({ databasePath });

    await expect(projector.project(historicalResetObservation())).resolves.toMatchObject({
      status: "projected",
      snapshot: { generation: 1 }
    });

    const graph = await openLocalAttuneGraph({
      databasePath,
      scope: { sourceId: SOURCE_ID, threadId: THREAD_ID }
    });
    await expect(graph.execute({
      operator: "working-graph@1",
      seed: continuityThreadGraphRef({ sourceId: SOURCE_ID, threadId: THREAD_ID }),
      now: SECOND_AT,
      maxEstimatedTokens: 12_000
    })).resolves.toMatchObject({ status: "complete" });
    await graph.close();
  });

  it("projects through the standalone local session and closes its worker explicitly", async () => {
    const databasePath = await temporaryDatabase();
    const receipt = observation();
    const projector = createContinuityAttuneGraphSessionProjector({
      databasePath
    });

    await expect(projector.project(receipt)).resolves.toMatchObject({
      status: "projected",
      snapshot: { generation: 1 }
    });
    await expect(projector.project(receipt)).resolves.toMatchObject({
      status: "replayed",
      snapshot: { generation: 1 }
    });
    await expect(projector.close()).resolves.toBeUndefined();
    await expect(projector.project(receipt)).rejects.toMatchObject({
      code: "CLOSED"
    });

    const graph = await openLocalAttuneGraph({
      databasePath,
      scope: { sourceId: SOURCE_ID, threadId: THREAD_ID }
    });
    await expect(graph.head()).resolves.toMatchObject({ generation: 1 });
    await graph.close();
  });

  it("serializes distinct calls in invocation order", async () => {
    const firstGate = Promise.withResolvers<void>();
    const trace: string[] = [];
    let head: AttuneGraphSnapshot | undefined;
    let opens = 0;
    const dependencies: ContinuityAttuneGraphProjectorDependencies = {
      openLocal: vi.fn(async () => {
        const invocation = ++opens;
        trace.push(`open-${invocation.toString()}`);
        return {
          head: vi.fn(async () => {
            trace.push(`head-${invocation.toString()}`);
            return head;
          }),
          project: vi.fn(async () => {
            trace.push(`project-${invocation.toString()}`);
            if (invocation === 1) await firstGate.promise;
            head = snapshot(invocation);
            return head;
          }),
          close: vi.fn(async () => {
            trace.push(`close-${invocation.toString()}`);
          })
        };
      })
    };
    const projector = createContinuityAttuneGraphProjectorWithDependencies(
      { databasePath: "/tmp/serialized-attunegraph.sqlite" },
      dependencies
    );

    const first = projector.project(observation());
    const second = projector.project(observation(SECOND_AT, 2));
    await vi.waitFor(() =>
      expect(trace).toEqual(["open-1", "head-1", "project-1"])
    );
    firstGate.resolve();
    await expect(Promise.all([first, second])).resolves.toMatchObject([
      { snapshot: { generation: 1 } },
      { snapshot: { generation: 2 } }
    ]);
    expect(trace).toEqual([
      "open-1",
      "head-1",
      "project-1",
      "close-1",
      "open-2",
      "head-2",
      "project-2",
      "close-2"
    ]);
  });

  it("rejects invalid configuration and receipts before opening a Store", async () => {
    expect(() =>
      createContinuityAttuneGraphProjector({
        databasePath: "relative.sqlite"
      })
    ).toThrow(ContinuityAttuneGraphProjectionError);
    expect(() =>
      createContinuityAttuneGraphProjector(
        new Proxy({ databasePath: "/tmp/proxy.sqlite" }, {})
      )
    ).toThrow(expect.objectContaining({ code: "INVALID_CONFIGURATION" }));

    const openLocal = vi.fn();
    const projector = createContinuityAttuneGraphProjectorWithDependencies(
      { databasePath: "/tmp/invalid-receipt.sqlite" },
      { openLocal }
    );
    const tampered = JSON.parse(
      JSON.stringify(observation())
    ) as Record<string, unknown>;
    tampered.receiptId = `muse-continuity-observation:v1:sha256:${"0".repeat(64)}`;
    await expect(projector.project(tampered)).rejects.toMatchObject({
      code: "INVALID_OBSERVATION",
      message: "Continuity Graph Observation Receipt is invalid"
    });
    expect(openLocal).not.toHaveBeenCalled();
  });

  it("does not retry a stale external-writer conflict and still closes", async () => {
    const conflict = new AttuneGraphError(
      "SNAPSHOT_CONFLICT",
      "expected snapshot is stale"
    );
    const project = vi.fn(async () => {
      throw conflict;
    });
    const close = vi.fn(async () => undefined);
    const openLocal = vi.fn(async () => ({
      head: vi.fn(async () => snapshot(1)),
      project,
      close
    }));
    const projector = createContinuityAttuneGraphProjectorWithDependencies(
      { databasePath: "/tmp/stale-head.sqlite" },
      { openLocal }
    );

    const failure = await projector.project(observation())
      .catch((cause: unknown) => cause);
    expect(failure).toMatchObject({ code: "PROJECTION_FAILED" });
    expect((failure as Error).cause).toBe(conflict);
    expect(openLocal).toHaveBeenCalledOnce();
    expect(project).toHaveBeenCalledOnce();
    expect(project).toHaveBeenCalledWith(expect.objectContaining({
      operator: "canonical-projection@2",
      observation: expect.objectContaining({
        schemaVersion: 2,
        threadRoot: continuityThreadGraphRef({
          sourceId: SOURCE_ID,
          threadId: THREAD_ID
        })
      })
    }));
    expect(close).toHaveBeenCalledOnce();
  });

  it("preserves a primary failure over close and surfaces close-only failure", async () => {
    const primary = new Error("private-primary");
    const cleanup = new Error("private-cleanup");
    const failing = createContinuityAttuneGraphProjectorWithDependencies(
      { databasePath: "/tmp/primary-wins.sqlite" },
      {
        openLocal: async () => ({
          head: async () => undefined,
          project: async () => {
            throw primary;
          },
          close: async () => {
            throw cleanup;
          }
        })
      }
    );
    const primaryFailure = await failing.project(observation())
      .catch((cause: unknown) => cause);
    expect(primaryFailure).toMatchObject({ code: "PROJECTION_FAILED" });
    expect((primaryFailure as Error).cause).toBe(primary);

    const closeOnly = createContinuityAttuneGraphProjectorWithDependencies(
      { databasePath: "/tmp/close-only.sqlite" },
      {
        openLocal: async () => ({
          head: async () => undefined,
          project: async () => snapshot(1),
          close: async () => {
            throw cleanup;
          }
        })
      }
    );
    const closeFailure = await closeOnly.project(observation())
      .catch((cause: unknown) => cause);
    expect(closeFailure).toMatchObject({ code: "PROJECTION_FAILED" });
    expect((closeFailure as Error).cause).toBe(cleanup);
  });

  it("shares one lazy session, drains admitted work, and rejects work after close begins", async () => {
    const firstGate = Promise.withResolvers<void>();
    const trace: string[] = [];
    let generation = 0;
    let head: AttuneGraphSnapshot | undefined;
    const closeSession = vi.fn(async () => {
      trace.push("session-close");
    });
    const open = vi.fn(async () => {
      const invocation = generation + 1;
      trace.push(`handle-open-${invocation.toString()}`);
      return {
        head: vi.fn(async () => head),
        project: vi.fn(async () => {
          trace.push(`project-${invocation.toString()}`);
          if (invocation === 1) await firstGate.promise;
          generation = invocation;
          head = snapshot(invocation);
          return head;
        }),
        close: vi.fn(async () => {
          trace.push(`handle-close-${invocation.toString()}`);
        })
      };
    });
    const openSession = vi.fn(async () => {
      trace.push("session-open");
      return { close: closeSession, open };
    });
    const dependencies: ContinuityAttuneGraphSessionProjectorDependencies = {
      openSession
    };
    const projector = createContinuityAttuneGraphSessionProjectorWithDependencies(
      { databasePath: "/tmp/shared-session-attunegraph.sqlite" },
      dependencies
    );

    expect(openSession).not.toHaveBeenCalled();
    const first = projector.project(observation());
    const second = projector.project(observation(SECOND_AT, 2));
    await vi.waitFor(() => expect(trace).toEqual([
      "session-open",
      "handle-open-1",
      "project-1"
    ]));

    const closing = projector.close();
    expect(projector.close()).toBe(closing);
    await expect(projector.project(observation())).rejects.toMatchObject({
      code: "CLOSED"
    });
    firstGate.resolve();

    await expect(Promise.all([first, second])).resolves.toMatchObject([
      { snapshot: { generation: 1 } },
      { snapshot: { generation: 2 } }
    ]);
    await expect(closing).resolves.toBeUndefined();
    expect(openSession).toHaveBeenCalledOnce();
    expect(open).toHaveBeenCalledTimes(2);
    expect(trace).toEqual([
      "session-open",
      "handle-open-1",
      "project-1",
      "handle-close-1",
      "handle-open-2",
      "project-2",
      "handle-close-2",
      "session-close"
    ]);
  });

  it("closes a session that resolves while close is waiting on its first project", async () => {
    const opening = Promise.withResolvers<Awaited<
      ReturnType<ContinuityAttuneGraphSessionProjectorDependencies["openSession"]>
    >>();
    const closeSession = vi.fn(async () => undefined);
    const openSession = vi.fn(() => opening.promise);
    const projector = createContinuityAttuneGraphSessionProjectorWithDependencies(
      { databasePath: "/tmp/open-race-attunegraph.sqlite" },
      { openSession }
    );
    const pending = projector.project(observation());
    await vi.waitFor(() => expect(openSession).toHaveBeenCalledOnce());

    const closing = projector.close();
    opening.resolve({
      close: closeSession,
      open: async () => ({
        close: async () => undefined,
        head: async () => undefined,
        project: async () => snapshot(1)
      })
    });

    await expect(pending).resolves.toMatchObject({
      snapshot: { generation: 1 }
    });
    await expect(closing).resolves.toBeUndefined();
    expect(closeSession).toHaveBeenCalledOnce();
  });

  it("closes without opening a session when no work was admitted", async () => {
    const openSession = vi.fn();
    const projector = createContinuityAttuneGraphSessionProjectorWithDependencies(
      { databasePath: "/tmp/unused-shared-session-attunegraph.sqlite" },
      { openSession }
    );

    await expect(projector.close()).resolves.toBeUndefined();
    expect(openSession).not.toHaveBeenCalled();
    await expect(projector.project(observation())).rejects.toMatchObject({
      code: "CLOSED"
    });
  });
});
