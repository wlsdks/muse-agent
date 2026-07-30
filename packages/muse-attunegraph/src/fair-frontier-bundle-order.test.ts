import { describe, expect, it } from "vitest";

import * as publicApi from "@attunegraph/core";
import {
  canonicalizeImmutableEnvelope
} from "@attunegraph/core/extension-kit";
import {
  FAIR_FRONTIER_LANES,
  FairFrontierBundleOrderError,
  type FairFrontierBundleOrderV1,
  type FairFrontierLane,
  orderFairFrontierBundles
} from "./fair-frontier-bundle-order.js";

const ORDER_SPEC = Object.freeze({
  hashDomain: "muse.attunegraph.fair-frontier-bundle-order.v1",
  idField: "orderId",
  idPrefix: "muse-attunegraph-fair-frontier-order:sha256:"
} as const);

function hex(index: number): string {
  return index.toString(16).padStart(64, "0");
}

function opportunity(
  index: number,
  lane: FairFrontierLane,
  observedAt = "2026-07-29T10:00:00.000Z",
  candidateId = `optional:${index.toString()}`
): Record<string, unknown> {
  return {
    bundleId: `muse-attunegraph-scoped-proof-document:sha256:${hex(index + 1)}`,
    candidateId,
    lane,
    observedAt
  };
}

function request(
  opportunities: readonly Record<string, unknown>[]
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    operatorVersion: "muse.fair-frontier-bundle-order.v1",
    scope: { sourceId: "local", threadId: "trip-plan" },
    snapshot: {
      authority: "caller-declared-read-snapshot",
      generationId: "generation:1",
      commitSequence: 42,
      commitHash: `sha256:${"a".repeat(64)}`
    },
    seed: { kind: "thread", id: "trip-plan" },
    opportunities: opportunities.map((item) => ({ ...item }))
  };
}

function errorOf(value: unknown): FairFrontierBundleOrderError {
  try {
    orderFairFrontierBundles(value);
  } catch (cause) {
    expect(cause).toBeInstanceOf(FairFrontierBundleOrderError);
    return cause as FairFrontierBundleOrderError;
  }
  throw new Error("expected fair frontier failure");
}

function assertDeepFrozen(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  expect(Object.isFrozen(value)).toBe(true);
  for (const key of Reflect.ownKeys(value)) {
    if (key === "length") continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    expect(descriptor).toBeDefined();
    expect(descriptor && "value" in descriptor).toBe(true);
    if (descriptor && "value" in descriptor) {
      assertDeepFrozen(descriptor.value);
    }
  }
}

function assertFairPrefixes(output: FairFrontierBundleOrderV1): void {
  const totals = new Map(
    output.lanes.map((lane) => [lane.lane, lane.opportunityCount])
  );
  for (let prefix = 0; prefix <= output.entries.length; prefix += 1) {
    const emitted = new Map(FAIR_FRONTIER_LANES.map((lane) => [
      lane,
      output.entries.slice(0, prefix).filter((entry) => entry.lane === lane).length
    ]));
    const active = FAIR_FRONTIER_LANES.filter((lane) =>
      (totals.get(lane) ?? 0) - (emitted.get(lane) ?? 0) > 0
    );
    const counts = active.map((lane) => emitted.get(lane) ?? 0);
    if (counts.length > 1) {
      expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
    }
  }
  for (const entry of output.entries) {
    const sameLaneBefore = output.entries
      .slice(0, entry.rank)
      .filter((candidate) => candidate.lane === entry.lane).length;
    const ordinal = sameLaneBefore + 1;
    if (ordinal <= 1) continue;
    for (const lane of FAIR_FRONTIER_LANES) {
      if ((totals.get(lane) ?? 0) < ordinal - 1) continue;
      const emittedBefore = output.entries
        .slice(0, entry.rank)
        .filter((candidate) => candidate.lane === lane).length;
      expect(emittedBefore).toBeGreaterThanOrEqual(ordinal - 1);
    }
  }
}

describe("orderFairFrontierBundles", () => {
  it("rejects cross-scope provider-head replay before ordering", () => {
    const input = request([]);
    const providerScope = { sourceId: "local", threadId: "trip-plan" };
    input.snapshot = {
      authority: "receipt-integrity-only",
      kind: "process-local-provider-head-revalidation",
      revalidationReceiptId:
        `muse-local-attunement-head-revalidation:sha256:${"d".repeat(64)}`,
      providerId: "muse.local-attunement-store",
      providerVersion: "muse.local-attunement-snapshot-provider.v1",
      providerScope,
      subject: {
        providerReceiptId:
          `muse-local-attunement-snapshot:sha256:${"e".repeat(64)}`,
        stateDigest: `sha256:${"f".repeat(64)}`,
        normalizedStateBytes: 42,
        captureCompletedAt: "2026-07-29T10:00:00.000Z"
      },
      head: {
        providerReceiptId:
          `muse-local-attunement-snapshot:sha256:${"1".repeat(64)}`,
        stateDigest: `sha256:${"f".repeat(64)}`,
        normalizedStateBytes: 42,
        captureCompletedAt: "2026-07-29T10:00:00.000Z"
      },
      mintVerification:
        "provider-owned-two-capture-pair-verified-in-composing-process",
      mintVerificationSurvivesSerialization: false
    };
    input.scope = { ...providerScope, threadId: "trip-other" };
    const error = errorOf(input);
    expect(error.details).toEqual({
      path: "/scope",
      reason: "scope-mismatch"
    });
  });

  it("gives every active agent lane one turn before a high-degree lane gets a second", () => {
    const crowded = Array.from({ length: 251 }, (_, index) =>
      opportunity(index, "continuity")
    );
    const tail = FAIR_FRONTIER_LANES.slice(1).map((lane, index) =>
      opportunity(251 + index, lane)
    );
    const output = orderFairFrontierBundles(request([...crowded, ...tail]));

    expect(output.entries).toHaveLength(255);
    expect(new Set(output.entries.slice(0, 5).map((entry) => entry.lane))).toEqual(
      new Set(FAIR_FRONTIER_LANES)
    );
    expect(output.lanes.map((lane) => lane.opportunityCount)).toEqual([
      251,
      1,
      1,
      1,
      1
    ]);
    expect(output.coverage).toEqual({
      canAssertAbsenceWithinSnapshot: false,
      canAssertCurrentWorldAbsence: false,
      reasons: [
        "candidate-pool-only",
        "lane-semantics-caller-declared",
        "not-budget-settled"
      ],
      status: "partial"
    });
    assertFairPrefixes(output);
    assertDeepFrozen(output);
  });

  it("preserves prefix fairness as uneven lanes exhaust", () => {
    const counts = [9, 4, 2, 1, 1] as const;
    let index = 0;
    const opportunities = FAIR_FRONTIER_LANES.flatMap((lane, laneIndex) =>
      Array.from({ length: counts[laneIndex]! }, () => {
        index += 1;
        return opportunity(index, lane);
      })
    );
    const output = orderFairFrontierBundles(request(opportunities));

    assertFairPrefixes(output);
    expect(output.entries.map((entry) => entry.rank)).toEqual(
      Array.from({ length: 17 }, (_, rank) => rank)
    );
    expect(output.lanes.every((lane) =>
      lane.orderedCount === lane.opportunityCount
    )).toBe(true);
  });

  it("normalizes input permutations, equal-time punctuation, and supplied request IDs", () => {
    const values = [
      opportunity(1, "continuity", undefined, "optional:z"),
      opportunity(2, "continuity", undefined, "optional.a"),
      opportunity(3, "change"),
      opportunity(4, "evidence"),
      opportunity(5, "policy"),
      opportunity(6, "authority")
    ];
    const first = orderFairFrontierBundles(request(values));
    const expected = JSON.stringify(first);

    for (let run = 0; run < 20; run += 1) {
      const rotated = [
        ...values.slice(run % values.length),
        ...values.slice(0, run % values.length)
      ];
      if (run % 2 === 1) rotated.reverse();
      expect(JSON.stringify(orderFairFrontierBundles(request(rotated)))).toBe(expected);
    }
    const continuity = first.entries.filter((entry) => entry.lane === "continuity");
    expect(continuity.map((entry) => entry.candidateId)).toEqual([
      "optional:z",
      "optional.a"
    ]);
    const withId = request([...values].reverse());
    withId.requestId = first.requestId;
    expect(JSON.stringify(orderFairFrontierBundles(withId))).toBe(expected);

    const hostileAdmissionId = canonicalizeImmutableEnvelope(
      request(values),
      "external-mutable",
      {
        hashDomain: "muse.attunegraph.fair-frontier-bundle-order-admission.v1",
        idField: "admissionId",
        idPrefix: "muse-attunegraph-fair-frontier-admission:sha256:"
      }
    ).contentId.replace(
      "muse-attunegraph-fair-frontier-admission:",
      "muse-attunegraph-fair-frontier-request:"
    );
    const wrong = request(values);
    wrong.requestId = hostileAdmissionId;
    expect(errorOf(wrong).details).toEqual({
      path: "/requestId",
      reason: "invalid-request-id"
    });

    const admitted = canonicalizeImmutableEnvelope(
      request(values),
      "external-mutable",
      {
        hashDomain: "muse.attunegraph.fair-frontier-bundle-order-admission.v1",
        idField: "admissionId",
        idPrefix: "muse-attunegraph-fair-frontier-admission:sha256:"
      }
    );
    const suppliedInternalId = JSON.parse(admitted.canonicalJson) as Record<string, unknown>;
    expect(errorOf(suppliedInternalId).details).toEqual({
      path: "/admissionId",
      reason: "invalid-field-set"
    });
  });

  it("handles exact opportunity boundaries and fixed empty-lane metrics", () => {
    const empty = orderFairFrontierBundles(request([]));
    expect(empty.rotationOffset).toBe(0);
    expect(empty.entries).toEqual([]);
    expect(empty.lanes).toEqual(FAIR_FRONTIER_LANES.map((lane) => ({
      lane,
      opportunityCount: 0,
      orderedCount: 0
    })));

    const one = orderFairFrontierBundles(request([opportunity(0, "policy")]));
    expect(one.entries[0]?.rank).toBe(0);
    expect(one.lanes.find((lane) => lane.lane === "policy")).toMatchObject({
      firstRank: 0,
      lastRank: 0,
      opportunityCount: 1,
      orderedCount: 1
    });

    const maximum = Array.from({ length: 255 }, (_, index) =>
      opportunity(index, FAIR_FRONTIER_LANES[index % FAIR_FRONTIER_LANES.length]!)
    );
    expect(orderFairFrontierBundles(request(maximum)).entries).toHaveLength(255);
    expect(errorOf(request([
      ...maximum,
      opportunity(255, "continuity")
    ])).details.reason).toBe("too-many-opportunities");
  });

  it("fails closed on semantic duplicates, bindings, identifiers, and time", () => {
    const base = request([
      opportunity(1, "change"),
      opportunity(2, "policy")
    ]);
    const duplicateCandidate = structuredClone(base);
    (duplicateCandidate.opportunities as Record<string, unknown>[])[1]!.candidateId =
      (duplicateCandidate.opportunities as Record<string, unknown>[])[0]!.candidateId;
    expect(errorOf(duplicateCandidate).details.reason).toBe("duplicate-candidate-id");

    const duplicateBundle = structuredClone(base);
    (duplicateBundle.opportunities as Record<string, unknown>[])[1]!.bundleId =
      (duplicateBundle.opportunities as Record<string, unknown>[])[0]!.bundleId;
    expect(errorOf(duplicateBundle).details.reason).toBe("duplicate-bundle-id");

    const wrongSeed = structuredClone(base);
    (wrongSeed.seed as Record<string, unknown>).id = "another-thread";
    expect(errorOf(wrongSeed).details.reason).toBe("scope-seed-mismatch");

    const unsafeSequence = structuredClone(base);
    (unsafeSequence.snapshot as Record<string, unknown>).commitSequence =
      Number.MAX_SAFE_INTEGER + 1;
    expect(errorOf(unsafeSequence).details.reason).toBe("invalid-request-envelope");

    for (const [field, value, reason] of [
      ["candidateId", "bad#id", "invalid-candidate-id"],
      ["bundleId", "sha256:bad", "invalid-bundle-id"],
      ["lane", "generic", "invalid-lane"],
      ["observedAt", "yesterday", "invalid-instant"]
    ] as const) {
      const invalid = structuredClone(base);
      (invalid.opportunities as Record<string, unknown>[])[0]![field] = value;
      expect(errorOf(invalid).details.reason).toBe(reason);
    }
  });

  it("rejects hostile object graphs without executing accessors", () => {
    let getterExecutions = 0;
    const accessor = request([]);
    Object.defineProperty(accessor, "opportunities", {
      enumerable: true,
      get() {
        getterExecutions += 1;
        return [];
      }
    });
    expect(errorOf(accessor).details.reason).toBe("invalid-request-envelope");
    expect(getterExecutions).toBe(0);

    const customPrototype = request([]);
    Object.setPrototypeOf(customPrototype, { hostile: true });
    expect(errorOf(customPrototype).details.reason).toBe("invalid-request-envelope");

    const sparse = request([]);
    const sparseArray = new Array(2);
    sparseArray[1] = opportunity(1, "change");
    sparse.opportunities = sparseArray;
    expect(errorOf(sparse).details.reason).toBe("invalid-request-envelope");

    const aliased = request([]);
    const shared = opportunity(1, "change");
    aliased.opportunities = [shared, shared];
    expect(errorOf(aliased).details.reason).toBe("invalid-request-envelope");

    const cyclic = request([]);
    cyclic.self = cyclic;
    expect(errorOf(cyclic).details.reason).toBe("invalid-request-envelope");
  });

  it("detaches caller state, re-verifies frozen bytes, and stays package-private", () => {
    const input = request([
      opportunity(1, "continuity"),
      opportunity(2, "authority")
    ]);
    const output = orderFairFrontierBundles(input);
    const before = JSON.stringify(output);
    (input.opportunities as Record<string, unknown>[])[0]!.candidateId = "optional:mutated";
    expect(JSON.stringify(output)).toBe(before);
    expect(() =>
      (output.entries as unknown as FairFrontierBundleOrderV1["entries"][number][])
        .push(output.entries[0]!)
    ).toThrow();

    const verified = canonicalizeImmutableEnvelope(
      output,
      "attunegraph-frozen",
      ORDER_SPEC
    );
    const verifiedAgain = canonicalizeImmutableEnvelope(
      verified.envelope,
      "attunegraph-frozen",
      ORDER_SPEC
    );
    expect(verified.contentId).toBe(output.orderId);
    expect(JSON.parse(verified.canonicalJson)).toEqual(JSON.parse(before));
    expect(verifiedAgain.canonicalJson).toBe(verified.canonicalJson);
    expect(verifiedAgain.canonicalByteLength).toBe(verified.canonicalByteLength);
    expect("orderFairFrontierBundles" in publicApi).toBe(false);
  });
});
