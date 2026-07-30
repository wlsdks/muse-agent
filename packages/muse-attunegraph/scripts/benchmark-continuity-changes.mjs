import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  CONTINUITY_CHANGE_LIMITS,
  CONTINUITY_PROJECTION_BOUNDARY_NAMESPACE,
  explainContinuityChanges
} from "../dist/continuity-change-query.js";
import {
  continuityThreadGraphRef,
  diffContinuityProjections,
  projectContinuityState
} from "../dist/continuity-projection.js";
import {
  buildContinuityChangeCandidates,
  classifyContinuityTemporal,
  isContinuityNoOp
} from "../dist/continuity-change-semantics.js";

const BOUNDARY_AT = "2026-07-29T08:00:00.000Z";
const CURRENT_AT = "2026-07-29T10:00:00.000Z";
const THREAD_ID = "thread_trip";
const GENERATOR_VERSION = "continuity-change-generator-v2";
const corpusPath = resolve("benchmarks/continuity-change-v1.json");
const reportPath = resolve("../../docs/benchmarks/attunegraph-awg-030.json");

function canonicalValue(value) {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalValue);
  return Object.fromEntries(
    Object.keys(value).sort().flatMap((key) =>
      value[key] === undefined ? [] : [[key, canonicalValue(value[key])]]
    )
  );
}

function canonicalJson(value) {
  return `${JSON.stringify(canonicalValue(value), null, 2)}\n`;
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function baseState() {
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
      title: "Controlled synthetic trip"
    }],
    undoResetReceipts: []
  };
}

function link(id, linkedAt = "2026-07-29T09:00:00.000Z") {
  return {
    artifactId: id,
    artifactType: "task",
    linkedAt,
    linkedBy: "user",
    providerId: "local",
    role: "context",
    threadId: THREAD_ID
  };
}

function delivery(id, evidenceRefs = []) {
  return {
    evidenceClass: "controlled",
    evidenceRefs,
    id,
    openedAt: "2026-07-29T07:00:00.000Z",
    policyVersion: 0,
    threadId: THREAD_ID
  };
}

function fixture(kind) {
  const previous = baseState();
  let current;
  switch (kind) {
    case "direct-add":
      current = structuredClone(previous);
      current.threads[0].links.push(link("task_direct"));
      break;
    case "safe-revision":
      previous.threads[0].links.push(
        link("task_revision", "2026-07-29T07:00:00.000Z")
      );
      current = structuredClone(previous);
      current.threads[0].links[0].linkedAt = "2026-07-29T09:00:00.000Z";
      break;
    case "ambiguous-revision":
      previous.deliveries.push(delivery("delivery_ambiguous", [
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
      ]));
      current = structuredClone(previous);
      current.deliveries[0].evidenceRefs = [{
        artifactId: "evidence_c",
        artifactType: "task",
        providerId: "local",
        role: "context"
      }];
      break;
    case "multi-hop-interaction":
      previous.threads[0].links.push(
        link("task_interaction", "2026-07-29T07:00:00.000Z")
      );
      previous.threads[0].links[0].role = "next-step";
      previous.deliveries.push({
        ...delivery("delivery_trip", [{
          artifactId: "task_interaction",
          artifactType: "task",
          providerId: "local",
          role: "next-step"
        }]),
        interactionAnchor: {
          artifactId: "task_interaction",
          linkedAt: "2026-07-29T07:00:00.000Z",
          observedAt: "2026-07-29T07:10:00.000Z",
          observedStatus: "open",
          openStateFingerprint: "a".repeat(64),
          providerId: "local",
          role: "next-step"
        },
        openedAt: "2026-07-29T07:10:00.000Z",
        runId: "run_interaction"
      });
      current = structuredClone(previous);
      current.interactionReceipts.push({
        artifactId: "task_interaction",
        completedAt: "2026-07-29T09:00:00.000Z",
        deliveryId: "delivery_trip",
        doneStateFingerprint: "b".repeat(64),
        eventId: "event_interaction",
        evidenceClass: "controlled",
        id: "interaction_current",
        linkedAt: "2026-07-29T07:00:00.000Z",
        openStateFingerprint: "a".repeat(64),
        providerId: "local",
        recordedAt: "2026-07-29T09:01:00.000Z",
        role: "next-step",
        runId: "run_interaction",
        threadId: THREAD_ID,
        transition: "open-to-done"
      });
      break;
    case "no-op-reset-reobservation":
      previous.resetReceipts.push({
        basePolicyVersion: 0,
        beforePolicy: previous.threads[0].policy,
        id: "reset_trip",
        resetPolicyVersion: 1,
        threadId: THREAD_ID
      });
      previous.threads[0].policy = {
        ...previous.threads[0].policy,
        version: 1
      };
      previous.nextPolicyVersion = 2;
      current = structuredClone(previous);
      break;
    case "pure-removal":
      previous.threads[0].links.push(
        link("task_removed", "2026-07-29T07:00:00.000Z")
      );
      current = structuredClone(previous);
      current.threads[0].links = [];
      break;
    case "recorded-later-backfill":
      previous.threads[0].links.push(
        link("task_backfill", "2026-07-29T07:00:00.000Z")
      );
      previous.threads[0].links[0].role = "next-step";
      previous.deliveries.push({
        ...delivery("delivery_backfill", [{
          artifactId: "task_backfill",
          artifactType: "task",
          providerId: "local",
          role: "next-step"
        }]),
        interactionAnchor: {
          artifactId: "task_backfill",
          linkedAt: "2026-07-29T07:00:00.000Z",
          observedAt: "2026-07-29T07:10:00.000Z",
          observedStatus: "open",
          openStateFingerprint: "a".repeat(64),
          providerId: "local",
          role: "next-step"
        },
        openedAt: "2026-07-29T07:10:00.000Z",
        runId: "run_backfill"
      });
      current = structuredClone(previous);
      current.interactionReceipts.push({
        artifactId: "task_backfill",
        completedAt: "2026-07-29T07:30:00.000Z",
        deliveryId: "delivery_backfill",
        doneStateFingerprint: "b".repeat(64),
        eventId: "event_backfill",
        evidenceClass: "controlled",
        id: "interaction_backfill",
        linkedAt: "2026-07-29T07:00:00.000Z",
        openStateFingerprint: "a".repeat(64),
        providerId: "local",
        recordedAt: "2026-07-29T09:00:00.000Z",
        role: "next-step",
        runId: "run_backfill",
        threadId: THREAD_ID,
        transition: "open-to-done"
      });
      break;
    case "output-budget":
      current = structuredClone(previous);
      for (let index = 0; index < 33; index += 1) {
        current.threads[0].links.push(link(`task_output_${index}`));
      }
      break;
    case "visited-ref-budget":
      for (let index = 0; index < 96; index += 1) {
        previous.threads[0].links.push(
          link(`task_link_${index}`, "2026-07-29T07:00:00.000Z")
        );
      }
      for (let index = 0; index < 96; index += 1) {
        previous.deliveries.push(delivery(`delivery_dense_${index}`, [
          {
            artifactId: `task_evidence_${index * 2}`,
            artifactType: "task",
            providerId: "local",
            role: "context"
          },
          {
            artifactId: `task_evidence_${index * 2 + 1}`,
            artifactType: "task",
            providerId: "local",
            role: "context"
          }
        ]));
      }
      current = structuredClone(previous);
      current.threads[0].links[0] = link(
        "task_dense_new",
        "2026-07-29T09:00:00.000Z"
      );
      break;
    default:
      throw new Error(`unknown fixture '${kind}'`);
  }
  return { previous, current };
}

function observation(state, sourceObservedAt) {
  return {
    scope: { sourceId: "benchmark", threadId: THREAD_ID },
    sourceObservedAt,
    state
  };
}

function queryFor(states) {
  const previous = observation(states.previous, BOUNDARY_AT);
  const current = observation(states.current, CURRENT_AT);
  const projection = projectContinuityState(previous);
  return {
    boundary: {
      authority: "caller-declared-observation",
      observedAt: BOUNDARY_AT,
      schemaVersion: 1,
      scope: previous.scope,
      sourceRef: {
        id: projection.sourceVersion,
        namespace: CONTINUITY_PROJECTION_BOUNDARY_NAMESPACE,
        version: projection.projectionVersion
      }
    },
    current,
    previous,
    schemaVersion: 1
  };
}

function flatArm(input) {
  const previous = projectContinuityState(input.previous);
  const current = projectContinuityState(input.current);
  if (isContinuityNoOp(previous, current)) {
    return {
      abstentionCodes: [],
      detectedIds: [],
      paths: {},
      status: "no-change"
    };
  }
  const delta = diffContinuityProjections(previous, current);
  const previousById = new Map(
    previous.assertions.map((assertion) => [assertion.id, assertion])
  );
  const removals = delta.forgetAssertionIds
    .map((id) => previousById.get(id))
    .filter(Boolean);
  const candidates = buildContinuityChangeCandidates(removals, delta.append);
  const seedKey = JSON.stringify(continuityThreadGraphRef(previous.scope));
  const detectedIds = [];
  const paths = {};
  const abstentionCodes = [];
  for (const candidate of candidates) {
    if (candidate.type === "ambiguous") {
      abstentionCodes.push("AMBIGUOUS_REVISION");
      continue;
    }
    if (candidate.type === "removal") {
      abstentionCodes.push("REMOVAL_TIME_UNKNOWN");
      continue;
    }
    const assertion = candidate.additions[0];
    if (!assertion) continue;
    if (!classifyContinuityTemporal(assertion, BOUNDARY_AT, CURRENT_AT)) {
      abstentionCodes.push("OUTSIDE_INTERVAL");
      continue;
    }
    detectedIds.push(assertion.id);
    if (
      JSON.stringify(assertion.subject) === seedKey
      || JSON.stringify(assertion.object) === seedKey
    ) {
      paths[assertion.id] = [assertion.id];
    } else {
      abstentionCodes.push("FLAT_NON_DIRECT");
    }
  }
  if (Object.keys(paths).length > CONTINUITY_CHANGE_LIMITS.maxExplainedChanges) {
    return {
      abstentionCodes: ["OUTPUT_BUDGET_EXCEEDED"],
      detectedIds: detectedIds.sort(),
      paths: {},
      status: "abstained"
    };
  }
  const answered = Object.keys(paths).length;
  const status = candidates.length === 0
    ? "no-change"
    : answered > 0 && abstentionCodes.length === 0
      ? "complete"
      : answered > 0
        ? "partial"
        : "abstained";
  return {
    abstentionCodes: abstentionCodes.sort(),
    detectedIds: detectedIds.sort(),
    paths,
    status
  };
}

function graphView(result) {
  return {
    abstentionCodes: result.abstentions.map((item) => item.code).sort(),
    changeIds: result.changes.map((item) => item.assertion.id).sort(),
    paths: Object.fromEntries(
      result.changes.map((item) => [
        item.assertion.id,
        item.path.map((step) => step.assertionId)
      ]).sort(([left], [right]) => left.localeCompare(right))
    ),
    status: result.status
  };
}

function divide(numerator, denominator) {
  return denominator === 0 ? null : numerator / denominator;
}

function exactArrays(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function metrics(executions, arm) {
  let returned = 0;
  let correctReturned = 0;
  let goldEligible = 0;
  let detectedCorrect = 0;
  let returnedPathItems = 0;
  let correctPathItems = 0;
  let goldAnswerable = 0;
  let exactPathAnswers = 0;
  let statusCorrect = 0;
  let abstentionCorrect = 0;
  for (const execution of executions.filter((item) => item.metricEligible)) {
    const expected = execution.expected;
    const output = arm === "graph" ? execution.graph : execution.flat;
    const detected = arm === "graph"
      ? [...new Set([
          ...output.changeIds,
          ...execution.graphResult.abstentions
            .filter((item) => item.code === "NO_PATH_WITHIN_DEPTH")
            .flatMap((item) => item.affectedAssertionIds)
        ])]
      : output.detectedIds;
    const gold = expected.eligibleChangeIds;
    returned += detected.length;
    correctReturned += detected.filter((id) => gold.includes(id)).length;
    goldEligible += gold.length;
    detectedCorrect += gold.filter((id) => detected.includes(id)).length;
    for (const [id, path] of Object.entries(output.paths)) {
      const goldPath = expected.paths[id] ?? [];
      returnedPathItems += path.length;
      correctPathItems += path.filter((step, index) => goldPath[index] === step).length;
    }
    for (const [id, goldPath] of Object.entries(expected.paths)) {
      goldAnswerable += 1;
      if (exactArrays(output.paths[id] ?? [], goldPath)) exactPathAnswers += 1;
    }
    if (output.status === expected[`${arm}Status`]) statusCorrect += 1;
    if (
      exactArrays(
        output.abstentionCodes,
        expected[`${arm}AbstentionCodes`]
      )
    ) {
      abstentionCorrect += 1;
    }
  }
  const cases = executions.filter((item) => item.metricEligible).length;
  return {
    abstentionAccuracy: divide(abstentionCorrect, cases),
    detectionPrecision: divide(correctReturned, returned),
    detectionRecall: divide(detectedCorrect, goldEligible),
    exactPathCoverage: divide(exactPathAnswers, goldAnswerable),
    exactPathPrecision: divide(correctPathItems, returnedPathItems),
    statusAccuracy: divide(statusCorrect, cases)
  };
}

const rawCorpus = await readFile(corpusPath, "utf8");
const corpus = JSON.parse(rawCorpus);
const executions = corpus.cases.map((entry) => {
  const input = queryFor(fixture(entry.fixture));
  const graphResult = explainContinuityChanges(input);
  const graph = graphView(graphResult);
  const flat = flatArm(input);
  return {
    ...entry,
    flat,
    graph,
    graphResult
  };
});

const proposed = executions.map((item) => ({
  id: item.id,
  expected: {
    eligibleChangeIds: item.flat.detectedIds,
    flatAbstentionCodes: item.flat.abstentionCodes,
    flatStatus: item.flat.status,
    graphAbstentionCodes: item.graph.abstentionCodes,
    graphStatus: item.graph.status,
    paths: item.graph.paths
  }
}));

if (process.argv.includes("--propose")) {
  process.stdout.write(canonicalJson(proposed));
  process.exit(0);
}

for (const execution of executions) {
  if (!execution.expected) {
    throw new Error(`corpus case '${execution.id}' has no frozen expectation`);
  }
  const actual = proposed.find((item) => item.id === execution.id)?.expected;
  if (canonicalJson(actual) !== canonicalJson(execution.expected)) {
    throw new Error(
      `corpus drift in '${execution.id}'\nexpected ${canonicalJson(execution.expected)}actual ${canonicalJson(actual)}`
    );
  }
}

const graphMetrics = metrics(executions, "graph");
const flatMetrics = metrics(executions, "flat");
const executedObservations = executions.map((item) => ({
  fixture: item.fixture,
  id: item.id,
  input: queryFor(fixture(item.fixture))
}));
const qualification = {
  graphDetectionNoRegression:
    (graphMetrics.detectionPrecision ?? 0) >= (flatMetrics.detectionPrecision ?? 0)
    && (graphMetrics.detectionRecall ?? 0) >= (flatMetrics.detectionRecall ?? 0),
  graphPathAdvantage:
    (graphMetrics.exactPathCoverage ?? 0) > (flatMetrics.exactPathCoverage ?? 0),
  graphPathPrecisionExact: graphMetrics.exactPathPrecision === 1,
  graphStatusAndAbstentionExact:
    graphMetrics.statusAccuracy === 1 && graphMetrics.abstentionAccuracy === 1,
  workWithinBounds: executions.every((item) =>
    item.graphResult.diagnostics.current.projectedAssertions
      <= CONTINUITY_CHANGE_LIMITS.maxProjectionAssertions
    && item.graphResult.diagnostics.previous.projectedAssertions
      <= CONTINUITY_CHANGE_LIMITS.maxProjectionAssertions
    && item.graphResult.diagnostics.visitedRefs
      <= CONTINUITY_CHANGE_LIMITS.maxVisitedRefs
  )
};
const qualified = Object.values(qualification).every(Boolean);
const report = {
  schemaVersion: 1,
  benchmarkId: "attunegraph-awg-030",
  corpus: {
    caseCount: corpus.cases.length,
    dataOrigin: corpus.dataOrigin,
    metricEligibleCaseCount: corpus.cases.filter((item) => item.metricEligible).length,
    semanticPayloadAvailable: corpus.semanticPayloadAvailable,
    generatorVersion: GENERATOR_VERSION,
    specSha256: sha256(rawCorpus),
    executedObservationsSha256: sha256(canonicalJson({
      generatorVersion: GENERATOR_VERSION,
      observations: executedObservations
    }))
  },
  executionEvidence: "controlled-replay",
  flat: {
    capabilities: "shared no-op/delta/revision/temporal candidates; direct thread edge; no adjacency or traversal",
    metrics: flatMetrics,
    modelCalls: 0,
    embeddingCalls: 0
  },
  graph: {
    capabilities: "same candidate truth plus bounded exact thread-path traversal",
    metrics: graphMetrics,
    modelCalls: 0,
    embeddingCalls: 0
  },
  vector: {
    applicability: "not-applicable",
    executionEvidence: "not-run",
    reason: "AWG-020 projection contains no semantic text payload",
    modelCalls: 0,
    embeddingCalls: 0
  },
  qualification,
  qualified
};
const expectedReport = await readFile(reportPath, "utf8");
if (canonicalJson(JSON.parse(expectedReport)) !== canonicalJson(report)) {
  throw new Error(
    `benchmark report drift\nexpected ${expectedReport}\nactual ${canonicalJson(report)}`
  );
}
if (!qualified) throw new Error("AWG-030 qualification failed");
process.stdout.write(canonicalJson(report));
