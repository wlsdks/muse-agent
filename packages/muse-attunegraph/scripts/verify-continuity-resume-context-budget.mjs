import {
  ResumeContextBudgetError,
  combineReservedResumeCosts,
  compileResumeContextFacts,
  reserveResumeBudget,
  serializeResumeContextFacts
} from "../dist/continuity-resume-context-budget.js";

const PREVIOUS_AT = "2026-07-30T08:00:00.000Z";
const CURRENT_AT = "2026-07-30T09:00:00.000Z";
const SCOPE = Object.freeze({ sourceId: "default", threadId: "thread_resume" });
const NEXT_STEP = Object.freeze({
  artifactId: "task_resume",
  artifactType: "task",
  providerId: "local",
  role: "next-step"
});

function fail(message) {
  throw new Error(`continuity resume context budget verification failed: ${message}`);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function assertion(id, objectId, recordedAt, validTo) {
  return Object.freeze({
    schemaVersion: 1,
    id,
    subject: Object.freeze({ id: "thread:resume", kind: "thread" }),
    predicate: "NEXT_STEP_FOR",
    object: Object.freeze({ id: objectId, kind: "artifact" }),
    epistemicClass: "source-observed",
    sourceRefs: Object.freeze([Object.freeze({
      id: `private-source:${id}`,
      namespace: "muse.verify",
      version: "1"
    })]),
    validFrom: recordedAt,
    ...(validTo === undefined ? {} : { validTo }),
    recordedAt,
    derivation: Object.freeze({
      kind: "projection",
      runId: `private-run:${id}`,
      version: "verify-v1"
    })
  });
}

function observation(
  receiptId,
  observedAt,
  sourceVersion,
  projectionVersion,
  assertions
) {
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

function input(permuted = false) {
  const before = assertion(
    "private-assertion:previous",
    "artifact:old",
    PREVIOUS_AT
  );
  const revised = assertion(
    "private-assertion:z-current",
    "artifact:new\\\"\u0000😀",
    CURRENT_AT,
    "2026-07-30T10:00:00.000Z"
  );
  const added = assertion(
    "private-assertion:a-current",
    "artifact:added",
    CURRENT_AT
  );
  const previousGraph = observation(
    "private-graph-receipt:previous",
    PREVIOUS_AT,
    "private-source-version:previous",
    "private-projection-version:previous",
    [before]
  );
  const currentAssertions = permuted ? [added, revised] : [revised, added];
  const currentGraph = observation(
    "private-graph-receipt:current",
    CURRENT_AT,
    "private-source-version:current",
    "private-projection-version:current",
    currentAssertions
  );
  const boundary = Object.freeze({
    schemaVersion: 1,
    boundaryVersion: "muse.continuity-resume-boundary.v1",
    authority: "caller-declared-resume-boundary",
    scope: SCOPE,
    observedAt: PREVIOUS_AT,
    sourceObservationReceiptId: "private-source-receipt:previous",
    graphObservationReceiptId: previousGraph.receiptId,
    graphSourceVersion: previousGraph.projection.sourceVersion,
    graphProjectionVersion: previousGraph.projection.projectionVersion,
    previousNextStep: NEXT_STEP,
    boundaryId: "private-boundary:previous"
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
        receiptId: "private-inner-source-receipt:previous"
      }),
      receiptId: boundary.sourceObservationReceiptId
    }),
    previousGraphObservationReceipt: previousGraph
  });
  const revisedChange = Object.freeze({
    assertion: revised,
    kind: "revised",
    path: Object.freeze([]),
    replacedAssertionId: before.id,
    temporalBasis: "world-valid"
  });
  const addedChange = Object.freeze({
    assertion: added,
    kind: "added",
    path: Object.freeze([]),
    temporalBasis: "learned-after"
  });
  const changes = permuted
    ? Object.freeze([revisedChange, addedChange])
    : Object.freeze([addedChange, revisedChange]);
  const changeResult = Object.freeze({
    schemaVersion: 1,
    queryVersion: "continuity-change-query-v1",
    resultId: "private-change-result",
    status: "partial",
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
    changes,
    abstentions: Object.freeze([]),
    diagnostics: Object.freeze({
      abstainedCount: 0,
      answeredCount: 2,
      candidateCount: 2,
      complete: false,
      consideredAssertions: 1,
      current: currentGraph.diagnostics,
      diffComparedAssertions: 2,
      embeddingCalls: 0,
      maxDepthReached: 2,
      modelCalls: 0,
      previous: previousGraph.diagnostics,
      rawDeltaCount: 2,
      visitedRefs: 2
    })
  });
  return Object.freeze({
    previous,
    currentGraphObservationReceipt: currentGraph,
    changeResult
  });
}

function expectInternal(operation) {
  try {
    operation();
  } catch (error) {
    assert(
      error instanceof ResumeContextBudgetError,
      "failure must use ResumeContextBudgetError"
    );
    assert(
      error.code === "INTERNAL_POSTCONDITION_FAILED",
      "failure code drifted"
    );
    assert(error.stack === undefined, "failure must not expose a stack");
    assert(Object.isFrozen(error), "failure must be frozen");
    assert(
      JSON.stringify(error.details).length < 128,
      "failure detail must remain bounded"
    );
    return;
  }
  fail("expected INTERNAL_POSTCONDITION_FAILED");
}

function assertDeepFrozen(value, seen = new WeakSet()) {
  if (typeof value !== "object" || value === null || seen.has(value)) return;
  seen.add(value);
  assert(Object.isFrozen(value), "every output object must be frozen");
  for (const item of Object.values(value)) assertDeepFrozen(item, seen);
}

const firstInput = input(false);
const originalInputBytes = JSON.stringify(firstInput);
const first = compileResumeContextFacts(firstInput);
const second = compileResumeContextFacts(input(true));
const firstBytes = serializeResumeContextFacts(first.facts);
const secondBytes = serializeResumeContextFacts(second.facts);

assert(firstBytes === secondBytes, "projection and change permutations changed bytes");
assert(
  JSON.stringify(first.backingAssertionIds)
    === JSON.stringify(second.backingAssertionIds),
  "permutations changed private backing order"
);
assert(
  JSON.stringify(first.mandatoryCost) === JSON.stringify(second.mandatoryCost),
  "permutations changed mandatory cost"
);
assert(
  JSON.stringify(Object.keys(first.facts))
    === JSON.stringify([
      "schemaVersion",
      "factsVersion",
      "status",
      "authority",
      "boundaryObservedAt",
      "currentObservedAt",
      "previousNextStep",
      "changes"
    ]),
  "facts field order drifted"
);
assert(
  JSON.stringify(Object.keys(first.facts.authority))
    === JSON.stringify([
      "basis",
      "canAssertCurrentWorldTruth",
      "canAssertSourceCompleteness",
      "canGrantActionAuthority"
    ]),
  "authority field order drifted"
);
for (const change of first.facts.changes) {
  assert(
    JSON.stringify(Object.keys(change))
      === JSON.stringify(["kind", "temporalBasis", "before", "after"]),
    "change field order drifted"
  );
}
assert(
  first.facts.status === "partial"
    && first.facts.authority.canAssertCurrentWorldTruth === false
    && first.facts.authority.canAssertSourceCompleteness === false
    && first.facts.authority.canGrantActionAuthority === false,
  "facts authority widened"
);
assert(
  first.facts.changes[0].kind === "added"
    && first.facts.changes[1].kind === "revised"
    && first.facts.changes[1].before.object.id === "artifact:old",
  "canonical added/revised semantic mapping drifted"
);
assert(
  first.backingAssertionIds.length === 3
    && first.mandatoryCost.consideredAssertions === 1
    && first.mandatoryCost.assertions === 3,
  "independent considered/backing accounting drifted"
);
for (const privateText of [
  "private-assertion:",
  "private-source:",
  "private-graph-receipt:",
  "private-change-result",
  "private-run:",
  "derivation",
  "recordedAt",
  "sourceRefs",
  "path"
]) {
  assert(!firstBytes.includes(privateText), `facts leaked ${privateText}`);
}
assert(firstBytes.endsWith("\n"), "facts must end in one newline");
assert(
  first.mandatoryCost.outputBytes
    === new TextEncoder().encode(firstBytes).byteLength,
  "outputBytes is not exact UTF-8 plus newline"
);
assert(
  first.mandatoryCost.estimatedTokensV1
    === Math.ceil(first.mandatoryCost.outputBytes / 4),
  "estimatedTokensV1 drifted"
);
assert(
  JSON.stringify(firstInput) === originalInputBytes,
  "compiler mutated its input"
);
assertDeepFrozen(first);
assert(Object.getPrototypeOf(first.facts) === null, "facts root needs null prototype");

const aboveDepthInput = Object.freeze({
  ...firstInput,
  changeResult: Object.freeze({
    ...firstInput.changeResult,
    diagnostics: Object.freeze({
      ...firstInput.changeResult.diagnostics,
      maxDepthReached: 5
    })
  })
});
const aboveDepth = compileResumeContextFacts(aboveDepthInput);
assert(
  aboveDepth.mandatoryCost.depth === 5,
  "compiler rejected or changed safe mandatory depth above provider maximum"
);
const aboveDepthReservation = reserveResumeBudget(Object.freeze({
  maxDepth: 4,
  maxConsideredAssertions: 256,
  maxVisitedRefs: 128,
  maxAssertions: 32,
  maxEstimatedTokens: 4096,
  maxOutputBytes: 262_144
}), aboveDepth.mandatoryCost);
assert(
  aboveDepthReservation.status === "exceeded"
    && aboveDepthReservation.firstViolatedAxis === "depth",
  "above-maximum mandatory depth did not return exceeded/depth"
);

const requested = Object.freeze({
  maxDepth: 4,
  maxConsideredAssertions: first.mandatoryCost.consideredAssertions + 2,
  maxVisitedRefs: first.mandatoryCost.visitedRefs + 2,
  maxAssertions: first.mandatoryCost.assertions + 2,
  maxEstimatedTokens: first.mandatoryCost.estimatedTokensV1 + 8,
  maxOutputBytes: first.mandatoryCost.outputBytes + 32
});
const reservation = reserveResumeBudget(requested, first.mandatoryCost);
assert(reservation.status === "admitted", "mandatory facts were not admitted");
assert(
  reservation.residual.depth === requested.maxDepth,
  "depth residual must preserve the admitted maximum"
);
const settlement = Object.freeze({
  depth: 3,
  consideredAssertions: 2,
  visitedRefs: 2,
  assertions: 2,
  estimatedTokensV1: 8,
  outputBytes: 32
});
const combined = combineReservedResumeCosts(reservation, settlement);
assert(
  combined.finalCost.depth === 3
    && combined.finalCost.outputBytes === requested.maxOutputBytes,
  "combined cost did not use max-depth and exact additive axes"
);
assertDeepFrozen(combined);

const forged = Object.freeze({
  ...reservation,
  residual: Object.freeze({
    ...reservation.residual,
    outputBytes: reservation.residual.outputBytes + 1
  })
});
expectInternal(() => combineReservedResumeCosts(forged, settlement));
expectInternal(() => combineReservedResumeCosts(
  reservation,
  Object.freeze({ ...settlement, outputBytes: 33 })
));
expectInternal(() => compileResumeContextFacts({
  ...firstInput,
  changeResult: Object.freeze({
    ...firstInput.changeResult,
    current: Object.freeze({
      ...firstInput.changeResult.current,
      sourceVersion: "forged-source-version"
    })
  })
}));

process.stdout.write("continuity resume context budget verification passed\n");
