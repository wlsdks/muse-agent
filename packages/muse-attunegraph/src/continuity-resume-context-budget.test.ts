import { describe, expect, it } from "vitest";

import {
  ResumeContextBudgetError,
  combineReservedResumeCosts,
  compileResumeContextFacts,
  reserveResumeBudget,
  serializeResumeContextFacts
} from "./continuity-resume-context-budget.js";

import type { ExplainedContinuityChangeResult } from "./continuity-change-contracts.js";
import type { ContinuityObservationReceipt } from "./continuity-observation.js";
import type { VerifiedContinuityResumeBoundaryDependencies } from "./continuity-resume-boundary.js";
import type { GraphAssertion } from "@attunegraph/core";

const PREVIOUS_AT = "2026-07-30T08:00:00.000Z";
const CURRENT_AT = "2026-07-30T09:00:00.000Z";
const SCOPE = Object.freeze({ sourceId: "default", threadId: "thread_resume" });
const NEXT_STEP = Object.freeze({
  artifactId: "task_resume",
  artifactType: "task" as const,
  providerId: "local" as const,
  role: "next-step" as const
});

function assertion(
  id: string,
  objectId: string,
  overrides: Partial<GraphAssertion> = {}
): GraphAssertion {
  return Object.freeze({
    schemaVersion: 1,
    id,
    subject: Object.freeze({ id: "thread:resume", kind: "thread" }),
    predicate: "NEXT_STEP_FOR",
    object: Object.freeze({ id: objectId, kind: "artifact" }),
    epistemicClass: "source-observed",
    sourceRefs: Object.freeze([Object.freeze({
      id: `source:${id}`,
      namespace: "muse.test",
      version: "1"
    })]),
    validFrom: PREVIOUS_AT,
    recordedAt: PREVIOUS_AT,
    derivation: Object.freeze({ kind: "projection", version: "test-v1" }),
    ...overrides
  });
}

function observation(
  receiptId: string,
  observedAt: string,
  sourceVersion: string,
  projectionVersion: string,
  assertions: readonly GraphAssertion[]
): ContinuityObservationReceipt {
  return Object.freeze({
    schemaVersion: 1,
    formatVersion: "muse.continuity-observation.v1",
    authority: "caller-declared-observation",
    observedAt,
    projection: Object.freeze({
      schemaVersion: 1,
      ruleVersion: "continuity-state-projection-v1",
      scope: SCOPE,
      sourceVersion,
      projectionVersion,
      assertions: Object.freeze([...assertions]),
      timestampBasis: Object.freeze([])
    }),
    diagnostics: Object.freeze({
      descriptorsInspected: 1,
      projectedAssertions: assertions.length,
      sourceRecordsInspected: 1,
      stringBytesInspected: 1
    }),
    receiptId
  });
}

function fixture(): {
  previous: VerifiedContinuityResumeBoundaryDependencies;
  currentGraphObservationReceipt: ContinuityObservationReceipt;
  changeResult: ExplainedContinuityChangeResult;
} {
  const before = assertion("assertion:before", "artifact:old");
  const after = assertion("assertion:after", "artifact:new", {
    validFrom: CURRENT_AT,
    recordedAt: CURRENT_AT
  });
  const previousGraph = observation(
    "graph:previous",
    PREVIOUS_AT,
    "source:previous",
    "projection:previous",
    [before]
  );
  const currentGraph = observation(
    "graph:current",
    CURRENT_AT,
    "source:current",
    "projection:current",
    [after]
  );
  const boundary = Object.freeze({
    schemaVersion: 1,
    boundaryVersion: "muse.continuity-resume-boundary.v1",
    authority: "caller-declared-resume-boundary",
    scope: SCOPE,
    observedAt: PREVIOUS_AT,
    sourceObservationReceiptId: "source-receipt:previous",
    graphObservationReceiptId: previousGraph.receiptId,
    graphSourceVersion: previousGraph.projection.sourceVersion,
    graphProjectionVersion: previousGraph.projection.projectionVersion,
    previousNextStep: NEXT_STEP,
    boundaryId: "boundary:previous"
  });
  const previous = Object.freeze({
    boundary,
    previousSourceObservationReceipt: Object.freeze({
      schemaVersion: 1,
      formatVersion: "muse.continuity-scoped-source-observation.v1",
      authority: "caller-declared-observation",
      scope: SCOPE,
      observation: Object.freeze({
        schemaVersion: 1,
        formatVersion: "muse.continuity-source-observation.v1",
        authority: "caller-declared-observation",
        temporalRuleVersion: "muse.continuity-temporal-state.v1",
        observedAt: PREVIOUS_AT,
        projection: Object.freeze({ nextStep: NEXT_STEP }),
        receiptId: "inner-source-receipt:previous"
      }),
      receiptId: boundary.sourceObservationReceiptId
    }),
    previousGraphObservationReceipt: previousGraph
  }) as VerifiedContinuityResumeBoundaryDependencies;
  const changeResult = Object.freeze({
    schemaVersion: 1,
    queryVersion: "continuity-change-query-v1",
    resultId: "change-result:private",
    status: "complete",
    scope: SCOPE,
    boundary: Object.freeze({
      authority: "caller-declared-observation",
      observedAt: PREVIOUS_AT,
      schemaVersion: 1,
      scope: SCOPE,
      sourceRef: Object.freeze({
        id: previousGraph.projection.sourceVersion,
        namespace: "muse.attunement.continuity-projection",
        version: previousGraph.projection.projectionVersion
      })
    }),
    previous: Object.freeze({
      sourceObservedAt: PREVIOUS_AT,
      sourceVersion: previousGraph.projection.sourceVersion,
      projectionVersion: previousGraph.projection.projectionVersion
    }),
    current: Object.freeze({
      sourceObservedAt: CURRENT_AT,
      sourceVersion: currentGraph.projection.sourceVersion,
      projectionVersion: currentGraph.projection.projectionVersion
    }),
    changes: Object.freeze([Object.freeze({
      assertion: after,
      kind: "added",
      path: Object.freeze([]),
      temporalBasis: "world-valid"
    })]),
    abstentions: Object.freeze([]),
    diagnostics: Object.freeze({
      abstainedCount: 0,
      answeredCount: 1,
      candidateCount: 1,
      complete: true,
      consideredAssertions: 0,
      current: currentGraph.diagnostics,
      diffComparedAssertions: 1,
      embeddingCalls: 0,
      maxDepthReached: 1,
      modelCalls: 0,
      previous: previousGraph.diagnostics,
      rawDeltaCount: 1,
      visitedRefs: 1
    })
  }) as ExplainedContinuityChangeResult;
  return {
    previous,
    currentGraphObservationReceipt: currentGraph,
    changeResult
  };
}

describe("compileResumeContextFacts", () => {
  it("projects one added change into semantic-only ordered facts", () => {
    const input = fixture();
    const compiled = compileResumeContextFacts(input);

    expect(Object.keys(compiled.facts)).toEqual([
      "schemaVersion",
      "factsVersion",
      "status",
      "authority",
      "boundaryObservedAt",
      "currentObservedAt",
      "previousNextStep",
      "changes"
    ]);
    expect(compiled.facts.status).toBe("partial");
    expect(compiled.facts.changes).toEqual([{
      kind: "added",
      temporalBasis: "world-valid",
      before: null,
      after: {
        subject: { id: "thread:resume", kind: "thread" },
        predicate: "NEXT_STEP_FOR",
        object: { id: "artifact:new", kind: "artifact" },
        epistemicClass: "source-observed",
        validFrom: CURRENT_AT
      }
    }]);
    expect(compiled.backingAssertionIds).toEqual(["assertion:after"]);
    expect(compiled.mandatoryCost.consideredAssertions).toBe(0);
    expect(compiled.mandatoryCost.assertions).toBe(1);
    expect(JSON.stringify(compiled.facts)).not.toMatch(
      /assertion:|source:|receipt:|derivation|recordedAt|path|ledger/u
    );
    expect(Object.getPrototypeOf(compiled.facts)).toBeNull();
    expect(Object.isFrozen(compiled)).toBe(true);
    expect(Object.isFrozen(compiled.facts.changes[0]?.after)).toBe(true);
  });

  it("binds revised support and is byte-identical across source permutations", () => {
    const base = fixture();
    const currentAssertion = base.changeResult.changes[0]!.assertion;
    const revisedResult = Object.freeze({
      ...base.changeResult,
      changes: Object.freeze([Object.freeze({
        assertion: currentAssertion,
        kind: "revised" as const,
        path: Object.freeze([]),
        replacedAssertionId: "assertion:before",
        temporalBasis: "world-valid" as const
      })])
    });
    const revised = {
      ...base,
      changeResult: revisedResult
    };
    const beforeBytes = JSON.stringify(revised);
    const compiled = compileResumeContextFacts(revised);

    expect(compiled.facts.changes[0]?.before).toEqual({
      subject: { id: "thread:resume", kind: "thread" },
      predicate: "NEXT_STEP_FOR",
      object: { id: "artifact:old", kind: "artifact" },
      epistemicClass: "source-observed",
      validFrom: PREVIOUS_AT
    });
    expect(compiled.backingAssertionIds).toEqual([
      "assertion:after",
      "assertion:before"
    ]);
    expect(JSON.stringify(revised)).toBe(beforeBytes);

    const other = assertion("assertion:\u{10000}", "artifact:\u0000\\\"😀", {
      validFrom: CURRENT_AT,
      recordedAt: CURRENT_AT
    });
    const currentA = observation(
      "graph:current",
      CURRENT_AT,
      "source:current",
      "projection:current",
      [other, currentAssertion]
    );
    const currentB = observation(
      "graph:current",
      CURRENT_AT,
      "source:current",
      "projection:current",
      [currentAssertion, other]
    );
    const otherChange = Object.freeze({
      assertion: other,
      kind: "added" as const,
      path: Object.freeze([]),
      temporalBasis: "learned-after" as const
    });
    const resultA = Object.freeze({
      ...base.changeResult,
      changes: Object.freeze([otherChange, base.changeResult.changes[0]!]),
      diagnostics: Object.freeze({
        ...base.changeResult.diagnostics,
        answeredCount: 2,
        candidateCount: 2,
        rawDeltaCount: 2
      })
    });
    const resultB = Object.freeze({
      ...resultA,
      changes: Object.freeze([...resultA.changes].reverse())
    });
    const compiledA = compileResumeContextFacts({
      ...base,
      currentGraphObservationReceipt: currentA,
      changeResult: resultA
    });
    const compiledB = compileResumeContextFacts({
      ...base,
      currentGraphObservationReceipt: currentB,
      changeResult: resultB
    });

    expect(serializeResumeContextFacts(compiledA.facts))
      .toBe(serializeResumeContextFacts(compiledB.facts));
    expect(compiledA.backingAssertionIds).toEqual(compiledB.backingAssertionIds);
    expect(compiledA.mandatoryCost).toEqual(compiledB.mandatoryCost);
    const serialized = serializeResumeContextFacts(compiledA.facts);
    expect(serialized.endsWith("\n")).toBe(true);
    expect(compiledA.mandatoryCost.outputBytes)
      .toBe(new TextEncoder().encode(serialized).byteLength);
    expect(compiledA.mandatoryCost.estimatedTokensV1)
      .toBe(Math.ceil(compiledA.mandatoryCost.outputBytes / 4));
  });

  it("fails closed on status, support, and every comparison cross-link", () => {
    const base = fixture();
    const cases: CompileCase[] = [
      {
        ...base,
        changeResult: Object.freeze({
          ...base.changeResult,
          status: "no-change"
        })
      },
      {
        ...base,
        changeResult: Object.freeze({
          ...base.changeResult,
          status: "partial",
          changes: Object.freeze([])
        })
      },
      {
        ...base,
        changeResult: Object.freeze({
          ...base.changeResult,
          status: "complete",
          changes: Object.freeze([])
        })
      },
      {
        ...base,
        changeResult: Object.freeze({
          ...base.changeResult,
          status: "abstained",
          changes: Object.freeze([])
        })
      },
      {
        ...base,
        currentGraphObservationReceipt: observation(
          "graph:current",
          CURRENT_AT,
          "source:current",
          "projection:current",
          []
        )
      },
      {
        ...base,
        changeResult: Object.freeze({
          ...base.changeResult,
          current: Object.freeze({
            ...base.changeResult.current,
            sourceVersion: "forged:source"
          })
        })
      },
      {
        ...base,
        previous: Object.freeze({
          ...base.previous,
          boundary: Object.freeze({
            ...base.previous.boundary,
            graphProjectionVersion: "forged:projection"
          })
        })
      },
      {
        ...base,
        previous: Object.freeze({
          ...base.previous,
          previousSourceObservationReceipt: Object.freeze({
            ...base.previous.previousSourceObservationReceipt,
            scope: Object.freeze({ ...SCOPE, threadId: "forged:thread" })
          })
        })
      },
      {
        ...base,
        changeResult: Object.freeze({
          ...base.changeResult,
          boundary: Object.freeze({
            ...base.changeResult.boundary,
            sourceRef: Object.freeze({
              ...base.changeResult.boundary.sourceRef,
              namespace: "forged:namespace"
            })
          })
        })
      }
    ];

    for (const value of cases) {
      expectInternalFailure(() => compileResumeContextFacts(value));
    }
  });

  it("emits the bounded no-change meaning and fixes all UTF-8 ceil boundaries", () => {
    const base = fixture();
    const noChange = compileResumeContextFacts({
      ...base,
      changeResult: Object.freeze({
        ...base.changeResult,
        status: "no-change",
        changes: Object.freeze([]),
        diagnostics: Object.freeze({
          ...base.changeResult.diagnostics,
          answeredCount: 0,
          candidateCount: 0,
          rawDeltaCount: 0
        })
      })
    });
    expect(noChange.facts.status).toBe("no-change");
    expect(noChange.facts.changes).toEqual([]);
    expect(noChange.backingAssertionIds).toEqual([]);
    expect(noChange.mandatoryCost.assertions).toBe(0);

    const observedRemainders = new Set<number>();
    for (let length = 0; length < 32; length += 1) {
      const suffix = `${"q".repeat(length)}\\"\u0000😀`;
      const changed = assertion(`assertion:utf8:${length}`, `artifact:${suffix}`, {
        validFrom: CURRENT_AT,
        validTo: "2026-07-30T10:00:00.000Z",
        recordedAt: CURRENT_AT
      });
      const current = observation(
        "graph:current",
        CURRENT_AT,
        "source:current",
        "projection:current",
        [changed]
      );
      const result = Object.freeze({
        ...base.changeResult,
        current: Object.freeze({
          sourceObservedAt: current.observedAt,
          sourceVersion: current.projection.sourceVersion,
          projectionVersion: current.projection.projectionVersion
        }),
        changes: Object.freeze([Object.freeze({
          assertion: changed,
          kind: "added" as const,
          path: Object.freeze([]),
          temporalBasis: "world-valid" as const
        })])
      });
      const compiled = compileResumeContextFacts({
        ...base,
        currentGraphObservationReceipt: current,
        changeResult: result
      });
      const bytes = new TextEncoder()
        .encode(serializeResumeContextFacts(compiled.facts)).byteLength;
      observedRemainders.add(bytes % 4);
      expect(compiled.mandatoryCost.outputBytes).toBe(bytes);
      expect(compiled.mandatoryCost.estimatedTokensV1).toBe(Math.ceil(bytes / 4));
      expect(compiled.facts.changes[0]?.after.validTo)
        .toBe("2026-07-30T10:00:00.000Z");
    }
    expect([...observedRemainders].sort()).toEqual([0, 1, 2, 3]);
  });

  it("compiles safe mandatory cost above provider maxima for explicit reservation", () => {
    const base = fixture();
    const compiled = compileResumeContextFacts({
      ...base,
      changeResult: Object.freeze({
        ...base.changeResult,
        diagnostics: Object.freeze({
          ...base.changeResult.diagnostics,
          maxDepthReached: 5
        })
      })
    });

    expect(compiled.mandatoryCost.depth).toBe(5);
    expect(reserveResumeBudget(Object.freeze({
      maxDepth: 4,
      maxConsideredAssertions: 256,
      maxVisitedRefs: 128,
      maxAssertions: 32,
      maxEstimatedTokens: 4096,
      maxOutputBytes: 262_144
    }), compiled.mandatoryCost)).toMatchObject({
      status: "exceeded",
      firstViolatedAxis: "depth"
    });
  });
});

type CompileCase = Parameters<typeof compileResumeContextFacts>[0];

function expectInternalFailure(operation: () => unknown): void {
  try {
    operation();
  } catch (cause) {
    expect(cause).toBeInstanceOf(ResumeContextBudgetError);
    const error = cause as ResumeContextBudgetError;
    expect(error.code).toBe("INTERNAL_POSTCONDITION_FAILED");
    expect(error.message).toBe("continuity-resume-context-budget-failed");
    expect(error.stack).toBeUndefined();
    expect(Object.keys(error).sort()).toEqual(["code", "details"]);
    expect(JSON.stringify(error.details).length).toBeLessThan(128);
    expect(Object.isFrozen(error)).toBe(true);
    expect(Object.isFrozen(error.details)).toBe(true);
    return;
  }
  throw new Error("expected ResumeContextBudgetError");
}

describe("six-axis resume budget", () => {
  const requested = Object.freeze({
    maxDepth: 4,
    maxConsideredAssertions: 9,
    maxVisitedRefs: 8,
    maxAssertions: 7,
    maxEstimatedTokens: 12,
    maxOutputBytes: 48
  });
  const mandatory = Object.freeze({
    depth: 2,
    consideredAssertions: 3,
    visitedRefs: 2,
    assertions: 4,
    estimatedTokensV1: 5,
    outputBytes: 19
  });

  it("reserves each independent axis with depth=max and exact residual subtraction", () => {
    const admitted = reserveResumeBudget(requested, mandatory);
    expect(admitted.status).toBe("admitted");
    if (admitted.status !== "admitted") throw new Error("expected admission");
    expect(admitted).toEqual({
      status: "admitted",
      requested,
      mandatoryCost: mandatory,
      residual: {
        depth: 4,
        consideredAssertions: 6,
        visitedRefs: 6,
        assertions: 3,
        estimatedTokensV1: 7,
        outputBytes: 29
      }
    });
    expect(Object.isFrozen(admitted)).toBe(true);
    expect(Object.isFrozen(admitted.residual)).toBe(true);

    const axes = [
      ["maxDepth", "depth"],
      ["maxConsideredAssertions", "consideredAssertions"],
      ["maxVisitedRefs", "visitedRefs"],
      ["maxAssertions", "assertions"],
      ["maxEstimatedTokens", "estimatedTokensV1"],
      ["maxOutputBytes", "outputBytes"]
    ] as const;
    for (const [requestKey, costKey] of axes) {
      const exact = reserveResumeBudget(
        Object.freeze({ ...requested, [requestKey]: mandatory[costKey] }),
        mandatory
      );
      expect(exact.status).toBe("admitted");
      const exceeded = reserveResumeBudget(
        Object.freeze({
          ...requested,
          [requestKey]: Math.max(0, mandatory[costKey] - 1)
        }),
        mandatory
      );
      expect(exceeded).toMatchObject({
        status: "exceeded",
        firstViolatedAxis: costKey
      });
    }

    const precedence = reserveResumeBudget(
      Object.freeze({
        ...requested,
        maxDepth: 1,
        maxConsideredAssertions: 0,
        maxVisitedRefs: 0,
        maxAssertions: 0,
        maxEstimatedTokens: 0,
        maxOutputBytes: 0
      }),
      mandatory
    );
    expect(precedence).toMatchObject({
      status: "exceeded",
      firstViolatedAxis: "depth"
    });
  });

  it("combines only an exact frozen admission and keeps the final inside the request", () => {
    const admitted = reserveResumeBudget(requested, mandatory);
    expect(admitted.status).toBe("admitted");
    if (admitted.status !== "admitted") throw new Error("expected admission");
    const settlement = Object.freeze({
      depth: 3,
      consideredAssertions: 6,
      visitedRefs: 1,
      assertions: 3,
      estimatedTokensV1: 7,
      outputBytes: 29
    });
    const combined = combineReservedResumeCosts(admitted, settlement);
    expect(combined.finalCost).toEqual({
      depth: 3,
      consideredAssertions: 9,
      visitedRefs: 3,
      assertions: 7,
      estimatedTokensV1: 12,
      outputBytes: 48
    });
    expect(Object.isFrozen(combined)).toBe(true);
    expect(Object.isFrozen(combined.finalCost)).toBe(true);

    const forged = Object.freeze({
      ...admitted,
      residual: Object.freeze({
        ...admitted.residual,
        outputBytes: admitted.residual.outputBytes + 1
      })
    });
    expectInternalFailure(() => combineReservedResumeCosts(forged, settlement));
    expectInternalFailure(() => combineReservedResumeCosts(
      admitted,
      Object.freeze({ ...settlement, assertions: 4 })
    ));
    expectInternalFailure(() => combineReservedResumeCosts(
      admitted,
      Object.freeze({ ...settlement, outputBytes: Number.MAX_SAFE_INTEGER })
    ));
  });

  it("rejects unsafe and over-cap requests without inventing cross-axis order", () => {
    expectInternalFailure(() => reserveResumeBudget(
      Object.freeze({ ...requested, maxOutputBytes: Number.MAX_SAFE_INTEGER }),
      mandatory
    ));
    expectInternalFailure(() => reserveResumeBudget(
      Object.freeze({ ...requested, maxDepth: 1.5 }),
      mandatory
    ));
    const independent = reserveResumeBudget(
      requested,
      Object.freeze({
        ...mandatory,
        consideredAssertions: 0,
        assertions: 7
      })
    );
    expect(independent.status).toBe("admitted");
    const overProviderMandatory = reserveResumeBudget(
      requested,
      Object.freeze({
        ...mandatory,
        outputBytes: 262_145
      })
    );
    expect(overProviderMandatory).toMatchObject({
      status: "exceeded",
      firstViolatedAxis: "outputBytes"
    });

    const aboveEveryProviderMaximum = reserveResumeBudget(
      Object.freeze({
        maxDepth: 4,
        maxConsideredAssertions: 256,
        maxVisitedRefs: 128,
        maxAssertions: 32,
        maxEstimatedTokens: 4096,
        maxOutputBytes: 262_144
      }),
      Object.freeze({
        depth: 5,
        consideredAssertions: 257,
        visitedRefs: 129,
        assertions: 33,
        estimatedTokensV1: 4097,
        outputBytes: 262_145
      })
    );
    expect(aboveEveryProviderMaximum).toMatchObject({
      status: "exceeded",
      firstViolatedAxis: "depth"
    });
  });
});
