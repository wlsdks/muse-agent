import { expect, it } from "vitest";

import { AttuneGraphError, openAttuneGraph } from "./index.js";
import { createAttuneGraphStore, type AttuneGraphStoreBackend } from "./attunegraph-backend.js";
import { createInMemoryAttuneGraphStore, InMemoryAttuneGraphStoreBackend, runAttuneGraphStoreConformance } from "./testing.js";
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
  options: {
    readonly scope?: typeof SCOPE;
    readonly freshness?: "fresh" | "stale" | "unknown";
    readonly assertions?: readonly GraphAssertion[];
    readonly observedAt?: string;
  } = {}
) {
  const observedAt = options.observedAt ?? NOW;
  return {
    operator: "canonical-projection@1" as const,
    observation: {
      schemaVersion: 1 as const,
      observationKey: id,
      scope: options.scope ?? SCOPE,
      observedAt,
      sourceFreshness: { state: options.freshness ?? "fresh", observedAt },
      assertions: options.assertions ?? [assertion(id)]
    }
  };
}

it("binds one exact scope and has replay-safe content-addressed projection", async () => {
  const attuneGraph = await openAttuneGraph({ scope: SCOPE, store: createInMemoryAttuneGraphStore() });
  await expect(attuneGraph.head()).resolves.toBeUndefined();
  const first = await attuneGraph.project(command("one"));
  const head = await attuneGraph.head();
  expect(head).toEqual(first);
  expect(head).not.toBe(first);
  expect(Object.isFrozen(head)).toBe(true);
  expect(Object.isFrozen(head?.scope)).toBe(true);
  const replay = await attuneGraph.project(command("one"));
  expect(replay).toEqual(first);
  await expect(attuneGraph.project(command("foreign", { scope: OTHER_SCOPE }))).rejects.toMatchObject({ code: "INVALID_SCOPE" });
  expect(Object.isFrozen(first)).toBe(true);
  expect(Object.isFrozen(first.scope)).toBe(true);
});

it("rejects content-id collision, stale CAS, and cross-scope snapshots", async () => {
  const store = createInMemoryAttuneGraphStore();
  const attuneGraph = await openAttuneGraph({ scope: SCOPE, store });
  const first = await attuneGraph.project(command("one"));
  await expect(attuneGraph.project({
    ...command("wrong-id", { assertions: [] }),
    observation: { ...command("wrong-id", { assertions: [] }).observation, observationId: "wrong-id" }
  } as never)).rejects.toMatchObject({ code: "INVALID_INPUT" });
  const second = await attuneGraph.project({
    ...command("two", { observedAt: "2026-07-30T00:00:01.000Z" }),
    expectedSnapshot: first
  });
  await expect(attuneGraph.project({ ...command("three"), expectedSnapshot: first })).rejects.toMatchObject({ code: "SNAPSHOT_CONFLICT" });
  const other = await openAttuneGraph({ scope: OTHER_SCOPE, store });
  await expect(other.project({ ...command("other", { scope: OTHER_SCOPE }), expectedSnapshot: second })).rejects.toMatchObject({ code: "SNAPSHOT_SCOPE_MISMATCH" });
});

it("rejects delayed source observations before they can replace newer truth", async () => {
  const attuneGraph = await openAttuneGraph({
    scope: SCOPE,
    store: createInMemoryAttuneGraphStore()
  });
  const first = await attuneGraph.project(command("first"));
  const second = await attuneGraph.project({
    ...command("second", { observedAt: "2026-07-30T00:00:02.000Z" }),
    expectedSnapshot: first
  });

  await expect(attuneGraph.project({
    ...command("delayed", { observedAt: "2026-07-30T00:00:01.000Z" }),
    expectedSnapshot: second
  })).rejects.toMatchObject({ code: "SNAPSHOT_CONFLICT" });
  await expect(attuneGraph.head()).resolves.toEqual(second);
});

it("reports separate freshness and deterministic partial Working Graph truncation", async () => {
  const attuneGraph = await openAttuneGraph({ scope: SCOPE, store: createInMemoryAttuneGraphStore() });
  await attuneGraph.project(command("stale", { freshness: "stale", assertions: [assertion("one"), assertion("two")] }));
  const result = await attuneGraph.execute({ operator: "working-graph@1", seed: { id: SCOPE.threadId, kind: "thread" }, now: NOW, maxEstimatedTokens: 1 });
  expect(result.status).toBe("partial");
  expect(result.sourceFreshness.state).toBe("stale");
  expect(result.workingGraph.diagnostics.truncationReasons).toContain("token-budget");
  expect(Object.isFrozen(result)).toBe(true);
  expect(Object.isFrozen(result.workingGraph.assertions)).toBe(true);
});

it("deduplicates assertions, reports a depth-boundary omission, and abstains only when empty", async () => {
  const attuneGraph = await openAttuneGraph({ scope: SCOPE, store: createInMemoryAttuneGraphStore() });
  const duplicate = assertion("duplicate");
  await attuneGraph.project(command("duplicate", { assertions: [duplicate, JSON.parse(JSON.stringify(duplicate)) as GraphAssertion] }));
  const deduped = await attuneGraph.execute({ operator: "working-graph@1", seed: { id: SCOPE.threadId, kind: "thread" }, now: NOW, maxEstimatedTokens: 4_000 });
  expect(deduped.status).toBe("complete");
  expect(deduped.workingGraph.assertions).toHaveLength(1);
  const snapshot = deduped.snapshot;
  await attuneGraph.project({ ...command("chain", { assertions: chainAssertions() }), expectedSnapshot: snapshot });
  const bounded = await attuneGraph.execute({ operator: "working-graph@1", seed: { id: SCOPE.threadId, kind: "thread" }, now: NOW, maxEstimatedTokens: 4_000 });
  expect(bounded.workingGraph.assertions.map((item) => item.id)).toEqual(["chain-one", "chain-two"]);
  expect(bounded.status).toBe("partial");
  expect(bounded.workingGraph.diagnostics.truncationReasons).toContain("traversal-budget");
  const abstained = await attuneGraph.execute({ operator: "working-graph@1", seed: { id: "unrelated", kind: "thread" }, now: NOW, maxEstimatedTokens: 4_000 });
  expect(abstained.status).toBe("abstained");
  expect(abstained.workingGraph.diagnostics.truncationReasons).toEqual([]);
});

it("detaches nested caller values and pins one validated Store head per execute", async () => {
  const backend = new InMemoryAttuneGraphStoreBackend();
  let reads = 0;
  const counted: AttuneGraphStoreBackend = {
    async read(scope) { reads += 1; return backend.read(scope); },
    compareAndSwap: backend.compareAndSwap.bind(backend)
  };
  const attuneGraph = await openAttuneGraph({ scope: SCOPE, store: createAttuneGraphStore(counted) });
  const mutable = assertion("mutable") as GraphAssertion & { sourceRefs: GraphAssertion["sourceRefs"] };
  const input = command("mutable", { assertions: [mutable] });
  await attuneGraph.project(input);
  (mutable.sourceRefs[0] as { id: string }).id = "mutated-after-project";
  reads = 0;
  const result = await attuneGraph.execute({ operator: "working-graph@1", seed: { id: SCOPE.threadId, kind: "thread" }, now: NOW, maxEstimatedTokens: 4_000 });
  expect(reads).toBe(1);
  expect(result.snapshot.generation).toBe(1);
  expect(result.workingGraph.assertions[0]?.sourceRefs[0]?.id).toBe("source-mutable");
  expect(Object.isFrozen(result.workingGraph.assertions[0]?.sourceRefs)).toBe(true);
});

it("rejects proxy/accessor Adapters before invocation and keeps bound Store methods safe", async () => {
  let accessed = 0;
  const accessor = Object.create(null) as AttuneGraphStoreBackend;
  Object.defineProperty(accessor, "read", { enumerable: true, get: () => { accessed += 1; return async () => undefined; } });
  Object.defineProperty(accessor, "compareAndSwap", { enumerable: true, value: async () => true });
  expect(() => createAttuneGraphStore(accessor)).toThrow(/data method/u);
  expect(accessed).toBe(0);
  const proxied = new Proxy(new InMemoryAttuneGraphStoreBackend(), {});
  expect(() => createAttuneGraphStore(proxied)).toThrow(/non-proxy/u);
  const backend = new InMemoryAttuneGraphStoreBackend();
  const store = createAttuneGraphStore(backend);
  Object.defineProperty(backend, "read", { configurable: true, get: () => { throw new Error("late getter must not run"); } });
  const attuneGraph = await openAttuneGraph({ scope: SCOPE, store });
  await expect(attuneGraph.project(command("bound-method"))).resolves.toMatchObject({ generation: 1 });
});

it("fails closed for Store scope corruption and drains accepted work before close resolves", async () => {
  const backing = new InMemoryAttuneGraphStoreBackend();
  const seed = await openAttuneGraph({ scope: SCOPE, store: createAttuneGraphStore(backing) });
  await seed.project(command("seed"));
  const scopeCorrupt: AttuneGraphStoreBackend = {
    async read(scope) {
      const raw = await backing.read(scope);
      return raw === undefined ? undefined : { ...raw, snapshot: { ...raw.snapshot, scope: OTHER_SCOPE } };
    },
    compareAndSwap: backing.compareAndSwap.bind(backing)
  };
  const corrupt = await openAttuneGraph({ scope: SCOPE, store: createAttuneGraphStore(scopeCorrupt) });
  await expect(corrupt.execute({ operator: "working-graph@1", seed: { id: SCOPE.threadId, kind: "thread" }, now: NOW, maxEstimatedTokens: 64 })).rejects.toMatchObject({ code: "CORRUPT_STORE" });
  const invalidCanonical: AttuneGraphStoreBackend = {
    async read(scope) {
      const raw = await backing.read(scope);
      return raw === undefined ? undefined : { ...raw, canonicalProjection: JSON.stringify({ schemaVersion: 1 }) };
    },
    compareAndSwap: backing.compareAndSwap.bind(backing)
  };
  const malformed = await openAttuneGraph({ scope: SCOPE, store: createAttuneGraphStore(invalidCanonical) });
  await expect(malformed.execute({ operator: "working-graph@1", seed: { id: SCOPE.threadId, kind: "thread" }, now: NOW, maxEstimatedTokens: 64 })).rejects.toMatchObject({ code: "CORRUPT_STORE" });
  const overBudgetCanonical: AttuneGraphStoreBackend = {
    async read(scope) {
      const raw = await backing.read(scope);
      return raw === undefined ? undefined : { ...raw, canonicalProjection: JSON.stringify("x".repeat(1_048_576)) };
    },
    compareAndSwap: backing.compareAndSwap.bind(backing)
  };
  const oversized = await openAttuneGraph({ scope: SCOPE, store: createAttuneGraphStore(overBudgetCanonical) });
  await expect(oversized.execute({ operator: "working-graph@1", seed: { id: SCOPE.threadId, kind: "thread" }, now: NOW, maxEstimatedTokens: 64 })).rejects.toMatchObject({ code: "CORRUPT_STORE" });

  const gate = deferred();
  const entered = deferred();
  const delayed: AttuneGraphStoreBackend = {
    read: backing.read.bind(backing),
    async compareAndSwap(scope, expected, proposed) {
      entered.resolve();
      await gate.promise;
      return backing.compareAndSwap(scope, expected, proposed);
    }
  };
  const closing = await openAttuneGraph({ scope: OTHER_SCOPE, store: createAttuneGraphStore(delayed) });
  const write = closing.project(command("delayed", { scope: OTHER_SCOPE }));
  await entered.promise;
  let closeResolved = false;
  const close = closing.close().then(() => { closeResolved = true; });
  await expect(closing.execute({ operator: "working-graph@1", seed: { id: OTHER_SCOPE.threadId, kind: "thread" }, now: NOW, maxEstimatedTokens: 64 })).rejects.toMatchObject({ code: "CLOSED" });
  expect(closeResolved).toBe(false);
  gate.resolve();
  await Promise.all([write, close]);
  const verifier = await openAttuneGraph({ scope: OTHER_SCOPE, store: createAttuneGraphStore(backing) });
  await expect(verifier.execute({ operator: "working-graph@1", seed: { id: OTHER_SCOPE.threadId, kind: "thread" }, now: NOW, maxEstimatedTokens: 64 })).resolves.toMatchObject({ snapshot: { generation: 1 } });
});

it("converges concurrent identical first projections after one validated replay read", async () => {
  const backing = new InMemoryAttuneGraphStoreBackend();
  const barrier = deferred();
  let initialReads = 0;
  const gated: AttuneGraphStoreBackend = {
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
  const store = createAttuneGraphStore(gated);
  const first = await openAttuneGraph({ scope: SCOPE, store });
  const second = await openAttuneGraph({ scope: SCOPE, store });
  const same = command("concurrent-same");
  const [left, right] = await Promise.all([first.project(same), second.project(same)]);
  expect(left).toEqual(right);
  expect(left).toMatchObject({ generation: 1 });
  expect(initialReads).toBe(3);
});

it("rejects proxies and accessors without invoking them", async () => {
  const attuneGraph = await openAttuneGraph({ scope: SCOPE, store: createInMemoryAttuneGraphStore() });
  await expect(attuneGraph.project(new Proxy(command("proxy"), {}))).rejects.toMatchObject({ code: "INVALID_INPUT" });
  const accessor = Object.create(null) as Record<string, unknown>;
  Object.defineProperty(accessor, "operator", { enumerable: true, get: () => "canonical-projection@1" });
  Object.defineProperty(accessor, "observation", { enumerable: true, value: command("accessor").observation });
  await expect(attuneGraph.project(accessor as never)).rejects.toMatchObject({ code: "INVALID_INPUT" });
});

it("close is idempotent and permanently closes head, project, and execute", async () => {
  const attuneGraph = await openAttuneGraph({ scope: SCOPE, store: createInMemoryAttuneGraphStore() });
  await attuneGraph.close();
  await attuneGraph.close();
  await expect(attuneGraph.head()).rejects.toMatchObject({ code: "CLOSED" });
  await expect(attuneGraph.project(command("after-close"))).rejects.toMatchObject({ code: "CLOSED" } satisfies Pick<AttuneGraphError, "code">);
  await expect(attuneGraph.execute({ operator: "working-graph@1", seed: { id: SCOPE.threadId, kind: "thread" }, now: NOW, maxEstimatedTokens: 10 })).rejects.toMatchObject({ code: "CLOSED" });
});

it("runs the backend-neutral Store conformance corpus", async () => {
  await expect(runAttuneGraphStoreConformance(() => new InMemoryAttuneGraphStoreBackend())).resolves.toMatchObject({ passed: true });
});

it("disposes each lifecycle-scoped conformance backend", async () => {
  let disposals = 0;
  await expect(runAttuneGraphStoreConformance(() => ({
    backend: new InMemoryAttuneGraphStoreBackend(),
    dispose: () => {
      disposals += 1;
    }
  }))).resolves.toMatchObject({ passed: true });
  expect(disposals).toBe(5);
});
