import { createAttuneGraphStore, type AttuneGraphStoreBackend } from "./attunegraph-backend.js";
import { AttuneGraphError } from "./attunegraph-error.js";
import { openAttuneGraph } from "./attunegraph-engine.js";
import type { AttuneGraph, AttuneGraphExecuteCommand, AttuneGraphProjectCommand, AttuneGraphScope } from "./attunegraph-contracts.js";

export interface AttuneGraphStoreConformanceCase {
  readonly name: string;
  readonly passed: true;
}

export interface AttuneGraphStoreConformanceReport {
  readonly cases: readonly AttuneGraphStoreConformanceCase[];
  readonly passed: true;
}

export interface AttuneGraphStoreConformanceBackend {
  readonly backend: AttuneGraphStoreBackend;
  readonly dispose: () => void | Promise<void>;
}

/**
 * The bare backend form remains supported for the in-memory oracle. Durable
 * adapters should return the resource form so each corpus case closes its own
 * connection or Worker before the next case starts.
 */
export type AttuneGraphStoreBackendFactory = () =>
  | AttuneGraphStoreBackend
  | AttuneGraphStoreConformanceBackend
  | Promise<AttuneGraphStoreBackend | AttuneGraphStoreConformanceBackend>;

const SCOPE: AttuneGraphScope = { sourceId: "conformance-source", threadId: "conformance-thread" };
const OTHER_SCOPE: AttuneGraphScope = { sourceId: "conformance-source", threadId: "other-thread" };
const NOW = "2026-07-30T00:00:00.000Z";
const EXECUTE: AttuneGraphExecuteCommand = {
  operator: "working-graph@1",
  seed: { id: SCOPE.threadId, kind: "thread" },
  now: NOW,
  maxEstimatedTokens: 64
};

function observation(id: string, scope = SCOPE): AttuneGraphProjectCommand {
  return {
    operator: "canonical-projection@1",
    observation: {
      schemaVersion: 1,
      observationKey: id,
      scope,
      observedAt: NOW,
      sourceFreshness: { state: "fresh", observedAt: NOW },
      assertions: []
    }
  };
}

function check(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function isCode(cause: unknown, code: AttuneGraphError["code"]): boolean {
  return cause instanceof AttuneGraphError && cause.code === code;
}

async function rejectsCode(operation: () => Promise<unknown>, code: AttuneGraphError["code"]): Promise<void> {
  try {
    await operation();
  } catch (cause) {
    check(isCode(cause, code), `expected ${code}`);
    return;
  }
  throw new Error(`expected rejection with ${code}`);
}

async function one(name: string, operation: () => Promise<void>): Promise<AttuneGraphStoreConformanceCase> {
  try {
    await operation();
    return Object.freeze({ name, passed: true as const });
  } catch (cause) {
    throw new Error(`AttuneGraph Store conformance failed: ${name}`, { cause });
  }
}

function isConformanceBackend(value: AttuneGraphStoreBackend | AttuneGraphStoreConformanceBackend): value is AttuneGraphStoreConformanceBackend {
  return "backend" in value && "dispose" in value;
}

async function withBackend(
  createBackend: AttuneGraphStoreBackendFactory,
  operation: (backend: AttuneGraphStoreBackend) => Promise<void>
): Promise<void> {
  const created = await createBackend();
  const resource = isConformanceBackend(created)
    ? created
    : { backend: created, dispose: () => undefined };
  try {
    await operation(resource.backend);
  } finally {
    await resource.dispose();
  }
}

async function closeAttuneGraphs(...attuneGraphs: readonly (AttuneGraph | undefined)[]): Promise<void> {
  await Promise.all(attuneGraphs.map(async (attuneGraph) => attuneGraph === undefined ? undefined : attuneGraph.close()));
}

/**
 * Backend-neutral executable Store Adapter contract. A SQLite Adapter must pass
 * this corpus unchanged: atomic first-write CAS, no-write failed CAS, independent
 * scopes, replay, detached reads, and fail-closed corrupt State handling.
 */
export async function runAttuneGraphStoreConformance(createBackend: AttuneGraphStoreBackendFactory): Promise<AttuneGraphStoreConformanceReport> {
  const definitions: readonly (readonly [string, () => Promise<void>])[] = [
    ["concurrent first compare-and-swap has exactly one winner", () => withBackend(createBackend, async (backend) => {
      let first: AttuneGraph | undefined;
      let second: AttuneGraph | undefined;
      try {
        first = await openAttuneGraph({ scope: SCOPE, store: createAttuneGraphStore(backend) });
        second = await openAttuneGraph({ scope: SCOPE, store: createAttuneGraphStore(backend) });
        const results = await Promise.allSettled([first.project(observation("first-a")), second.project(observation("first-b"))]);
        check(results.filter((result) => result.status === "fulfilled").length === 1, "exactly one first CAS succeeds");
        check(results.filter((result) => result.status === "rejected" && isCode(result.reason, "SNAPSHOT_CONFLICT")).length === 1, "losing first CAS reports a conflict");
      } finally {
        await closeAttuneGraphs(first, second);
      }
    })],
    ["concurrent identical first projection converges as an exact replay", () => withBackend(createBackend, async (backend) => {
      let first: AttuneGraph | undefined;
      let second: AttuneGraph | undefined;
      try {
        first = await openAttuneGraph({ scope: SCOPE, store: createAttuneGraphStore(backend) });
        second = await openAttuneGraph({ scope: SCOPE, store: createAttuneGraphStore(backend) });
        const command = observation("same-first");
        const [left, right] = await Promise.all([first.project(command), second.project(command)]);
        check(left.generation === 1 && right.generation === 1 && left.commitId === right.commitId, "identical first projection converges on the winning head");
      } finally {
        await closeAttuneGraphs(first, second);
      }
    })],
    ["stale compare-and-swap fails without changing the pinned head", () => withBackend(createBackend, async (backend) => {
      let attuneGraph: AttuneGraph | undefined;
      try {
        const opened = await openAttuneGraph({ scope: SCOPE, store: createAttuneGraphStore(backend) });
        attuneGraph = opened;
        const first = await opened.project(observation("first"));
        const second = await opened.project({ ...observation("second"), expectedSnapshot: first });
        await rejectsCode(() => opened.project({ ...observation("third"), expectedSnapshot: first }), "SNAPSHOT_CONFLICT");
        const replay = await opened.project(observation("second"));
        const executed = await opened.execute(EXECUTE);
        check(replay.commitId === second.commitId && executed.snapshot.commitId === second.commitId, "failed CAS leaves the prior head unchanged");
      } finally {
        await closeAttuneGraphs(attuneGraph);
      }
    })],
    ["scopes replay and execute independently", () => withBackend(createBackend, async (backend) => {
      let first: AttuneGraph | undefined;
      let second: AttuneGraph | undefined;
      try {
        first = await openAttuneGraph({ scope: SCOPE, store: createAttuneGraphStore(backend) });
        second = await openAttuneGraph({ scope: OTHER_SCOPE, store: createAttuneGraphStore(backend) });
        const firstSnapshot = await first.project(observation("first-scope"));
        const secondSnapshot = await second.project(observation("second-scope", OTHER_SCOPE));
        const replay = await first.project(observation("first-scope"));
        const firstResult = await first.execute(EXECUTE);
        const secondResult = await second.execute({ ...EXECUTE, seed: { id: OTHER_SCOPE.threadId, kind: "thread" } });
        check(replay.commitId === firstSnapshot.commitId, "exact canonical replay succeeds");
        check(firstResult.snapshot.commitId === firstSnapshot.commitId && secondResult.snapshot.commitId === secondSnapshot.commitId, "each scope remains executable at its own head");
      } finally {
        await closeAttuneGraphs(first, second);
      }
    })],
    ["reads are detached and corrupt or future state fails closed", () => withBackend(createBackend, async (backend) => {
      let seed: AttuneGraph | undefined;
      let corruptAttuneGraph: AttuneGraph | undefined;
      let futureAttuneGraph: AttuneGraph | undefined;
      try {
        seed = await openAttuneGraph({ scope: SCOPE, store: createAttuneGraphStore(backend) });
        await seed.project(observation("detached"));
        const oneRead = await backend.read(SCOPE);
        const nextRead = await backend.read(SCOPE);
        check(oneRead !== undefined && nextRead !== undefined && oneRead !== nextRead && oneRead.snapshot !== nextRead.snapshot, "read returns detached state");
        const corrupt: AttuneGraphStoreBackend = {
          async read(scope) {
            const raw = await backend.read(scope);
            return raw === undefined ? undefined : { ...raw, projectionFingerprint: "collision" };
          },
          compareAndSwap: backend.compareAndSwap.bind(backend)
        };
        const openedCorrupt = await openAttuneGraph({ scope: SCOPE, store: createAttuneGraphStore(corrupt) });
        corruptAttuneGraph = openedCorrupt;
        await rejectsCode(() => openedCorrupt.execute(EXECUTE), "CORRUPT_STORE");
        const future: AttuneGraphStoreBackend = {
          async read(scope) {
            const raw = await backend.read(scope);
            return raw === undefined ? undefined : { ...raw, schemaVersion: 2 } as never;
          },
          compareAndSwap: backend.compareAndSwap.bind(backend)
        };
        const openedFuture = await openAttuneGraph({ scope: SCOPE, store: createAttuneGraphStore(future) });
        futureAttuneGraph = openedFuture;
        await rejectsCode(() => openedFuture.execute(EXECUTE), "FUTURE_STORE_STATE");
      } finally {
        await closeAttuneGraphs(seed, corruptAttuneGraph, futureAttuneGraph);
      }
    })]
  ];
  const cases: AttuneGraphStoreConformanceCase[] = [];
  for (const [name, operation] of definitions) cases.push(await one(name, operation));
  return Object.freeze({ cases: Object.freeze(cases), passed: true as const });
}
