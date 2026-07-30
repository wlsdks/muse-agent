import { describe, expect, it } from "vitest";

import {
  AttuneGraphDataError,
  GRAPH_ASSERTION_SOURCE_NAMESPACE,
  InMemoryAttuneGraphDataStore,
  type AttuneGraphDataStore,
  type GraphAssertion,
  type GraphEvidenceRef,
  type GraphRef
} from "./index.js";

const THREAD: GraphRef = { id: "thread_trip", kind: "thread" };
const SOURCE: GraphEvidenceRef = {
  id: "task_trip",
  namespace: "example.tasks",
  version: "sha256:one"
};

function assertion(
  id: string,
  overrides: Partial<GraphAssertion> = {}
): GraphAssertion {
  const epistemicClass = overrides.epistemicClass ?? "source-observed";
  return {
    schemaVersion: 1,
    id,
    subject: { id: `artifact_${id}`, kind: "artifact" },
    predicate: "LINKED_TO",
    object: THREAD,
    epistemicClass,
    sourceRefs: [SOURCE],
    recordedAt: "2026-07-29T01:00:00.000Z",
    derivation: {
      kind: epistemicClass === "model-hypothesis"
        ? "model"
        : epistemicClass === "deterministic-derived"
          ? "rule"
          : "projection",
      version: "projector-v1"
    },
    ...overrides
  };
}

function storeConformance(
  name: string,
  createStore: () => AttuneGraphDataStore
): void {
  describe(`${name} conformance`, () => {
    it("appends atomically, replays equivalent content idempotently, and refuses collisions", async () => {
      const store = createStore();
      const first = assertion("assertion_one", {
        sourceRefs: [
          SOURCE,
          { id: "calendar_trip", namespace: "example.calendar" }
        ]
      });
      const second = assertion("assertion_two");
      const receipt = await store.append([first, second]);

      expect(receipt).toEqual({
        appended: 2,
        assertionIds: ["assertion_one", "assertion_two"],
        replayed: 0
      });
      await expect(store.append([
        {
          ...first,
          sourceRefs: [...first.sourceRefs].reverse()
        }
      ])).resolves.toMatchObject({ appended: 0, replayed: 1 });
      await expect(store.append([
        { ...first, recordedAt: "2026-07-29T02:00:00.000Z" },
        assertion("never_appended")
      ])).rejects.toMatchObject({
        code: "ASSERTION_COLLISION"
      });
      expect((await store.journal()).map((item) => item.id)).toEqual([
        "assertion_one",
        "assertion_two"
      ]);
    });

    it("validates a whole batch before mutation", async () => {
      const store = createStore();
      const invalid = assertion("invalid_time", {
        validFrom: "2026-07-30T00:00:00.000Z",
        validTo: "2026-07-29T00:00:00.000Z"
      });

      await expect(store.append([assertion("would_be_valid"), invalid])).rejects.toMatchObject({
        code: "INVALID_ASSERTION"
      });
      expect(await store.journal()).toEqual([]);
    });

    it("isolates stored assertions from caller mutation", async () => {
      const store = createStore();
      const original = assertion("immutable");
      const mutable = {
        ...original,
        subject: { ...original.subject },
        sourceRefs: original.sourceRefs.map((sourceRef) => ({ ...sourceRef }))
      } as {
        id: string;
        sourceRefs: GraphEvidenceRef[];
        subject: { id: string; kind: GraphRef["kind"] };
      } & Omit<GraphAssertion, "id" | "sourceRefs" | "subject">;
      await store.append([mutable]);

      mutable.id = "mutated";
      mutable.subject.id = "mutated_subject";
      mutable.sourceRefs[0] = { id: "mutated", namespace: "other" };

      const stored = await store.getAssertion("immutable");
      expect(stored).toMatchObject({
        id: "immutable",
        subject: { id: "artifact_immutable" },
        sourceRefs: [SOURCE]
      });
      expect(Object.isFrozen(stored)).toBe(true);
      expect(Object.isFrozen(stored?.sourceRefs)).toBe(true);
      expect(Object.isFrozen(stored?.subject)).toBe(true);
    });

    it("keeps recorded-time and adjacency indexes deterministic", async () => {
      const store = createStore();
      await store.append([
        assertion("late", { recordedAt: "2026-07-29T03:00:00.000Z" }),
        assertion("early", { recordedAt: "2026-07-29T01:00:00.000Z" }),
        assertion("middle", { recordedAt: "2026-07-29T02:00:00.000Z" })
      ]);

      expect((await store.recorded({
        after: "2026-07-29T01:00:00.000Z",
        through: "2026-07-29T03:00:00.000Z",
        limit: 10
      })).map((item) => item.id)).toEqual(["middle", "late"]);
      expect(await store.verify()).toMatchObject({ assertionCount: 3, ok: true });
    });

    it("forgets exact graph/source scopes without leaving corrupt indexes", async () => {
      const store = createStore();
      const sharedSource = { id: "shared", namespace: "example.tasks" };
      await store.append([
        assertion("shared_one", { sourceRefs: [sharedSource] }),
        assertion("shared_two", { sourceRefs: [sharedSource] }),
        assertion("derived_from_shared", {
          subject: { id: "artifact_derived", kind: "artifact" },
          predicate: "DERIVED_FROM",
          object: { id: "evidence_shared", kind: "evidence" },
          epistemicClass: "deterministic-derived",
          sourceRefs: [{
            id: "shared_one",
            namespace: GRAPH_ASSERTION_SOURCE_NAMESPACE,
            version: "v1"
          }],
          derivation: { kind: "rule", version: "derive-v1" }
        }),
        assertion("other")
      ]);

      await expect(store.forget({})).rejects.toMatchObject({
        code: "INVALID_FORGET_SCOPE"
      });
      expect(await store.forget({ sourceRefs: [sharedSource] })).toEqual({
        removed: 3,
        removedAssertionIds: [
          "derived_from_shared",
          "shared_one",
          "shared_two"
        ]
      });
      expect((await store.journal()).map((item) => item.id)).toEqual(["other"]);
      expect(await store.verify()).toMatchObject({ assertionCount: 1, ok: true });
      expect(await store.forget({
        graphRefs: [{ id: "artifact_other", kind: "artifact" }]
      })).toMatchObject({ removed: 1 });
      expect(await store.verify()).toMatchObject({ assertionCount: 0, ok: true });
    });
  });
}

storeConformance("in-memory AttuneGraph store", () =>
  new InMemoryAttuneGraphDataStore()
);

describe("AttuneGraph assertion invariants", () => {
  it("refuses model hypotheses that could manufacture authority, outcome, or performance", async () => {
    const store = new InMemoryAttuneGraphDataStore();
    const dangerous = [
      assertion("hypothesis_authority", {
        subject: { id: "action_hold", kind: "action" },
        predicate: "AUTHORIZED_BY",
        object: { id: "approval_receipt", kind: "evidence" },
        epistemicClass: "model-hypothesis",
        derivation: { kind: "model", runId: "run_one", version: "extract-v1" }
      }),
      assertion("hypothesis_outcome", {
        subject: { id: "delivery_one", kind: "delivery" },
        predicate: "PRODUCED_OUTCOME",
        object: { id: "outcome_used", kind: "outcome" },
        epistemicClass: "model-hypothesis",
        derivation: { kind: "model", runId: "run_one", version: "extract-v1" }
      }),
      assertion("hypothesis_performed", {
        subject: { id: "decision_one", kind: "decision" },
        predicate: "PERFORMED",
        object: { id: "action_hold", kind: "action" },
        epistemicClass: "model-hypothesis",
        derivation: { kind: "model", runId: "run_one", version: "extract-v1" }
      })
    ];

    for (const item of dangerous) {
      await expect(store.append([item])).rejects.toMatchObject({
        code: "INVALID_ASSERTION"
      });
    }
    expect(await store.journal()).toEqual([]);
  });

  it("refuses malformed endpoint kinds, missing provenance, accessors, and transaction time reversal", async () => {
    const store = new InMemoryAttuneGraphDataStore();
    const cases: unknown[] = [
      assertion("wrong_endpoint", {
        subject: { id: "delivery_one", kind: "delivery" },
        predicate: "LINKED_TO"
      }),
      assertion("missing_source", { sourceRefs: [] }),
      assertion("time_reversal", {
        recordedAt: "2026-07-29T02:00:00.000Z",
        supersededAt: "2026-07-29T01:00:00.000Z"
      })
    ];
    const accessor = assertion("accessor");
    Object.defineProperty(accessor, "recordedAt", {
      enumerable: true,
      get: () => "2026-07-29T01:00:00.000Z"
    });
    cases.push(accessor);

    for (const item of cases) {
      await expect(store.append([item as GraphAssertion])).rejects.toBeInstanceOf(
        AttuneGraphDataError
      );
    }
  });

  it("does not execute accessor-backed assertion arrays during batch validation", async () => {
    const store = new InMemoryAttuneGraphDataStore();
    let getterInvoked = false;
    const sourceRefs = [SOURCE];
    Object.defineProperty(sourceRefs, "0", {
      enumerable: true,
      get: () => {
        getterInvoked = true;
        return SOURCE;
      }
    });
    const unsafe = assertion("unsafe_array", {
      sourceRefs
    });

    await expect(store.append([unsafe])).rejects.toMatchObject({
      code: "INVALID_ASSERTION"
    });
    expect(getterInvoked).toBe(false);
    expect(await store.journal()).toEqual([]);
  });

  it("compares canonical extended-year instants by epoch rather than text", async () => {
    const store = new InMemoryAttuneGraphDataStore();
    await expect(store.append([
      assertion("extended_year_reversal", {
        validFrom: "+010000-01-01T00:00:00.000Z",
        validTo: "9999-01-01T00:00:00.000Z"
      })
    ])).rejects.toMatchObject({ code: "INVALID_ASSERTION" });
  });
});

describe("AttuneGraph bounded traversal", () => {
  it("applies temporal and supersession filters without rewriting history", async () => {
    const store = new InMemoryAttuneGraphDataStore();
    await store.append([
      assertion("current", {
        recordedAt: "2026-07-28T01:00:00.000Z",
        validFrom: "2026-07-28T00:00:00.000Z"
      }),
      assertion("expired", {
        validFrom: "2026-07-27T00:00:00.000Z",
        validTo: "2026-07-28T00:00:00.000Z"
      }),
      assertion("superseded_later", {
        recordedAt: "2026-07-27T00:00:00.000Z",
        supersededAt: "2026-07-29T00:00:00.000Z"
      })
    ]);

    const historical = await store.traverse({
      seeds: [THREAD],
      predicates: ["LINKED_TO"],
      direction: "incoming",
      maxDepth: 1,
      maxAssertions: 10,
      maxConsideredAssertions: 20,
      maxVisitedRefs: 20,
      validAt: "2026-07-28T12:00:00.000Z",
      recordedAtOrBefore: "2026-07-28T12:00:00.000Z"
    });
    expect(historical.assertions.map((item) => item.id)).toEqual([
      "current",
      "superseded_later"
    ]);

    const current = await store.traverse({
      seeds: [THREAD],
      predicates: ["LINKED_TO"],
      direction: "incoming",
      maxDepth: 1,
      maxAssertions: 10,
      maxConsideredAssertions: 20,
      maxVisitedRefs: 20,
      validAt: "2026-07-29T12:00:00.000Z",
      recordedAtOrBefore: "2026-07-29T12:00:00.000Z"
    });
    expect(current.assertions.map((item) => item.id)).toEqual(["current"]);
  });

  it("terminates cycles and reports explicit result/visit truncation", async () => {
    const store = new InMemoryAttuneGraphDataStore();
    const artifactA = { id: "artifact_a", kind: "artifact" } as const;
    const artifactB = { id: "artifact_b", kind: "artifact" } as const;
    await store.append([
      assertion("thread_to_a", { subject: artifactA }),
      assertion("a_to_b", {
        subject: artifactA,
        predicate: "CORRELATES_WITH",
        object: artifactB
      }),
      assertion("b_to_a", {
        subject: artifactB,
        predicate: "CORRELATES_WITH",
        object: artifactA
      })
    ]);

    const result = await store.traverse({
      seeds: [THREAD],
      predicates: ["LINKED_TO", "CORRELATES_WITH"],
      direction: "both",
      maxDepth: 4,
      maxAssertions: 2,
      maxConsideredAssertions: 4,
      maxVisitedRefs: 2
    });
    expect(result.truncated).toBe(true);
    expect(result.assertions).toHaveLength(2);
    expect(result.diagnostics.visitedRefs).toBe(2);
    expect(result.diagnostics.maxDepthReached).toBeLessThanOrEqual(4);
  });

  it("rejects NaN, Infinity, and caller attempts to exceed hard traversal caps", async () => {
    const store = new InMemoryAttuneGraphDataStore();
    const base = {
      seeds: [THREAD],
      predicates: ["LINKED_TO"] as const,
      direction: "both" as const,
      maxDepth: 1,
      maxAssertions: 10,
      maxConsideredAssertions: 20,
      maxVisitedRefs: 10
    };
    for (const invalid of [
      { ...base, maxDepth: Number.NaN },
      { ...base, maxAssertions: Number.POSITIVE_INFINITY },
      {
        ...base,
        seeds: [THREAD, { id: "thread_second", kind: "thread" as const }],
        maxVisitedRefs: 1
      },
      { ...base, maxConsideredAssertions: 9 },
      { ...base, maxVisitedRefs: 1_025 },
      { ...base, maxDepth: 5 }
    ]) {
      await expect(store.traverse(invalid)).rejects.toMatchObject({
        code: "INVALID_QUERY"
      });
    }
  });

  it("bounds work for a high-cardinality adjacency before materialization", async () => {
    const store = new InMemoryAttuneGraphDataStore();
    const dense = Array.from({ length: 10_000 }, (_, index) =>
      assertion(`dense_${index.toString()}`)
    );
    await store.append(dense);

    const result = await store.traverse({
      seeds: [THREAD],
      predicates: ["LINKED_TO"],
      direction: "incoming",
      maxDepth: 1,
      maxAssertions: 1,
      maxConsideredAssertions: 2,
      maxVisitedRefs: 10
    });
    expect(result.assertions.map((item) => item.id)).toEqual(["dense_0"]);
    expect(result.diagnostics.consideredAssertions).toBe(2);
    expect(result.truncated).toBe(true);
    expect(await store.verify()).toMatchObject({
      assertionCount: 10_000,
      ok: true
    });
  });
});
