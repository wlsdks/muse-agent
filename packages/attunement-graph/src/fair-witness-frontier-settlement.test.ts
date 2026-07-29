import { describe, expect, it } from "vitest";

import {
  FairWitnessFrontierSettlementError,
  deriveFairWitnessLaneV1
} from "./fair-witness-frontier-settlement.js";
import {
  ThreadRootedWitnessDocumentsError,
  compileThreadRootedWitnessDocuments
} from "./thread-rooted-witness-documents.js";
import {
  GRAPH_PREDICATES,
  type GraphAssertion,
  type GraphPredicate,
  type GraphRef
} from "./types.js";

const NOW = "2026-07-29T10:00:00.000Z";
const EARLIER = "2026-07-29T09:59:00.000Z";
const SCOPE = { sourceId: "dogfood", threadId: "thread-1" };
const THREAD = { id: SCOPE.threadId, kind: "thread" } as const;
const HUB = { id: "hub", kind: "artifact" } as const;
const SNAPSHOT = {
  authority: "caller-declared-read-snapshot",
  commitHash: `sha256:${"a".repeat(64)}`,
  commitSequence: 7,
  generationId: "generation-7"
} as const;

function assertion(
  id: string,
  subject: GraphRef,
  predicate: GraphPredicate,
  object: GraphRef,
  sourceRefs = [{ id: `source-${id}`, namespace: "dogfood" }]
): GraphAssertion {
  return {
    derivation: { kind: "projection", version: "fixture-v1" },
    epistemicClass: "source-observed",
    id,
    object,
    predicate,
    recordedAt: "2026-07-29T09:00:00.000Z",
    schemaVersion: 1,
    sourceRefs,
    subject
  };
}

const CORE = assertion("core-edge", HUB, "LINKED_TO", THREAD);
const TARGET = { id: "target", kind: "artifact" } as const;
const OPTIONAL = assertion("optional-edge", HUB, "REVISION_OF", TARGET);

function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function request(
  optionals: readonly {
    readonly assertion: GraphAssertion;
    readonly kind?: "change" | "support";
    readonly nominationId: string;
    readonly observedAt?: string;
    readonly pathAssertions?: readonly GraphAssertion[];
  }[] = [{
    assertion: OPTIONAL,
    kind: "change",
    nominationId: "optional-change"
  }],
  overrides: Record<string, unknown> = {}
): Record<string, any> {
  const assertions = [
    CORE,
    ...optionals.flatMap((item) => [
      ...(item.pathAssertions ?? []),
      item.assertion
    ])
  ];
  const refs = new Map<string, GraphRef>();
  for (const item of assertions) {
    for (const ref of [item.subject, item.object]) {
      refs.set(JSON.stringify([ref.kind, ref.id]), ref);
    }
  }
  return copy({
    boundedResult: {
      assertions: assertions.map((item) => ({
        assertion: item,
        memberships: [SCOPE]
      })),
      diagnostics: {
        consideredAssertions: assertions.length,
        maxDepthReached: 2,
        visitedRefs: refs.size
      },
      refs: [...refs.values()],
      truncated: false
    },
    budget: {
      maxAssertions: 64,
      maxConsideredAssertions: 256,
      maxDepth: 12,
      maxEstimatedTokens: 1_000_000,
      maxOutputBytes: 4_000_000,
      maxVisitedRefs: 128
    },
    declaredFreshness: {
      assessedAt: NOW,
      observedAt: NOW,
      status: "fresh"
    },
    nominations: {
      core: {
        assertionId: CORE.id,
        kind: "core",
        nominationId: "core-context",
        observedAt: NOW
      },
      optionals: optionals.map((item) => ({
        assertionId: item.assertion.id,
        kind: item.kind ?? "support",
        nominationId: item.nominationId,
        observedAt: item.observedAt ?? NOW
      }))
    },
    operatorVersion: "muse.thread-rooted-witness-documents.v1",
    query: {
      direction: "both",
      maxAssertions: 256,
      maxConsideredAssertions: 512,
      maxDepth: 4,
      maxVisitedRefs: 256,
      predicates: [...new Set(assertions.map((item) => item.predicate))],
      recordedAtOrBefore: NOW,
      seeds: [THREAD],
      validAt: NOW
    },
    schemaVersion: 1,
    scope: SCOPE,
    snapshot: SNAPSHOT,
    ...overrides
  });
}

function frontier(value: Record<string, any>) {
  let result: ReturnType<typeof compileThreadRootedWitnessDocuments>;
  try {
    result = compileThreadRootedWitnessDocuments(value);
  } catch (cause) {
    if (cause instanceof ThreadRootedWitnessDocumentsError) {
      throw new Error(JSON.stringify(cause.details), { cause });
    }
    if (cause instanceof FairWitnessFrontierSettlementError) {
      throw new Error(JSON.stringify(cause.details), { cause });
    }
    throw cause;
  }
  expect(result.frontier).toBeDefined();
  if (!result.frontier) throw new Error("expected frontier");
  return { result, frontier: result.frontier };
}

describe("witness-derived lane mapping", () => {
  it("maps every current graph predicate without turning generic links into intent", () => {
    const expected = new Map<GraphPredicate, ReturnType<typeof deriveFairWitnessLaneV1>>([
      ["LINKED_TO", undefined],
      ["NEXT_STEP_FOR", "continuity"],
      ["CONTEXT_FOR", "continuity"],
      ["SUPPORTED_BY", "evidence"],
      ["DERIVED_FROM", "evidence"],
      ["REVISION_OF", "change"],
      ["SUPERSEDES", "change"],
      ["OBSERVED_DURING", "evidence"],
      ["DELIVERED_FOR", "continuity"],
      ["PRODUCED_OUTCOME", "evidence"],
      ["PROPOSES_POLICY", "policy"],
      ["SCOPED_TO", "policy"],
      ["GOVERNED_BY", "policy"],
      ["PRECEDED", "continuity"],
      ["CORRELATES_WITH", "evidence"],
      ["AUTHORIZED_BY", "authority"],
      ["PERFORMED", "authority"]
    ]);
    expect(new Set(expected.keys())).toEqual(new Set(GRAPH_PREDICATES));
    for (const predicate of GRAPH_PREDICATES) {
      expect(deriveFairWitnessLaneV1(predicate)).toBe(expected.get(predicate));
    }
  });

  it("keeps LINKED_TO undetermined and outside budget attempts", () => {
    const linked = assertion("optional-linked", TARGET, "LINKED_TO", THREAD);
    const { result, frontier: output } = frontier(request([{
      assertion: linked,
      nominationId: "generic-link"
    }]));
    expect(output.receipt.dispositions).toEqual([
      expect.objectContaining({
        nominationId: "generic-link",
        predicate: "LINKED_TO",
        status: "lane-undetermined"
      })
    ]);
    expect(output.order.entries).toEqual([]);
    expect(output.receipt.metrics).toMatchObject({
      attemptedCandidates: 0,
      laneUndetermined: 1,
      settlementInvocations: 1
    });
    expect(result.settlement?.status).toBe("partial");
    if (result.settlement?.status !== "partial") throw new Error("expected partial");
    expect(result.settlement.documents).toHaveLength(1);
  });
});

describe("fair witness budget admission", () => {
  it("keeps trying later lane rounds after oversized first-round witnesses fail", () => {
    const lanes: readonly [GraphPredicate, string][] = [
      ["PRECEDED", "continuity"],
      ["REVISION_OF", "change"],
      ["SUPPORTED_BY", "evidence"],
      ["PROPOSES_POLICY", "policy"],
      ["AUTHORIZED_BY", "authority"]
    ];
    const largeSources = Array.from({ length: 128 }, (_, index) => ({
      id: `large-${index.toString().padStart(3, "0")}-${"x".repeat(470)}`,
      namespace: "n".repeat(120)
    }));
    const candidates = lanes.flatMap(([predicate, lane], laneIndex) => {
      const focus = (
        size: "large" | "small",
        sources: readonly { readonly id: string; readonly namespace: string }[]
      ): {
        readonly assertion: GraphAssertion;
        readonly pathAssertions?: readonly GraphAssertion[];
      } => {
        const id = `${laneIndex.toString()}-${lane}-${size}`;
        if (predicate === "PRECEDED") {
          return {
            assertion: assertion(id, THREAD, predicate, {
              id: `${lane}-${size}`,
              kind: "artifact"
            }, [...sources])
          };
        }
        if (predicate === "REVISION_OF") {
          return {
            assertion: assertion(id, HUB, predicate, {
              id: `${lane}-${size}`,
              kind: "artifact"
            }, [...sources])
          };
        }
        if (predicate === "SUPPORTED_BY") {
          return {
            assertion: assertion(id, HUB, predicate, {
              id: `${lane}-${size}`,
              kind: "evidence"
            }, [...sources])
          };
        }
        if (predicate === "PROPOSES_POLICY") {
          const decision = {
            id: `${lane}-${size}-decision`,
            kind: "decision" as const
          };
          return {
            assertion: assertion(id, decision, predicate, {
              id: `${lane}-${size}-policy`,
              kind: "policy"
            }, [...sources]),
            pathAssertions: [assertion(
              `${id}-bridge`,
              THREAD,
              "CORRELATES_WITH",
              decision
            )]
          };
        }
        const action = {
          id: `${lane}-${size}-action`,
          kind: "action" as const
        };
        return {
          assertion: assertion(id, action, predicate, {
            id: `${lane}-${size}-evidence`,
            kind: "evidence"
          }, [...sources]),
          pathAssertions: [assertion(
            `${id}-bridge`,
            THREAD,
            "CORRELATES_WITH",
            action
          )]
        };
      };
      const large = focus("large", largeSources);
      const small = focus("small", [{
        id: `small-${lane}`,
        namespace: "dogfood"
      }]);
      return [
        {
          ...large,
          nominationId: `${lane}-large`,
          observedAt: NOW
        },
        {
          ...small,
          nominationId: `${lane}-small`,
          observedAt: EARLIER
        }
      ];
    });
    const value = request(candidates);
    value.budget.maxOutputBytes = 160_000;
    const { frontier: output } = frontier(value);

    expect(output.order.entries.slice(0, 5).every((entry) =>
      output.receipt.dispositions.find((item) =>
        item.candidateId === entry.candidateId
      )?.nominationId.endsWith("-large")
    )).toBe(true);
    expect(output.receipt.dispositions.map((item) => ({
      axis: "firstViolatedAxis" in item ? item.firstViolatedAxis : undefined,
      nominationId: item.nominationId,
      status: item.status
    }))).toEqual([
      { nominationId: "authority-large", status: "capacity-excluded", axis: "bytes" },
      { nominationId: "authority-small", status: "budget-admitted", axis: undefined },
      { nominationId: "change-large", status: "capacity-excluded", axis: "bytes" },
      { nominationId: "change-small", status: "budget-admitted", axis: undefined },
      { nominationId: "continuity-large", status: "capacity-excluded", axis: "bytes" },
      { nominationId: "continuity-small", status: "budget-admitted", axis: undefined },
      { nominationId: "evidence-large", status: "capacity-excluded", axis: "bytes" },
      { nominationId: "evidence-small", status: "budget-admitted", axis: undefined },
      { nominationId: "policy-large", status: "capacity-excluded", axis: "bytes" },
      { nominationId: "policy-small", status: "budget-admitted", axis: undefined }
    ]);
    expect(output.receipt.dispositions.filter((item) =>
      item.status === "capacity-excluded"
    )).toHaveLength(5);
    expect(output.receipt.dispositions.filter((item) =>
      item.status === "budget-admitted"
    )).toHaveLength(5);
    expect(output.receipt.dispositions.filter((item) =>
      item.status === "budget-admitted"
    ).every((item) => item.nominationId.endsWith("-small"))).toBe(true);
    expect(output.receipt.metrics).toMatchObject({
      attemptedCandidates: 10,
      budgetAdmitted: 5,
      capacityExcluded: 5,
      ordered: 10,
      settlementInvocations: 11,
      witnessedOptional: 10
    });
  });

  it("reports the exact payload axis and continues for every logical budget dimension", () => {
    const cases = [
      ["depth", "maxDepth", 1],
      ["considered", "maxConsideredAssertions", 2],
      ["visited", "maxVisitedRefs", 4],
      ["assertions", "maxAssertions", 2]
    ] as const;
    for (const [axis, field, limit] of cases) {
      const value = request();
      value.budget[field] = limit;
      const { frontier: output } = frontier(value);
      expect(output.receipt.dispositions).toEqual([
        expect.objectContaining({
          firstViolatedAxis: axis,
          status: "capacity-excluded"
        })
      ]);
    }

    const baseline = frontier(request()).result;
    if (baseline.settlement?.status !== "partial") throw new Error("expected partial");
    const payload = baseline.settlement.settlement.ledger.counters;
    const token = request();
    token.budget.maxEstimatedTokens =
      payload.selectedPayloadEstimatedTokens - 1;
    expect(frontier(token).frontier.receipt.dispositions).toEqual([
      expect.objectContaining({
        firstViolatedAxis: "token",
        status: "capacity-excluded"
      })
    ]);
    const bytes = request();
    bytes.budget.maxOutputBytes = payload.selectedPayloadBytes - 1;
    expect(frontier(bytes).frontier.receipt.dispositions).toEqual([
      expect.objectContaining({
        firstViolatedAxis: "bytes",
        status: "capacity-excluded"
      })
    ]);
  });

  it("distinguishes envelope-only overflow, core abstention, and minimum-capacity invalid input", () => {
    const baseline = frontier(request()).result;
    if (baseline.settlement?.status !== "partial") throw new Error("expected partial");
    const counters = baseline.settlement.settlement.ledger.counters;

    const envelopeOnly = request();
    envelopeOnly.budget.maxEstimatedTokens =
      counters.selectedPayloadEstimatedTokens;
    const envelopeOutput = frontier(envelopeOnly).frontier;
    expect(envelopeOutput.receipt.dispositions).toEqual([
      expect.objectContaining({
        firstViolatedAxis: "token",
        status: "capacity-excluded"
      })
    ]);

    const unavailable = request([], {
      declaredFreshness: {
        reasonId: "caller-unavailable",
        status: "unavailable"
      }
    });
    const optionalUnavailable = request();
    optionalUnavailable.declaredFreshness = unavailable.declaredFreshness;
    const abstained = frontier(optionalUnavailable);
    expect(abstained.frontier.receipt.status).toBe("abstained");
    expect(abstained.frontier.receipt.dispositions).toEqual([
      expect.objectContaining({ status: "core-not-admitted" })
    ]);
    expect(abstained.frontier.receipt.metrics).toMatchObject({
      attemptedCandidates: 0,
      coreNotAdmitted: 1,
      settlementInvocations: 1
    });

    const impossible = request();
    impossible.budget.maxEstimatedTokens = 0;
    impossible.budget.maxOutputBytes = 0;
    const invalid = frontier(impossible);
    expect(invalid.result.settlement?.status).toBe("invalid-input");
    expect(invalid.frontier.receipt.status).toBe("invalid-input");
    expect(invalid.frontier.receipt.coverage).toMatchObject({
      status: "abstained",
      canAssertAbsenceWithinSnapshot: false,
      canAssertCurrentWorldAbsence: false
    });
    expect(invalid.frontier.receipt.coverage.reasons).toContain(
      "minimum-settlement-envelope-exceeds-budget"
    );
    expect(invalid.frontier.receipt.dispositions).toEqual([
      expect.objectContaining({
        firstViolatedAxis: "token",
        status: "capacity-invalid"
      })
    ]);
    expect(invalid.frontier.receipt.metrics).toMatchObject({
      attemptedCandidates: 0,
      capacityInvalid: 1,
      settlementInvocations: 1
    });
  });

  it("is permutation-stable and keeps a2a eligibility disjoint from frontier admission", () => {
    const missing = assertion("missing-edge", HUB, "SUPPORTED_BY", {
      id: "missing-evidence",
      kind: "evidence"
    });
    const value = request([
      {
        assertion: OPTIONAL,
        kind: "change",
        nominationId: "witnessed"
      },
      {
        assertion: missing,
        nominationId: "excluded"
      }
    ]);
    value.query.predicates = ["LINKED_TO", "REVISION_OF"];
    const first = compileThreadRootedWitnessDocuments(value);
    const permuted = copy(value);
    permuted.boundedResult.assertions.reverse();
    permuted.boundedResult.refs.reverse();
    permuted.nominations.optionals.reverse();
    const second = compileThreadRootedWitnessDocuments(permuted);

    expect(second.frontier?.receipt.receiptId).toBe(first.frontier?.receipt.receiptId);
    expect(second.frontier?.order.orderId).toBe(first.frontier?.order.orderId);
    expect(second.settlement?.resultId).toBe(first.settlement?.resultId);
    expect(first.receipt.dispositions.find((item) =>
      item.nominationId === "excluded"
    )).toMatchObject({
      reason: "not-plan-eligible",
      status: "excluded"
    });
    expect(first.frontier?.receipt.dispositions.map((item) =>
      item.nominationId
    )).toEqual(["witnessed"]);
    expect(first.receipt.frontierReceiptId).toBe(first.frontier?.receipt.receiptId);
  });
});
