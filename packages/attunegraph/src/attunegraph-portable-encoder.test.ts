import { createHash } from "node:crypto";
import { TextDecoder, TextEncoder } from "node:util";

import { beforeAll, describe, expect, it, vi } from "vitest";

import { createAttuneGraphStore, type AttuneGraphStoredProjection } from "./attunegraph-backend.js";
import { openAttuneGraph } from "./attunegraph-engine.js";
import {
  createAttuneGraphPortableEncoder,
  AttuneGraphPortableFormatError,
  type AttuneGraphPortableEncoder,
  type AttuneGraphPortableEncoderIdentitySink,
  type AttuneGraphPortableProjectionIdentity
} from "./attunegraph-portable-encoder.js";
import type { GraphAssertion } from "./types.js";

const SCOPE = { sourceId: "source-a", threadId: "thread-a" };
const NOW = "2026-07-30T00:00:00.000Z";
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf8", { fatal: true });

let projections: readonly AttuneGraphStoredProjection[];

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

async function engineProjections(): Promise<readonly AttuneGraphStoredProjection[]> {
  let current: AttuneGraphStoredProjection | undefined;
  const captured: AttuneGraphStoredProjection[] = [];
  const attuneGraph = await openAttuneGraph({
    scope: SCOPE,
    store: createAttuneGraphStore({
      async read() {
        return current;
      },
      async compareAndSwap(_scope, expected, proposed) {
        const matches = expected === undefined
          ? current === undefined
          : current !== undefined
            && current.snapshot.generation === expected.generation
            && current.snapshot.commitId === expected.commitId;
        if (!matches) return false;
        current = JSON.parse(JSON.stringify(proposed)) as AttuneGraphStoredProjection;
        captured.push(current);
        return true;
      }
    })
  });
  try {
    let expectedSnapshot: AttuneGraphStoredProjection["snapshot"] | undefined;
    for (const id of ["one", "two"]) {
      expectedSnapshot = await attuneGraph.project({
        operator: "canonical-projection@1",
        expectedSnapshot,
        observation: {
          schemaVersion: 1,
          observationKey: id,
          scope: SCOPE,
          observedAt: NOW,
          sourceFreshness: { state: "fresh", observedAt: NOW },
          assertions: [assertion(id)]
        }
      });
    }
  } finally {
    await attuneGraph.close();
  }
  return captured;
}

beforeAll(async () => {
  projections = await engineProjections();
});

function sink(overrides: Partial<AttuneGraphPortableEncoderIdentitySink> = {}): {
  readonly value: AttuneGraphPortableEncoderIdentitySink;
  readonly appended: AttuneGraphPortableProjectionIdentity[];
  readonly heads: AttuneGraphPortableProjectionIdentity[];
  readonly aborts: unknown[];
} {
  const appended: AttuneGraphPortableProjectionIdentity[] = [];
  const heads: AttuneGraphPortableProjectionIdentity[] = [];
  const aborts: unknown[] = [];
  const value: AttuneGraphPortableEncoderIdentitySink = {
    appendProjection(identity) {
      appended.push(identity);
    },
    sealProjections() {},
    assertHead(head) {
      heads.push(head);
    },
    finish() {},
    abort(cause) {
      aborts.push(cause);
    },
    ...overrides
  };
  return { value, appended, heads, aborts };
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const length = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function canonical(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonical(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(
    (key) => `${JSON.stringify(key)}:${canonical(record[key])}`
  ).join(",")}}`;
}

function portableRecordId(record: Record<string, unknown>): string {
  const { recordId: _recordId, ...body } = record;
  return `attunegraph-portable-record:${createHash("sha256")
    .update("attunegraph.portable-record.v1\0", "utf8")
    .update(canonical(body), "utf8")
    .digest("hex")}`;
}

function decodedLines(bytes: Uint8Array): {
  readonly texts: readonly string[];
  readonly records: readonly Record<string, unknown>[];
} {
  const text = decoder.decode(bytes);
  expect(text.endsWith("\n")).toBe(true);
  const texts = text.slice(0, -1).split("\n").map((line) => `${line}\n`);
  return {
    texts,
    records: texts.map((line) => JSON.parse(line) as Record<string, unknown>)
  };
}

function encodeHappy(
  identitySink: AttuneGraphPortableEncoderIdentitySink,
  mutateReturned = false
): {
  readonly artifact: Uint8Array;
  readonly report: ReturnType<AttuneGraphPortableEncoder["finish"]>["report"];
} {
  const portable = createAttuneGraphPortableEncoder({ identitySink });
  const chunks: Uint8Array[] = [];
  const manifest = portable.start();
  if (mutateReturned) manifest.fill(0);
  else chunks.push(manifest);
  let finalIdentity: AttuneGraphPortableProjectionIdentity | undefined;
  for (const projection of projections) {
    const appended = portable.appendProjection(SCOPE, projection);
    finalIdentity = appended.identity;
    if (mutateReturned) appended.bytes.fill(0);
    else chunks.push(appended.bytes);
  }
  portable.sealProjections();
  if (finalIdentity === undefined) throw new Error("missing final identity");
  const head = portable.appendHead(
    finalIdentity.scope,
    finalIdentity.generation,
    finalIdentity.commitId,
    finalIdentity.projectionId
  );
  if (mutateReturned) head.fill(0);
  else chunks.push(head);
  const finished = portable.finish();
  chunks.push(finished.bytes);
  return { artifact: concat(chunks), report: finished.report };
}

describe("transactional AttuneGraph portable encoder", () => {
  it("encodes empty and one-scope/two-generation artifacts with independently recomputed identities", () => {
    const emptySink = sink();
    const empty = createAttuneGraphPortableEncoder({ identitySink: emptySink.value });
    const emptyChunks = [empty.start()];
    empty.sealProjections();
    const emptyFinished = empty.finish();
    emptyChunks.push(emptyFinished.bytes);
    const emptyDecoded = decodedLines(concat(emptyChunks));
    expect(emptyDecoded.records.map((record) => record.kind)).toEqual([
      "manifest",
      "footer"
    ]);
    expect(emptyFinished.report).toMatchObject({
      scopes: 0,
      projections: 0,
      bytes: concat(emptyChunks).byteLength
    });

    const exactSink = sink({
      assertHead(head) {
        const final = exactSink.appended.at(-1);
        expect(head).toEqual(final);
        exactSink.heads.push(head);
      },
      finish(expectedScopeCount, expectedHeadCount) {
        expect([expectedScopeCount, expectedHeadCount]).toEqual([1, 1]);
        expect(exactSink.appended).toHaveLength(2);
        expect(exactSink.heads).toHaveLength(1);
      }
    });
    const encoded = encodeHappy(exactSink.value);
    const decoded = decodedLines(encoded.artifact);
    expect(decoded.records.map((record) => record.kind)).toEqual([
      "manifest",
      "projection",
      "projection",
      "head",
      "footer"
    ]);
    for (let index = 0; index < decoded.records.length; index += 1) {
      const record = decoded.records[index]!;
      expect(record.sequence).toBe(index);
      expect(record.recordId).toBe(portableRecordId(record));
      expect(decoded.texts[index]).toBe(`${canonical(record)}\n`);
    }
    const footer = decoded.records.at(-1)!;
    const manifest = decoded.records[0]!;
    const priorBytes = encoder.encode(decoded.texts.slice(0, -1).join(""));
    const expectedStateId = `attunegraph-state:${createHash("sha256")
      .update("attunegraph.portable-state.v1\0", "utf8")
      .update(priorBytes)
      .digest("hex")}`;
    expect(footer).toMatchObject({
      headCount: 1,
      manifestId: manifest.recordId,
      priorByteLength: priorBytes.byteLength,
      priorRecordCount: 4,
      projectionCount: 2,
      scopeCount: 1,
      stateId: expectedStateId
    });
    expect(encoded.report).toEqual({
      format: "attunegraph-portable",
      formatVersion: 1,
      stateId: expectedStateId,
      exportId: footer.recordId,
      scopes: 1,
      projections: 2,
      bytes: encoded.artifact.byteLength
    });
  });

  it("admits expectedScope first and enforces projection/head order and lifecycle", () => {
    const observed = sink();
    const portable = createAttuneGraphPortableEncoder({ identitySink: observed.value });
    expect(() => portable.appendProjection(SCOPE, projections[0])).toThrow(
      AttuneGraphPortableFormatError
    );
    portable.start();
    expect(() => portable.start()).toThrow(AttuneGraphPortableFormatError);

    let projectionReads = 0;
    const hostileProjection = new Proxy(projections[0]!, {
      get() {
        projectionReads += 1;
        throw new Error("projection must not be inspected");
      }
    });
    let scopeGetterCalls = 0;
    const hostileScope = { sourceId: SCOPE.sourceId };
    Object.defineProperty(hostileScope, "threadId", {
      enumerable: true,
      get() {
        scopeGetterCalls += 1;
        throw new Error("scope getter must not run");
      }
    });
    expect(() => portable.appendProjection(
      hostileScope as typeof SCOPE,
      hostileProjection
    )).toThrow();
    expect(projectionReads).toBe(0);
    expect(scopeGetterCalls).toBe(0);

    const first = portable.appendProjection(SCOPE, projections[0]);
    expect(() => portable.appendProjection(SCOPE, projections[0])).toThrow(
      /contiguous/u
    );
    expect(observed.aborts).toHaveLength(1);
    expect(() => portable.sealProjections()).toThrow(observed.aborts[0]);

    const lifecycle = sink();
    const second = createAttuneGraphPortableEncoder({ identitySink: lifecycle.value });
    second.start();
    const identity = second.appendProjection(SCOPE, projections[0]).identity;
    second.sealProjections();
    expect(() => second.appendProjection(SCOPE, projections[1])).toThrow(
      /projection phase/u
    );
    expect(() => second.appendHead(
      identity.scope,
      identity.generation,
      identity.commitId,
      identity.projectionId
    )).toThrow(lifecycle.aborts[0]);
    expect(first.identity.generation).toBe(1);
  });

  it("validates options, sink methods, head primitives, and isolates returned byte mutation", () => {
    let getterCalls = 0;
    const accessorOptions = {};
    Object.defineProperty(accessorOptions, "identitySink", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return sink().value;
      }
    });
    expect(() => createAttuneGraphPortableEncoder(accessorOptions as never)).toThrow(
      AttuneGraphPortableFormatError
    );
    expect(getterCalls).toBe(0);
    expect(() => createAttuneGraphPortableEncoder({
      identitySink: new Proxy(sink().value, {})
    })).toThrow(AttuneGraphPortableFormatError);
    expect(() => createAttuneGraphPortableEncoder({
      identitySink: { ...sink().value, finish: 1 as never }
    })).toThrow(AttuneGraphPortableFormatError);

    const invalid = sink();
    const invalidHead = createAttuneGraphPortableEncoder({ identitySink: invalid.value });
    invalidHead.start();
    invalidHead.sealProjections();
    expect(() => invalidHead.appendHead(
      SCOPE,
      0,
      "commit",
      `attunegraph-store:${"0".repeat(64)}`
    )).toThrow(AttuneGraphPortableFormatError);
    expect(invalid.aborts).toHaveLength(1);

    const clean = encodeHappy(sink().value);
    const mutated = encodeHappy(sink().value, true);
    expect(mutated.report).toEqual(clean.report);
  });

  it.each(["appendProjection", "sealProjections", "assertHead", "finish"] as const)(
    "aborts exactly once and pins the original %s sink failure",
    (method) => {
      const failure = new Error(`${method} failure`);
      const observed = sink({
        [method]() {
          throw failure;
        }
      });
      const portable = createAttuneGraphPortableEncoder({ identitySink: observed.value });
      portable.start();
      let operation: () => unknown;
      if (method === "appendProjection") {
        operation = () => portable.appendProjection(SCOPE, projections[0]);
      } else if (method === "sealProjections") {
        operation = () => portable.sealProjections();
      } else {
        const identity = portable.appendProjection(SCOPE, projections[0]).identity;
        portable.sealProjections();
        operation = method === "assertHead"
          ? () => portable.appendHead(
            identity.scope,
            identity.generation,
            identity.commitId,
            identity.projectionId
          )
          : () => portable.finish();
      }
      expect(operation).toThrow(failure);
      expect(observed.aborts).toEqual([failure]);
      expect(() => portable.start()).toThrow(failure);
      expect(observed.aborts).toEqual([failure]);
    }
  );

  it.each([true, false])(
    "turns %s-caught callback reentry into the authoritative terminal failure",
    (caught) => {
      const portableRef: { current?: AttuneGraphPortableEncoder } = {};
      let reentry: unknown;
      const observed = sink({
        appendProjection() {
          if (caught) {
            try {
              portableRef.current!.finish();
            } catch (cause) {
              reentry = cause;
            }
          } else {
            portableRef.current!.finish();
          }
        }
      });
      const portable = createAttuneGraphPortableEncoder({ identitySink: observed.value });
      portableRef.current = portable;
      portable.start();
      expect(() => portable.appendProjection(SCOPE, projections[0])).toThrow(
        AttuneGraphPortableFormatError
      );
      expect(observed.aborts).toHaveLength(1);
      expect(observed.aborts[0]).toMatchObject({ code: "REENTRY" });
      if (caught) expect(observed.aborts[0]).toBe(reentry);
      expect(() => portable.finish()).toThrow(observed.aborts[0]);
    }
  );

  it("swallows hostile abort behavior and retains captured sink methods and receiver", () => {
    const failure = new Error("original sink failure");
    const portableRef: { current?: AttuneGraphPortableEncoder } = {};
    let abortCalls = 0;
    const append = vi.fn(function (
      this: AttuneGraphPortableEncoderIdentitySink
    ) {
      expect(this).toBe(identitySink);
      throw failure;
    });
    const identitySink: AttuneGraphPortableEncoderIdentitySink = {
      appendProjection: append,
      sealProjections() {},
      assertHead() {},
      finish() {},
      abort(cause) {
        abortCalls += 1;
        expect(cause).toBe(failure);
        identitySink.appendProjection = () => undefined;
        identitySink.abort = () => undefined;
        expect(() => portableRef.current!.start()).toThrow(failure);
        throw new Error("abort must not shadow");
      }
    };
    const portable = createAttuneGraphPortableEncoder({ identitySink });
    portableRef.current = portable;
    const capturedAppend = identitySink.appendProjection;
    identitySink.appendProjection = () => undefined;
    portable.start();
    expect(() => portable.appendProjection(SCOPE, projections[0])).toThrow(
      failure
    );
    expect(capturedAppend).toBe(append);
    expect(append).toHaveBeenCalledOnce();
    expect(abortCalls).toBe(1);
    expect(() => portable.finish()).toThrow(failure);
    expect(abortCalls).toBe(1);
  });

  it("does not expose the encoder through any public package surface", async () => {
    const [root, local, backend, testing] = await Promise.all([
      import("./index.js"),
      import("./local.js"),
      import("./attunegraph-backend.js"),
      import("./testing.js")
    ]);
    for (const surface of [root, local, backend, testing]) {
      expect(Object.hasOwn(surface, "createAttuneGraphPortableEncoder")).toBe(false);
      expect(Object.hasOwn(surface, "AttuneGraphPortableFormatError")).toBe(false);
    }
    const privateSubpath = "@attunegraph/core/attunegraph-portable-encoder";
    await expect(import(privateSubpath)).rejects.toThrow(/not exported/u);
  });
});
