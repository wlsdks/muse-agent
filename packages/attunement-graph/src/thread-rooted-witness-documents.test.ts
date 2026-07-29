import { describe, expect, it } from "vitest";

import {
  ThreadRootedWitnessDocumentsError,
  compileThreadRootedWitnessDocuments
} from "./thread-rooted-witness-documents.js";
import type { GraphAssertion, GraphPredicate, GraphRef } from "./types.js";

const NOW = "2026-07-29T10:00:00.000Z";
const SCOPE = { sourceId: "dogfood", threadId: "thread-1" };
const THREAD = { id: SCOPE.threadId, kind: "thread" } as const;
const A = { id: "artifact-a", kind: "artifact" } as const;
const B = { id: "artifact-b", kind: "artifact" } as const;
const C = { id: "artifact-c", kind: "artifact" } as const;
const D = { id: "artifact-d", kind: "artifact" } as const;
const SNAPSHOT = {
  authority: "caller-declared-read-snapshot",
  commitHash: `sha256:${"a".repeat(64)}`,
  commitSequence: 7,
  generationId: "generation-7"
} as const;
const PROVIDER_SNAPSHOT = {
  authority: "receipt-integrity-only",
  kind: "process-local-provider-capture",
  providerReceiptId: `muse-local-attunement-snapshot:sha256:${"b".repeat(64)}`,
  providerId: "muse.local-attunement-store",
  providerVersion: "muse.local-attunement-snapshot-provider.v1",
  stateDigest: `sha256:${"c".repeat(64)}`,
  normalizedStateBytes: 42,
  captureCompletedAt: NOW,
  mintVerification: "verified-in-composing-process",
  mintVerificationSurvivesSerialization: false
} as const;

function assertion(
  id: string,
  subject: GraphRef,
  predicate: GraphPredicate,
  object: GraphRef,
  overrides: Partial<GraphAssertion> = {}
): GraphAssertion {
  return {
    schemaVersion: 1,
    id,
    subject,
    predicate,
    object,
    epistemicClass: "source-observed",
    sourceRefs: [{ id: `source-${id}`, namespace: "dogfood" }],
    recordedAt: "2026-07-29T09:00:00.000Z",
    derivation: { kind: "projection", version: "fixture-v1" },
    ...overrides
  };
}

const EDGE_A = assertion("edge-a", A, "LINKED_TO", THREAD);
const EDGE_B = assertion("edge-b", A, "REVISION_OF", B);

function scoped(item: GraphAssertion, memberships = [SCOPE]) {
  return JSON.parse(JSON.stringify({ assertion: item, memberships })) as {
    assertion: GraphAssertion;
    memberships: typeof SCOPE[];
  };
}

function request(overrides: Record<string, unknown> = {}) {
  return JSON.parse(JSON.stringify({
    schemaVersion: 1,
    operatorVersion: "muse.thread-rooted-witness-documents.v1",
    scope: structuredClone(SCOPE),
    snapshot: structuredClone(SNAPSHOT),
    declaredFreshness: {
      assessedAt: NOW,
      observedAt: NOW,
      status: "fresh"
    },
    query: {
      seeds: [structuredClone(THREAD)],
      predicates: ["LINKED_TO", "REVISION_OF"],
      direction: "both",
      maxDepth: 4,
      maxAssertions: 16,
      maxConsideredAssertions: 32,
      maxVisitedRefs: 16,
      validAt: NOW,
      recordedAtOrBefore: NOW
    },
    boundedResult: {
      assertions: [scoped(EDGE_A), scoped(EDGE_B)],
      refs: [structuredClone(THREAD), structuredClone(A), structuredClone(B)],
      diagnostics: {
        consideredAssertions: 2,
        maxDepthReached: 2,
        visitedRefs: 3
      },
      truncated: false
    },
    nominations: {
      core: {
        assertionId: EDGE_A.id,
        kind: "core",
        nominationId: "core-context",
        observedAt: NOW
      },
      optionals: [{
        assertionId: EDGE_B.id,
        kind: "change",
        nominationId: "changed-flight",
        observedAt: NOW
      }]
    },
    budget: {
      maxAssertions: 64,
      maxConsideredAssertions: 256,
      maxDepth: 12,
      maxEstimatedTokens: 32_768,
      maxOutputBytes: 1_000_000,
      maxVisitedRefs: 128
    },
    ...overrides
  })) as {
    schemaVersion: number;
    operatorVersion: string;
    requestId?: string;
    scope: typeof SCOPE;
    snapshot: {
      authority: "caller-declared-read-snapshot";
      commitHash: string;
      commitSequence: number;
      generationId: string;
    };
    declaredFreshness: { assessedAt: string; observedAt: string; status: string };
    query: {
      seeds: { id: string; kind: "thread" }[];
      predicates: GraphPredicate[];
      direction: "both" | "incoming" | "outgoing";
      maxDepth: number;
      maxAssertions: number;
      maxConsideredAssertions: number;
      maxVisitedRefs: number;
      validAt: string;
      recordedAtOrBefore: string;
      includeSuperseded?: boolean;
    };
    boundedResult: {
      assertions: { assertion: GraphAssertion; memberships: typeof SCOPE[] }[];
      refs: GraphRef[];
      diagnostics: {
        consideredAssertions: number;
        maxDepthReached: number;
        visitedRefs: number;
      };
      truncated: boolean;
    };
    nominations: {
      core: {
        assertionId: string;
        kind: "core";
        nominationId: string;
        observedAt: string;
      };
      optionals: {
        assertionId: string;
        kind: "change" | "support";
        nominationId: string;
        observedAt: string;
      }[];
    };
    budget: {
      maxAssertions: number;
      maxConsideredAssertions: number;
      maxDepth: number;
      maxEstimatedTokens: number;
      maxOutputBytes: number;
      maxVisitedRefs: number;
    };
  };
}

function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

describe("compileThreadRootedWitnessDocuments", () => {
  it("forces settlement abstention for an unassessed provider capture without inventing graph commits", () => {
    const result = compileThreadRootedWitnessDocuments({
      ...request(),
      snapshot: PROVIDER_SNAPSHOT,
      declaredFreshness: {
        status: "unassessed",
        reasonId: "single-read-no-head-revalidation"
      }
    });
    expect(result.status).toBe("abstained");
    expect(result.receipt.coverage.reasons.slice(0, 3)).toEqual([
      "provider-capture-snapshot-integrity-only",
      "freshness-unassessed",
      "bounded-result-only"
    ]);
    expect(result.settlement?.status).toBe("abstained");
    expect(result.settlement).toMatchObject({
      completeness: { reasons: ["freshness-unassessed", "mandatory-proof-not-admitted", "settlement-abstained"] }
    });
  });

  it("builds exact thread-rooted proof documents and delegates settlement once", () => {
    const input = request();
    (input.boundedResult.assertions[1]!.assertion as unknown as {
      sourceRefs: { id: string; namespace: string }[];
    }).sourceRefs = [
      { id: "a", namespace: "dogfood" },
      { id: "z", namespace: "dogfood" }
    ];
    const result = compileThreadRootedWitnessDocuments(input);
    expect(result.status).toBe("partial");
    expect(result.receipt.coverage).toEqual({
      canAssertAbsenceWithinSnapshot: false,
      canAssertCurrentWorldAbsence: false,
      reasons: ["caller-declared-snapshot", "bounded-result-only"],
      status: "partial"
    });
    expect(result.receipt.dispositions).toEqual([
      expect.objectContaining({
        assertionId: "edge-a",
        nominationId: "core-context",
        role: "core",
        status: "witnessed"
      }),
      expect.objectContaining({
        assertionId: "edge-b",
        nominationId: "changed-flight",
        role: "optional",
        status: "witnessed"
      })
    ]);
    expect(result.settlement?.status).toBe("partial");
    expect(result.frontier?.receipt.dispositions).toEqual([
      expect.objectContaining({
        focusAssertionId: "edge-b",
        lane: "change",
        nominationId: "changed-flight",
        predicate: "REVISION_OF",
        rank: 0,
        status: "budget-admitted"
      })
    ]);
    expect(result.frontier?.receipt.coverage).toEqual({
      canAssertAbsenceWithinSnapshot: false,
      canAssertCurrentWorldAbsence: false,
      reasons: [
        "bounded-witness-pool-only",
        "caller-declared-snapshot",
        "caller-declared-freshness",
        "source-authority-not-independently-verified",
        "focus-predicate-lane-mapping-v1"
      ],
      status: "partial"
    });
    expect(result.receipt.frontierReceiptId).toBe(
      result.frontier?.receipt.receiptId
    );
    if (result.settlement?.status !== "partial") throw new Error("expected partial");
    const documents = new Map(result.settlement.documents.map((item) => [item.kind, item]));
    expect(documents.get("core")?.proof.paths).toEqual([[
      { assertionId: "edge-a", direction: "incoming" }
    ]]);
    expect(documents.get("change")?.proof.paths).toEqual([[
      { assertionId: "edge-a", direction: "incoming" },
      { assertionId: "edge-b", direction: "outgoing" }
    ]]);
    expect(documents.get("change")?.proof.assertions.map((item) =>
      item.memberships
    )).toEqual([[SCOPE], [SCOPE]]);
    expect(documents.get("change")?.proof.sourceRefs).toEqual([
      { id: "a", namespace: "dogfood" },
      { id: "source-edge-a", namespace: "dogfood" },
      { id: "z", namespace: "dogfood" }
    ]);
    expect(result.receipt.settlementResultId).toBe(result.settlement.resultId);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.receipt.dispositions)).toBe(true);
    const retainedId = result.receipt.receiptId;
    input.scope.threadId = "mutated";
    expect(result.receipt.scope.threadId).toBe("thread-1");
    expect(result.receipt.receiptId).toBe(retainedId);
    expect(() => {
      (result.receipt.dispositions as unknown as unknown[]).push({});
    }).toThrow();
  });

  it("chooses the lexicographically first shortest path and is permutation-stable", () => {
    const value = request();
    const linkA = assertion("\"", A, "LINKED_TO", THREAD);
    const linkB = assertion("#", B, "LINKED_TO", THREAD);
    const routeA = assertion("route-a", C, "REVISION_OF", A);
    const routeB = assertion("route-b", C, "REVISION_OF", B);
    const target = assertion("target", C, "REVISION_OF", D);
    value.boundedResult.assertions = [
      scoped(routeB),
      scoped(target),
      scoped(linkB),
      scoped(routeA),
      scoped(linkA)
    ];
    value.boundedResult.refs = [D, B, C, THREAD, A];
    value.boundedResult.diagnostics.consideredAssertions = 5;
    value.boundedResult.diagnostics.maxDepthReached = 3;
    value.boundedResult.diagnostics.visitedRefs = 5;
    value.nominations.optionals = [{
      assertionId: target.id,
      kind: "change",
      nominationId: "changed-flight",
      observedAt: NOW
    }];
    value.nominations.core.assertionId = linkA.id;
    const first = compileThreadRootedWitnessDocuments(value);
    const permuted = copy(value);
    permuted.boundedResult.assertions.reverse();
    permuted.boundedResult.refs.reverse();
    const second = compileThreadRootedWitnessDocuments(permuted);
    expect(second.receipt.requestId).toBe(first.receipt.requestId);
    expect(second.receipt.receiptId).toBe(first.receipt.receiptId);
    if (first.settlement?.status !== "partial") throw new Error("expected partial");
    const change = first.settlement.documents.find((item) => item.kind === "change");
    expect(change?.proof.paths).toEqual([[
      { assertionId: "\"", direction: "incoming" },
      { assertionId: "route-a", direction: "incoming" },
      { assertionId: "target", direction: "outgoing" }
    ]]);
    for (let index = 0; index < 10; index += 1) {
      expect(compileThreadRootedWitnessDocuments(copy(value)).receipt.receiptId)
        .toBe(first.receipt.receiptId);
    }
  });

  it("binds a normalized semantic request ID and verifies a caller-supplied ID", () => {
    const baseline = request();
    const first = compileThreadRootedWitnessDocuments(baseline);
    const equivalent = request();
    equivalent.query.predicates.reverse();
    equivalent.query.includeSuperseded = false;
    equivalent.requestId = first.receipt.requestId;
    const second = compileThreadRootedWitnessDocuments(equivalent);
    expect(second.receipt.requestId).toBe(first.receipt.requestId);
    expect(second.receipt.receiptId).toBe(first.receipt.receiptId);

    const wrong = request();
    wrong.requestId = `muse-thread-rooted-witness-request:sha256:${"0".repeat(64)}`;
    expect(() => compileThreadRootedWitnessDocuments(wrong))
      .toThrowError(ThreadRootedWitnessDocumentsError);
  });

  it("accounts for unreachable optionals outside settlement and abstains for core", () => {
    const optionalMissing = request();
    optionalMissing.nominations.optionals[0]!.assertionId = "absent";
    const partial = compileThreadRootedWitnessDocuments(optionalMissing);
    expect(partial.status).toBe("partial");
    expect(partial.receipt.coverage.reasons).toContain("nomination-excluded");
    expect(partial.receipt.dispositions[1]).toEqual({
      assertionId: "absent",
      nominationId: "changed-flight",
      reason: "not-in-bounded-result",
      role: "optional",
      status: "excluded"
    });
    if (partial.settlement?.status !== "partial") throw new Error("expected partial");
    expect(partial.settlement.documents).toHaveLength(1);

    const coreMissing = request();
    coreMissing.nominations.core.assertionId = "absent";
    const abstained = compileThreadRootedWitnessDocuments(coreMissing);
    expect(abstained.status).toBe("abstained");
    expect(abstained.settlement).toBeUndefined();
    expect(abstained.receipt.coverage.reasons).toContain("core-witness-unavailable");
    expect(abstained.receipt.settlementResultId).toBeUndefined();
  });

  it("keeps plan, scope, direction, time, supersession, and truncation honest", () => {
    const cases = [
      {
        name: "scope",
        mutate(value: ReturnType<typeof request>) {
          value.boundedResult.assertions[1]!.memberships = [{
            sourceId: "foreign",
            threadId: "thread-2"
          }];
        },
        reason: "not-scope-eligible"
      },
      {
        name: "predicate",
        mutate(value: ReturnType<typeof request>) {
          value.query.predicates = ["LINKED_TO"];
        },
        reason: "not-plan-eligible"
      },
      {
        name: "recorded time",
        mutate(value: ReturnType<typeof request>) {
          value.boundedResult.assertions[1]!.assertion = assertion(
            "edge-b",
            A,
            "REVISION_OF",
            B,
            { recordedAt: "2026-07-30T09:00:00.000Z" }
          );
        },
        reason: "not-plan-eligible"
      },
      {
        name: "supersession",
        mutate(value: ReturnType<typeof request>) {
          value.boundedResult.assertions[1]!.assertion = assertion(
            "edge-b",
            A,
            "REVISION_OF",
            B,
            { supersededAt: "2026-07-29T09:30:00.000Z" }
          );
        },
        reason: "not-plan-eligible"
      },
      {
        name: "valid time",
        mutate(value: ReturnType<typeof request>) {
          value.boundedResult.assertions[1]!.assertion = assertion(
            "edge-b",
            A,
            "REVISION_OF",
            B,
            { validFrom: "2026-07-29T11:00:00.000Z" }
          );
        },
        reason: "not-plan-eligible"
      },
      {
        name: "direction",
        mutate(value: ReturnType<typeof request>) {
          value.query.direction = "outgoing";
        },
        reason: "not-thread-rooted"
      }
    ];
    for (const fixture of cases) {
      const value = request();
      fixture.mutate(value);
      const result = compileThreadRootedWitnessDocuments(value);
      expect(result.receipt.dispositions[1], fixture.name).toMatchObject({
        reason: fixture.reason,
        status: "excluded"
      });
    }
    const truncated = request();
    truncated.boundedResult.truncated = true;
    expect(
      compileThreadRootedWitnessDocuments(truncated).receipt.coverage.reasons
    ).toContain("traversal-truncated");

    const cyclic = request();
    cyclic.boundedResult.assertions.push(scoped(
      assertion("cycle", B, "REVISION_OF", A)
    ));
    cyclic.boundedResult.diagnostics.consideredAssertions = 3;
    expect(compileThreadRootedWitnessDocuments(cyclic).status).toBe("partial");
  });

  it("rejects cross-thread seeds, inconsistent result budgets, duplicates, and hostile input", () => {
    const wrongSeed = request();
    wrongSeed.query.seeds[0]!.id = "thread-2";
    expect(() => compileThreadRootedWitnessDocuments(wrongSeed))
      .toThrowError(ThreadRootedWitnessDocumentsError);

    const wrongCount = request();
    wrongCount.boundedResult.diagnostics.visitedRefs = 2;
    expect(() => compileThreadRootedWitnessDocuments(wrongCount))
      .toThrowError(ThreadRootedWitnessDocumentsError);

    const duplicate = request();
    duplicate.nominations.optionals[0]!.assertionId = EDGE_A.id;
    expect(() => compileThreadRootedWitnessDocuments(duplicate))
      .toThrowError(ThreadRootedWitnessDocumentsError);

    const reversedFreshness = request();
    reversedFreshness.nominations.core.assertionId = "absent";
    reversedFreshness.declaredFreshness.observedAt = "2026-07-29T11:00:00.000Z";
    expect(() => compileThreadRootedWitnessDocuments(reversedFreshness))
      .toThrowError(ThreadRootedWitnessDocumentsError);

    const invalidScope = request();
    invalidScope.nominations.core.assertionId = "absent";
    invalidScope.scope.sourceId = "not a source";
    expect(() => compileThreadRootedWitnessDocuments(invalidScope))
      .toThrowError(ThreadRootedWitnessDocumentsError);

    const invalidSnapshot = request();
    invalidSnapshot.nominations.core.assertionId = "absent";
    invalidSnapshot.snapshot.commitHash = "sha256:invalid";
    expect(() => compileThreadRootedWitnessDocuments(invalidSnapshot))
      .toThrowError(ThreadRootedWitnessDocumentsError);

    const sparse = request();
    delete sparse.nominations.optionals[0];
    expect(() => compileThreadRootedWitnessDocuments(sparse))
      .toThrowError(ThreadRootedWitnessDocumentsError);

    const customPrototype = request();
    Object.setPrototypeOf(customPrototype, { poisoned: true });
    expect(() => compileThreadRootedWitnessDocuments(customPrototype))
      .toThrowError(ThreadRootedWitnessDocumentsError);

    const aliased = request();
    aliased.boundedResult.assertions[0]!.memberships[0] = aliased.scope;
    expect(() => compileThreadRootedWitnessDocuments(aliased))
      .toThrowError(ThreadRootedWitnessDocumentsError);

    const unsafe = request();
    unsafe.boundedResult.diagnostics.consideredAssertions =
      Number.MAX_SAFE_INTEGER + 1;
    expect(() => compileThreadRootedWitnessDocuments(unsafe))
      .toThrowError(ThreadRootedWitnessDocumentsError);

    let getterRuns = 0;
    const hostile = request();
    Object.defineProperty(hostile, "scope", {
      enumerable: true,
      get() {
        getterRuns += 1;
        return SCOPE;
      }
    });
    expect(() => compileThreadRootedWitnessDocuments(hostile))
      .toThrowError(ThreadRootedWitnessDocumentsError);
    expect(getterRuns).toBe(0);
  });

  it("accepts exact traversal boundaries and rejects each exceeded bound", () => {
    const exact = request();
    exact.query.maxAssertions = 2;
    exact.query.maxConsideredAssertions = 2;
    exact.query.maxDepth = 2;
    exact.query.maxVisitedRefs = 3;
    expect(compileThreadRootedWitnessDocuments(exact).status).toBe("partial");

    const cases = [
      (value: ReturnType<typeof request>) => {
        value.query.maxAssertions = 1;
      },
      (value: ReturnType<typeof request>) => {
        value.query.maxConsideredAssertions = 2;
        value.boundedResult.diagnostics.consideredAssertions = 3;
      },
      (value: ReturnType<typeof request>) => {
        value.query.maxVisitedRefs = 2;
      },
      (value: ReturnType<typeof request>) => {
        value.query.maxDepth = 1;
      }
    ];
    for (const mutate of cases) {
      const value = request();
      mutate(value);
      expect(() => compileThreadRootedWitnessDocuments(value))
        .toThrowError(ThreadRootedWitnessDocumentsError);
    }

    const zeroOutput = request();
    zeroOutput.budget.maxOutputBytes = 0;
    const abstained = compileThreadRootedWitnessDocuments(zeroOutput);
    expect(abstained.status).toBe("abstained");
    expect(abstained.receipt.coverage.canAssertAbsenceWithinSnapshot).toBe(false);
  });
});
