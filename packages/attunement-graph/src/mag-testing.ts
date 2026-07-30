import { createMagStore, type MagStoreBackend } from "./mag-backend.js";
import { MagError } from "./mag-error.js";
import { openMag } from "./mag-engine.js";
import type { MagExecuteCommand, MagProjectCommand, MagScope } from "./mag-contracts.js";

export interface MagStoreConformanceCase {
  readonly name: string;
  readonly passed: true;
}

export interface MagStoreConformanceReport {
  readonly cases: readonly MagStoreConformanceCase[];
  readonly passed: true;
}

export type MagStoreBackendFactory = () => MagStoreBackend | Promise<MagStoreBackend>;

const SCOPE: MagScope = { sourceId: "conformance-source", threadId: "conformance-thread" };
const OTHER_SCOPE: MagScope = { sourceId: "conformance-source", threadId: "other-thread" };
const NOW = "2026-07-30T00:00:00.000Z";
const EXECUTE: MagExecuteCommand = {
  operator: "working-graph@1",
  seed: { id: SCOPE.threadId, kind: "thread" },
  now: NOW,
  maxEstimatedTokens: 64
};

function observation(id: string, scope = SCOPE): MagProjectCommand {
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

function isCode(cause: unknown, code: MagError["code"]): boolean {
  return cause instanceof MagError && cause.code === code;
}

async function rejectsCode(operation: () => Promise<unknown>, code: MagError["code"]): Promise<void> {
  try {
    await operation();
  } catch (cause) {
    check(isCode(cause, code), `expected ${code}`);
    return;
  }
  throw new Error(`expected rejection with ${code}`);
}

async function one(name: string, operation: () => Promise<void>): Promise<MagStoreConformanceCase> {
  try {
    await operation();
    return Object.freeze({ name, passed: true as const });
  } catch (cause) {
    throw new Error(`MAG Store conformance failed: ${name}`, { cause });
  }
}

/**
 * Backend-neutral executable Store Adapter contract. A SQLite Adapter must pass
 * this corpus unchanged: atomic first-write CAS, no-write failed CAS, independent
 * scopes, replay, detached reads, and fail-closed corrupt State handling.
 */
export async function runMagStoreConformance(createBackend: MagStoreBackendFactory): Promise<MagStoreConformanceReport> {
  const definitions: readonly (readonly [string, () => Promise<void>])[] = [
    ["concurrent first compare-and-swap has exactly one winner", async () => {
      const backend = await createBackend();
      const first = await openMag({ scope: SCOPE, store: createMagStore(backend) });
      const second = await openMag({ scope: SCOPE, store: createMagStore(backend) });
      const results = await Promise.allSettled([first.project(observation("first-a")), second.project(observation("first-b"))]);
      check(results.filter((result) => result.status === "fulfilled").length === 1, "exactly one first CAS succeeds");
      check(results.filter((result) => result.status === "rejected" && isCode(result.reason, "SNAPSHOT_CONFLICT")).length === 1, "losing first CAS reports a conflict");
      await Promise.all([first.close(), second.close()]);
    }],
    ["concurrent identical first projection converges as an exact replay", async () => {
      const backend = await createBackend();
      const first = await openMag({ scope: SCOPE, store: createMagStore(backend) });
      const second = await openMag({ scope: SCOPE, store: createMagStore(backend) });
      const command = observation("same-first");
      const [left, right] = await Promise.all([first.project(command), second.project(command)]);
      check(left.generation === 1 && right.generation === 1 && left.commitId === right.commitId, "identical first projection converges on the winning head");
      await Promise.all([first.close(), second.close()]);
    }],
    ["stale compare-and-swap fails without changing the pinned head", async () => {
      const backend = await createBackend();
      const mag = await openMag({ scope: SCOPE, store: createMagStore(backend) });
      const first = await mag.project(observation("first"));
      const second = await mag.project({ ...observation("second"), expectedSnapshot: first });
      await rejectsCode(() => mag.project({ ...observation("third"), expectedSnapshot: first }), "SNAPSHOT_CONFLICT");
      const replay = await mag.project(observation("second"));
      const executed = await mag.execute(EXECUTE);
      check(replay.commitId === second.commitId && executed.snapshot.commitId === second.commitId, "failed CAS leaves the prior head unchanged");
      await mag.close();
    }],
    ["scopes replay and execute independently", async () => {
      const backend = await createBackend();
      const first = await openMag({ scope: SCOPE, store: createMagStore(backend) });
      const second = await openMag({ scope: OTHER_SCOPE, store: createMagStore(backend) });
      const firstSnapshot = await first.project(observation("first-scope"));
      const secondSnapshot = await second.project(observation("second-scope", OTHER_SCOPE));
      const replay = await first.project(observation("first-scope"));
      const firstResult = await first.execute(EXECUTE);
      const secondResult = await second.execute({ ...EXECUTE, seed: { id: OTHER_SCOPE.threadId, kind: "thread" } });
      check(replay.commitId === firstSnapshot.commitId, "exact canonical replay succeeds");
      check(firstResult.snapshot.commitId === firstSnapshot.commitId && secondResult.snapshot.commitId === secondSnapshot.commitId, "each scope remains executable at its own head");
      await Promise.all([first.close(), second.close()]);
    }],
    ["reads are detached and corrupt or future state fails closed", async () => {
      const backend = await createBackend();
      const seed = await openMag({ scope: SCOPE, store: createMagStore(backend) });
      await seed.project(observation("detached"));
      const oneRead = await backend.read(SCOPE);
      const nextRead = await backend.read(SCOPE);
      check(oneRead !== undefined && nextRead !== undefined && oneRead !== nextRead && oneRead.snapshot !== nextRead.snapshot, "read returns detached state");
      const corrupt: MagStoreBackend = {
        async read(scope) {
          const raw = await backend.read(scope);
          return raw === undefined ? undefined : { ...raw, projectionFingerprint: "collision" };
        },
        compareAndSwap: backend.compareAndSwap.bind(backend)
      };
      const corruptMag = await openMag({ scope: SCOPE, store: createMagStore(corrupt) });
      await rejectsCode(() => corruptMag.execute(EXECUTE), "CORRUPT_STORE");
      const future: MagStoreBackend = {
        async read(scope) {
          const raw = await backend.read(scope);
          return raw === undefined ? undefined : { ...raw, schemaVersion: 2 } as never;
        },
        compareAndSwap: backend.compareAndSwap.bind(backend)
      };
      const futureMag = await openMag({ scope: SCOPE, store: createMagStore(future) });
      await rejectsCode(() => futureMag.execute(EXECUTE), "FUTURE_STORE_STATE");
      await Promise.all([seed.close(), corruptMag.close(), futureMag.close()]);
    }]
  ];
  const cases: MagStoreConformanceCase[] = [];
  for (const [name, operation] of definitions) cases.push(await one(name, operation));
  return Object.freeze({ cases: Object.freeze(cases), passed: true as const });
}
