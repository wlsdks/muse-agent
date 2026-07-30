import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it, vi } from "vitest";

import {
  createAttuneGraphStore,
  type AttuneGraphStoredProjection
} from "./attunegraph-backend.js";
import type { AttuneGraphScope, AttuneGraphSnapshot } from "./attunegraph-contracts.js";
import { openAttuneGraph } from "./attunegraph-engine.js";
import {
  createAttuneGraphPortableEncoder,
  createAttuneGraphPortableEncoderForQualification,
  AttuneGraphPortableFormatError,
  type AttuneGraphPortableEncoder,
  type AttuneGraphPortableEncoderIdentitySink,
  type AttuneGraphPortableProjectionIdentity
} from "./attunegraph-portable-encoder.js";
import { admitPortableProjection } from "./attunegraph-portable-admission.js";
import type { GraphAssertion } from "./types.js";

interface QualificationBudgets {
  readonly maxProjections: number;
  readonly maxHeads: number;
  readonly maxScopes: number;
  readonly maxTotalRecords: number;
  readonly maxPortableLineBytes: number;
  readonly maxEdgeLineBytes: number;
  readonly maxArtifactBytes: number;
}

const PRODUCTION_BUDGETS: QualificationBudgets = Object.freeze({
  maxProjections: 1_000_000,
  maxHeads: 1_000_000,
  maxScopes: 1_000_000,
  maxTotalRecords: 2_000_002,
  maxPortableLineBytes: 1_114_112,
  maxEdgeLineBytes: 16_384,
  maxArtifactBytes: 1_099_511_627_776
});
const BUDGET_KEYS = Object.freeze(Object.keys(PRODUCTION_BUDGETS));
const NOW = "2026-07-30T00:00:00.000Z";
const fixtureDirectory = join(
  dirname(fileURLToPath(import.meta.url)),
  "../fixtures/portable-v1"
);

let oneScope: readonly AttuneGraphStoredProjection[];
let unicode: readonly AttuneGraphStoredProjection[];

beforeAll(async () => {
  const [oneScopeInput, unicodeInput] = await Promise.all([
    readFile(join(fixtureDirectory, "one-scope-two-generations.input.json"), "utf8"),
    readFile(join(fixtureDirectory, "unicode-multi-scope.input.json"), "utf8")
  ]);
  oneScope = (JSON.parse(oneScopeInput) as {
    readonly projections: readonly AttuneGraphStoredProjection[];
  }).projections;
  unicode = (JSON.parse(unicodeInput) as {
    readonly projections: readonly AttuneGraphStoredProjection[];
  }).projections;
});

function budgets(
  overrides: Partial<QualificationBudgets> = {}
): QualificationBudgets {
  return { ...PRODUCTION_BUDGETS, ...overrides };
}

function sink(overrides: Partial<AttuneGraphPortableEncoderIdentitySink> = {}): {
  readonly value: AttuneGraphPortableEncoderIdentitySink;
  readonly projections: AttuneGraphPortableProjectionIdentity[];
  readonly heads: AttuneGraphPortableProjectionIdentity[];
  readonly aborts: unknown[];
  readonly calls: {
    readonly appendProjection: ReturnType<typeof vi.fn>;
    readonly sealProjections: ReturnType<typeof vi.fn>;
    readonly assertHead: ReturnType<typeof vi.fn>;
    readonly finish: ReturnType<typeof vi.fn>;
    readonly abort: ReturnType<typeof vi.fn>;
  };
} {
  const projections: AttuneGraphPortableProjectionIdentity[] = [];
  const heads: AttuneGraphPortableProjectionIdentity[] = [];
  const aborts: unknown[] = [];
  const calls = {
    appendProjection: vi.fn(),
    sealProjections: vi.fn(),
    assertHead: vi.fn(),
    finish: vi.fn(),
    abort: vi.fn()
  };
  const value: AttuneGraphPortableEncoderIdentitySink = {
    appendProjection(identity) {
      calls.appendProjection(identity);
      projections.push(identity);
    },
    sealProjections() {
      calls.sealProjections();
    },
    assertHead(head) {
      calls.assertHead(head);
      heads.push(head);
    },
    finish(expectedScopeCount, expectedHeadCount) {
      calls.finish(expectedScopeCount, expectedHeadCount);
    },
    abort(cause) {
      calls.abort(cause);
      aborts.push(cause);
    },
    ...overrides
  };
  return { value, projections, heads, aborts, calls };
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(
    chunks.reduce((total, chunk) => total + chunk.byteLength, 0)
  );
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function encode(
  encoder: AttuneGraphPortableEncoder,
  projections: readonly AttuneGraphStoredProjection[]
): {
  readonly artifact: Uint8Array;
  readonly report: ReturnType<AttuneGraphPortableEncoder["finish"]>["report"];
  readonly identities: readonly AttuneGraphPortableProjectionIdentity[];
} {
  const chunks = [encoder.start()];
  const identities: AttuneGraphPortableProjectionIdentity[] = [];
  const heads = new Map<string, AttuneGraphPortableProjectionIdentity>();
  for (const projection of projections) {
    const appended = encoder.appendProjection(
      projection.snapshot.scope,
      projection
    );
    chunks.push(appended.bytes);
    identities.push(appended.identity);
    heads.set(
      `${appended.identity.scope.sourceId}\0${appended.identity.scope.threadId}`,
      appended.identity
    );
  }
  encoder.sealProjections();
  for (const head of heads.values()) {
    chunks.push(encoder.appendHead(
      head.scope,
      head.generation,
      head.commitId,
      head.projectionId
    ));
  }
  const finished = encoder.finish();
  chunks.push(finished.bytes);
  return {
    artifact: concat(chunks),
    report: finished.report,
    identities
  };
}

function thrown(operation: () => unknown): unknown {
  try {
    operation();
  } catch (cause) {
    return cause;
  }
  throw new Error("operation did not throw");
}

function expectLimit(
  operation: () => unknown,
  message: string
): AttuneGraphPortableFormatError {
  const error = thrown(operation);
  expect(error).toBeInstanceOf(AttuneGraphPortableFormatError);
  expect(error).toMatchObject({ code: "LIMIT_EXCEEDED", message });
  return error as AttuneGraphPortableFormatError;
}

function syntheticHead(
  encoder: AttuneGraphPortableEncoder,
  sourceId: string
): Uint8Array {
  return encoder.appendHead(
    { sourceId, threadId: "boundary-thread" },
    1,
    "boundary-commit",
    `attunegraph-store:${"0".repeat(64)}`
  );
}

function exactFixtureHead(encoder: AttuneGraphPortableEncoder): Uint8Array {
  const identity = admitPortableProjection(
    oneScope[1],
    oneScope[1]!.snapshot.scope
  ).identity;
  return encoder.appendHead(
    identity.scope,
    identity.generation,
    identity.commitId,
    identity.projectionId
  );
}

function sortedProjections(
  values: readonly AttuneGraphStoredProjection[]
): readonly AttuneGraphStoredProjection[] {
  return [...values].sort((left, right) => {
    const source = Buffer.compare(
      Buffer.from(left.snapshot.scope.sourceId),
      Buffer.from(right.snapshot.scope.sourceId)
    );
    if (source !== 0) return source;
    const thread = Buffer.compare(
      Buffer.from(left.snapshot.scope.threadId),
      Buffer.from(right.snapshot.scope.threadId)
    );
    return thread !== 0
      ? thread
      : left.snapshot.generation - right.snapshot.generation;
  });
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

function evidenceAssertion(
  scope: AttuneGraphScope,
  version: string,
  generation: number
): GraphAssertion {
  return {
    schemaVersion: 1,
    id: `single-evidence-${generation.toString()}`,
    subject: { id: "single-evidence-artifact", kind: "artifact" },
    predicate: "LINKED_TO",
    object: { id: scope.threadId, kind: "thread" },
    epistemicClass: "source-observed",
    sourceRefs: [{
      id: "single-evidence-source",
      namespace: "qualification.source",
      version
    }],
    recordedAt: NOW,
    derivation: { kind: "projection", version: "single-evidence-version@1" }
  };
}

async function currentEvidenceProjection(
  version: string
): Promise<AttuneGraphStoredProjection> {
  const scope = {
    sourceId: "single-evidence-source",
    threadId: "single-evidence-thread"
  };
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
  try {
    await attuneGraph.project({
      operator: "canonical-projection@1",
      observation: {
        schemaVersion: 1,
        observationKey: "single-evidence-1",
        scope,
        observedAt: NOW,
        sourceFreshness: { state: "fresh", observedAt: NOW },
        assertions: [evidenceAssertion(scope, version, 1)]
      }
    });
  } finally {
    await attuneGraph.close();
  }
  if (current === undefined) {
    throw new Error("Engine did not propose a current evidence projection");
  }
  return JSON.parse(JSON.stringify(current)) as AttuneGraphStoredProjection;
}

async function boundedEvidencePair(
  firstVersion: string,
  secondVersion: string
): Promise<readonly [AttuneGraphStoredProjection, AttuneGraphStoredProjection]> {
  const scope = {
    sourceId: "single-evidence-source",
    threadId: "single-evidence-thread"
  };
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
  try {
    expectedSnapshot = await attuneGraph.project({
      operator: "canonical-projection@1",
      observation: {
        schemaVersion: 1,
        observationKey: "single-evidence-1",
        scope,
        observedAt: NOW,
        sourceFreshness: { state: "fresh", observedAt: NOW },
        assertions: [evidenceAssertion(scope, firstVersion, 1)]
      }
    });
    if (current === undefined) {
      throw new Error("Engine did not propose first bounded evidence projection");
    }
    const first = JSON.parse(JSON.stringify(current)) as AttuneGraphStoredProjection;
    await attuneGraph.project({
      operator: "canonical-projection@1",
      expectedSnapshot,
      observation: {
        schemaVersion: 1,
        observationKey: "single-evidence-2",
        scope,
        observedAt: NOW,
        sourceFreshness: { state: "fresh", observedAt: NOW },
        assertions: [evidenceAssertion(scope, secondVersion, 2)]
      }
    });
    if (current === undefined) {
      throw new Error("Engine did not propose second bounded evidence projection");
    }
    return [
      first,
      JSON.parse(JSON.stringify(current)) as AttuneGraphStoredProjection
    ];
  } finally {
    await attuneGraph.close();
  }
}

describe("AttuneGraph portable shared-path reduced-budget qualification", () => {
  it.each([
    ["empty", []],
    ["one-scope/two-generation", () => oneScope],
    ["Unicode corpus", () => unicode]
  ] as const)(
    "keeps production and production-budget qualification exact for %s",
    (_name, fixture) => {
      const values = sortedProjections(
        typeof fixture === "function" ? fixture() : fixture
      );
      const productionSink = sink();
      const qualificationSink = sink();
      const production = encode(
        createAttuneGraphPortableEncoder({ identitySink: productionSink.value }),
        values
      );
      const qualification = encode(
        createAttuneGraphPortableEncoderForQualification(
          { identitySink: qualificationSink.value },
          PRODUCTION_BUDGETS
        ),
        values
      );
      expect(qualification.artifact).toEqual(production.artifact);
      expect(qualification.report).toEqual(production.report);
      expect(qualification.identities).toEqual(production.identities);
      expect(qualificationSink.projections).toEqual(productionSink.projections);
      expect(qualificationSink.heads).toEqual(productionSink.heads);
      expect(qualificationSink.calls.finish.mock.calls).toEqual(
        productionSink.calls.finish.mock.calls
      );
    }
  );

  it("keeps representative lifecycle, order, options, and sink-failure behavior paired", () => {
    const factories = [
      (identitySink: AttuneGraphPortableEncoderIdentitySink) =>
        createAttuneGraphPortableEncoder({ identitySink }),
      (identitySink: AttuneGraphPortableEncoderIdentitySink) =>
        createAttuneGraphPortableEncoderForQualification(
          { identitySink },
          PRODUCTION_BUDGETS
        )
    ];
    const failures: unknown[] = [];
    for (const factory of factories) {
      const observed = sink();
      const lifecycle = factory(observed.value);
      const lifecycleFailure = thrown(() => lifecycle.finish());
      expect(lifecycleFailure).toMatchObject({
        code: "INVALID_STATE",
        message: "portable encoder may finish only after sealing"
      });
      expect(observed.aborts).toHaveLength(0);

      const ordered = factory(observed.value);
      ordered.start();
      ordered.appendProjection(oneScope[0]!.snapshot.scope, oneScope[0]);
      const orderFailure = thrown(() =>
        ordered.appendProjection(oneScope[0]!.snapshot.scope, oneScope[0])
      );
      expect(orderFailure).toMatchObject({
        code: "INVALID_ORDER",
        message: "projection generations must be contiguous"
      });
      expect(observed.aborts.at(-1)).toBe(orderFailure);

      const sinkFailure = new Error("paired sink failure");
      const hostile = sink({
        appendProjection() {
          throw sinkFailure;
        }
      });
      const terminal = factory(hostile.value);
      terminal.start();
      expect(thrown(() => terminal.appendProjection(
        oneScope[0]!.snapshot.scope,
        oneScope[0]
      ))).toBe(sinkFailure);
      expect(hostile.aborts).toEqual([sinkFailure]);
      expect(thrown(() => terminal.finish())).toBe(sinkFailure);
      failures.push(lifecycleFailure, orderFailure);
    }
    expect(failures[2]).toEqual(failures[0]);
    expect(failures[3]).toEqual(failures[1]);

    let productionGetterCalls = 0;
    let qualificationGetterCalls = 0;
    for (const [factory, increment] of [
      [
        (options: unknown) => createAttuneGraphPortableEncoder(options as never),
        () => { productionGetterCalls += 1; }
      ],
      [
        (options: unknown) => createAttuneGraphPortableEncoderForQualification(
          options as never,
          PRODUCTION_BUDGETS
        ),
        () => { qualificationGetterCalls += 1; }
      ]
    ] as const) {
      const options = {};
      Object.defineProperty(options, "identitySink", {
        enumerable: true,
        get() {
          increment();
          return sink().value;
        }
      });
      expect(thrown(() => factory(options))).toMatchObject({
        code: "INVALID_INPUT",
        message: "portable encoder options.identitySink must be a data property"
      });
    }
    expect([productionGetterCalls, qualificationGetterCalls]).toEqual([0, 0]);
  });

  it("validates and snapshots the exact seven-key budget record without observation", () => {
    const validNull = Object.assign(Object.create(null), PRODUCTION_BUDGETS);
    expect(createAttuneGraphPortableEncoderForQualification(
      { identitySink: sink().value },
      validNull
    )).toBeDefined();
    expect(createAttuneGraphPortableEncoderForQualification(
      { identitySink: sink().value },
      budgets()
    )).toBeDefined();

    let getterCalls = 0;
    const accessor = budgets() as unknown as Record<string, unknown>;
    Object.defineProperty(accessor, "maxHeads", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return 1;
      }
    });
    const symbol = budgets() as unknown as Record<PropertyKey, unknown>;
    symbol[Symbol("extra")] = 1;
    const nonEnumerable = budgets() as unknown as Record<string, unknown>;
    Object.defineProperty(nonEnumerable, "maxHeads", {
      value: 1,
      enumerable: false
    });
    const missing = budgets() as unknown as Record<string, unknown>;
    delete missing.maxScopes;
    const extra = { ...budgets(), extra: 1 };
    const inherited = Object.assign(Object.create({ inherited: 1 }), budgets());
    class BudgetClass {
      maxProjections = 1;
      maxHeads = 1;
      maxScopes = 1;
      maxTotalRecords = 2;
      maxPortableLineBytes = 1;
      maxEdgeLineBytes = 1;
      maxArtifactBytes = 1;
    }
    const revocable = Proxy.revocable(budgets(), {});
    revocable.revoke();
    const invalid: readonly unknown[] = [
      null,
      [],
      () => undefined,
      new BudgetClass(),
      new Proxy(budgets(), {}),
      revocable.proxy,
      accessor,
      symbol,
      nonEnumerable,
      missing,
      extra,
      inherited,
      budgets({ maxProjections: 0 }),
      budgets({ maxHeads: -1 }),
      budgets({ maxScopes: 1.5 }),
      budgets({ maxTotalRecords: 1 }),
      budgets({ maxPortableLineBytes: Number.NaN }),
      budgets({ maxEdgeLineBytes: Number.POSITIVE_INFINITY }),
      budgets({ maxArtifactBytes: Number.MAX_SAFE_INTEGER + 1 })
    ];
    for (const candidate of invalid) {
      const observed = sink();
      const error = thrown(() => createAttuneGraphPortableEncoderForQualification(
        { identitySink: observed.value },
        candidate as typeof PRODUCTION_BUDGETS
      ));
      expect(error).toBeInstanceOf(AttuneGraphPortableFormatError);
      expect(error).toMatchObject({ code: "INVALID_INPUT" });
      expect(Object.values(observed.calls).every(
        (callback) => callback.mock.calls.length === 0
      )).toBe(true);
    }
    expect(getterCalls).toBe(0);

    const mutable = budgets({ maxProjections: 2 }) as {
      -readonly [Key in keyof QualificationBudgets]: number;
    };
    const observed = sink();
    const portable = createAttuneGraphPortableEncoderForQualification(
      { identitySink: observed.value },
      mutable
    );
    mutable.maxProjections = 1_000_000;
    portable.start();
    portable.appendProjection(oneScope[0]!.snapshot.scope, oneScope[0]);
    portable.appendProjection(oneScope[1]!.snapshot.scope, oneScope[1]);
    expectLimit(
      () => portable.appendProjection(oneScope[1]!.snapshot.scope, oneScope[1]),
      "portable projection count exceeds its limit"
    );
    expect(BUDGET_KEYS).toEqual([
      "maxProjections",
      "maxHeads",
      "maxScopes",
      "maxTotalRecords",
      "maxPortableLineBytes",
      "maxEdgeLineBytes",
      "maxArtifactBytes"
    ]);
  });

  it("pins all exact byte and count boundary axes with non-preempting peers", () => {
    const manifestSuccess = createAttuneGraphPortableEncoderForQualification(
      { identitySink: sink().value },
      budgets({ maxEdgeLineBytes: 377 })
    );
    expect(manifestSuccess.start()).toHaveLength(378);
    const manifestFailureSink = sink();
    const manifestFailure = createAttuneGraphPortableEncoderForQualification(
      { identitySink: manifestFailureSink.value },
      budgets({ maxEdgeLineBytes: 376 })
    );
    expectLimit(
      () => manifestFailure.start(),
      "portable record line exceeds its byte limit"
    );
    expect(manifestFailureSink.calls.abort).not.toHaveBeenCalled();

    for (const [limit, succeeds] of [[449, true], [448, false]] as const) {
      const portable = createAttuneGraphPortableEncoderForQualification(
        { identitySink: sink().value },
        budgets({ maxEdgeLineBytes: limit })
      );
      portable.start();
      portable.sealProjections();
      if (succeeds) expect(portable.finish().bytes).toHaveLength(450);
      else expectLimit(
        () => portable.finish(),
        "portable record line exceeds its byte limit"
      );
    }

    for (const [limit, succeeds] of [[1_994, true], [1_993, false]] as const) {
      const portable = createAttuneGraphPortableEncoderForQualification(
        { identitySink: sink().value },
        budgets({ maxPortableLineBytes: limit })
      );
      portable.start();
      const operation = () => portable.appendProjection(
        oneScope[0]!.snapshot.scope,
        oneScope[0]
      );
      if (succeeds) expect(operation().bytes).toHaveLength(1_995);
      else expectLimit(
        operation,
        "portable record line exceeds its byte limit"
      );
    }

    for (const [limit, succeeds] of [[442, true], [441, false]] as const) {
      const portable = createAttuneGraphPortableEncoderForQualification(
        { identitySink: sink().value },
        budgets({ maxPortableLineBytes: limit })
      );
      portable.start();
      portable.sealProjections();
      if (succeeds) expect(exactFixtureHead(portable)).toHaveLength(443);
      else expectLimit(
        () => exactFixtureHead(portable),
        "portable record line exceeds its byte limit"
      );
    }

    const projectionCount = createAttuneGraphPortableEncoderForQualification(
      { identitySink: sink().value },
      budgets({ maxProjections: 1, maxTotalRecords: 5 })
    );
    projectionCount.start();
    projectionCount.appendProjection(oneScope[0]!.snapshot.scope, oneScope[0]);
    expectLimit(
      () => projectionCount.appendProjection(
        oneScope[1]!.snapshot.scope,
        oneScope[1]
      ),
      "portable projection count exceeds its limit"
    );
    const projectionCountSuccess = createAttuneGraphPortableEncoderForQualification(
      { identitySink: sink().value },
      budgets({ maxProjections: 2, maxTotalRecords: 5 })
    );
    projectionCountSuccess.start();
    projectionCountSuccess.appendProjection(oneScope[0]!.snapshot.scope, oneScope[0]);
    projectionCountSuccess.appendProjection(oneScope[1]!.snapshot.scope, oneScope[1]);

    const headCount = createAttuneGraphPortableEncoderForQualification(
      { identitySink: sink().value },
      budgets({ maxHeads: 1, maxScopes: 3, maxTotalRecords: 5 })
    );
    headCount.start();
    headCount.sealProjections();
    syntheticHead(headCount, "a");
    expectLimit(
      () => syntheticHead(headCount, "b"),
      "portable head count exceeds its limit"
    );
    const scopeCount = createAttuneGraphPortableEncoderForQualification(
      { identitySink: sink().value },
      budgets({ maxHeads: 3, maxScopes: 1, maxTotalRecords: 5 })
    );
    scopeCount.start();
    scopeCount.sealProjections();
    syntheticHead(scopeCount, "a");
    expectLimit(
      () => syntheticHead(scopeCount, "b"),
      "portable scope count exceeds its limit"
    );
    const headBeforeScopePrecedence = createAttuneGraphPortableEncoderForQualification(
      { identitySink: sink().value },
      budgets({ maxHeads: 1, maxScopes: 1, maxTotalRecords: 5 })
    );
    headBeforeScopePrecedence.start();
    headBeforeScopePrecedence.sealProjections();
    syntheticHead(headBeforeScopePrecedence, "a");
    expectLimit(
      () => syntheticHead(headBeforeScopePrecedence, "b"),
      "portable head count exceeds its limit"
    );
    const headSuccess = createAttuneGraphPortableEncoderForQualification(
      { identitySink: sink().value },
      budgets({ maxHeads: 2, maxScopes: 2, maxTotalRecords: 5 })
    );
    headSuccess.start();
    headSuccess.sealProjections();
    syntheticHead(headSuccess, "a");
    syntheticHead(headSuccess, "b");

    for (const [limit, succeeds] of [[4, true], [3, false]] as const) {
      const portable = createAttuneGraphPortableEncoderForQualification(
        { identitySink: sink().value },
        budgets({
          maxProjections: 2,
          maxHeads: 2,
          maxScopes: 2,
          maxTotalRecords: limit
        })
      );
      portable.start();
      const identity = portable.appendProjection(
        oneScope[0]!.snapshot.scope,
        oneScope[0]
      ).identity;
      portable.sealProjections();
      const operation = () => portable.appendHead(
        identity.scope,
        identity.generation,
        identity.commitId,
        identity.projectionId
      );
      if (succeeds) {
        operation();
        portable.finish();
      } else {
        expectLimit(operation, "portable record count exceeds its limit");
      }
    }

    for (const [limit, succeeds] of [[828, true], [827, false]] as const) {
      const portable = createAttuneGraphPortableEncoderForQualification(
        { identitySink: sink().value },
        budgets({ maxArtifactBytes: limit })
      );
      const chunks = [portable.start()];
      portable.sealProjections();
      if (succeeds) {
        chunks.push(portable.finish().bytes);
        expect(concat(chunks)).toHaveLength(828);
      } else {
        expectLimit(
          () => portable.finish(),
          "portable artifact exceeds its byte limit"
        );
      }
    }
  });

  it("normalizes only portable canonical line overflow and preserves retry/terminal semantics", async () => {
    const [smallFresh, largeFresh] = await Promise.all([
      currentEvidenceProjection("a"),
      currentEvidenceProjection("x".repeat(128))
    ]);
    const sequential = await boundedEvidencePair("a", "x".repeat(128));
    const measure = (projection: AttuneGraphStoredProjection): number => {
      const portable = createAttuneGraphPortableEncoder({
        identitySink: sink().value
      });
      portable.start();
      return portable.appendProjection(
        projection.snapshot.scope,
        projection
      ).bytes.byteLength - 1;
    };
    const smallBytes = measure(smallFresh);
    const largeBytes = measure(largeFresh);
    expect(largeBytes).toBeGreaterThan(smallBytes);
    const reduced = budgets({ maxPortableLineBytes: largeBytes - 1 });

    const preSink = sink();
    const retrying = createAttuneGraphPortableEncoderForQualification(
      { identitySink: preSink.value },
      reduced
    );
    retrying.start();
    expectLimit(
      () => retrying.appendProjection(
        largeFresh.snapshot.scope,
        largeFresh
      ),
      "portable record line exceeds its byte limit"
    );
    expect(preSink.calls.appendProjection).not.toHaveBeenCalled();
    expect(preSink.calls.abort).not.toHaveBeenCalled();
    const retried = retrying.appendProjection(
      smallFresh.snapshot.scope,
      smallFresh
    );
    const fresh = createAttuneGraphPortableEncoderForQualification(
      { identitySink: sink().value },
      reduced
    );
    fresh.start();
    const freshSmall = fresh.appendProjection(
      smallFresh.snapshot.scope,
      smallFresh
    );
    expect(retried).toEqual(freshSmall);

    let abortCalls = 0;
    const postSink = sink({
      abort(cause) {
        abortCalls += 1;
        postSink.aborts.push(cause);
        throw new Error("hostile abort");
      }
    });
    const sequentialMeasure = createAttuneGraphPortableEncoder({
      identitySink: sink().value
    });
    sequentialMeasure.start();
    sequentialMeasure.appendProjection(
      sequential[0]!.snapshot.scope,
      sequential[0]
    );
    const largeSequentialBytes = sequentialMeasure.appendProjection(
      sequential[1]!.snapshot.scope,
      sequential[1]
    ).bytes.byteLength - 1;
    const terminal = createAttuneGraphPortableEncoderForQualification(
      { identitySink: postSink.value },
      budgets({
        maxPortableLineBytes: largeSequentialBytes - 1
      })
    );
    terminal.start();
    terminal.appendProjection(
      sequential[0]!.snapshot.scope,
      sequential[0]
    );
    const original = expectLimit(
      () => terminal.appendProjection(
        sequential[1]!.snapshot.scope,
        sequential[1]
      ),
      "portable record line exceeds its byte limit"
    );
    expect(Object.hasOwn(original, "details")).toBe(false);
    expect(Object.hasOwn(original, "cause")).toBe(false);
    expect(original.name).toBe("AttuneGraphPortableFormatError");
    expect(postSink.aborts).toEqual([original]);
    expect(abortCalls).toBe(1);
    for (const later of [
      () => terminal.start(),
      () => terminal.sealProjections(),
      () => terminal.finish()
    ]) {
      expect(thrown(later)).toBe(original);
    }
    expect(abortCalls).toBe(1);
  });

  it("records the bounded single-evidence-version@1 search family and Engine ceiling", async () => {
    const lengths: number[] = [];
    for (let length = 1; length <= 128; length += 1) {
      const projection = await currentEvidenceProjection("v".repeat(length));
      const portable = createAttuneGraphPortableEncoderForQualification(
        { identitySink: sink().value },
        PRODUCTION_BUDGETS
      );
      portable.start();
      lengths.push(portable.appendProjection(
        projection!.snapshot.scope,
        projection
      ).bytes.byteLength - 1);
    }
    const maximum = Math.max(...lengths);
    const searchEvidence = Object.freeze({
      family: "single-evidence-version@1",
      bounds: Object.freeze({ minimum: 1, maximum: 128 }),
      generator: "ASCII v repeated to sourceRefs[0].version length",
      maximumAdmittedPortableLineBytes: maximum,
      productionCeiling: PRODUCTION_BUDGETS.maxPortableLineBytes,
      exactMargin: PRODUCTION_BUDGETS.maxPortableLineBytes - maximum,
      claim: "bounded transition coverage, not a global maximum or ceiling reachability proof"
    });
    expect(searchEvidence).toEqual({
      family: "single-evidence-version@1",
      bounds: { minimum: 1, maximum: 128 },
      generator: "ASCII v repeated to sourceRefs[0].version length",
      maximumAdmittedPortableLineBytes: 2_510,
      productionCeiling: 1_114_112,
      exactMargin: 1_111_602,
      claim: "bounded transition coverage, not a global maximum or ceiling reachability proof"
    });
    await expect(currentEvidenceProjection("v".repeat(129))).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message: "source observation assertions are invalid"
    });
  });

  it("keeps the qualification seam absent from all package exports", async () => {
    const surfaces = await Promise.all([
      import("./index.js"),
      import("./local.js"),
      import("./attunegraph-backend.js"),
      import("./testing.js")
    ]);
    for (const surface of surfaces) {
      expect(Object.hasOwn(
        surface,
        "createAttuneGraphPortableEncoderForQualification"
      )).toBe(false);
    }
    const privateSubpath = "@attunegraph/core/attunegraph-portable-encoder";
    await expect(import(privateSubpath)).rejects.toThrow(/not exported/u);
  });
});
