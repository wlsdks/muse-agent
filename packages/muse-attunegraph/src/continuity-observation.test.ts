import { createHash } from "node:crypto";

import type { AttunementState } from "@muse/attunement";
import { describe, expect, it } from "vitest";

import {
  captureContinuityObservation,
  CONTINUITY_OBSERVATION_FORMAT_VERSION,
  ContinuityObservationError,
  explainContinuityChangesFromReceipt,
  sealContinuityObservation,
  verifyContinuityObservation,
  type ContinuityObservationReceipt
} from "./continuity-observation.js";
import {
  ContinuityChangeQueryError
} from "./continuity-change-primitives.js";
import {
  prepareContinuitySourceObservation
} from "./continuity-source-observation.js";
import {
  compareVerifiedContinuityObservationReceipts
} from "./continuity-observation-comparison.js";
import {
  projectContinuityState,
  type ContinuityGraphProjection
} from "./continuity-projection.js";

const OBSERVED_AT = "2026-07-29T08:00:00.000Z";
const CURRENT_AT = "2026-07-29T10:00:00.000Z";
const HASH_DOMAIN = "muse.attunement.continuity-observation.v1\0";
const RECEIPT_PREFIX = "muse-continuity-observation:v1:sha256:";

const SENTINELS = Object.freeze([
  "private trip title sentinel",
  "private owner note sentinel",
  "private artifact summary sentinel",
  "mcp:private-provider-sentinel",
  "private-provider-artifact-id-sentinel"
]);

function sourceFixture(): AttunementState {
  const link = {
    artifactId: SENTINELS[4] as string,
    artifactType: "resource" as const,
    linkedAt: "2026-07-29T01:00:00.000Z",
    linkedBy: "user" as const,
    providerId: SENTINELS[3] as string,
    role: "context" as const,
    threadId: "thread_trip"
  };
  return {
    deliveries: [
      {
        evidenceClass: "organic",
        evidenceRefs: [{
          artifactId: link.artifactId,
          artifactType: link.artifactType,
          providerId: link.providerId,
          role: link.role
        }],
        id: "delivery_first",
        openedAt: "2026-07-29T02:00:00.000Z",
        outcome: {
          evidenceClass: "organic",
          outcome: "used",
          ownerNote: SENTINELS[1] as string,
          policyVersion: 1,
          recordedAt: "2026-07-29T03:00:00.000Z"
        },
        policyVersion: 0,
        runId: "continuity_run_first",
        threadId: "thread_trip"
      }
    ],
    experienceLearningPolicyAudits: [],
    interactionReceipts: [],
    nextPolicyVersion: 2,
    resetReceipts: [],
    schemaVersion: 12,
    threads: [{
      createdAt: "2026-07-29T00:00:00.000Z",
      id: "thread_trip",
      kind: "life",
      links: [link],
      policy: {
        detail: "compact",
        nextStep: "direct",
        suppression: "none",
        version: 1
      },
      title: `${SENTINELS[0] as string} · ${SENTINELS[2] as string}`
    }],
    undoResetReceipts: []
  };
}

function projection(): ContinuityGraphProjection {
  return projectContinuityState({
    scope: { sourceId: "default", threadId: "thread_trip" },
    sourceObservedAt: OBSERVED_AT,
    state: sourceFixture()
  });
}

function rawObservation(state: unknown = sourceFixture()): Record<string, unknown> {
  return {
    scope: { sourceId: "default", threadId: "thread_trip" },
    sourceObservedAt: OBSERVED_AT,
    state
  };
}

function input(value: ContinuityGraphProjection = projection()): Record<string, unknown> {
  return {
    schemaVersion: 1,
    authority: "caller-declared-observation",
    observedAt: OBSERVED_AT,
    projection: value,
    diagnostics: {
      descriptorsInspected: 128,
      projectedAssertions: value.assertions.length,
      sourceRecordsInspected: 4,
      stringBytesInspected: 2_048
    }
  };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function mutableInput(): Record<string, unknown> {
  return clone(input());
}

function canonicalValue(value: unknown): unknown {
  if (
    value === null
    || typeof value === "string"
    || typeof value === "boolean"
    || typeof value === "number"
  ) {
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalValue);
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(value as object).sort()) {
    output[key] = canonicalValue((value as Record<string, unknown>)[key]);
  }
  return output;
}

function rehashReceipt(value: ContinuityObservationReceipt): void {
  const mutable = value as unknown as Record<string, unknown>;
  const { receiptId: ignored, ...body } = mutable;
  void ignored;
  const material = HASH_DOMAIN + JSON.stringify(canonicalValue(body));
  mutable.receiptId = RECEIPT_PREFIX
    + createHash("sha256").update(material).digest("hex");
}

function expectObservationError(
  operation: () => unknown,
  codes?: readonly ContinuityObservationError["code"][]
): ContinuityObservationError {
  try {
    operation();
  } catch (cause) {
    expect(cause).toBeInstanceOf(ContinuityObservationError);
    const error = cause as ContinuityObservationError;
    if (codes) expect(codes).toContain(error.code);
    return error;
  }
  throw new Error("expected ContinuityObservationError");
}

function compareReceiptCurrent(
  receipt: ContinuityObservationReceipt,
  current: unknown
): ReturnType<typeof explainContinuityChangesFromReceipt> {
  return explainContinuityChangesFromReceipt({
    schemaVersion: 1,
    previousReceipt: receipt,
    current
  });
}

describe("Continuity Observation Receipt", () => {
  it("captures one raw observation through the exact manual prepare-to-seal path", () => {
    const raw = rawObservation();
    const before = clone(raw);
    const prepared = prepareContinuitySourceObservation(
      raw,
      "observation source"
    );
    const manual = sealContinuityObservation({
      schemaVersion: 1,
      authority: "caller-declared-observation",
      observedAt: prepared.input.sourceObservedAt,
      projection: prepared.projection,
      diagnostics: prepared.diagnostics
    });
    const captured = captureContinuityObservation(raw);

    expect(captured).toStrictEqual(manual);
    expect(JSON.stringify(captured)).toBe(JSON.stringify(manual));
    expect(captured.receiptId).toBe(manual.receiptId);
    expect(captureContinuityObservation(raw)).toStrictEqual(captured);
    expect(verifyContinuityObservation(clone(captured))).toStrictEqual(captured);
    expect(raw).toStrictEqual(before);
    expect(captured.diagnostics.projectedAssertions).toBe(
      captured.projection.assertions.length
    );
    const serialized = JSON.stringify(captured);
    for (const sentinel of SENTINELS) expect(serialized).not.toContain(sentinel);
  });

  it("maps eager and lazy preparation failures without leaking query errors", () => {
    const assertMapped = (
      raw: unknown,
      materialize: (prepared: ReturnType<
        typeof prepareContinuitySourceObservation
      >) => unknown,
      expectedCode: ContinuityObservationError["code"]
    ): void => {
      let sourceError: ContinuityChangeQueryError | undefined;
      try {
        const prepared = prepareContinuitySourceObservation(
          raw,
          "observation source"
        );
        materialize(prepared);
      } catch (cause) {
        expect(cause).toBeInstanceOf(ContinuityChangeQueryError);
        sourceError = cause as ContinuityChangeQueryError;
      }
      expect(sourceError).toBeDefined();

      const mapped = expectObservationError(
        () => captureContinuityObservation(raw),
        [expectedCode]
      );
      expect(mapped.constructor).toBe(ContinuityObservationError);
      expect(mapped.message).toBe(sourceError?.message);
      expect(mapped.details).toStrictEqual(sourceError?.details);
      expect(mapped).not.toBeInstanceOf(ContinuityChangeQueryError);
    };

    assertMapped({}, () => undefined, "INVALID_INPUT");

    const base = sourceFixture();
    const overflow = {
      ...base,
      threads: Array.from({ length: 129 }, (_, index) => ({
        ...clone(base.threads[0]),
        id: `thread_${index.toString()}`
      }))
    };
    assertMapped(
      rawObservation(overflow),
      (prepared) => prepared.projection,
      "BUDGET_EXCEEDED"
    );
  });

  it("rejects capture metadata injection and rethrows unknown failures by identity", () => {
    expectObservationError(
      () => captureContinuityObservation({
        ...rawObservation(),
        diagnostics: { projectedAssertions: 0 }
      }),
      ["INVALID_INPUT"]
    );

    const sentinel = new Error("internal sentinel");
    const throwingState = new Proxy(sourceFixture(), {
      getPrototypeOf() {
        throw sentinel;
      }
    });
    try {
      captureContinuityObservation(rawObservation(throwingState));
    } catch (cause) {
      expect(cause).toBe(sentinel);
      return;
    }
    throw new Error("expected unknown capture failure");
  });

  it("verifies the prior receipt before touching current source state", () => {
    const tampered = clone(captureContinuityObservation(rawObservation()));
    (tampered as unknown as Record<string, unknown>).observedAt = CURRENT_AT;
    let currentTraps = 0;
    const throwingCurrent = new Proxy({}, {
      get() {
        currentTraps += 1;
        throw new Error("current get trap");
      },
      getOwnPropertyDescriptor() {
        currentTraps += 1;
        throw new Error("current descriptor trap");
      },
      ownKeys() {
        currentTraps += 1;
        throw new Error("current ownKeys trap");
      }
    });
    expectObservationError(
      () => explainContinuityChangesFromReceipt({
        schemaVersion: 1,
        previousReceipt: tampered,
        current: throwingCurrent
      }),
      ["INTEGRITY_MISMATCH"]
    );
    expect(currentTraps).toBe(0);

    const sentinel = new ContinuityObservationError(
      "BUDGET_EXCEEDED",
      "receipt sentinel"
    );
    const throwingReceipt = new Proxy(tampered, {
      getPrototypeOf() {
        throw sentinel;
      }
    });
    try {
      explainContinuityChangesFromReceipt({
        schemaVersion: 1,
        previousReceipt: throwingReceipt,
        current: throwingCurrent
      });
    } catch (cause) {
      expect(cause).toBe(sentinel);
      expect(currentTraps).toBe(0);
      return;
    }
    throw new Error("expected receipt sentinel");
  });

  it("copies only top-level envelope data descriptors without invoking accessors", () => {
    const receipt = captureContinuityObservation(rawObservation());
    let accessorCalls = 0;
    const envelope = {
      schemaVersion: 1,
      previousReceipt: receipt
    } as Record<string, unknown>;
    Object.defineProperty(envelope, "current", {
      enumerable: true,
      get() {
        accessorCalls += 1;
        return rawObservation();
      }
    });
    expectObservationError(
      () => explainContinuityChangesFromReceipt(envelope),
      ["INVALID_INPUT"]
    );
    expect(accessorCalls).toBe(0);
  });

  it("maps current preparation and comparison failures into observation errors", () => {
    const receipt = captureContinuityObservation(rawObservation());
    const compare = (current: unknown): unknown =>
      explainContinuityChangesFromReceipt({
        schemaVersion: 1,
        previousReceipt: receipt,
        current
      });

    expectObservationError(() => compare({}), ["INVALID_INPUT"]);

    const crowdedBase = sourceFixture();
    const crowded = {
      ...crowdedBase,
      threads: Array.from({ length: 129 }, (_, index) => ({
        ...clone(crowdedBase.threads[0]),
        id: `thread_${index.toString()}`
      }))
    };
    const crowdedCurrent = rawObservation(crowded);
    crowdedCurrent.sourceObservedAt = CURRENT_AT;
    expectObservationError(
      () => compare(crowdedCurrent),
      ["BUDGET_EXCEEDED"]
    );

    expectObservationError(
      () => compare({
        ...rawObservation(),
        scope: { sourceId: "default", threadId: "thread_other" },
        sourceObservedAt: CURRENT_AT
      }),
      ["INVALID_INPUT"]
    );
    expectObservationError(
      () => compare({
        ...rawObservation(),
        sourceObservedAt: "2026-07-29T07:59:59.999Z"
      }),
      ["INVALID_INPUT"]
    );
  });

  it("preserves unknown current failures and leaves inputs unchanged", () => {
    const receipt = captureContinuityObservation(rawObservation());
    const receiptBefore = JSON.stringify(receipt);
    const current = rawObservation();
    current.sourceObservedAt = CURRENT_AT;
    const currentBefore = clone(current);
    const result = explainContinuityChangesFromReceipt({
      schemaVersion: 1,
      previousReceipt: receipt,
      current
    });

    expect(current).toStrictEqual(currentBefore);
    expect(JSON.stringify(receipt)).toBe(receiptBefore);
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.boundary)).toBe(true);
    expect(Object.isFrozen(result.boundary.sourceRef)).toBe(true);
    expect(result.previous).toStrictEqual({
      projectionVersion: receipt.projection.projectionVersion,
      sourceObservedAt: receipt.observedAt,
      sourceVersion: receipt.projection.sourceVersion
    });
    expect(result.diagnostics.previous).toStrictEqual(receipt.diagnostics);
    const serialized = JSON.stringify(result);
    for (const sentinel of SENTINELS) expect(serialized).not.toContain(sentinel);

    const sentinel = new Error("current internal sentinel");
    const throwingState = new Proxy(sourceFixture(), {
      getPrototypeOf() {
        throw sentinel;
      }
    });
    try {
      compareReceiptCurrent(receipt, rawObservation(throwingState));
    } catch (cause) {
      expect(cause).toBe(sentinel);
      return;
    }
    throw new Error("expected current internal sentinel");
  });

  it("keeps verified receipt comparison byte-identical to the raw-current query", () => {
    const previous = verifyContinuityObservation(
      clone(captureContinuityObservation(rawObservation()))
    );
    const currentInput = rawObservation();
    currentInput.sourceObservedAt = CURRENT_AT;
    const current = verifyContinuityObservation(
      clone(captureContinuityObservation(currentInput))
    );

    const rawResult = compareReceiptCurrent(previous, currentInput);
    const receiptResult = compareVerifiedContinuityObservationReceipts(
      previous,
      current
    );

    expect(receiptResult).toStrictEqual(rawResult);
    expect(JSON.stringify(receiptResult)).toBe(JSON.stringify(rawResult));
    expect(receiptResult.resultId).toBe(rawResult.resultId);
  });

  it("seals a deterministic caller-declared receipt and survives JSON round-trip", () => {
    const receipt = sealContinuityObservation(input());
    expect(receipt.formatVersion).toBe(CONTINUITY_OBSERVATION_FORMAT_VERSION);
    expect(receipt.authority).toBe("caller-declared-observation");
    expect(receipt.receiptId).toMatch(
      /^muse-continuity-observation:v1:sha256:[0-9a-f]{64}$/u
    );
    expect(verifyContinuityObservation(clone(receipt))).toEqual(receipt);
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(Object.isFrozen(receipt.projection)).toBe(true);
  });

  it("normalizes semantic collection order before content addressing", () => {
    const base = projection();
    const reordered = {
      timestampBasis: [...base.timestampBasis].reverse(),
      assertions: [...base.assertions].reverse(),
      projectionVersion: base.projectionVersion,
      sourceVersion: base.sourceVersion,
      scope: { threadId: base.scope.threadId, sourceId: base.scope.sourceId },
      ruleVersion: base.ruleVersion,
      schemaVersion: base.schemaVersion
    };
    const reorderedInput = {
      diagnostics: {
        stringBytesInspected: 2_048,
        sourceRecordsInspected: 4,
        projectedAssertions: base.assertions.length,
        descriptorsInspected: 128
      },
      projection: reordered,
      observedAt: OBSERVED_AT,
      authority: "caller-declared-observation",
      schemaVersion: 1
    };
    expect(sealContinuityObservation(reorderedInput)).toEqual(
      sealContinuityObservation(input(base))
    );
  });

  it("keeps personal source text out of the complete receipt JSON", () => {
    const serialized = JSON.stringify(sealContinuityObservation(input()));
    for (const sentinel of SENTINELS) expect(serialized).not.toContain(sentinel);
  });

  it("rejects top-level and nested tampering without a matching receipt hash", () => {
    const mutations: Array<(receipt: Record<string, any>) => void> = [
      (receipt) => { receipt.receiptId = `${RECEIPT_PREFIX}${"0".repeat(64)}`; },
      (receipt) => { receipt.observedAt = "2026-07-29T09:00:00.000Z"; },
      (receipt) => { receipt.projection.sourceVersion = `sha256:${"1".repeat(64)}`; },
      (receipt) => { receipt.diagnostics.descriptorsInspected += 1; },
      (receipt) => { receipt.projection.scope.threadId = "thread_other"; },
      (receipt) => {
        receipt.projection.assertions[0].id =
          `${receipt.projection.assertions[0].id}-tampered`;
      },
      (receipt) => {
        receipt.projection.timestampBasis[0].basis =
          receipt.projection.timestampBasis[0].basis === "source-event"
            ? "source-observation"
            : "source-event";
      }
    ];
    for (const mutate of mutations) {
      const receipt = clone(sealContinuityObservation(input())) as unknown as Record<
        string,
        any
      >;
      mutate(receipt);
      expectObservationError(
        () => verifyContinuityObservation(receipt),
        ["INVALID_RECEIPT", "INTEGRITY_MISMATCH"]
      );
    }
  });

  it("still rejects assertion tampering when only receiptId is recomputed", () => {
    const receipt = clone(sealContinuityObservation(input()));
    const mutable = receipt as unknown as Record<string, any>;
    mutable.projection.assertions[0].id =
      `${mutable.projection.assertions[0].id}-tampered`;
    rehashReceipt(receipt);
    expectObservationError(
      () => verifyContinuityObservation(receipt),
      ["INTEGRITY_MISMATCH"]
    );
  });

  it("rejects future versions, unknown fields, and diagnostics drift", () => {
    const future = clone(sealContinuityObservation(input())) as unknown as Record<
      string,
      any
    >;
    future.formatVersion = "muse.continuity-observation.v2";
    expectObservationError(
      () => verifyContinuityObservation(future),
      ["INVALID_RECEIPT"]
    );

    const unknown = { ...input(), extra: true };
    expectObservationError(
      () => sealContinuityObservation(unknown),
      ["INVALID_INPUT"]
    );

    const drift = input();
    (drift.diagnostics as Record<string, unknown>).projectedAssertions = 0;
    expectObservationError(
      () => sealContinuityObservation(drift),
      ["INVALID_INPUT"]
    );
  });

  it("rejects accessors, symbols, cycles, sparse arrays, and array extras", () => {
    const accessor = mutableInput();
    Object.defineProperty(accessor, "observedAt", { get: () => OBSERVED_AT });
    expectObservationError(() => sealContinuityObservation(accessor));

    const symbolKey = mutableInput();
    Object.defineProperty(symbolKey, Symbol("hidden"), { value: true });
    expectObservationError(() => sealContinuityObservation(symbolKey));

    const symbolValue = mutableInput();
    symbolValue.observedAt = Symbol("instant");
    expectObservationError(() => sealContinuityObservation(symbolValue));

    const cyclic = mutableInput();
    cyclic.extra = cyclic;
    expectObservationError(() => sealContinuityObservation(cyclic));

    const sparse = mutableInput();
    (sparse.projection as Record<string, unknown>).assertions = new Array(1);
    expectObservationError(() => sealContinuityObservation(sparse));

    const arrayExtra = mutableInput();
    const assertions = [
      ...(arrayExtra.projection as ContinuityGraphProjection).assertions
    ] as Array<unknown> & { extra?: boolean };
    assertions.extra = true;
    (arrayExtra.projection as Record<string, unknown>).assertions = assertions;
    expectObservationError(() => sealContinuityObservation(arrayExtra));
  });

  it("enforces string, nesting, descriptor, and aggregate UTF-8 budgets", () => {
    const oversizedString = mutableInput();
    oversizedString.observedAt = "a".repeat(16_385);
    expectObservationError(
      () => sealContinuityObservation(oversizedString),
      ["BUDGET_EXCEEDED"]
    );

    const nested = mutableInput();
    let cursor: Record<string, unknown> = nested;
    for (let index = 0; index < 14; index += 1) {
      cursor.extra = {};
      cursor = cursor.extra as Record<string, unknown>;
    }
    expectObservationError(
      () => sealContinuityObservation(nested),
      ["BUDGET_EXCEEDED"]
    );

    const descriptors = mutableInput();
    descriptors.extra = Array.from({ length: 32_769 }, () => null);
    expectObservationError(
      () => sealContinuityObservation(descriptors),
      ["BUDGET_EXCEEDED"]
    );

    const aggregate = mutableInput();
    aggregate.extra = Array.from({ length: 65 }, () => "a".repeat(16_384));
    expectObservationError(
      () => sealContinuityObservation(aggregate),
      ["BUDGET_EXCEEDED"]
    );
  });

  it("enforces projection assertion and evidence-ref collection budgets", () => {
    const assertionOverflow = mutableInput();
    const one = projection().assertions[0];
    expect(one).toBeDefined();
    (assertionOverflow.projection as Record<string, unknown>).assertions =
      Array.from({ length: 513 }, () => one);
    expectObservationError(
      () => sealContinuityObservation(assertionOverflow),
      ["BUDGET_EXCEEDED"]
    );

    const evidenceOverflow = mutableInput();
    const base = projection();
    const baseAssertion = base.assertions[0];
    expect(baseAssertion).toBeDefined();
    const assertions = Array.from({ length: 512 }, (_, index) => ({
      ...baseAssertion,
      id: `assertion-${index.toString().padStart(3, "0")}`,
      sourceRefs: [
        ...(baseAssertion?.sourceRefs ?? []),
        {
          id: `extra-${index.toString()}`,
          namespace: "muse.test",
          version: "v1"
        },
        {
          id: `extra-b-${index.toString()}`,
          namespace: "muse.test",
          version: "v1"
        }
      ]
    }));
    (evidenceOverflow.projection as Record<string, unknown>).assertions = assertions;
    (evidenceOverflow.diagnostics as Record<string, unknown>).projectedAssertions =
      assertions.length;
    expectObservationError(
      () => sealContinuityObservation(evidenceOverflow),
      ["BUDGET_EXCEEDED"]
    );
  });

  it("rejects projectionVersion, source-version shape, and timestamp source drift", () => {
    const projectionVersion = mutableInput();
    (projectionVersion.projection as Record<string, unknown>).projectionVersion =
      `sha256:${"0".repeat(64)}`;
    expectObservationError(
      () => sealContinuityObservation(projectionVersion),
      ["INTEGRITY_MISMATCH"]
    );

    const sourceVersion = mutableInput();
    (sourceVersion.projection as Record<string, unknown>).sourceVersion = "not-a-digest";
    expectObservationError(
      () => sealContinuityObservation(sourceVersion),
      ["INVALID_INPUT"]
    );

    const basis = mutableInput();
    const projectionRecord = basis.projection as Record<string, any>;
    projectionRecord.timestampBasis[0].sourceRef.id = "unknown-evidence";
    expectObservationError(
      () => sealContinuityObservation(basis),
      ["INVALID_INPUT"]
    );

    const incompleteBasis = clone(sealContinuityObservation(input()));
    (incompleteBasis as unknown as Record<string, any>).projection.timestampBasis.pop();
    rehashReceipt(incompleteBasis);
    expectObservationError(
      () => verifyContinuityObservation(incompleteBasis),
      ["INVALID_RECEIPT"]
    );
  });
});
