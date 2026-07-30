import { describe, expect, it } from "vitest";

import {
  compileActivationSubgraph,
  InMemoryAttuneGraphDataStore,
  type GraphAssertion,
  type GraphEpistemicClass,
  type GraphPredicate,
  type GraphRef
} from "./index.js";

const THREAD = { id: "thread_trip", kind: "thread" } as const;
const NOW = "2026-07-29T10:00:00.000Z";

function graphAssertion(input: {
  readonly id: string;
  readonly subject: GraphRef;
  readonly predicate: GraphPredicate;
  readonly object: GraphRef;
  readonly recordedAt?: string;
  readonly epistemicClass?: GraphEpistemicClass;
  readonly sourceId?: string;
}): GraphAssertion {
  const epistemicClass = input.epistemicClass ?? "source-observed";
  return {
    schemaVersion: 1,
    id: input.id,
    subject: input.subject,
    predicate: input.predicate,
    object: input.object,
    epistemicClass,
    sourceRefs: [{
      id: input.sourceId ?? `source_${input.id}`,
      namespace: "dogfood.trip",
      version: "v1"
    }],
    recordedAt: input.recordedAt ?? "2026-07-29T09:00:00.000Z",
    derivation: {
      kind: epistemicClass === "model-hypothesis"
        ? "model"
        : epistemicClass === "deterministic-derived"
          ? "rule"
          : "projection",
      version: "fixture-v1"
    }
  };
}

function defaultBudget() {
  return {
    maxAssertions: 32,
    maxConsideredAssertions: 256,
    maxDepth: 4,
    maxEstimatedTokens: 8_192,
    maxVisitedRefs: 64
  };
}

async function tripStore(): Promise<InMemoryAttuneGraphDataStore> {
  const store = new InMemoryAttuneGraphDataStore();
  const flight = { id: "artifact_flight_new", kind: "artifact" } as const;
  const oldFlight = { id: "artifact_flight_old", kind: "artifact" } as const;
  const hotel = { id: "artifact_hotel_deadline", kind: "artifact" } as const;
  const policyOne = { id: "policy_evening", kind: "policy" } as const;
  const policyTwo = { id: "policy_short_gap", kind: "policy" } as const;
  const delivery = { id: "delivery_capsule", kind: "delivery" } as const;
  await store.append([
    graphAssertion({
      id: "flight_context",
      subject: flight,
      predicate: "CONTEXT_FOR",
      object: THREAD,
      sourceId: "calendar_flight"
    }),
    graphAssertion({
      id: "flight_revision",
      subject: flight,
      predicate: "REVISION_OF",
      object: oldFlight,
      sourceId: "calendar_flight"
    }),
    graphAssertion({
      id: "hotel_next",
      subject: hotel,
      predicate: "NEXT_STEP_FOR",
      object: THREAD,
      sourceId: "task_hotel_deadline"
    }),
    graphAssertion({
      id: "policy_scope_one",
      subject: policyOne,
      predicate: "SCOPED_TO",
      object: THREAD,
      sourceId: "policy_receipt_one"
    }),
    graphAssertion({
      id: "policy_scope_two",
      subject: policyTwo,
      predicate: "SCOPED_TO",
      object: THREAD,
      sourceId: "policy_receipt_two"
    }),
    graphAssertion({
      id: "delivery_policy_one",
      subject: delivery,
      predicate: "GOVERNED_BY",
      object: policyOne,
      sourceId: "delivery_receipt"
    }),
    graphAssertion({
      id: "delivery_policy_two",
      subject: delivery,
      predicate: "GOVERNED_BY",
      object: policyTwo,
      sourceId: "delivery_receipt"
    }),
    graphAssertion({
      id: "model_proposal",
      subject: { id: "decision_offer", kind: "decision" },
      predicate: "PROPOSES_POLICY",
      object: policyTwo,
      epistemicClass: "model-hypothesis",
      sourceId: "shadow_decision"
    })
  ]);
  return store;
}

describe("Activation Subgraph compiler", () => {
  it("compiles a deterministic, source-addressed slice and exposes live conflicts", async () => {
    const store = await tripStore();
    const first = await compileActivationSubgraph(store, {
      seed: THREAD,
      now: NOW,
      budget: defaultBudget()
    });
    const second = await compileActivationSubgraph(store, {
      seed: THREAD,
      now: NOW,
      budget: defaultBudget()
    });

    expect(second).toEqual(first);
    expect(first.seed).toEqual(THREAD);
    expect(first.assertions.map((item) => item.id)).toContain("flight_revision");
    expect(first.sourceRefs.map((item) => item.id)).toEqual(
      expect.arrayContaining(["calendar_flight", "task_hotel_deadline", "delivery_receipt"])
    );
    expect(first.conflicts).toEqual([
      expect.objectContaining({
        assertionIds: ["delivery_policy_one", "delivery_policy_two"],
        predicate: "GOVERNED_BY",
        subject: { id: "delivery_capsule", kind: "delivery" }
      })
    ]);
    expect(first.diagnostics).toMatchObject({
      detectedConflicts: 1,
      reportedConflicts: 1
    });
    expect(JSON.stringify(first)).not.toMatch(/chain.of.thought|reasoningTrace/iu);
  });

  it("enforces assertion and token budgets with explicit truncation", async () => {
    const store = await tripStore();
    const assertionLimited = await compileActivationSubgraph(store, {
      seed: THREAD,
      now: NOW,
      budget: {
        ...defaultBudget(),
        maxAssertions: 2
      }
    });
    expect(assertionLimited.assertions).toHaveLength(2);
    expect(assertionLimited.truncated).toBe(true);
    expect(assertionLimited.diagnostics.truncationReasons).toContain("assertion-budget");
    expect(assertionLimited.conflicts).toHaveLength(1);
    expect(assertionLimited.diagnostics).toMatchObject({
      detectedConflicts: 1,
      reportedConflicts: 1
    });

    const tokenLimited = await compileActivationSubgraph(store, {
      seed: THREAD,
      now: NOW,
      budget: {
        ...defaultBudget(),
        maxEstimatedTokens: 512
      }
    });
    expect(tokenLimited.truncated).toBe(true);
    expect(tokenLimited.diagnostics.truncationReasons).toContain("token-budget");
    expect(tokenLimited.diagnostics.estimatedTokens).toBeLessThanOrEqual(512);
    expect(tokenLimited.diagnostics.estimatedTokens).toBe(
      Math.ceil(Buffer.byteLength(JSON.stringify(tokenLimited), "utf8") / 4)
    );
  });

  it("fails closed for a non-thread seed and malicious budgets", async () => {
    const store = await tripStore();
    await expect(compileActivationSubgraph(store, {
      seed: { id: "artifact_flight", kind: "artifact" },
      now: NOW,
      budget: defaultBudget()
    })).rejects.toMatchObject({ code: "INVALID_QUERY" });
    await expect(compileActivationSubgraph(store, {
      seed: THREAD,
      now: NOW,
      budget: {
        ...defaultBudget(),
        maxEstimatedTokens: Number.POSITIVE_INFINITY
      }
    })).rejects.toMatchObject({ code: "INVALID_QUERY" });

    const accessorInput = {
      seed: THREAD,
      now: NOW,
      budget: defaultBudget()
    };
    Object.defineProperty(accessorInput, "now", {
      enumerable: true,
      get: () => NOW
    });
    await expect(compileActivationSubgraph(
      store,
      accessorInput as never
    )).rejects.toMatchObject({ code: "INVALID_QUERY" });
  });

  it("returns an empty, non-fabricated slice when the exact thread has no graph path", async () => {
    const store = await tripStore();
    const result = await compileActivationSubgraph(store, {
      seed: { id: "thread_unknown", kind: "thread" },
      now: NOW,
      budget: defaultBudget()
    });

    expect(result.assertions).toEqual([]);
    expect(result.refs).toEqual([{ id: "thread_unknown", kind: "thread" }]);
    expect(result.sourceRefs).toEqual([]);
    expect(result.conflicts).toEqual([]);
    expect(result.truncated).toBe(false);
  });

  it("accepts the smallest internally coherent consideration budget", async () => {
    const store = new InMemoryAttuneGraphDataStore();
    const result = await compileActivationSubgraph(store, {
      seed: { id: "thread_empty", kind: "thread" },
      now: NOW,
      budget: {
        maxAssertions: 1,
        maxConsideredAssertions: 1,
        maxDepth: 0,
        maxEstimatedTokens: 8_192,
        maxVisitedRefs: 1
      }
    });

    expect(result.assertions).toEqual([]);
    expect(result.truncated).toBe(false);
  });
});
