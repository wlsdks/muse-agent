import {
  ACTIVATION_PREDICATES,
  ACTIVATION_PREDICATE_PRIORITY,
  MAX_ACTIVATION_ESTIMATED_TOKENS,
  MAX_GRAPH_QUERY_ASSERTIONS,
  MAX_GRAPH_QUERY_CONSIDERED_ASSERTIONS,
  MAX_GRAPH_QUERY_DEPTH,
  MAX_GRAPH_QUERY_VISITED_REFS,
  SINGLE_VALUE_PREDICATES
} from "./constants.js";
import { AttuneGraphDataError } from "./error.js";
import type {
  ActivationConflict,
  ActivationSubgraph,
  ActivationSubgraphBudget,
  AttuneGraphDataStore,
  CompileActivationSubgraphInput,
  GraphAssertion,
  GraphEvidenceRef,
  GraphRef
} from "./types.js";
import {
  evidenceRefKey,
  graphRefKey,
  instantEpoch,
  normalizeGraphQueryPlan
} from "./validation.js";

const EPISTEMIC_PRIORITY: Readonly<Record<GraphAssertion["epistemicClass"], number>> = {
  "user-asserted": 0,
  "source-observed": 1,
  "deterministic-derived": 2,
  "model-hypothesis": 3
};

function boundedInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number
): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new AttuneGraphDataError(
      "INVALID_QUERY",
      `${label} must be an integer from ${minimum.toString()} to ${maximum.toString()}`
    );
  }
  return value as number;
}

function dataProperties(
  value: unknown,
  label: string,
  allowedKeys: readonly string[],
  requiredKeys: readonly string[]
): PropertyDescriptorMap {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AttuneGraphDataError("INVALID_QUERY", `${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new AttuneGraphDataError("INVALID_QUERY", `${label} must be a plain object`);
  }
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string")) {
    throw new AttuneGraphDataError("INVALID_QUERY", `${label} must not contain symbol keys`);
  }
  const stringKeys = keys as string[];
  const allowed = new Set(allowedKeys);
  if (
    stringKeys.some((key) => !allowed.has(key))
    || requiredKeys.some((key) => !stringKeys.includes(key))
  ) {
    throw new AttuneGraphDataError(
      "INVALID_QUERY",
      `${label} has missing or unknown fields`
    );
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (stringKeys.some((key) => !descriptors[key] || !("value" in descriptors[key]))) {
    throw new AttuneGraphDataError(
      "INVALID_QUERY",
      `${label} fields must be plain data properties`
    );
  }
  return descriptors;
}

function propertyValue(descriptors: PropertyDescriptorMap, key: string): unknown {
  return descriptors[key]?.value;
}

function normalizeBudget(value: unknown): ActivationSubgraphBudget {
  const properties = dataProperties(
    value,
    "activation budget",
    [
      "maxAssertions",
      "maxConsideredAssertions",
      "maxDepth",
      "maxEstimatedTokens",
      "maxVisitedRefs"
    ],
    [
      "maxAssertions",
      "maxConsideredAssertions",
      "maxDepth",
      "maxEstimatedTokens",
      "maxVisitedRefs"
    ]
  );
  const maxAssertions = boundedInteger(
    propertyValue(properties, "maxAssertions"),
    "activation budget.maxAssertions",
    1,
    MAX_GRAPH_QUERY_ASSERTIONS
  );
  const maxConsideredAssertions = boundedInteger(
    propertyValue(properties, "maxConsideredAssertions"),
    "activation budget.maxConsideredAssertions",
    1,
    MAX_GRAPH_QUERY_CONSIDERED_ASSERTIONS
  );
  if (maxConsideredAssertions < maxAssertions) {
    throw new AttuneGraphDataError(
      "INVALID_QUERY",
      "activation budget.maxConsideredAssertions must be at least maxAssertions"
    );
  }
  return Object.freeze({
    maxAssertions,
    maxConsideredAssertions,
    maxDepth: boundedInteger(
      propertyValue(properties, "maxDepth"),
      "activation budget.maxDepth",
      0,
      MAX_GRAPH_QUERY_DEPTH
    ),
    maxEstimatedTokens: boundedInteger(
      propertyValue(properties, "maxEstimatedTokens"),
      "activation budget.maxEstimatedTokens",
      64,
      MAX_ACTIVATION_ESTIMATED_TOKENS
    ),
    maxVisitedRefs: boundedInteger(
      propertyValue(properties, "maxVisitedRefs"),
      "activation budget.maxVisitedRefs",
      1,
      MAX_GRAPH_QUERY_VISITED_REFS
    )
  });
}

function estimateTokens(value: unknown): number {
  return Math.ceil(Buffer.byteLength(JSON.stringify(value), "utf8") / 4);
}

function compareActivationAssertions(left: GraphAssertion, right: GraphAssertion): number {
  return ACTIVATION_PREDICATE_PRIORITY[left.predicate]
    - ACTIVATION_PREDICATE_PRIORITY[right.predicate]
    || EPISTEMIC_PRIORITY[left.epistemicClass] - EPISTEMIC_PRIORITY[right.epistemicClass]
    || instantEpoch(right.recordedAt) - instantEpoch(left.recordedAt)
    || left.id.localeCompare(right.id);
}

function detectConflicts(assertions: readonly GraphAssertion[]): readonly ActivationConflict[] {
  const groups = new Map<string, GraphAssertion[]>();
  for (const assertion of assertions) {
    if (!SINGLE_VALUE_PREDICATES.has(assertion.predicate)) continue;
    const key = JSON.stringify([graphRefKey(assertion.subject), assertion.predicate]);
    const group = groups.get(key);
    if (group) group.push(assertion);
    else groups.set(key, [assertion]);
  }
  const conflicts: ActivationConflict[] = [];
  for (const group of groups.values()) {
    const objectKeys = new Set(group.map((assertion) => graphRefKey(assertion.object)));
    if (objectKeys.size < 2) continue;
    const first = group[0];
    if (!first) continue;
    const sourceRefs = new Map<string, GraphEvidenceRef>();
    for (const assertion of group) {
      for (const sourceRef of assertion.sourceRefs) {
        sourceRefs.set(evidenceRefKey(sourceRef), sourceRef);
      }
    }
    conflicts.push(Object.freeze({
      assertionIds: Object.freeze(group.map((assertion) => assertion.id).sort()),
      objectRefs: Object.freeze(
        [...new Map(group.map((assertion) => [
          graphRefKey(assertion.object),
          assertion.object
        ])).values()].sort((left, right) => graphRefKey(left).localeCompare(graphRefKey(right)))
      ),
      predicate: first.predicate,
      sourceRefs: Object.freeze(
        [...sourceRefs.values()].sort((left, right) =>
          evidenceRefKey(left).localeCompare(evidenceRefKey(right))
        )
      ),
      subject: first.subject
    }));
  }
  return Object.freeze(conflicts.sort((left, right) =>
    graphRefKey(left.subject).localeCompare(graphRefKey(right.subject))
    || left.predicate.localeCompare(right.predicate)
  ));
}

function collectRefs(seed: GraphRef, assertions: readonly GraphAssertion[]): readonly GraphRef[] {
  const refs = new Map([[graphRefKey(seed), seed]]);
  for (const assertion of assertions) {
    refs.set(graphRefKey(assertion.subject), assertion.subject);
    refs.set(graphRefKey(assertion.object), assertion.object);
  }
  return Object.freeze(
    [...refs.values()].sort((left, right) => graphRefKey(left).localeCompare(graphRefKey(right)))
  );
}

function collectSourceRefs(
  assertions: readonly GraphAssertion[],
  conflicts: readonly ActivationConflict[]
): readonly GraphEvidenceRef[] {
  const refs = new Map<string, GraphEvidenceRef>();
  for (const assertion of assertions) {
    for (const sourceRef of assertion.sourceRefs) {
      refs.set(evidenceRefKey(sourceRef), sourceRef);
    }
  }
  for (const conflict of conflicts) {
    for (const sourceRef of conflict.sourceRefs) {
      refs.set(evidenceRefKey(sourceRef), sourceRef);
    }
  }
  return Object.freeze(
    [...refs.values()].sort((left, right) =>
      evidenceRefKey(left).localeCompare(evidenceRefKey(right))
    )
  );
}

function buildCandidateOutput(
  input: CompileActivationSubgraphInput,
  assertions: readonly GraphAssertion[],
  conflicts: readonly ActivationConflict[],
  traversal: {
    readonly candidateAssertions: number;
    readonly detectedConflicts: number;
    readonly maxDepthReached: number;
    readonly traversalTruncated: boolean;
    readonly visitedRefs: number;
  },
  assertionBudgetTruncated: boolean,
  tokenBudgetTruncated: boolean
): ActivationSubgraph {
  const reportedConflicts = conflicts;
  const truncationReasons = [
    ...(assertionBudgetTruncated ? ["assertion-budget" as const] : []),
    ...(tokenBudgetTruncated ? ["token-budget" as const] : []),
    ...(traversal.traversalTruncated ? ["traversal-budget" as const] : [])
  ];
  const refs = collectRefs(input.seed, assertions);
  const sourceRefs = collectSourceRefs(assertions, reportedConflicts);
  const base = {
    schemaVersion: 1 as const,
    assertions: Object.freeze([...assertions]),
    compiledAt: input.now,
    conflicts: reportedConflicts,
    refs,
    seed: input.seed,
    sourceRefs,
    truncated: truncationReasons.length > 0
  };
  const diagnosticsWithoutEstimate = {
    candidateAssertions: traversal.candidateAssertions,
    detectedConflicts: traversal.detectedConflicts,
    maxDepthReached: traversal.maxDepthReached,
    reportedConflicts: reportedConflicts.length,
    selectedAssertions: assertions.length,
    truncationReasons: Object.freeze(truncationReasons),
    visitedRefs: traversal.visitedRefs
  };
  let estimatedTokens = 0;
  for (let iteration = 0; iteration < 8; iteration += 1) {
    const nextEstimate = estimateTokens({
      ...base,
      diagnostics: { ...diagnosticsWithoutEstimate, estimatedTokens }
    });
    if (nextEstimate === estimatedTokens) break;
    estimatedTokens = nextEstimate;
  }
  return Object.freeze({
    ...base,
    diagnostics: Object.freeze({
      ...diagnosticsWithoutEstimate,
      estimatedTokens
    })
  });
}

/**
 * Compiles only bounded graph input. It does not persist search paths, model reasoning,
 * or authority; callers may trace the returned exact slice.
 */
export async function compileActivationSubgraph(
  store: AttuneGraphDataStore,
  input: CompileActivationSubgraphInput
): Promise<ActivationSubgraph> {
  const inputProperties = dataProperties(
    input,
    "activation input",
    ["budget", "now", "recordedAtOrBefore", "seed"],
    ["budget", "now", "seed"]
  );
  const budget = normalizeBudget(propertyValue(inputProperties, "budget"));
  const rawNow = propertyValue(inputProperties, "now");
  const rawRecordedAtOrBefore = propertyValue(inputProperties, "recordedAtOrBefore");
  const plan = normalizeGraphQueryPlan({
    seeds: [propertyValue(inputProperties, "seed") as GraphRef],
    predicates: ACTIVATION_PREDICATES,
    direction: "both",
    maxDepth: budget.maxDepth,
    maxAssertions: Math.min(
      MAX_GRAPH_QUERY_ASSERTIONS,
      budget.maxConsideredAssertions
    ),
    maxConsideredAssertions: budget.maxConsideredAssertions,
    maxVisitedRefs: budget.maxVisitedRefs,
    validAt: rawNow as string,
    recordedAtOrBefore: (rawRecordedAtOrBefore ?? rawNow) as string
  });
  const normalizedSeed = plan.seeds[0];
  if (!normalizedSeed || normalizedSeed.kind !== "thread") {
    throw new AttuneGraphDataError(
      "INVALID_QUERY",
      "activation seed must be an exact thread ref"
    );
  }
  if (!plan.validAt || !plan.recordedAtOrBefore) {
    throw new AttuneGraphDataError(
      "INVALID_QUERY",
      "activation requires validated world-time and transaction-time instants"
    );
  }
  const traversal = await store.traverse(plan);
  if (!traversal.refs.some((ref) =>
    graphRefKey(ref) === graphRefKey(normalizedSeed)
  )) {
    throw new AttuneGraphDataError(
      "INVALID_QUERY",
      "activation traversal did not preserve its exact seed"
    );
  }
  const normalizedInput: CompileActivationSubgraphInput = {
    budget,
    now: plan.validAt,
    recordedAtOrBefore: plan.recordedAtOrBefore,
    seed: normalizedSeed
  };
  const candidates = [...traversal.assertions].sort(compareActivationAssertions);
  const conflicts = detectConflicts(candidates);
  const selected: GraphAssertion[] = [];
  let assertionBudgetTruncated = false;
  let tokenBudgetTruncated = false;

  for (const assertion of candidates) {
    if (selected.length >= budget.maxAssertions) {
      assertionBudgetTruncated = true;
      break;
    }
    const tentative = [...selected, assertion];
    const output = buildCandidateOutput(
      normalizedInput,
      tentative,
      conflicts,
      {
        candidateAssertions: candidates.length,
        detectedConflicts: conflicts.length,
        maxDepthReached: traversal.diagnostics.maxDepthReached,
        traversalTruncated: traversal.truncated,
        visitedRefs: traversal.diagnostics.visitedRefs
      },
      assertionBudgetTruncated,
      false
    );
    if (output.diagnostics.estimatedTokens > budget.maxEstimatedTokens) {
      tokenBudgetTruncated = true;
      continue;
    }
    selected.push(assertion);
  }

  let output = buildCandidateOutput(
    normalizedInput,
    selected,
    conflicts,
    {
      candidateAssertions: candidates.length,
      detectedConflicts: conflicts.length,
      maxDepthReached: traversal.diagnostics.maxDepthReached,
      traversalTruncated: traversal.truncated,
      visitedRefs: traversal.diagnostics.visitedRefs
    },
    assertionBudgetTruncated || selected.length < candidates.length && !tokenBudgetTruncated,
    tokenBudgetTruncated
  );
  while (
    output.diagnostics.estimatedTokens > budget.maxEstimatedTokens
    && selected.length > 0
  ) {
    selected.pop();
    tokenBudgetTruncated = true;
    output = buildCandidateOutput(
      normalizedInput,
      selected,
      conflicts,
      {
        candidateAssertions: candidates.length,
        detectedConflicts: conflicts.length,
        maxDepthReached: traversal.diagnostics.maxDepthReached,
        traversalTruncated: traversal.truncated,
        visitedRefs: traversal.diagnostics.visitedRefs
      },
      assertionBudgetTruncated,
      tokenBudgetTruncated
    );
  }
  if (output.diagnostics.estimatedTokens > budget.maxEstimatedTokens) {
    throw new AttuneGraphDataError(
      "INVALID_QUERY",
      "activation token budget is too small for mandatory graph metadata"
    );
  }
  return output;
}
