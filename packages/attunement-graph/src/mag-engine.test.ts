import { expect, it } from "vitest";

import { MagError, openMag } from "./index.js";
import { createMagStore, type MagStoreBackend } from "./mag-backend.js";
import { createInMemoryMagStore, InMemoryMagStoreBackend, runMagStoreConformance } from "./testing.js";
import type { GraphAssertion } from "./types.js";

const SCOPE = { sourceId: "source-a", threadId: "thread-a" };
const OTHER_SCOPE = { sourceId: "source-a", threadId: "thread-b" };
const NOW = "2026-07-30T00:00:00.000Z";

function assertion(id: string): GraphAssertion {
  return {
    schemaVersion: 1,
    id,
    subject: { id: `artifact-${id}`, kind: "artifact" },
    predicate: "LINKED_TO",
    object: { id: SCOPE.threadId, kind: "thread" },
    epistemicClass: "source-observed",
    sourceRefs: [{ id: `source-${id}`, namespace: "test.source" }],
    recordedAt: NOW,
    derivation: { kind: "projection", version: "test@1" }
  };
}

function chainAssertions(): readonly GraphAssertion[] {
  const two = assertion("chain-two");
  const three = assertion("chain-three");
  return JSON.parse(JSON.stringify([
    assertion("chain-one"),
    {
      ...two,
      subject: { id: "artifact-chain-one", kind: "artifact" },
      predicate: "DERIVED_FROM",
      object: { id: "evidence-chain", kind: "evidence" },
      sourceRefs: two.sourceRefs.map((ref) => ({ ...ref })),
      derivation: { ...two.derivation }
    },
    {
      ...three,
      subject: { id: "evidence-chain", kind: "evidence" },
      predicate: "DERIVED_FROM",
      object: { id: "evidence-chain-two", kind: "evidence" },
      sourceRefs: three.sourceRefs.map((ref) => ({ ...ref })),
      derivation: { ...three.derivation }
    }
  ])) as readonly GraphAssertion[];
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => { resolvePromise = resolve; });
  return { promise, resolve: () => resolvePromise?.() };
}

function command(
  id: string,
  options: { readonly scope?: typeof SCOPE; readonly freshness?: "fresh" | "stale" | "unknown"; readonly assertions?: readonly GraphAssertion[] } = {}
) {
  return {
    operator: "canonical-projection@1" as const,
    observation: {
      schemaVersion: 1 as const,
      observationKey: id,
      scope: options.scope ?? SCOPE,
      observedAt: NOW,
      sourceFreshness: { state: options.freshness ?? "fresh", observedAt: NOW },
      assertions: options.assertions ?? [assertion(id)]
    }
  };
}

it("binds one exact scope and has replay-safe content-addressed projection", async () => {
  const mag = await openMag({ scope: SCOPE, store: createInMemoryMagStore() });
  const first = await mag.project(command("one"));
  const replay = await mag.project(command("one"));
  expect(replay).toEqual(first);
  await expect(mag.project(command("foreign", { scope: OTHER_SCOPE }))).rejects.toMatchObject({ code: "INVALID_SCOPE" });
  expect(Object.isFrozen(first)).toBe(true);
  expect(Object.isFrozen(first.scope)).toBe(true);
});

it("rejects content-id collision, stale CAS, and cross-scope snapshots", async () => {
  const store = createInMemoryMagStore();
  const mag = await openMag({ scope: SCOPE, store });
  const first = await mag.project(command("one"));
  await expect(mag.project({
    ...command("wrong-id", { assertions: [] }),
    observation: { ...command("wrong-id", { assertions: [] }).observation, observationId: "wrong-id" }
  } as never)).rejects.toMatchObject({ code: "INVALID_INPUT" });
  const second = await mag.project({ ...command("two"), expectedSnapshot: first });
  await expect(mag.project({ ...command("three"), expectedSnapshot: first })).rejects.toMatchObject({ code: "SNAPSHOT_CONFLICT" });
  const other = await openMag({ scope: OTHER_SCOPE, store });
  await expect(other.project({ ...command("other", { scope: OTHER_SCOPE }), expectedSnapshot: second })).rejects.toMatchObject({ code: "SNAPSHOT_SCOPE_MISMATCH" });
});

it("reports separate freshness and deterministic partial Working Graph truncation", async () => {
  const mag = await openMag({ scope: SCOPE, store: createInMemoryMagStore() });
  await mag.project(command("stale", { freshness: "stale", assertions: [assertion("one"), assertion("two")] }));
  const result = await mag.execute({ operator: "working-graph@1", seed: { id: SCOPE.threadId, kind: "thread" }, now: NOW, maxEstimatedTokens: 1 });
  expect(result.status).toBe("partial");
  expect(result.sourceFreshness.state).toBe("stale");
  expect(result.workingGraph.diagnostics.truncationReasons).toContain("token-budget");
  expect(Object.isFrozen(result)).toBe(true);
  expect(Object.isFrozen(result.workingGraph.assertions)).toBe(true);
});

it("deduplicates assertions, reports a depth-boundary omission, and abstains only when empty", async () => {
  const mag = await openMag({ scope: SCOPE, store: createInMemoryMagStore() });
  const duplicate = assertion("duplicate");
  await mag.project(command("duplicate", { assertions: [duplicate, JSON.parse(JSON.stringify(duplicate)) as GraphAssertion] }));
  const deduped = await mag.execute({ operator: "working-graph@1", seed: { id: SCOPE.threadId, kind: "thread" }, now: NOW, maxEstimatedTokens: 4_000 });
  expect(deduped.status).toBe("complete");
  expect(deduped.workingGraph.assertions).toHaveLength(1);
  const snapshot = deduped.snapshot;
  await mag.project({ ...command("chain", { assertions: chainAssertions() }), expectedSnapshot: snapshot });
  const bounded = await mag.execute({ operator: "working-graph@1", seed: { id: SCOPE.threadId, kind: "thread" }, now: NOW, maxEstimatedTokens: 4_000 });
  expect(bounded.workingGraph.assertions.map((item) => item.id)).toEqual(["chain-one", "chain-two"]);
  expect(bounded.status).toBe("partial");
  expect(bounded.workingGraph.diagnostics.truncationReasons).toContain("traversal-budget");
  const abstained = await mag.execute({ operator: "working-graph@1", seed: { id: "unrelated", kind: "thread" }, now: NOW, maxEstimatedTokens: 4_000 });
  expect(abstained.status).toBe("abstained");
  expect(abstained.workingGraph.diagnostics.truncationReasons).toEqual([]);
});

it("detaches nested caller values and pins one validated Store head per execute", async () => {
  const backend = new InMemoryMagStoreBackend();
  let reads = 0;
  const counted: MagStoreBackend = {
    async read(scope) { reads += 1; return backend.read(scope); },
    compareAndSwap: backend.compareAndSwap.bind(backend)
  };
  const mag = await openMag({ scope: SCOPE, store: createMagStore(counted) });
  const mutable = assertion("mutable") as GraphAssertion & { sourceRefs: GraphAssertion["sourceRefs"] };
  const input = command("mutable", { assertions: [mutable] });
  await mag.project(input);
  (mutable.sourceRefs[0] as { id: string }).id = "mutated-after-project";
  reads = 0;
  const result = await mag.execute({ operator: "working-graph@1", seed: { id: SCOPE.threadId, kind: "thread" }, now: NOW, maxEstimatedTokens: 4_000 });
  expect(reads).toBe(1);
  expect(result.snapshot.generation).toBe(1);
  expect(result.workingGraph.assertions[0]?.sourceRefs[0]?.id).toBe("source-mutable");
  expect(Object.isFrozen(result.workingGraph.assertions[0]?.sourceRefs)).toBe(true);
});

it("rejects proxy/accessor Adapters before invocation and keeps bound Store methods safe", async () => {
  let accessed = 0;
  const accessor = Object.create(null) as MagStoreBackend;
  Object.defineProperty(accessor, "read", { enumerable: true, get: () => { accessed += 1; return async () => undefined; } });
  Object.defineProperty(accessor, "compareAndSwap", { enumerable: true, value: async () => true });
  expect(() => createMagStore(accessor)).toThrow(/data method/u);
  expect(accessed).toBe(0);
  const proxied = new Proxy(new InMemoryMagStoreBackend(), {});
  expect(() => createMagStore(proxied)).toThrow(/non-proxy/u);
  const backend = new InMemoryMagStoreBackend();
  const store = createMagStore(backend);
  Object.defineProperty(backend, "read", { configurable: true, get: () => { throw new Error("late getter must not run"); } });
  const mag = await openMag({ scope: SCOPE, store });
  await expect(mag.project(command("bound-method"))).resolves.toMatchObject({ generation: 1 });
});

it("fails closed for Store scope corruption and drains accepted work before close resolves", async () => {
  const backing = new InMemoryMagStoreBackend();
  const seed = await openMag({ scope: SCOPE, store: createMagStore(backing) });
  await seed.project(command("seed"));
  const scopeCorrupt: MagStoreBackend = {
    async read(scope) {
      const raw = await backing.read(scope);
      return raw === undefined ? undefined : { ...raw, snapshot: { ...raw.snapshot, scope: OTHER_SCOPE } };
    },
    compareAndSwap: backing.compareAndSwap.bind(backing)
  };
  const corrupt = await openMag({ scope: SCOPE, store: createMagStore(scopeCorrupt) });
  await expect(corrupt.execute({ operator: "working-graph@1", seed: { id: SCOPE.threadId, kind: "thread" }, now: NOW, maxEstimatedTokens: 64 })).rejects.toMatchObject({ code: "CORRUPT_STORE" });
  const invalidCanonical: MagStoreBackend = {
    async read(scope) {
      const raw = await backing.read(scope);
      return raw === undefined ? undefined : { ...raw, canonicalProjection: JSON.stringify({ schemaVersion: 1 }) };
    },
    compareAndSwap: backing.compareAndSwap.bind(backing)
  };
  const malformed = await openMag({ scope: SCOPE, store: createMagStore(invalidCanonical) });
  await expect(malformed.execute({ operator: "working-graph@1", seed: { id: SCOPE.threadId, kind: "thread" }, now: NOW, maxEstimatedTokens: 64 })).rejects.toMatchObject({ code: "CORRUPT_STORE" });
  const overBudgetCanonical: MagStoreBackend = {
    async read(scope) {
      const raw = await backing.read(scope);
      return raw === undefined ? undefined : { ...raw, canonicalProjection: JSON.stringify("x".repeat(1_048_576)) };
    },
    compareAndSwap: backing.compareAndSwap.bind(backing)
  };
  const oversized = await openMag({ scope: SCOPE, store: createMagStore(overBudgetCanonical) });
  await expect(oversized.execute({ operator: "working-graph@1", seed: { id: SCOPE.threadId, kind: "thread" }, now: NOW, maxEstimatedTokens: 64 })).rejects.toMatchObject({ code: "CORRUPT_STORE" });

  const gate = deferred();
  const entered = deferred();
  const delayed: MagStoreBackend = {
    read: backing.read.bind(backing),
    async compareAndSwap(scope, expected, proposed) {
      entered.resolve();
      await gate.promise;
      return backing.compareAndSwap(scope, expected, proposed);
    }
  };
  const closing = await openMag({ scope: OTHER_SCOPE, store: createMagStore(delayed) });
  const write = closing.project(command("delayed", { scope: OTHER_SCOPE }));
  await entered.promise;
  let closeResolved = false;
  const close = closing.close().then(() => { closeResolved = true; });
  await expect(closing.execute({ operator: "working-graph@1", seed: { id: OTHER_SCOPE.threadId, kind: "thread" }, now: NOW, maxEstimatedTokens: 64 })).rejects.toMatchObject({ code: "CLOSED" });
  expect(closeResolved).toBe(false);
  gate.resolve();
  await Promise.all([write, close]);
  const verifier = await openMag({ scope: OTHER_SCOPE, store: createMagStore(backing) });
  await expect(verifier.execute({ operator: "working-graph@1", seed: { id: OTHER_SCOPE.threadId, kind: "thread" }, now: NOW, maxEstimatedTokens: 64 })).resolves.toMatchObject({ snapshot: { generation: 1 } });
});

it("converges concurrent identical first projections after one validated replay read", async () => {
  const backing = new InMemoryMagStoreBackend();
  const barrier = deferred();
  let initialReads = 0;
  const gated: MagStoreBackend = {
    async read(scope) {
      initialReads += 1;
      if (initialReads <= 2) {
        if (initialReads === 2) barrier.resolve();
        await barrier.promise;
      }
      return backing.read(scope);
    },
    compareAndSwap: backing.compareAndSwap.bind(backing)
  };
  const store = createMagStore(gated);
  const first = await openMag({ scope: SCOPE, store });
  const second = await openMag({ scope: SCOPE, store });
  const same = command("concurrent-same");
  const [left, right] = await Promise.all([first.project(same), second.project(same)]);
  expect(left).toEqual(right);
  expect(left).toMatchObject({ generation: 1 });
  expect(initialReads).toBe(3);
});

it("rejects proxies and accessors without invoking them", async () => {
  const mag = await openMag({ scope: SCOPE, store: createInMemoryMagStore() });
  await expect(mag.project(new Proxy(command("proxy"), {}))).rejects.toMatchObject({ code: "INVALID_INPUT" });
  const accessor = Object.create(null) as Record<string, unknown>;
  Object.defineProperty(accessor, "operator", { enumerable: true, get: () => "canonical-projection@1" });
  Object.defineProperty(accessor, "observation", { enumerable: true, value: command("accessor").observation });
  await expect(mag.project(accessor as never)).rejects.toMatchObject({ code: "INVALID_INPUT" });
});

it("close is idempotent and permanently closes project and execute", async () => {
  const mag = await openMag({ scope: SCOPE, store: createInMemoryMagStore() });
  await mag.close();
  await mag.close();
  await expect(mag.project(command("after-close"))).rejects.toMatchObject({ code: "CLOSED" } satisfies Pick<MagError, "code">);
  await expect(mag.execute({ operator: "working-graph@1", seed: { id: SCOPE.threadId, kind: "thread" }, now: NOW, maxEstimatedTokens: 10 })).rejects.toMatchObject({ code: "CLOSED" });
});

it("runs the backend-neutral Store conformance corpus", async () => {
  await expect(runMagStoreConformance(() => new InMemoryMagStoreBackend())).resolves.toMatchObject({ passed: true });
});
