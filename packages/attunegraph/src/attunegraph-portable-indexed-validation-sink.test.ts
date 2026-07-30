import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
  createAttuneGraphStore,
  type AttuneGraphStoreBackend,
  type AttuneGraphStoredProjection
} from "./attunegraph-backend.js";
import type { AttuneGraphScope, AttuneGraphSnapshot } from "./attunegraph-contracts.js";
import { openAttuneGraph } from "./attunegraph-engine.js";
import {
  createAttuneGraphPortableIndexedValidationSink,
  createAttuneGraphPortableIndexedValidationSinkForQualification,
  createAttuneGraphPortableIndexedValidationSinkWithTerminalCloseOutcomeForInternalUse,
  createAttuneGraphPortableIndexedValidationSinkWithTerminalCloseOutcomeForQualification,
  AttuneGraphPortableIndexedValidationSinkError
} from "./attunegraph-portable-indexed-validation-sink.js";
import { createAttuneGraphPortableDecoder } from "./attunegraph-portable-decoder.js";
import {
  createAttuneGraphPortableEncoder,
  type AttuneGraphPortableEncoderIdentitySink,
  type AttuneGraphPortableProjectionIdentity
} from "./attunegraph-portable-encoder.js";
import type { GraphAssertion } from "./types.js";

const NOW = "2026-07-30T00:00:00.000Z";
const GENERATIONS = 4_096;
const STREAM_SCOPE = { sourceId: "indexed-stream", threadId: "thread" };
const temporaryDirectories: string[] = [];
const STORE_ONE = `attunegraph-store:${"1".repeat(64)}` as const;
const STORE_TWO = `attunegraph-store:${"2".repeat(64)}` as const;

async function databasePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "attunegraph-indexed-sink-"));
  temporaryDirectories.push(directory);
  return join(directory, "staging.sqlite");
}

function identity(
  sourceId: string,
  threadId: string,
  generation: number,
  projectionId = STORE_ONE
): AttuneGraphPortableProjectionIdentity {
  return {
    scope: { sourceId, threadId },
    generation,
    commitId: `commit-${generation.toString()}`,
    projectionId
  };
}

function row(
  database: DatabaseSync,
  sourceId: string,
  threadId: string
): Record<string, unknown> | undefined {
  return database.prepare(`
    SELECT hex(source_id) AS sourceHex, hex(thread_id) AS threadHex,
      generation, commit_id AS commitId, projection_id AS projectionId,
      head_seen AS headSeen
    FROM attunegraph_portable_validation_scope
    WHERE source_id = ? AND thread_id = ?
  `).get(Buffer.from(sourceId), Buffer.from(threadId)) as
    | Record<string, unknown>
    | undefined;
}

function rejection(operation: () => void): unknown {
  try {
    operation();
  } catch (cause) {
    return cause;
  }
  throw new Error("operation did not throw");
}

function countRows(database: DatabaseSync): {
  readonly scopes: number;
  readonly heads: number;
} {
  return database.prepare(`
    SELECT COUNT(*) AS scopes, COALESCE(SUM(head_seen), 0) AS heads
    FROM attunegraph_portable_validation_scope
  `).get() as { scopes: number; heads: number };
}

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
    id: `indexed-${key}`,
    subject: { id: `artifact-${key}`, kind: "artifact" },
    predicate: "LINKED_TO",
    object: { id: scope.threadId, kind: "thread" },
    epistemicClass: "source-observed",
    sourceRefs: [{ id: `source-${key}`, namespace: "indexed.test" }],
    recordedAt: NOW,
    derivation: { kind: "projection", version: "indexed-test@1" }
  };
}

async function stream4096Artifact(path: string): Promise<{
  readonly report: {
    readonly scopes: number;
    readonly projections: number;
  };
  readonly finalIdentity: AttuneGraphPortableProjectionIdentity;
}> {
  let current: AttuneGraphStoredProjection | undefined;
  let expectedSnapshot: AttuneGraphSnapshot | undefined;
  let finalIdentity: AttuneGraphPortableProjectionIdentity | undefined;
  let encoderCount = 0;
  const encoderSink: AttuneGraphPortableEncoderIdentitySink = {
    appendProjection(value) {
      finalIdentity = value;
      encoderCount += 1;
    },
    sealProjections() {},
    assertHead(value) {
      expect(value).toEqual(finalIdentity);
    },
    finish(scopeCount, headCount) {
      expect(scopeCount).toBe(1);
      expect(headCount).toBe(1);
    },
    abort(cause) {
      throw cause;
    }
  };
  const indexed = createAttuneGraphPortableIndexedValidationSink(
    new DatabaseSync(path, { timeout: 1_000 })
  );
  const decoder = createAttuneGraphPortableDecoder(indexed);
  const encoder = createAttuneGraphPortableEncoder({ identitySink: encoderSink });
  await decoder.write(encoder.start());

  const backend: AttuneGraphStoreBackend = {
    async read() {
      return current === undefined
        ? undefined
        : JSON.parse(JSON.stringify(current)) as AttuneGraphStoredProjection;
    },
    async compareAndSwap(_scope, expected, proposed) {
      if (!sameSnapshot(current?.snapshot, expected)) return false;
      const appended = encoder.appendProjection(
        STREAM_SCOPE,
        JSON.parse(JSON.stringify(proposed)) as AttuneGraphStoredProjection
      );
      await decoder.write(appended.bytes);
      current = proposed;
      return true;
    }
  };
  const attuneGraph = await openAttuneGraph({
    scope: STREAM_SCOPE,
    store: createAttuneGraphStore(backend)
  });
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
    }
  } finally {
    await attuneGraph.close();
  }
  if (finalIdentity === undefined) throw new Error("missing final identity");
  encoder.sealProjections();
  await decoder.write(encoder.appendHead(
    finalIdentity.scope,
    finalIdentity.generation,
    finalIdentity.commitId,
    finalIdentity.projectionId
  ));
  const footer = encoder.finish();
  await decoder.write(footer.bytes);
  const report = await decoder.finish();
  expect(encoderCount).toBe(GENERATIONS);
  expect(report).toEqual(footer.report);
  return { report, finalIdentity };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true })
    )
  );
});

describe("package-private AttuneGraph portable indexed validation sink", () => {
  it("commits one exact final head and transfers close ownership", async () => {
    const path = await databasePath();
    const transferred = new DatabaseSync(path, { timeout: 1_000 });
    const sink = createAttuneGraphPortableIndexedValidationSink(transferred);
    const first = identity("source", "thread", 1);
    const second = identity("source", "thread", 2, STORE_TWO);
    sink.appendProjection(first);
    sink.appendProjection(second);
    sink.sealProjections();
    sink.assertHead(second);
    sink.finish(1, 1);

    expect(transferred.isOpen).toBe(false);
    const inspected = new DatabaseSync(path, { readOnly: true });
    expect(row(inspected, "source", "thread")).toEqual({
      sourceHex: Buffer.from("source").toString("hex").toUpperCase(),
      threadHex: Buffer.from("thread").toString("hex").toUpperCase(),
      generation: 2,
      commitId: "commit-2",
      projectionId: STORE_TWO,
      headSeen: 1
    });
    expect(inspected.prepare("PRAGMA application_id").get()).toEqual({
      application_id: 0x4d505631
    });
    expect(inspected.prepare("PRAGMA user_version").get()).toEqual({
      user_version: 1
    });
    inspected.close();
  });

  it("decodes the Unicode golden artifact with exact raw UTF-8 BLOB keys", async () => {
    const path = await databasePath();
    const fixture = await readFile(join(
      import.meta.dirname,
      "../fixtures/portable-v1/unicode-multi-scope.atgx"
    ));
    const sink = createAttuneGraphPortableIndexedValidationSink(
      new DatabaseSync(path, { timeout: 1_000 })
    );
    const decoder = createAttuneGraphPortableDecoder(sink);
    for (let offset = 0; offset < fixture.byteLength; offset += 257) {
      await decoder.write(fixture.slice(offset, offset + 257));
    }
    const report = await decoder.finish();
    expect(report).toMatchObject({ scopes: 6, projections: 6 });

    const inspected = new DatabaseSync(path, { readOnly: true });
    expect(countRows(inspected)).toEqual({ scopes: 6, heads: 6 });
    for (const sourceId of ["e\u0301", "\u00e9", "\ue000", "\u{10000}"]) {
      const found = inspected.prepare(`
        SELECT hex(source_id) AS sourceHex
        FROM attunegraph_portable_validation_scope WHERE source_id = ?
      `).get(Buffer.from(sourceId)) as { sourceHex: string };
      expect(found.sourceHex).toBe(
        Buffer.from(sourceId).toString("hex").toUpperCase()
      );
    }
    inspected.close();
  });

  it("streams a 4,096-generation artifact through decoder into one final indexed row", async () => {
    const path = await databasePath();
    const result = await stream4096Artifact(path);
    expect(result.report).toMatchObject({ scopes: 1, projections: GENERATIONS });
    expect(result.finalIdentity.generation).toBe(GENERATIONS);
    const inspected = new DatabaseSync(path, { readOnly: true });
    expect(countRows(inspected)).toEqual({ scopes: 1, heads: 1 });
    expect(row(inspected, STREAM_SCOPE.sourceId, STREAM_SCOPE.threadId))
      .toMatchObject({
        generation: GENERATIONS,
        commitId: result.finalIdentity.commitId,
        projectionId: result.finalIdentity.projectionId,
        headSeen: 1
      });
    inspected.close();
  }, 660_000);

  it("indexes 4,096 distinct scopes without caller-side identity history", async () => {
    const path = await databasePath();
    const sink = createAttuneGraphPortableIndexedValidationSink(
      new DatabaseSync(path, { timeout: 1_000 })
    );
    for (let index = 0; index < GENERATIONS; index += 1) {
      const hex = index.toString(16).padStart(4, "0");
      sink.appendProjection(identity(
        `scope-${hex}`,
        "thread",
        1,
        `attunegraph-store:${hex.padStart(64, "0")}`
      ));
    }
    sink.sealProjections();
    for (let index = 0; index < GENERATIONS; index += 1) {
      const hex = index.toString(16).padStart(4, "0");
      sink.assertHead(identity(
        `scope-${hex}`,
        "thread",
        1,
        `attunegraph-store:${hex.padStart(64, "0")}`
      ));
    }
    sink.finish(GENERATIONS, GENERATIONS);
    const inspected = new DatabaseSync(path, { readOnly: true });
    expect(countRows(inspected)).toEqual({
      scopes: GENERATIONS,
      heads: GENERATIONS
    });
    inspected.close();
  }, 120_000);

  it("fails lifecycle, generation, head, and count mismatches closed", async () => {
    const cases: readonly {
      readonly name: string;
      readonly exercise: (
        sink: ReturnType<typeof createAttuneGraphPortableIndexedValidationSink>
      ) => void;
      readonly code: string;
    }[] = [
      {
        name: "new generation is not one",
        exercise(sink) {
          sink.appendProjection(identity("s", "t", 2));
        },
        code: "INVALID_INPUT"
      },
      {
        name: "generation gap",
        exercise(sink) {
          sink.appendProjection(identity("s", "t", 1));
          sink.appendProjection(identity("s", "t", 3));
        },
        code: "INVALID_INPUT"
      },
      {
        name: "duplicate generation",
        exercise(sink) {
          sink.appendProjection(identity("s", "t", 1));
          sink.appendProjection(identity("s", "t", 1));
        },
        code: "INVALID_INPUT"
      },
      {
        name: "generation regression",
        exercise(sink) {
          sink.appendProjection(identity("s", "t", 1));
          sink.appendProjection(identity("s", "t", 2, STORE_TWO));
          sink.appendProjection(identity("s", "t", 1));
        },
        code: "INVALID_INPUT"
      },
      {
        name: "head before seal",
        exercise(sink) {
          sink.assertHead(identity("s", "t", 1));
        },
        code: "INVALID_STATE"
      },
      {
        name: "projection after seal",
        exercise(sink) {
          sink.sealProjections();
          sink.appendProjection(identity("s", "t", 1));
        },
        code: "INVALID_STATE"
      },
      {
        name: "missing head",
        exercise(sink) {
          sink.appendProjection(identity("s", "t", 1));
          sink.sealProjections();
          sink.finish(1, 1);
        },
        code: "HEAD_MISMATCH"
      },
      {
        name: "substituted head",
        exercise(sink) {
          sink.appendProjection(identity("s", "t", 1));
          sink.sealProjections();
          sink.assertHead(identity("s", "t", 1, STORE_TWO));
        },
        code: "HEAD_MISMATCH"
      },
      {
        name: "duplicate head",
        exercise(sink) {
          const exact = identity("s", "t", 1);
          sink.appendProjection(exact);
          sink.sealProjections();
          sink.assertHead(exact);
          sink.assertHead(exact);
        },
        code: "HEAD_MISMATCH"
      },
      {
        name: "wrong finish count",
        exercise(sink) {
          const exact = identity("s", "t", 1);
          sink.appendProjection(exact);
          sink.sealProjections();
          sink.assertHead(exact);
          sink.finish(2, 2);
        },
        code: "HEAD_MISMATCH"
      }
    ];
    for (const row of cases) {
      const path = await databasePath();
      const transferred = new DatabaseSync(path);
      const sink = createAttuneGraphPortableIndexedValidationSink(transferred);
      const failure = rejection(() => row.exercise(sink));
      expect(failure, row.name).toMatchObject({ code: row.code });
      expect(transferred.isOpen, row.name).toBe(false);
      expect(rejection(() => sink.sealProjections()), row.name).toBe(failure);
    }
  });

  it("gives invalid finish integers and head-vs-scope mismatch deterministic precedence", async () => {
    const invalidCounts: readonly [unknown, unknown][] = [
      [-1, 0],
      [0, -1],
      [0.5, 0.5],
      [Number.NaN, Number.NaN],
      [Number.MAX_SAFE_INTEGER + 1, Number.MAX_SAFE_INTEGER + 1],
      [1, 0],
      [0, 1]
    ];
    for (const [scopeCount, headCount] of invalidCounts) {
      const path = await databasePath();
      const transferred = new DatabaseSync(path);
      const sink = createAttuneGraphPortableIndexedValidationSink(transferred);
      sink.sealProjections();
      const failure = rejection(
        () => sink.finish(scopeCount as number, headCount as number)
      );
      expect(failure).toMatchObject({ code: "INVALID_INPUT" });
      expect(transferred.isOpen).toBe(false);
      expect(rejection(() => sink.finish(0, 0))).toBe(failure);
    }
  });

  it("rejects hostile identities and non-round-tripping UTF-16 without observation", async () => {
    const cases: unknown[] = [
      new Proxy(identity("s", "t", 1), {}),
      { ...identity("s", "t", 1), extra: true },
      {
        scope: Object.defineProperty({}, "sourceId", {
          enumerable: true,
          get() {
            throw new Error("must not execute");
          }
        }),
        generation: 1,
        commitId: "commit",
        projectionId: STORE_ONE
      },
      identity("\ud800", "thread", 1),
      identity("source", "\udfff", 1),
      identity("source", "thread", 0),
      { ...identity("s", "t", 1), projectionId: "bad" }
    ];
    for (const value of cases) {
      const path = await databasePath();
      const transferred = new DatabaseSync(path);
      const sink = createAttuneGraphPortableIndexedValidationSink(transferred);
      expect(rejection(() => sink.appendProjection(value as never)))
        .toMatchObject({ code: "INVALID_INPUT" });
      expect(transferred.isOpen).toBe(false);
    }
  });

  it("transfers genuine handles on factory failure but not hostile values", async () => {
    const hostile = {};
    expect(rejection(
      () => createAttuneGraphPortableIndexedValidationSink(hostile as DatabaseSync)
    )).toMatchObject({ code: "INVALID_INPUT" });

    const proxyTarget = new DatabaseSync(":memory:");
    expect(rejection(
      () => createAttuneGraphPortableIndexedValidationSink(
        new Proxy(proxyTarget, {}) as DatabaseSync
      )
    )).toMatchObject({ code: "INVALID_INPUT" });
    expect(proxyTarget.isOpen).toBe(true);
    proxyTarget.close();

    const closed = new DatabaseSync(":memory:");
    closed.close();
    expect(rejection(
      () => createAttuneGraphPortableIndexedValidationSink(closed)
    )).toMatchObject({ code: "INVALID_INPUT" });
    expect(closed.isOpen).toBe(false);

    const active = new DatabaseSync(":memory:");
    active.exec("BEGIN");
    expect(rejection(
      () => createAttuneGraphPortableIndexedValidationSink(active)
    )).toMatchObject({ code: "INVALID_INPUT" });
    expect(active.isOpen).toBe(false);

    const nonempty = new DatabaseSync(":memory:");
    nonempty.exec("CREATE TABLE existing (value INTEGER)");
    expect(rejection(
      () => createAttuneGraphPortableIndexedValidationSink(nonempty)
    )).toMatchObject({ code: "INVALID_INPUT" });
    expect(nonempty.isOpen).toBe(false);
  });

  it("moves hostile qualification-fault validation inside genuine ownership", () => {
    const accessor = Object.defineProperty({
      payload: new Error("payload")
    }, "operation", {
      enumerable: true,
      get() {
        throw new Error("hostile getter");
      }
    });
    const hostileFaults: unknown[] = [
      null,
      [],
      new Proxy({ operation: "execute", payload: new Error("x") }, {}),
      accessor,
      { operation: "execute", payload: new Error("x"), extra: true }
    ];
    for (const fault of hostileFaults) {
      const transferred = new DatabaseSync(":memory:");
      const failure = rejection(
        () => createAttuneGraphPortableIndexedValidationSinkForQualification(
          transferred,
          fault as never
        )
      );
      expect(failure).toBeInstanceOf(AttuneGraphPortableIndexedValidationSinkError);
      expect(failure).toMatchObject({
        code: "INVALID_INPUT",
        message: "indexed validation qualification fault is invalid"
      });
      expect(Object.hasOwn(failure as object, "cause")).toBe(false);
      expect(transferred.isOpen).toBe(false);
    }

    let faultObserved = false;
    const unownedFault = new Proxy({}, {
      ownKeys() {
        faultObserved = true;
        throw new Error("must not inspect");
      }
    });
    expect(rejection(
      () => createAttuneGraphPortableIndexedValidationSinkForQualification(
        {} as DatabaseSync,
        unownedFault as never
      )
    )).toMatchObject({
      code: "INVALID_INPUT",
      message: "indexed validation database must be genuine"
    });
    expect(faultObserved).toBe(false);
  });

  it("rejects TEMP state and empty or nonempty attachments at admission", () => {
    const configureCases: readonly {
      readonly name: string;
      readonly configure: (database: DatabaseSync) => void;
    }[] = [
      {
        name: "unrelated TEMP table",
        configure(database) {
          database.exec("CREATE TEMP TABLE unrelated (value INTEGER)");
        }
      },
      {
        name: "TEMP exact-name shadow",
        configure(database) {
          database.exec(
            "CREATE TEMP TABLE attunegraph_portable_validation_scope (value INTEGER)"
          );
        }
      },
      {
        name: "empty attachment",
        configure(database) {
          database.exec("ATTACH DATABASE ':memory:' AS extra");
        }
      },
      {
        name: "nonempty attachment",
        configure(database) {
          database.exec(
            "ATTACH DATABASE ':memory:' AS extra;"
            + " CREATE TABLE extra.other (value INTEGER)"
          );
        }
      }
    ];
    for (const row of configureCases) {
      const transferred = new DatabaseSync(":memory:");
      row.configure(transferred);
      const failure = rejection(
        () => createAttuneGraphPortableIndexedValidationSink(transferred)
      );
      expect(failure, row.name).toBeInstanceOf(
        AttuneGraphPortableIndexedValidationSinkError
      );
      expect(failure, row.name).toMatchObject({ code: "INVALID_INPUT" });
      expect((failure as Error).message, row.name).not.toMatch(
        /ATTACH DATABASE|CREATE TABLE|SQLITE_|database is locked|sqlite_schema/iu
      );
      expect(transferred.isOpen, row.name).toBe(false);
    }
  });

  it("revalidates main-only attachment and empty TEMP state before commit", () => {
    for (const mutation of ["temp", "attach"] as const) {
      const transferred = new DatabaseSync(":memory:");
      const sink = createAttuneGraphPortableIndexedValidationSink(transferred);
      if (mutation === "temp") {
        transferred.exec("CREATE TEMP TABLE late_temp (value INTEGER)");
      } else {
        transferred.exec("ATTACH DATABASE ':memory:' AS late_extra");
      }
      sink.sealProjections();
      const failure = rejection(() => sink.finish(0, 0));
      expect(failure).toMatchObject({ code: "STORE_FAILURE" });
      expect(transferred.isOpen).toBe(false);
      expect(rejection(() => sink.finish(0, 0))).toBe(failure);
    }
  });

  it("uses a bounded busy timeout and sanitizes lock failures", async () => {
    const path = await databasePath();
    const holder = new DatabaseSync(path);
    holder.exec("BEGIN EXCLUSIVE");
    const transferred = new DatabaseSync(path, { timeout: 10 });
    const failure = rejection(
      () => createAttuneGraphPortableIndexedValidationSink(transferred)
    );
    expect(failure).toBeInstanceOf(AttuneGraphPortableIndexedValidationSinkError);
    expect(failure).toMatchObject({
      code: "STORE_FAILURE",
      message: "indexed validation SQLite operation failed"
    });
    expect(Object.hasOwn(failure as object, "cause")).toBe(false);
    expect((failure as Error).message).not.toMatch(/SQLITE_BUSY|database is locked|SELECT/iu);
    expect(transferred.isOpen).toBe(false);
    holder.exec("ROLLBACK");
    holder.close();
  });

  it("detaches and freezes the current identity before SQLite execution", async () => {
    const path = await databasePath();
    const mutable = identity("before", "thread", 1);
    let mutationDone = false;
    const sink = createAttuneGraphPortableIndexedValidationSinkForQualification(
      new DatabaseSync(path),
      {
        operation: "close",
        occurrence: 99,
        payload: new Error("unused"),
        runtimeOnly: true,
        beforeOperation(operation) {
          if (operation === "execute" && !mutationDone) {
            mutationDone = true;
            (mutable.scope as { sourceId: string }).sourceId = "after";
            (mutable as { commitId: string }).commitId = "changed";
          }
        }
      }
    );
    sink.appendProjection(mutable);
    sink.sealProjections();
    sink.assertHead(identity("before", "thread", 1));
    sink.finish(1, 1);
    const inspected = new DatabaseSync(path, { readOnly: true });
    expect(row(inspected, "before", "thread")).toMatchObject({
      commitId: "commit-1",
      headSeen: 1
    });
    expect(row(inspected, "after", "thread")).toBeUndefined();
    inspected.close();
  });

  it("pins nullish qualification failures and reentry while cleaning up once", () => {
    for (const payload of [undefined, null]) {
      const transferred = new DatabaseSync(":memory:");
      const sink = createAttuneGraphPortableIndexedValidationSinkForQualification(
        transferred,
        { operation: "execute", payload, runtimeOnly: true }
      );
      expect(rejection(() => sink.appendProjection(identity("s", "t", 1))))
        .toBe(payload);
      expect(rejection(() => sink.sealProjections())).toBe(payload);
      expect(transferred.isOpen).toBe(false);
    }

    const transferred = new DatabaseSync(":memory:");
    const holder: {
      sink?: ReturnType<typeof createAttuneGraphPortableIndexedValidationSinkForQualification>;
    } = {};
    let entered = false;
    const sink = createAttuneGraphPortableIndexedValidationSinkForQualification(
      transferred,
      {
        operation: "close",
        occurrence: 99,
        payload: new Error("unused"),
        runtimeOnly: true,
        beforeOperation(operation) {
          if (operation === "execute" && !entered) {
            entered = true;
            holder.sink!.sealProjections();
          }
        }
      }
    );
    holder.sink = sink;
    const failure = rejection(
      () => sink.appendProjection(identity("s", "t", 1))
    );
    expect(failure).toMatchObject({ code: "REENTRY" });
    expect(rejection(() => sink.sealProjections())).toBe(failure);
    expect(transferred.isOpen).toBe(false);
  });

  it("rolls back external abort staging and pins its exact nullish-safe cause", async () => {
    const path = await databasePath();
    const transferred = new DatabaseSync(path);
    const sink = createAttuneGraphPortableIndexedValidationSink(transferred);
    sink.appendProjection(identity("s", "t", 1));
    const cause = new Error("decoder-abort");
    sink.abort(cause);
    expect(transferred.isOpen).toBe(false);
    expect(rejection(() => sink.sealProjections())).toBe(cause);

    const inspected = new DatabaseSync(path, { readOnly: true });
    expect(inspected.prepare(`
      SELECT COUNT(*) AS count FROM sqlite_schema
      WHERE name NOT LIKE 'sqlite_%'
    `).get()).toEqual({ count: 0 });
    expect(inspected.prepare("PRAGMA application_id").get()).toEqual({
      application_id: 0
    });
    expect(inspected.prepare("PRAGMA user_version").get()).toEqual({
      user_version: 0
    });
    inspected.close();
  });

  it("observes native terminal close exactly once without changing the public sink", () => {
    const transferred = new DatabaseSync(":memory:");
    const internal =
      createAttuneGraphPortableIndexedValidationSinkWithTerminalCloseOutcomeForInternalUse(
        transferred
      );
    expect(() => internal.terminalCloseOutcome())
      .toThrow(expect.objectContaining({ code: "INVALID_STATE" }));
    internal.sink.abort("cancel");
    expect(transferred.isOpen).toBe(false);
    expect(internal.terminalCloseOutcome()).toBe("closed");
    expect(internal.terminalCloseOutcome()).toBe("closed");
    internal.sink.abort("later");
    expect(internal.terminalCloseOutcome()).toBe("closed");
  });

  it("observes injected terminal close failure as monotonic unknown", () => {
    const transferred = new DatabaseSync(":memory:");
    const internal =
      createAttuneGraphPortableIndexedValidationSinkWithTerminalCloseOutcomeForQualification(
        transferred,
        {
          operation: "close",
          payload: new Error("close"),
          runtimeOnly: true
        }
      );
    internal.sink.abort("cancel");
    expect(transferred.isOpen).toBe(true);
    expect(internal.terminalCloseOutcome()).toBe("unknown");
    internal.sink.abort("later");
    expect(internal.terminalCloseOutcome()).toBe("unknown");
    transferred.close();
  });

  it("preserves successful finished terminal across later cleanup aborts", () => {
    for (const payload of [undefined, null, new Error("late")]) {
      const transferred = new DatabaseSync(":memory:");
      const sink = createAttuneGraphPortableIndexedValidationSink(transferred);
      sink.sealProjections();
      sink.finish(0, 0);
      expect(transferred.isOpen).toBe(false);
      sink.abort(payload);
      const failure = rejection(() => sink.sealProjections());
      expect(failure).toMatchObject({
        code: "INVALID_STATE",
        message: "indexed validation sink is finished"
      });
      expect(failure).not.toBe(payload);
      expect(transferred.isOpen).toBe(false);
    }
  });

  it("injects every SQLite operation fault without replacing the first failure", () => {
    const factoryFaults = ["begin", "execute", "quick-check"] as const;
    for (const operation of factoryFaults) {
      const transferred = new DatabaseSync(":memory:");
      const failure = new Error(`fault-${operation}`);
      expect(rejection(
        () => createAttuneGraphPortableIndexedValidationSinkForQualification(
          transferred,
          { operation, payload: failure }
        )
      )).toBe(failure);
      expect(transferred.isOpen).toBe(false);
    }

    const rollbackDatabase = new DatabaseSync(":memory:");
    const rollbackSink = createAttuneGraphPortableIndexedValidationSinkForQualification(
      rollbackDatabase,
      { operation: "rollback", payload: new Error("rollback"), runtimeOnly: true }
    );
    const original = new Error("original");
    rollbackSink.abort(original);
    expect(rejection(() => rollbackSink.sealProjections())).toBe(original);
    expect(rollbackDatabase.isOpen).toBe(false);

    const commitDatabase = new DatabaseSync(":memory:");
    const commitFailure = new Error("commit");
    const commitSink = createAttuneGraphPortableIndexedValidationSinkForQualification(
      commitDatabase,
      { operation: "commit", payload: commitFailure, runtimeOnly: true }
    );
    commitSink.sealProjections();
    expect(rejection(() => commitSink.finish(0, 0))).toBe(commitFailure);
    expect(commitDatabase.isOpen).toBe(false);

    const quickDatabase = new DatabaseSync(":memory:");
    const quickFailure = new Error("quick");
    const quickSink = createAttuneGraphPortableIndexedValidationSinkForQualification(
      quickDatabase,
      { operation: "quick-check", payload: quickFailure, runtimeOnly: true }
    );
    quickSink.sealProjections();
    expect(rejection(() => quickSink.finish(0, 0))).toBe(quickFailure);
    expect(quickDatabase.isOpen).toBe(false);

    const closeDatabase = new DatabaseSync(":memory:");
    const closeFailure = new Error("close");
    let closeAttempts = 0;
    const closeSink = createAttuneGraphPortableIndexedValidationSinkForQualification(
      closeDatabase,
      {
        operation: "close",
        payload: closeFailure,
        runtimeOnly: true,
        beforeOperation(operation) {
          if (operation === "close") closeAttempts += 1;
        }
      }
    );
    closeSink.sealProjections();
    expect(rejection(() => closeSink.finish(0, 0))).toBe(closeFailure);
    expect(closeDatabase.isOpen).toBe(true);
    expect(closeDatabase.isTransaction).toBe(false);
    expect(closeAttempts).toBe(1);
    closeSink.abort(new Error("later"));
    expect(closeAttempts).toBe(1);
    expect(closeDatabase.prepare("PRAGMA application_id").get()).toEqual({
      application_id: 0x4d505631
    });
    closeDatabase.close();

    const unknownCloseDatabase = new DatabaseSync(":memory:");
    const initializationFailure = new Error("initialization");
    const cleanupFailure = new Error("cleanup");
    let threwInitialization = false;
    expect(rejection(
      () => createAttuneGraphPortableIndexedValidationSinkForQualification(
        unknownCloseDatabase,
        {
          operation: "close",
          payload: cleanupFailure,
          beforeOperation(operation) {
            if (operation === "execute" && !threwInitialization) {
              threwInitialization = true;
              throw initializationFailure;
            }
          }
        }
      )
    )).toBe(initializationFailure);
    expect(unknownCloseDatabase.isOpen).toBe(true);
    unknownCloseDatabase.close();
  });

  it("keeps the sink absent from package exports and serving Worker imports", async () => {
    for (const surface of await Promise.all([
      import("./index.js"),
      import("./local.js"),
      import("./attunegraph-backend.js"),
      import("./testing.js")
    ])) {
      expect(Object.hasOwn(
        surface,
        "createAttuneGraphPortableIndexedValidationSink"
      )).toBe(false);
    }
    const source = await readFile(join(
      import.meta.dirname,
      "attunegraph-portable-indexed-validation-sink.ts"
    ), "utf8");
    expect(source).not.toMatch(/attunegraph-local-(?:worker|protocol|sqlite|profile)/u);
    expect(source).not.toMatch(/canonicalProjection|projection_json|projection body/iu);
    expect(source).not.toMatch(/node:fs|unlink|rmSync|mkdir|openSync/u);
  });

  it("pins the exact closed JavaScript retained-state ledger", async () => {
    const source = await readFile(join(
      import.meta.dirname,
      "attunegraph-portable-indexed-validation-sink.ts"
    ), "utf8");
    const body = source.slice(
      source.indexOf("function createIndexedSink("),
      source.indexOf("\nexport function createAttuneGraphPortableIndexedValidationSink(")
    );
    const declarations = body
      .split("\n")
      .filter((line) => /^ {2}(?:const|let) [A-Za-z_$][\w$]*/u.test(line))
      .map((line) => line.trim());
    expect(declarations).toEqual([
      'const openDescriptor = objectGetOwnPropertyDescriptor(candidate, "isOpen");',
      "const transactionDescriptor = objectGetOwnPropertyDescriptor(",
      "const database = candidate as DatabaseSync;",
      'let phase: Phase = "projections";',
      "let operationActive = false;",
      "let terminalPinned = false;",
      "let terminalFailure: unknown;",
      "let transactionStarted = false;",
      "let committed = false;",
      "let rollbackAttempted = false;",
      "let closeAttempted = false;",
      "let closeOutcome:",
      "let statements: Statements | undefined;",
      "let currentIdentity: DetachedIdentity | undefined;",
      "let initialized = false;",
      "let qualificationFault:",
      "let projectionCount = 0;",
      "let headCount = 0;",
      "let scopeCount = 0;",
      "const faultCounts: Record<SqliteOperation, number> = {",
      "const maybeFault = (",
      "const exec = (",
      "const prepare = (sql: string): StatementSync => {",
      "const get = (",
      "const run = (",
      "const isTransaction = (): boolean => {",
      "const rollback = (): void => {",
      "const close = (): void => {",
      "const cleanup = (): void => {",
      "const pinFailure = (cause: unknown): never => {",
      "const assertProfile = (): void => {",
      "const assertConnectionProfile = (",
      "const quickCheck = (): void => {",
      "const initialize = (): void => {",
      "const invoke = <Result>(operation: () => Result): Result => {",
      "const sink: AttuneGraphPortableDecoderValidationSink = {"
    ]);
    expect(declarations).not.toEqual(
      expect.arrayContaining([
        expect.stringMatching(/(?:\[\]|Array<|Map<|Set<|new Map|new Set)/u)
      ])
    );
    expect(source).not.toMatch(
      /(?:projection|identity|scope)(?:History|Journal)\s*[:=]/u
    );
  });
});
