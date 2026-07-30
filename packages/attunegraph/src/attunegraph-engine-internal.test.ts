import { expect, it } from "vitest";

import {
  canonicalizeImmutableEnvelope,
  mintCanonicalImmutableEnvelopeFromFrozenUnsignedForInternalUse
} from "./canonical-immutable-envelope.js";
import { createAttuneGraphStore, type AttuneGraphStoredProjection } from "./attunegraph-backend.js";
import {
  normalizeAttuneGraphScope,
  normalizeStoredProjection,
  openAttuneGraph
} from "./attunegraph-engine.js";
import { admitPortableProjection } from "./attunegraph-portable-admission.js";
import type { GraphAssertion } from "./types.js";

const SCOPE = { sourceId: "source-a", threadId: "thread-a" };
const OTHER_SCOPE = { sourceId: "source-a", threadId: "thread-b" };
const NOW = "2026-07-30T00:00:00.000Z";

function assertion(): GraphAssertion {
  return {
    schemaVersion: 1,
    id: "stored-assertion",
    subject: { id: "stored-artifact", kind: "artifact" },
    predicate: "LINKED_TO",
    object: { id: SCOPE.threadId, kind: "thread" },
    epistemicClass: "source-observed",
    sourceRefs: [{ id: "stored-source", namespace: "test.source" }],
    recordedAt: NOW,
    derivation: { kind: "projection", version: "test@1" }
  };
}

async function engineProjection(): Promise<AttuneGraphStoredProjection> {
  let captured: AttuneGraphStoredProjection | undefined;
  const attuneGraph = await openAttuneGraph({
    scope: SCOPE,
    store: createAttuneGraphStore({
      async read() {
        return undefined;
      },
      async compareAndSwap(_scope, _expected, proposed) {
        captured = JSON.parse(JSON.stringify(proposed)) as AttuneGraphStoredProjection;
        return true;
      }
    })
  });
  await attuneGraph.project({
    operator: "canonical-projection@1",
    observation: {
      schemaVersion: 1,
      observationKey: "stored-projection",
      scope: SCOPE,
      observedAt: NOW,
      sourceFreshness: { state: "fresh", observedAt: NOW },
      assertions: [assertion()]
    }
  });
  await attuneGraph.close();
  expect(captured).toBeDefined();
  return captured!;
}

function mutableProjection(
  projection: AttuneGraphStoredProjection
): Record<string, unknown> {
  return JSON.parse(JSON.stringify(projection)) as Record<string, unknown>;
}

function expectStoredError(
  value: unknown,
  code: "CORRUPT_STORE" | "FUTURE_STORE_STATE"
): void {
  try {
    normalizeStoredProjection(value, SCOPE);
  } catch (cause) {
    expect(cause).toMatchObject({ code });
    return;
  }
  throw new Error(`expected ${code}`);
}

function expectAttuneGraphError(
  operation: () => unknown,
  code: "INVALID_INPUT" | "CORRUPT_STORE" | "FUTURE_STORE_STATE"
): void {
  try {
    operation();
  } catch (cause) {
    expect(cause).toMatchObject({ code });
    return;
  }
  throw new Error(`expected ${code}`);
}

function expectDeeplyFrozen(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  expect(Object.isFrozen(value)).toBe(true);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    expect(descriptor).toBeDefined();
    expect(descriptor && "value" in descriptor).toBe(true);
    if (descriptor && "value" in descriptor) {
      expectDeeplyFrozen(descriptor.value);
    }
  }
}

it("normalizes the exact valid projection produced by the current Engine", async () => {
  const projection = await engineProjection();
  const normalized = normalizeStoredProjection(projection, SCOPE);

  expect(normalized).toEqual(projection);
  expect(Object.isFrozen(normalized)).toBe(true);
  expect(Object.isFrozen(normalized.snapshot)).toBe(true);
  expect(Object.isFrozen(normalized.assertions)).toBe(true);
});

it("rejects exact stored-projection corruption with current typed semantics", async () => {
  const projection = await engineProjection();

  const wrongScope = mutableProjection(projection);
  (wrongScope.snapshot as Record<string, unknown>).scope = OTHER_SCOPE;
  expectStoredError(wrongScope, "CORRUPT_STORE");

  const tamperedCanonical = mutableProjection(projection);
  tamperedCanonical.canonicalProjection = (
    tamperedCanonical.canonicalProjection as string
  ).replace("stored-projection", "tampered-projection");
  expectStoredError(tamperedCanonical, "CORRUPT_STORE");

  const tamperedContentId = mutableProjection(projection);
  tamperedContentId.storeEnvelopeId = `attunegraph-store:${"0".repeat(64)}`;
  expectStoredError(tamperedContentId, "CORRUPT_STORE");

  const metadataMismatch = mutableProjection(projection);
  metadataMismatch.observedAt = "2026-07-30T00:00:01.000Z";
  expectStoredError(metadataMismatch, "CORRUPT_STORE");

  const assertionMismatch = mutableProjection(projection);
  assertionMismatch.assertions = [];
  expectStoredError(assertionMismatch, "CORRUPT_STORE");

  const invalidSchema = mutableProjection(projection);
  invalidSchema.schemaVersion = 0;
  expectStoredError(invalidSchema, "CORRUPT_STORE");

  const futureSchema = mutableProjection(projection);
  futureSchema.schemaVersion = 2;
  expectStoredError(futureSchema, "FUTURE_STORE_STATE");
});

it("admits one Engine projection with exact scope, store identity, and detached frozen output", async () => {
  const projection = await engineProjection();
  const expectedScope = { ...SCOPE };
  const source = mutableProjection(projection);
  const expectedProjection = normalizeStoredProjection(source, SCOPE);
  const expectedProjectionId = canonicalizeImmutableEnvelope(
    mutableProjection(expectedProjection),
    "external-mutable",
    {
      hashDomain: "attunegraph.store-projection.v1",
      idField: "storeEnvelopeId",
      idPrefix: "attunegraph-store:"
    }
  ).contentId;

  const admitted = admitPortableProjection(source, expectedScope);

  expect(admitted.projection).toEqual(expectedProjection);
  expect(admitted.identity).toEqual({
    scope: SCOPE,
    generation: projection.snapshot.generation,
    commitId: projection.snapshot.commitId,
    projectionId: expectedProjectionId
  });
  expect(admitted.identity.projectionId).toMatch(/^attunegraph-store:[0-9a-f]{64}$/u);
  const rebound =
    mintCanonicalImmutableEnvelopeFromFrozenUnsignedForInternalUse(
      admitted.projection,
      {
        hashDomain: "attunegraph.store-projection.v1",
        idField: "storeEnvelopeId",
        idPrefix: "attunegraph-store:"
      }
    );
  expect(rebound.contentId).toBe(admitted.identity.projectionId);
  expect(rebound.canonicalJson).toBe(
    canonicalizeImmutableEnvelope(
      rebound.envelope,
      "attunegraph-frozen",
      {
        hashDomain: "attunegraph.store-projection.v1",
        idField: "storeEnvelopeId",
        idPrefix: "attunegraph-store:"
      }
    ).canonicalJson
  );
  expect(admitted.identity.scope).not.toBe(expectedScope);
  expect(admitted.identity.scope).not.toBe(admitted.projection.snapshot.scope);
  expectDeeplyFrozen(admitted);

  expectedScope.threadId = "mutated-thread";
  (source.snapshot as Record<string, unknown>).generation = 99;
  expect(admitted.identity.scope).toEqual(SCOPE);
  expect(admitted.identity.generation).toBe(1);
  expect(admitted.projection.snapshot.generation).toBe(1);
});

it("does not consult mutable global structuredClone during portable admission", async () => {
  const projection = await engineProjection();
  const descriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "structuredClone"
  );
  if (descriptor === undefined) {
    throw new Error("structuredClone descriptor is unavailable");
  }
  let cloneCalls = 0;
  Object.defineProperty(globalThis, "structuredClone", {
    ...descriptor,
    value() {
      cloneCalls += 1;
      throw new Error("mutable global structuredClone must not run");
    }
  });
  try {
    const admitted = admitPortableProjection(projection, SCOPE);
    expect(admitted.identity.projectionId).toMatch(
      /^attunegraph-store:[0-9a-f]{64}$/u
    );
  } finally {
    Object.defineProperty(globalThis, "structuredClone", descriptor);
  }
  expect(cloneCalls).toBe(0);
});

it("normalizes hostile expected scopes first without invoking accessors or proxy traps", async () => {
  const projection = await engineProjection();
  let getterCalls = 0;
  const accessorScope = { sourceId: SCOPE.sourceId };
  Object.defineProperty(accessorScope, "threadId", {
    enumerable: true,
    get() {
      getterCalls += 1;
      throw new Error("must not run");
    }
  });
  let proxyTraps = 0;
  const proxyScope = new Proxy({ ...SCOPE }, {
    ownKeys() {
      proxyTraps += 1;
      throw new Error("must not run");
    }
  });
  const symbolScope = {
    ...SCOPE,
    [Symbol("unknown")]: true
  };
  class ExoticScope {
    sourceId = SCOPE.sourceId;
    threadId = SCOPE.threadId;
  }
  const invalidScopes: readonly unknown[] = [
    proxyScope,
    accessorScope,
    symbolScope,
    new ExoticScope(),
    { sourceId: SCOPE.sourceId },
    { sourceId: SCOPE.sourceId, threadId: SCOPE.threadId, extra: true }
  ];
  for (const expectedScope of invalidScopes) {
    expectAttuneGraphError(
      () => admitPortableProjection(projection, expectedScope as never),
      "INVALID_INPUT"
    );
  }
  expect(getterCalls).toBe(0);
  expect(proxyTraps).toBe(0);
  expect(normalizeAttuneGraphScope(SCOPE, "scope")).toEqual(SCOPE);
});

it("rejects hostile or corrupt portable projections with current typed semantics and no getter invocation", async () => {
  const projection = await engineProjection();
  let getterCalls = 0;
  const accessorProjection = mutableProjection(projection);
  Object.defineProperty(accessorProjection, "snapshot", {
    enumerable: true,
    get() {
      getterCalls += 1;
      throw new Error("must not run");
    }
  });
  const symbolProjection = mutableProjection(projection);
  Object.defineProperty(symbolProjection, Symbol("unknown"), {
    enumerable: true,
    value: true
  });
  const aliasedProjection = mutableProjection(projection);
  const shared = { state: "fresh", observedAt: NOW };
  aliasedProjection.sourceFreshness = shared;
  (aliasedProjection.snapshot as Record<string, unknown>).scope = shared;
  const proxyProjection = new Proxy(mutableProjection(projection), {
    get() {
      getterCalls += 1;
      throw new Error("must not run");
    }
  });
  for (const hostile of [
    proxyProjection,
    accessorProjection,
    symbolProjection,
    new Date(),
    aliasedProjection
  ]) {
    expectAttuneGraphError(
      () => admitPortableProjection(hostile, SCOPE),
      "CORRUPT_STORE"
    );
  }

  expectAttuneGraphError(
    () => admitPortableProjection(projection, OTHER_SCOPE),
    "CORRUPT_STORE"
  );
  const tamperedCanonical = mutableProjection(projection);
  tamperedCanonical.canonicalProjection = (
    tamperedCanonical.canonicalProjection as string
  ).replace("stored-projection", "tampered-projection");
  expectAttuneGraphError(
    () => admitPortableProjection(tamperedCanonical, SCOPE),
    "CORRUPT_STORE"
  );
  const tamperedContentId = mutableProjection(projection);
  tamperedContentId.storeEnvelopeId = `attunegraph-store:${"0".repeat(64)}`;
  expectAttuneGraphError(
    () => admitPortableProjection(tamperedContentId, SCOPE),
    "CORRUPT_STORE"
  );
  const metadataMismatch = mutableProjection(projection);
  metadataMismatch.observedAt = "2026-07-30T00:00:01.000Z";
  expectAttuneGraphError(
    () => admitPortableProjection(metadataMismatch, SCOPE),
    "CORRUPT_STORE"
  );
  const assertionMismatch = mutableProjection(projection);
  assertionMismatch.assertions = [];
  expectAttuneGraphError(
    () => admitPortableProjection(assertionMismatch, SCOPE),
    "CORRUPT_STORE"
  );
  const futureSchema = mutableProjection(projection);
  futureSchema.schemaVersion = 2;
  expectAttuneGraphError(
    () => admitPortableProjection(futureSchema, SCOPE),
    "FUTURE_STORE_STATE"
  );
  expect(getterCalls).toBe(0);
});

it("keeps the package-private normalizer out of every public package surface", async () => {
  const [root, local, backend, testing] = await Promise.all([
    import("./index.js"),
    import("./local.js"),
    import("./attunegraph-backend.js"),
    import("./testing.js")
  ]);

  for (const surface of [root, local, backend, testing]) {
    expect(Object.hasOwn(surface, "normalizeStoredProjection")).toBe(false);
    expect(Object.hasOwn(surface, "normalizeAttuneGraphScope")).toBe(false);
    expect(Object.hasOwn(surface, "admitPortableProjection")).toBe(false);
    expect(Object.hasOwn(
      surface,
      "canonicalizeImmutableEnvelopeForInternalUse"
    )).toBe(false);
    expect(Object.hasOwn(
      surface,
      "mintCanonicalImmutableEnvelopeFromFrozenUnsignedForInternalUse"
    )).toBe(false);
  }
  for (const privateSubpath of [
    "@attunegraph/core/attunegraph-engine",
    "@attunegraph/core/attunegraph-portable-admission",
    "@attunegraph/core/canonical-immutable-envelope"
  ]) {
    await expect(import(privateSubpath)).rejects.toThrow(/not exported/u);
  }
});
