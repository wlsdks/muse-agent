import type { AttunementState } from "@muse/attunement";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  CONTINUITY_CHANGE_LIMITS,
  CONTINUITY_PROJECTION_BOUNDARY_NAMESPACE,
  ContinuityChangeQueryError,
  explainContinuityChanges
} from "./continuity-change-query.js";
import {
  captureContinuityObservation,
  ContinuityObservationError,
  explainContinuityChangesFromReceipt
} from "./continuity-observation.js";
import {
  projectContinuityState,
  type ContinuityProjectionInput
} from "./continuity-projection.js";

const BOUNDARY_AT = "2026-07-29T08:00:00.000Z";
const CURRENT_AT = "2026-07-29T10:00:00.000Z";
const THREAD_ID = "thread_trip";

type Mutable<T> = {
  -readonly [Key in keyof T]:
    T[Key] extends readonly (infer Item)[]
      ? Mutable<Item>[]
      : T[Key] extends object
        ? Mutable<T[Key]>
        : T[Key];
};

function state(): Mutable<AttunementState> {
  return {
    deliveries: [],
    interactionReceipts: [],
    nextPolicyVersion: 1,
    resetReceipts: [],
    schemaVersion: 11,
    threads: [{
      createdAt: "2026-07-29T01:00:00.000Z",
      id: THREAD_ID,
      kind: "life",
      links: [],
      policy: {
        detail: "standard",
        nextStep: "direct",
        suppression: "none",
        version: 0
      },
      title: "Synthetic trip"
    }],
    undoResetReceipts: []
  };
}

function link(
  linkedAt = "2026-07-29T09:00:00.000Z",
  artifactId = "task_compare",
  role: "next-step" | "context" = "next-step"
) {
  return {
    artifactId,
    artifactType: "task" as const,
    linkedAt,
    linkedBy: "user" as const,
    providerId: "local" as const,
    role,
    threadId: THREAD_ID
  };
}

function observation(
  value: AttunementState,
  sourceObservedAt: string
): ContinuityProjectionInput {
  return {
    scope: { sourceId: "default", threadId: THREAD_ID },
    sourceObservedAt,
    state: value
  };
}

function query(
  previousState: AttunementState,
  currentState: AttunementState,
  previousAt = BOUNDARY_AT,
  currentAt = CURRENT_AT
) {
  const previous = observation(previousState, previousAt);
  const current = observation(currentState, currentAt);
  const projection = projectContinuityState(previous);
  return {
    boundary: {
      authority: "caller-declared-observation" as const,
      observedAt: previousAt,
      schemaVersion: 1 as const,
      scope: previous.scope,
      sourceRef: {
        id: projection.sourceVersion,
        namespace: CONTINUITY_PROJECTION_BOUNDARY_NAMESPACE,
        version: projection.projectionVersion
      }
    },
    current,
    previous,
    schemaVersion: 1 as const
  };
}

function explainWithReceiptParity(
  input: ReturnType<typeof query>
): ReturnType<typeof explainContinuityChanges> {
  const rawResult = explainContinuityChanges(input);
  const receiptResult = explainContinuityChangesFromReceipt({
    schemaVersion: 1,
    previousReceipt: captureContinuityObservation(input.previous),
    current: input.current
  });
  expect(JSON.stringify(receiptResult)).toBe(JSON.stringify(rawResult));
  expect(receiptResult.resultId).toBe(rawResult.resultId);
  return rawResult;
}

function inputWithCurrentState(raw: unknown): Mutable<ReturnType<typeof query>> {
  const input = structuredClone(
    query(state(), state())
  ) as Mutable<ReturnType<typeof query>>;
  input.current.state = raw as Mutable<AttunementState>;
  return input;
}

function expectQueryError(
  input: unknown,
  code: ContinuityChangeQueryError["code"],
  messagePart?: string
): void {
  try {
    explainContinuityChanges(input);
    throw new Error("expected explainContinuityChanges to reject the input");
  } catch (error) {
    expect(error).toBeInstanceOf(ContinuityChangeQueryError);
    expect(error).toMatchObject({ code });
    if (messagePart) {
      expect((error as Error).message).toContain(messagePart);
    }
  }
}

describe("explained Continuity changes", () => {
  it("returns a deterministic direct source path for an eligible addition", () => {
    const previous = state();
    const current = structuredClone(previous);
    current.threads[0]?.links.push(link());

    const first = explainWithReceiptParity(query(previous, current));
    const replay = explainContinuityChanges(query(previous, current));

    expect(first).toEqual(replay);
    expect(first.status).toBe("complete");
    expect(first.changes).toHaveLength(1);
    expect(first.changes[0]).toMatchObject({
      kind: "added",
      temporalBasis: "world-valid"
    });
    expect(first.changes[0]?.path.map((step) => step.predicate))
      .toEqual(["NEXT_STEP_FOR"]);
    expect(first.changes[0]?.path[0]?.direction).toBe("incoming");
    expect(first.resultId).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(JSON.stringify(first)).not.toContain("Synthetic trip");
    expect(first.diagnostics).toMatchObject({
      answeredCount: 1,
      candidateCount: 1,
      complete: true,
      embeddingCalls: 0,
      modelCalls: 0
    });
  });

  it("uses an unchanged bridge for multi-hop outcome changes", () => {
    const previous = state();
    previous.deliveries.push({
      evidenceClass: "controlled",
      evidenceRefs: [],
      id: "delivery_trip",
      openedAt: "2026-07-29T07:00:00.000Z",
      policyVersion: 0,
      threadId: THREAD_ID
    });
    const current = structuredClone(previous);
    current.deliveries[0] = {
      ...current.deliveries[0]!,
      outcome: {
        evidenceClass: "controlled",
        outcome: "used",
        policyVersion: 1,
        recordedAt: "2026-07-29T09:00:00.000Z"
      }
    };
    current.threads[0]!.policy = {
      ...current.threads[0]!.policy,
      version: 1
    };
    current.nextPolicyVersion = 2;

    const result = explainContinuityChanges(query(previous, current));

    expect(result.status).toBe("complete");
    const outcome = result.changes.find((change) =>
      change.assertion.predicate === "PRODUCED_OUTCOME"
    );
    expect(outcome?.path.map((step) => step.predicate))
      .toEqual(["DELIVERED_FOR", "PRODUCED_OUTCOME"]);
    expect(outcome?.path[0]?.assertionId)
      .not.toBe(outcome?.assertion.id);
  });

  it("normalizes a later observation of the same reset-bearing source to no-change", () => {
    const previous = state();
    previous.resetReceipts.push({
      basePolicyVersion: 0,
      beforePolicy: previous.threads[0]!.policy,
      id: "reset_trip",
      resetPolicyVersion: 1,
      threadId: THREAD_ID
    });
    previous.threads[0]!.policy = {
      ...previous.threads[0]!.policy,
      version: 1
    };
    previous.nextPolicyVersion = 2;

    const result = explainWithReceiptParity(
      query(previous, structuredClone(previous))
    );

    expect(result.status).toBe("no-change");
    expect(result.changes).toEqual([]);
    expect(result.diagnostics.rawDeltaCount).toBe(0);
    expect(result.previous.projectionVersion)
      .not.toBe(result.current.projectionVersion);
    expect(result.previous.sourceVersion).toBe(result.current.sourceVersion);
  });

  it("abstains for pre-boundary backfills and removals", () => {
    const previous = state();
    previous.threads[0]?.links.push(link("2026-07-29T07:00:00.000Z"));
    previous.deliveries.push({
      evidenceClass: "controlled",
      evidenceRefs: [{
        artifactId: "task_compare",
        artifactType: "task",
        providerId: "local",
        role: "next-step"
      }],
      id: "delivery_trip",
      interactionAnchor: {
        artifactId: "task_compare",
        linkedAt: "2026-07-29T07:00:00.000Z",
        observedAt: "2026-07-29T07:10:00.000Z",
        observedStatus: "open",
        openStateFingerprint: "a".repeat(64),
        providerId: "local",
        role: "next-step"
      },
      openedAt: "2026-07-29T07:10:00.000Z",
      policyVersion: 0,
      runId: "run_trip",
      threadId: THREAD_ID
    });
    const current = structuredClone(previous);
    current.threads[0]?.links.splice(0, 1);
    current.interactionReceipts.push({
      artifactId: "task_compare",
      completedAt: "2026-07-29T07:30:00.000Z",
      deliveryId: "delivery_trip",
      doneStateFingerprint: "b".repeat(64),
      eventId: "event_trip",
      evidenceClass: "controlled",
      id: "interaction_trip",
      linkedAt: "2026-07-29T07:00:00.000Z",
      openStateFingerprint: "a".repeat(64),
      providerId: "local",
      recordedAt: "2026-07-29T09:00:00.000Z",
      role: "next-step",
      runId: "run_trip",
      threadId: THREAD_ID,
      transition: "open-to-done"
    });

    const result = explainWithReceiptParity(query(previous, current));

    expect(result.status).toBe("abstained");
    expect(result.abstentions.map((item) => item.code).sort())
      .toEqual([
        "OUTSIDE_INTERVAL",
        "OUTSIDE_INTERVAL",
        "REMOVAL_TIME_UNKNOWN"
      ]);
    expect(result.diagnostics).toMatchObject({
      answeredCount: 0,
      abstainedCount: 3,
      candidateCount: 3
    });
  });

  it("pairs a source revision one-to-one", () => {
    const previous = state();
    previous.threads[0]?.links.push(link("2026-07-29T07:00:00.000Z"));
    const current = structuredClone(previous);
    current.threads[0]!.links[0] = link("2026-07-29T09:00:00.000Z");

    const result = explainWithReceiptParity(query(previous, current));

    expect(result.status).toBe("complete");
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]).toMatchObject({
      kind: "revised",
      temporalBasis: "world-valid"
    });
    expect(result.changes[0]?.replacedAssertionId).toBeTruthy();
  });

  it("uses lower-exclusive and upper-inclusive temporal boundaries", () => {
    const previous = state();
    const current = structuredClone(previous);
    current.threads[0]?.links.push(
      link(BOUNDARY_AT, "task_lower", "context"),
      link(CURRENT_AT, "task_upper", "context")
    );

    const result = explainContinuityChanges(query(previous, current));

    expect(result.status).toBe("partial");
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]?.assertion.sourceRefs[0]?.id).toBeTruthy();
    expect(result.changes[0]?.temporalBasis).toBe("world-valid");
    expect(result.abstentions).toHaveLength(1);
    expect(result.abstentions[0]?.code).toBe("OUTSIDE_INTERVAL");
  });

  it("classifies a future-effective relation learned inside the interval", () => {
    const previous = state();
    previous.threads[0]?.links.push(
      link("2026-07-29T07:00:00.000Z")
    );
    previous.deliveries.push({
      evidenceClass: "controlled",
      evidenceRefs: [{
        artifactId: "task_compare",
        artifactType: "task",
        providerId: "local",
        role: "next-step"
      }],
      id: "delivery_future",
      interactionAnchor: {
        artifactId: "task_compare",
        linkedAt: "2026-07-29T07:00:00.000Z",
        observedAt: "2026-07-29T07:10:00.000Z",
        observedStatus: "open",
        openStateFingerprint: "a".repeat(64),
        providerId: "local",
        role: "next-step"
      },
      openedAt: "2026-07-29T07:10:00.000Z",
      policyVersion: 0,
      runId: "run_future",
      threadId: THREAD_ID
    });
    const current = structuredClone(previous);
    current.interactionReceipts.push({
      artifactId: "task_compare",
      completedAt: "2026-07-29T11:00:00.000Z",
      deliveryId: "delivery_future",
      doneStateFingerprint: "b".repeat(64),
      eventId: "event_future",
      evidenceClass: "controlled",
      id: "interaction_future",
      linkedAt: "2026-07-29T07:00:00.000Z",
      openStateFingerprint: "a".repeat(64),
      providerId: "local",
      recordedAt: "2026-07-29T09:00:00.000Z",
      role: "next-step",
      runId: "run_future",
      threadId: THREAD_ID,
      transition: "open-to-done"
    });

    const result = explainContinuityChanges(query(previous, current));

    expect(result.status).toBe("complete");
    expect(result.changes).toHaveLength(2);
    expect(result.changes.every((change) =>
      change.temporalBasis === "learned-after"
    )).toBe(true);
  });

  it("forms one canonical ambiguous revision component", () => {
    const previous = state();
    previous.deliveries.push({
      evidenceClass: "controlled",
      evidenceRefs: [
        {
          artifactId: "evidence_a",
          artifactType: "task",
          providerId: "local",
          role: "context"
        },
        {
          artifactId: "evidence_b",
          artifactType: "task",
          providerId: "local",
          role: "context"
        }
      ],
      id: "delivery_ambiguous",
      openedAt: "2026-07-29T07:00:00.000Z",
      policyVersion: 0,
      threadId: THREAD_ID
    });
    const current = structuredClone(previous);
    current.deliveries[0]!.evidenceRefs = [{
      artifactId: "evidence_c",
      artifactType: "task",
      providerId: "local",
      role: "context"
    }];

    const first = explainContinuityChanges(query(previous, current));
    const reorderedPrevious = structuredClone(previous);
    reorderedPrevious.deliveries[0]!.evidenceRefs.reverse();
    const replay = explainContinuityChanges(query(reorderedPrevious, current));

    const ambiguous = first.abstentions.find((item) =>
      item.code === "AMBIGUOUS_REVISION"
    );
    expect(ambiguous).toMatchObject({
      affectedCount: 3,
      global: false
    });
    expect(ambiguous?.affectedAssertionIds).toHaveLength(3);
    expect(replay).toEqual(first);
  });

  it("abstains when a new relation has no unchanged support bridge", () => {
    const previous = state();
    const current = structuredClone(previous);
    current.deliveries.push({
      evidenceClass: "controlled",
      evidenceRefs: [],
      id: "delivery_without_bridge",
      openedAt: "2026-07-29T09:00:00.000Z",
      outcome: {
        evidenceClass: "controlled",
        outcome: "used",
        policyVersion: 1,
        recordedAt: "2026-07-29T09:30:00.000Z"
      },
      policyVersion: 0,
      threadId: THREAD_ID
    });
    current.threads[0]!.policy = {
      ...current.threads[0]!.policy,
      version: 1
    };
    current.nextPolicyVersion = 2;

    const result = explainContinuityChanges(query(previous, current));

    expect(result.abstentions.some((item) =>
      item.code === "NO_PATH_WITHIN_DEPTH"
    )).toBe(true);
  });

  it("fails the whole result for a future-recorded assertion", () => {
    const previous = state();
    const current = structuredClone(previous);
    current.threads[0]?.links.push(
      link("2026-07-29T11:00:00.000Z", "task_future_record", "context")
    );

    const result = explainContinuityChanges(query(previous, current));

    expect(result.status).toBe("abstained");
    expect(result.abstentions).toEqual([
      expect.objectContaining({
        code: "INCONSISTENT_OBSERVATION",
        global: true
      })
    ]);
    expect(result.diagnostics.complete).toBe(false);
  });

  it("returns a whole-result abstention when more than 32 answers qualify", () => {
    const previous = state();
    const current = structuredClone(previous);
    for (
      let index = 0;
      index < CONTINUITY_CHANGE_LIMITS.maxExplainedChanges + 1;
      index += 1
    ) {
      current.threads[0]?.links.push(
        link(
          "2026-07-29T09:00:00.000Z",
          `task_output_${index.toString()}`,
          "context"
        )
      );
    }

    const result = explainContinuityChanges(query(previous, current));

    expect(result.status).toBe("abstained");
    expect(result.changes).toEqual([]);
    expect(result.abstentions).toEqual([
      expect.objectContaining({
        affectedCount: CONTINUITY_CHANGE_LIMITS.maxExplainedChanges + 1,
        code: "OUTPUT_BUDGET_EXCEEDED",
        global: true
      })
    ]);
    expect(result.diagnostics.candidateCount)
      .toBe(CONTINUITY_CHANGE_LIMITS.maxExplainedChanges + 1);
  });

  it("returns a whole-result abstention on the 257th reachable ref", () => {
    const previous = state();
    for (let index = 0; index < CONTINUITY_CHANGE_LIMITS.maxSelectedLinks; index += 1) {
      previous.threads[0]?.links.push(
        link(
          "2026-07-29T07:00:00.000Z",
          `task_link_${index.toString()}`,
          "context"
        )
      );
    }
    for (let index = 0; index < CONTINUITY_CHANGE_LIMITS.maxSelectedDeliveries; index += 1) {
      previous.deliveries.push({
        evidenceClass: "controlled",
        evidenceRefs: [
          {
            artifactId: `task_evidence_${(index * 2).toString()}`,
            artifactType: "task",
            providerId: "local",
            role: "context"
          },
          {
            artifactId: `task_evidence_${(index * 2 + 1).toString()}`,
            artifactType: "task",
            providerId: "local",
            role: "context"
          }
        ],
        id: `delivery_dense_${index.toString()}`,
        openedAt: "2026-07-29T07:00:00.000Z",
        policyVersion: 0,
        threadId: THREAD_ID
      });
    }
    const current = structuredClone(previous);
    current.deliveries[0] = {
      ...current.deliveries[0]!,
      outcome: {
        evidenceClass: "controlled",
        outcome: "used",
        policyVersion: 1,
        recordedAt: "2026-07-29T09:00:00.000Z"
      }
    };
    current.threads[0]!.policy = {
      ...current.threads[0]!.policy,
      version: 1
    };
    current.nextPolicyVersion = 2;

    const result = explainContinuityChanges(query(previous, current));

    expect(result.status).toBe("abstained");
    expect(result.changes).toEqual([]);
    expect(result.abstentions[0]).toMatchObject({
      affectedCount: result.diagnostics.candidateCount,
      code: "VISITED_REF_BUDGET_EXCEEDED",
      global: true
    });
    expect(result.diagnostics.visitedRefs)
      .toBe(CONTINUITY_CHANGE_LIMITS.maxVisitedRefs);
    expect(result.diagnostics.complete).toBe(false);
  });

  it("rejects accessors and bounded scalar overflow before projection", () => {
    const previous = state();
    const current = structuredClone(previous);
    const accessor = query(previous, current) as Record<string, unknown>;
    Object.defineProperty(accessor, "schemaVersion", {
      enumerable: true,
      get: () => 1
    });
    expect(() => explainContinuityChanges(accessor))
      .toThrowError(expect.objectContaining({
        code: "INVALID_INPUT"
      }));

    const oversized = state();
    oversized.threads[0]!.title = "x".repeat(
      CONTINUITY_CHANGE_LIMITS.maxStringBytes + 1
    );
    expect(() => explainContinuityChanges(query(oversized, state())))
      .toThrowError(expect.objectContaining({
        code: "SOURCE_BUDGET_EXCEEDED"
      }));
  });

  it("rejects nonplain data, symbol keys, and structural budget overflow", () => {
    expectQueryError(
      inputWithCurrentState(new Date()),
      "INVALID_INPUT",
      "plain objects and arrays"
    );

    const symbolState = state() as Mutable<AttunementState> & {
      [key: symbol]: unknown;
    };
    symbolState[Symbol("hidden")] = "not inspectable by string-key contracts";
    expectQueryError(inputWithCurrentState(symbolState), "INVALID_INPUT", "symbol keys");

    const nestedState = state() as Mutable<AttunementState> & {
      nested?: unknown;
    };
    let nested: Record<string, unknown> = {};
    nestedState.nested = nested;
    for (
      let depth = 0;
      depth <= CONTINUITY_CHANGE_LIMITS.maxNestingDepth;
      depth += 1
    ) {
      const next: Record<string, unknown> = {};
      nested.next = next;
      nested = next;
    }
    expectQueryError(
      inputWithCurrentState(nestedState),
      "SOURCE_BUDGET_EXCEEDED",
      "nesting budget"
    );

    const descriptorState = state() as Mutable<AttunementState> & {
      padding?: null[];
    };
    descriptorState.padding = Array.from(
      { length: CONTINUITY_CHANGE_LIMITS.maxDescriptors + 1 },
      () => null
    );
    expectQueryError(
      inputWithCurrentState(descriptorState),
      "SOURCE_BUDGET_EXCEEDED",
      "descriptor budget"
    );

    const aggregateState = state() as Mutable<AttunementState> & {
      padding?: string[];
    };
    aggregateState.padding = Array.from(
      {
        length:
          Math.floor(
            CONTINUITY_CHANGE_LIMITS.maxAggregateStringBytes
              / CONTINUITY_CHANGE_LIMITS.maxStringBytes
          ) + 1
      },
      () => "x".repeat(CONTINUITY_CHANGE_LIMITS.maxStringBytes)
    );
    expectQueryError(
      inputWithCurrentState(aggregateState),
      "SOURCE_BUDGET_EXCEEDED",
      "string-byte budget"
    );
  });

  it("enforces every full-state and selected-scope record cap", () => {
    const makeBase = () => state() as Mutable<AttunementState>;
    const otherThread = (index: number, links: unknown[] = []) => ({
      id: `other_${index.toString()}`,
      links
    });
    const otherDelivery = (index: number, evidenceRefs: unknown[] = []) => ({
      evidenceRefs,
      threadId: `other_${index.toString()}`
    });
    const selectedDelivery = (evidenceRefs: unknown[] = []) => ({
      evidenceRefs,
      threadId: THREAD_ID
    });
    const records = (count: number, threadId = "other") =>
      Array.from({ length: count }, () => ({ threadId }));

    const cases: readonly {
      readonly name: string;
      readonly raw: () => unknown;
    }[] = [
      {
        name: "threads",
        raw: () => {
          const raw = makeBase();
          raw.threads = Array.from(
            { length: CONTINUITY_CHANGE_LIMITS.maxThreads + 1 },
            (_, index) => otherThread(index)
          ) as Mutable<AttunementState>["threads"];
          return raw;
        }
      },
      {
        name: "links",
        raw: () => {
          const raw = makeBase();
          raw.threads = [otherThread(
            0,
            Array.from(
              { length: CONTINUITY_CHANGE_LIMITS.maxLinks + 1 },
              () => ({})
            )
          )] as Mutable<AttunementState>["threads"];
          return raw;
        }
      },
      {
        name: "deliveries",
        raw: () => {
          const raw = makeBase();
          raw.deliveries = Array.from(
            { length: CONTINUITY_CHANGE_LIMITS.maxSourceDeliveries + 1 },
            (_, index) => otherDelivery(index)
          ) as Mutable<AttunementState>["deliveries"];
          return raw;
        }
      },
      {
        name: "evidence refs",
        raw: () => {
          const raw = makeBase();
          raw.deliveries = [otherDelivery(
            0,
            Array.from(
              { length: CONTINUITY_CHANGE_LIMITS.maxEvidenceRefs + 1 },
              () => ({})
            )
          )] as Mutable<AttunementState>["deliveries"];
          return raw;
        }
      },
      {
        name: "interactions",
        raw: () => {
          const raw = makeBase();
          raw.interactionReceipts = records(
            CONTINUITY_CHANGE_LIMITS.maxInteractions + 1
          ) as Mutable<AttunementState>["interactionReceipts"];
          return raw;
        }
      },
      {
        name: "resets",
        raw: () => {
          const raw = makeBase();
          raw.resetReceipts = records(
            CONTINUITY_CHANGE_LIMITS.maxResets + 1
          ) as Mutable<AttunementState>["resetReceipts"];
          return raw;
        }
      },
      {
        name: "undos",
        raw: () => {
          const raw = makeBase();
          raw.undoResetReceipts = records(
            CONTINUITY_CHANGE_LIMITS.maxUndos + 1
          ) as Mutable<AttunementState>["undoResetReceipts"];
          return raw;
        }
      },
      {
        name: "source records",
        raw: () => {
          const raw = makeBase();
          raw.threads = Array.from(
            { length: CONTINUITY_CHANGE_LIMITS.maxThreads },
            (_, index) => otherThread(
              index,
              index === 0 ? Array.from({ length: 800 }, () => ({})) : []
            )
          ) as Mutable<AttunementState>["threads"];
          raw.deliveries = Array.from(
            { length: 400 },
            (_, index) => otherDelivery(
              index,
              index === 0 ? Array.from({ length: 600 }, () => ({})) : []
            )
          ) as Mutable<AttunementState>["deliveries"];
          raw.interactionReceipts = records(100) as Mutable<
            AttunementState
          >["interactionReceipts"];
          raw.resetReceipts = records(20) as Mutable<
            AttunementState
          >["resetReceipts"];
          raw.undoResetReceipts = records(10) as Mutable<
            AttunementState
          >["undoResetReceipts"];
          return raw;
        }
      },
      {
        name: "selected links",
        raw: () => {
          const raw = makeBase();
          raw.threads[0]!.links = Array.from(
            { length: CONTINUITY_CHANGE_LIMITS.maxSelectedLinks + 1 },
            () => ({})
          ) as Mutable<AttunementState>["threads"][number]["links"];
          return raw;
        }
      },
      {
        name: "selected deliveries",
        raw: () => {
          const raw = makeBase();
          raw.deliveries = Array.from(
            { length: CONTINUITY_CHANGE_LIMITS.maxSelectedDeliveries + 1 },
            () => selectedDelivery()
          ) as Mutable<AttunementState>["deliveries"];
          return raw;
        }
      },
      {
        name: "selected evidence refs",
        raw: () => {
          const raw = makeBase();
          raw.deliveries = [selectedDelivery(Array.from(
            { length: CONTINUITY_CHANGE_LIMITS.maxSelectedEvidenceRefs + 1 },
            () => ({})
          ))] as Mutable<AttunementState>["deliveries"];
          return raw;
        }
      },
      {
        name: "selected interactions",
        raw: () => {
          const raw = makeBase();
          raw.interactionReceipts = records(
            CONTINUITY_CHANGE_LIMITS.maxSelectedInteractions + 1,
            THREAD_ID
          ) as Mutable<AttunementState>["interactionReceipts"];
          return raw;
        }
      },
      {
        name: "selected resets",
        raw: () => {
          const raw = makeBase();
          raw.resetReceipts = records(
            CONTINUITY_CHANGE_LIMITS.maxSelectedResets + 1,
            THREAD_ID
          ) as Mutable<AttunementState>["resetReceipts"];
          return raw;
        }
      },
      {
        name: "selected undos",
        raw: () => {
          const raw = makeBase();
          raw.undoResetReceipts = records(
            CONTINUITY_CHANGE_LIMITS.maxSelectedUndos + 1,
            THREAD_ID
          ) as Mutable<AttunementState>["undoResetReceipts"];
          return raw;
        }
      }
    ];

    for (const cap of cases) {
      expectQueryError(
        inputWithCurrentState(cap.raw()),
        "SOURCE_BUDGET_EXCEEDED",
        cap.name
      );
    }
  });

  it("rejects a valid projection on its 513th assertion", () => {
    const previous = state();
    for (
      let index = 0;
      index < CONTINUITY_CHANGE_LIMITS.maxSelectedLinks;
      index += 1
    ) {
      previous.threads[0]!.links.push(
        link(
          "2026-07-29T07:00:00.000Z",
          `task_projection_${index.toString()}`,
          index === 0 ? "next-step" : "context"
        )
      );
      previous.deliveries.push({
        evidenceClass: "controlled",
        evidenceRefs: [
          {
            artifactId: index < 16
              ? "task_projection_0"
              : `task_projection_${index.toString()}`,
            artifactType: "task",
            providerId: "local",
            role: index < 16 ? "next-step" : "context"
          },
          {
            artifactId: `evidence_projection_${index.toString()}`,
            artifactType: "task",
            providerId: "local",
            role: "context"
          }
        ],
        id: `delivery_projection_${index.toString()}`,
        openedAt: "2026-07-29T07:10:00.000Z",
        policyVersion: 0,
        threadId: THREAD_ID
      });
    }
    const current = structuredClone(previous);
    for (let index = 0; index < 16; index += 1) {
      const artifactId = "task_projection_0";
      const deliveryId = `delivery_projection_${index.toString()}`;
      const runId = `run_projection_${index.toString()}`;
      current.deliveries[index] = {
        ...current.deliveries[index]!,
        interactionAnchor: {
          artifactId,
          linkedAt: "2026-07-29T07:00:00.000Z",
          observedAt: "2026-07-29T07:10:00.000Z",
          observedStatus: "open",
          openStateFingerprint: "a".repeat(64),
          providerId: "local",
          role: "next-step"
        },
        runId
      };
      current.interactionReceipts.push({
        artifactId,
        completedAt: "2026-07-29T09:00:00.000Z",
        deliveryId,
        doneStateFingerprint: "b".repeat(64),
        eventId: `event_projection_${index.toString()}`,
        evidenceClass: "controlled",
        id: `interaction_projection_${index.toString()}`,
        linkedAt: "2026-07-29T07:00:00.000Z",
        openStateFingerprint: "a".repeat(64),
        providerId: "local",
        recordedAt: "2026-07-29T09:01:00.000Z",
        role: "next-step",
        runId,
        threadId: THREAD_ID,
        transition: "open-to-done"
      });
    }

    expectQueryError(
      query(previous, current),
      "SOURCE_BUDGET_EXCEEDED",
      "projection exceeds query budget"
    );
  });

  it("rejects cross-source, cross-thread, and invalid observation boundaries", () => {
    const crossSource = query(state(), state());
    (crossSource.current.scope as { sourceId: string }).sourceId = "other";
    expectQueryError(crossSource, "INVALID_INPUT", "scopes must match");

    const crossThread = query(state(), state());
    (crossThread.current.scope as { threadId: string }).threadId = "other";
    expectQueryError(crossThread, "INVALID_INPUT", "scopes must match");

    const crossBoundary = query(state(), state());
    (crossBoundary.boundary.scope as { threadId: string }).threadId = "other";
    expectQueryError(crossBoundary, "INVALID_INPUT", "scopes must match");

    const mismatchedPrevious = query(state(), state());
    mismatchedPrevious.boundary.observedAt = "2026-07-29T08:00:01.000Z";
    expectQueryError(
      mismatchedPrevious,
      "INVALID_INPUT",
      "observation interval"
    );

    const backwardsCurrent = query(state(), state());
    (backwardsCurrent.current as { sourceObservedAt: string }).sourceObservedAt =
      "2026-07-29T07:59:59.000Z";
    expectQueryError(
      backwardsCurrent,
      "INVALID_INPUT",
      "observation interval"
    );
  });

  it("maps projection validation failures into the public typed contract", () => {
    const invalid = state();
    (invalid as unknown as { schemaVersion: number }).schemaVersion = 999;
    try {
      explainContinuityChanges(inputWithCurrentState(invalid));
      throw new Error("expected projection validation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ContinuityChangeQueryError);
      expect(error).toMatchObject({
        code: "INVALID_INPUT",
        details: { causeCode: "INVALID_STATE" }
      });
    }
  });

  it("keeps the public query path free of storage, network, and model imports", () => {
    const sources = [
      readFileSync(new URL("./continuity-change-query.ts", import.meta.url), "utf8"),
      readFileSync(
        new URL("./continuity-change-semantics.ts", import.meta.url),
        "utf8"
      )
    ];
    const imports = sources.flatMap((source) =>
      [...source.matchAll(/\bfrom\s+["']([^"']+)["']/gu)]
        .map((match) => match[1] ?? "")
    );

    expect(imports.some((specifier) =>
      /(?:^node:(?:fs|http|https|net)$|model|embedding|graph-store|storage)/u
        .test(specifier)
    )).toBe(false);
  });

  it("rejects cycles, selected-scope overflow, and decorative boundary refs", () => {
    const cyclic = state() as Mutable<AttunementState> & { self?: unknown };
    cyclic.self = cyclic;
    const cyclicInput = structuredClone(
      query(state(), state())
    ) as Mutable<ReturnType<typeof query>>;
    cyclicInput.previous.state = cyclic;
    expect(() => explainContinuityChanges(cyclicInput))
      .toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));

    const crowded = state();
    for (
      let index = 0;
      index < CONTINUITY_CHANGE_LIMITS.maxSelectedLinks + 1;
      index += 1
    ) {
      crowded.threads[0]?.links.push(
        link(
          "2026-07-29T07:00:00.000Z",
          `task_crowded_${index.toString()}`,
          "context"
        )
      );
    }
    expect(() => explainContinuityChanges(query(crowded, state())))
      .toThrowError(expect.objectContaining({
        code: "SOURCE_BUDGET_EXCEEDED"
      }));

    const invalidBoundary = query(state(), state());
    invalidBoundary.boundary.sourceRef.version = "sha256:decorative";
    expect(() => explainContinuityChanges(invalidBoundary))
      .toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
  });

  it("rejects a raw delta before candidate accounting", () => {
    const previous = state();
    const current = structuredClone(previous);
    for (let index = 0; index < CONTINUITY_CHANGE_LIMITS.maxSelectedLinks; index += 1) {
      current.threads[0]?.links.push(
        link(
          "2026-07-29T09:00:00.000Z",
          `task_${index.toString()}`,
          "context"
        )
      );
    }
    for (let index = 0; index < 17; index += 1) {
      current.deliveries.push({
        evidenceClass: "controlled",
        evidenceRefs: [],
        id: `delivery_${index.toString()}`,
        openedAt: "2026-07-29T09:00:00.000Z",
        policyVersion: 0,
        threadId: THREAD_ID
      });
    }
    const rawInput = query(previous, current);
    expect(() => explainContinuityChanges(rawInput))
      .toThrowError(expect.objectContaining({
        code: "RAW_DELTA_BUDGET_EXCEEDED"
      }));
    expect(() => explainContinuityChangesFromReceipt({
      schemaVersion: 1,
      previousReceipt: captureContinuityObservation(rawInput.previous),
      current: rawInput.current
    })).toThrowError(expect.objectContaining({
      code: "BUDGET_EXCEEDED",
      constructor: ContinuityObservationError
    }));
  });

  it("exports a stable typed query error", () => {
    const error = new ContinuityChangeQueryError(
      "RAW_DELTA_BUDGET_EXCEEDED",
      "bounded",
      { limit: 128, rawDeltaCount: 129 }
    );
    expect(error).toMatchObject({
      code: "RAW_DELTA_BUDGET_EXCEEDED",
      details: { limit: 128, rawDeltaCount: 129 },
      name: "ContinuityChangeQueryError"
    });
  });
});
