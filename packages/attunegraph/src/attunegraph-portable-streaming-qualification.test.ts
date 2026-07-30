import { createHash, type Hash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { TextEncoder } from "node:util";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  createAttuneGraphStore,
  type AttuneGraphStoreBackend,
  type AttuneGraphStoredProjection
} from "./attunegraph-backend.js";
import type { AttuneGraphScope, AttuneGraphSnapshot } from "./attunegraph-contracts.js";
import { openAttuneGraph } from "./attunegraph-engine.js";
import {
  createAttuneGraphPortableEncoder,
  AttuneGraphPortableFormatError,
  type AttuneGraphPortableEncoder,
  type AttuneGraphPortableEncoderIdentitySink,
  type AttuneGraphPortableProjectionIdentity
} from "./attunegraph-portable-encoder.js";
import type { GraphAssertion } from "./types.js";

const NOW = "2026-07-30T00:00:00.000Z";
const STREAM_SCOPE = { sourceId: "stream-source", threadId: "stream-thread" };
const GENERATIONS = 4_096;
const utf8 = new TextEncoder();
const fixturePath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../fixtures/portable-v1/unicode-multi-scope.input.json"
);

function sameSnapshot(
  left: AttuneGraphSnapshot | undefined,
  right: AttuneGraphSnapshot | undefined
): boolean {
  return left?.generation === right?.generation
    && left?.commitId === right?.commitId
    && left?.scope.sourceId === right?.scope.sourceId
    && left?.scope.threadId === right?.scope.threadId;
}

function assertion(scope: AttuneGraphScope, key: string): GraphAssertion {
  return {
    schemaVersion: 1,
    id: `stream-${key}`,
    subject: { id: `artifact-${key}`, kind: "artifact" },
    predicate: "LINKED_TO",
    object: { id: scope.threadId, kind: "thread" },
    epistemicClass: "source-observed",
    sourceRefs: [{ id: `source-${key}`, namespace: "test.source" }],
    recordedAt: NOW,
    derivation: { kind: "projection", version: "qualification@1" }
  };
}

async function engineSequence(scope: AttuneGraphScope): Promise<{
  readonly one: AttuneGraphStoredProjection;
  readonly two: AttuneGraphStoredProjection;
  readonly three: AttuneGraphStoredProjection;
}> {
  let current: AttuneGraphStoredProjection | undefined;
  const attuneGraph = await openAttuneGraph({
    scope,
    store: createAttuneGraphStore({
      async read() {
        return current === undefined
          ? undefined
          : JSON.parse(JSON.stringify(current)) as AttuneGraphStoredProjection;
      },
      async compareAndSwap(_scope, expected, proposed) {
        if (!sameSnapshot(current?.snapshot, expected)) return false;
        current = proposed;
        return true;
      }
    })
  });
  let expectedSnapshot: AttuneGraphSnapshot | undefined;
  const project = async (key: string): Promise<AttuneGraphStoredProjection> => {
    expectedSnapshot = await attuneGraph.project({
      operator: "canonical-projection@1",
      expectedSnapshot,
      observation: {
        schemaVersion: 1,
        observationKey: key,
        scope,
        observedAt: NOW,
        sourceFreshness: { state: "fresh", observedAt: NOW },
        assertions: [assertion(scope, key)]
      }
    });
    if (current === undefined) throw new Error("Engine did not propose a projection");
    return JSON.parse(JSON.stringify(current)) as AttuneGraphStoredProjection;
  };
  try {
    const one = await project("0001");
    const two = await project("0002");
    const three = await project("0003");
    return { one, two, three };
  } finally {
    await attuneGraph.close();
  }
}

function updateIdentityHash(hash: Hash, identity: AttuneGraphPortableProjectionIdentity): void {
  hash
    .update(identity.scope.sourceId, "utf8")
    .update("\0", "utf8")
    .update(identity.scope.threadId, "utf8")
    .update("\0", "utf8")
    .update(String(identity.generation), "utf8")
    .update("\0", "utf8")
    .update(identity.commitId, "utf8")
    .update("\0", "utf8")
    .update(identity.projectionId, "utf8")
    .update("\0", "utf8");
}

function expectPinnedInvalidOrder(
  operation: (portable: AttuneGraphPortableEncoder) => void
): void {
  const aborts: unknown[] = [];
  const identitySink: AttuneGraphPortableEncoderIdentitySink = {
    appendProjection() {},
    sealProjections() {},
    assertHead() {},
    finish() {},
    abort(cause) {
      aborts.push(cause);
    }
  };
  const portable = createAttuneGraphPortableEncoder({ identitySink });
  portable.start();
  let thrown: unknown;
  try {
    operation(portable);
  } catch (cause) {
    thrown = cause;
  }
  expect(thrown).toBeInstanceOf(AttuneGraphPortableFormatError);
  expect((thrown as AttuneGraphPortableFormatError).code).toBe("INVALID_ORDER");
  expect(aborts).toHaveLength(1);
  expect(aborts[0]).toBe(thrown);
  let rethrown: unknown;
  try {
    portable.finish();
  } catch (cause) {
    rethrown = cause;
  }
  expect(rethrown).toBe(thrown);
  expect(aborts).toHaveLength(1);
}

async function streamingNonRetentionSmoke(): Promise<{
  readonly report: ReturnType<AttuneGraphPortableEncoder["finish"]>["report"];
  readonly artifactDigest: string;
  readonly artifactBytes: number;
  readonly identityDigest: string;
  readonly projectionCount: number;
  readonly canonicalProjectionBytes: number;
  readonly minProjectionLineBytes: number;
  readonly maxProjectionLineBytes: number;
  readonly lastIdentity: AttuneGraphPortableProjectionIdentity;
  readonly retainedState: {
    readonly backendCurrentProjections: 1;
    readonly callerExpectedSnapshots: 1;
    readonly sinkLastIdentities: 1;
  };
}> {
  let current: AttuneGraphStoredProjection | undefined;
  let sinkLastIdentity: AttuneGraphPortableProjectionIdentity | undefined;
  let sinkProjectionCount = 0;
  let sinkHeadCount = 0;
  let abortCount = 0;
  let abortCause: unknown;
  let canonicalProjectionBytes: number | undefined;
  let minProjectionLineBytes = Number.POSITIVE_INFINITY;
  let maxProjectionLineBytes = 0;
  let artifactBytes = 0;
  const identityHash = createHash("sha256");
  const artifactHash = createHash("sha256");

  const identitySink: AttuneGraphPortableEncoderIdentitySink = {
    appendProjection(identity) {
      sinkLastIdentity = identity;
      sinkProjectionCount += 1;
      updateIdentityHash(identityHash, identity);
    },
    sealProjections() {},
    assertHead(head) {
      expect(head.scope.sourceId).toBe(sinkLastIdentity?.scope.sourceId);
      expect(head.scope.threadId).toBe(sinkLastIdentity?.scope.threadId);
      expect(head.generation).toBe(sinkLastIdentity?.generation);
      expect(head.commitId).toBe(sinkLastIdentity?.commitId);
      expect(head.projectionId).toBe(sinkLastIdentity?.projectionId);
      expect(head).toEqual(sinkLastIdentity);
      sinkHeadCount += 1;
    },
    finish(expectedScopeCount, expectedHeadCount) {
      expect(expectedScopeCount).toBe(1);
      expect(expectedHeadCount).toBe(1);
      expect(sinkHeadCount).toBe(1);
    },
    abort(cause) {
      abortCount += 1;
      abortCause = cause;
    }
  };
  const portable = createAttuneGraphPortableEncoder({ identitySink });
  const manifestBytes = portable.start();
  artifactHash.update(manifestBytes);
  artifactBytes += manifestBytes.byteLength;

  const backend: AttuneGraphStoreBackend = {
    async read() {
      return current === undefined
        ? undefined
        : JSON.parse(JSON.stringify(current)) as AttuneGraphStoredProjection;
    },
    async compareAndSwap(_scope, expected, proposed) {
      if (!sameSnapshot(current?.snapshot, expected)) return false;
      expect(proposed.assertions).toHaveLength(1);
      const key = proposed.snapshot.generation.toString(16).padStart(4, "0");
      expect(key).toMatch(/^[0-9a-f]{4}$/u);
      expect(proposed.assertions[0]?.id).toBe(`stream-${key}`);
      const body = JSON.parse(proposed.canonicalProjection) as {
        readonly assertions: readonly unknown[];
        readonly observationKey: string;
      };
      expect(body.observationKey).toBe(key);
      expect(body.assertions).toHaveLength(1);
      const bodyBytes = utf8.encode(proposed.canonicalProjection).byteLength;
      canonicalProjectionBytes ??= bodyBytes;
      expect(bodyBytes).toBe(canonicalProjectionBytes);

      const appended = portable.appendProjection(
        STREAM_SCOPE,
        JSON.parse(JSON.stringify(proposed)) as AttuneGraphStoredProjection
      );
      artifactHash.update(appended.bytes);
      artifactBytes += appended.bytes.byteLength;
      minProjectionLineBytes = Math.min(
        minProjectionLineBytes,
        appended.bytes.byteLength
      );
      maxProjectionLineBytes = Math.max(
        maxProjectionLineBytes,
        appended.bytes.byteLength
      );
      current = proposed;
      return true;
    }
  };
  const attuneGraph = await openAttuneGraph({
    scope: STREAM_SCOPE,
    store: createAttuneGraphStore(backend)
  });
  let expectedSnapshot: AttuneGraphSnapshot | undefined;
  try {
    for (let generation = 1; generation <= GENERATIONS; generation += 1) {
      const key = generation.toString(16).padStart(4, "0");
      expectedSnapshot = await attuneGraph.project({
        operator: "canonical-projection@1",
        expectedSnapshot,
        observation: {
          schemaVersion: 1,
          observationKey: key,
          scope: STREAM_SCOPE,
          observedAt: NOW,
          sourceFreshness: { state: "fresh", observedAt: NOW },
          assertions: [assertion(STREAM_SCOPE, key)]
        }
      });

      // Success-iteration boundary: only the current backend projection, caller
      // snapshot, sink identity, scalar accounting, and incremental hashes survive.
      expect(current?.snapshot).toEqual(expectedSnapshot);
      expect(sinkLastIdentity).toMatchObject({
        scope: expectedSnapshot.scope,
        generation,
        commitId: expectedSnapshot.commitId
      });
      expect(sinkProjectionCount).toBe(generation);
    }
  } finally {
    await attuneGraph.close();
  }

  if (
    current === undefined
    || expectedSnapshot === undefined
    || sinkLastIdentity === undefined
    || canonicalProjectionBytes === undefined
  ) {
    throw new Error("streaming smoke did not retain its exact final scalar state");
  }
  portable.sealProjections();
  const headBytes = portable.appendHead(
    sinkLastIdentity.scope,
    sinkLastIdentity.generation,
    sinkLastIdentity.commitId,
    sinkLastIdentity.projectionId
  );
  artifactHash.update(headBytes);
  artifactBytes += headBytes.byteLength;
  const finished = portable.finish();
  artifactHash.update(finished.bytes);
  artifactBytes += finished.bytes.byteLength;

  expect(current.snapshot).toEqual(expectedSnapshot);
  expect(sinkLastIdentity).toEqual({
    scope: expectedSnapshot.scope,
    generation: expectedSnapshot.generation,
    commitId: expectedSnapshot.commitId,
    projectionId: sinkLastIdentity.projectionId
  });
  expect(sinkProjectionCount).toBe(GENERATIONS);
  expect(maxProjectionLineBytes - minProjectionLineBytes).toBe(
    2 * (String(GENERATIONS).length - 1)
  );
  expect(artifactBytes).toBe(finished.report.bytes);
  expect(abortCount).toBe(0);
  expect(abortCause).toBeUndefined();

  return {
    report: finished.report,
    artifactDigest: artifactHash.digest("hex"),
    artifactBytes,
    identityDigest: identityHash.digest("hex"),
    projectionCount: sinkProjectionCount,
    canonicalProjectionBytes,
    minProjectionLineBytes,
    maxProjectionLineBytes,
    lastIdentity: sinkLastIdentity,
    retainedState: {
      backendCurrentProjections: 1,
      callerExpectedSnapshots: 1,
      sinkLastIdentities: 1
    }
  };
}

describe("AttuneGraph portable streaming qualification", () => {
  it("qualifies exact Unicode ordering and the 4,096-generation streaming non-retention smoke", async () => {
    const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as {
      readonly projections: readonly AttuneGraphStoredProjection[];
    };
    const sourceHigh = fixture.projections.find(
      (projection) => projection.snapshot.scope.sourceId === "\u{10000}"
    );
    const sourceLow = fixture.projections.find(
      (projection) => projection.snapshot.scope.sourceId === "\uE000"
    );
    const tiedHigh = fixture.projections.find(
      (projection) => projection.snapshot.scope.sourceId === "tied"
        && projection.snapshot.scope.threadId === "\u{10000}"
    );
    const tiedLow = fixture.projections.find(
      (projection) => projection.snapshot.scope.sourceId === "tied"
        && projection.snapshot.scope.threadId === "\uE000"
    );
    const decomposed = fixture.projections.find(
      (projection) => projection.snapshot.scope.sourceId === "e\u0301"
    );
    const composed = fixture.projections.find(
      (projection) => projection.snapshot.scope.sourceId === "\u00E9"
    );
    expect([
      sourceHigh,
      sourceLow,
      tiedHigh,
      tiedLow,
      decomposed,
      composed
    ].every((projection) => projection !== undefined)).toBe(true);

    const lowSequence = await engineSequence({
      sourceId: "a-source",
      threadId: "thread"
    });
    const highSequence = await engineSequence({
      sourceId: "b-source",
      threadId: "thread"
    });

    const normalizationSink: AttuneGraphPortableEncoderIdentitySink = {
      appendProjection() {},
      sealProjections() {},
      assertHead() {},
      finish() {},
      abort(cause) {
        throw cause;
      }
    };
    const normalization = createAttuneGraphPortableEncoder({
      identitySink: normalizationSink
    });
    normalization.start();
    const decomposedIdentity = normalization.appendProjection(
      decomposed!.snapshot.scope,
      decomposed
    ).identity;
    const composedIdentity = normalization.appendProjection(
      composed!.snapshot.scope,
      composed
    ).identity;
    normalization.sealProjections();
    normalization.appendHead(
      decomposedIdentity.scope,
      decomposedIdentity.generation,
      decomposedIdentity.commitId,
      decomposedIdentity.projectionId
    );
    normalization.appendHead(
      composedIdentity.scope,
      composedIdentity.generation,
      composedIdentity.commitId,
      composedIdentity.projectionId
    );
    expect(normalization.finish().report).toMatchObject({
      projections: 2,
      scopes: 2
    });

    const negativeRows: readonly {
      readonly name: string;
      readonly operation: (portable: AttuneGraphPortableEncoder) => void;
    }[] = [
      {
        name: "sourceId raw UTF-8 regression U+10000 to U+E000",
        operation(portable) {
          portable.appendProjection(sourceHigh!.snapshot.scope, sourceHigh);
          portable.appendProjection(sourceLow!.snapshot.scope, sourceLow);
        }
      },
      {
        name: "tied threadId raw UTF-8 regression U+10000 to U+E000",
        operation(portable) {
          portable.appendProjection(tiedHigh!.snapshot.scope, tiedHigh);
          portable.appendProjection(tiedLow!.snapshot.scope, tiedLow);
        }
      },
      {
        name: "normalization-distinct reverse composed to decomposed",
        operation(portable) {
          portable.appendProjection(composed!.snapshot.scope, composed);
          portable.appendProjection(decomposed!.snapshot.scope, decomposed);
        }
      },
      {
        name: "duplicate generation",
        operation(portable) {
          portable.appendProjection(lowSequence.one.snapshot.scope, lowSequence.one);
          portable.appendProjection(lowSequence.one.snapshot.scope, lowSequence.one);
        }
      },
      {
        name: "generation gap",
        operation(portable) {
          portable.appendProjection(lowSequence.one.snapshot.scope, lowSequence.one);
          portable.appendProjection(lowSequence.three.snapshot.scope, lowSequence.three);
        }
      },
      {
        name: "new scope generation does not begin at 1",
        operation(portable) {
          portable.appendProjection(lowSequence.one.snapshot.scope, lowSequence.one);
          portable.appendProjection(highSequence.two.snapshot.scope, highSequence.two);
        }
      },
      {
        name: "duplicate head",
        operation(portable) {
          const identity = portable.appendProjection(
            lowSequence.one.snapshot.scope,
            lowSequence.one
          ).identity;
          portable.sealProjections();
          portable.appendHead(
            identity.scope,
            identity.generation,
            identity.commitId,
            identity.projectionId
          );
          portable.appendHead(
            identity.scope,
            identity.generation,
            identity.commitId,
            identity.projectionId
          );
        }
      },
      {
        name: "head scope regression",
        operation(portable) {
          const low = portable.appendProjection(
            lowSequence.one.snapshot.scope,
            lowSequence.one
          ).identity;
          const high = portable.appendProjection(
            highSequence.one.snapshot.scope,
            highSequence.one
          ).identity;
          portable.sealProjections();
          portable.appendHead(
            high.scope,
            high.generation,
            high.commitId,
            high.projectionId
          );
          portable.appendHead(
            low.scope,
            low.generation,
            low.commitId,
            low.projectionId
          );
        }
      }
    ];
    for (const row of negativeRows) {
      expect(row.name.length).toBeGreaterThan(0);
      expectPinnedInvalidOrder(row.operation);
    }

    const first = await streamingNonRetentionSmoke();
    const second = await streamingNonRetentionSmoke();
    expect(first).toEqual(second);
    expect(first.report).toMatchObject({
      scopes: 1,
      projections: GENERATIONS
    });
    expect(first.projectionCount).toBe(GENERATIONS);
    expect(first.lastIdentity.generation).toBe(GENERATIONS);
    expect(first.retainedState).toEqual({
      backendCurrentProjections: 1,
      callerExpectedSnapshots: 1,
      sinkLastIdentities: 1
    });
  }, 660_000);
});
