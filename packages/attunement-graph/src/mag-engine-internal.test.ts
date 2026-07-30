import { expect, it } from "vitest";

import { createMagStore, type MagStoredProjection } from "./mag-backend.js";
import { normalizeStoredProjection, openMag } from "./mag-engine.js";
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

async function engineProjection(): Promise<MagStoredProjection> {
  let captured: MagStoredProjection | undefined;
  const mag = await openMag({
    scope: SCOPE,
    store: createMagStore({
      async read() {
        return undefined;
      },
      async compareAndSwap(_scope, _expected, proposed) {
        captured = JSON.parse(JSON.stringify(proposed)) as MagStoredProjection;
        return true;
      }
    })
  });
  await mag.project({
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
  await mag.close();
  expect(captured).toBeDefined();
  return captured!;
}

function mutableProjection(
  projection: MagStoredProjection
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
  tamperedContentId.storeEnvelopeId = `mag-store:${"0".repeat(64)}`;
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

it("keeps the package-private normalizer out of every public package surface", async () => {
  const [root, local, backend, testing] = await Promise.all([
    import("./index.js"),
    import("./local.js"),
    import("./mag-backend.js"),
    import("./testing.js")
  ]);

  for (const surface of [root, local, backend, testing]) {
    expect(Object.hasOwn(surface, "normalizeStoredProjection")).toBe(false);
  }
});
