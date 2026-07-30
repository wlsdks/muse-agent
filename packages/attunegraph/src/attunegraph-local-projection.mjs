import {
  admitJsonData,
  boundedText,
  fail,
  parseSnapshot,
  plainRecord
} from "./attunegraph-local-protocol.mjs";

/** @typedef {import("./attunegraph-contracts.js").AttuneGraphScope} AttuneGraphScope */
/** @typedef {import("./attunegraph-backend.js").AttuneGraphStoredProjection} AttuneGraphStoredProjection */

const GRAPH_NODE_KINDS = new Set([
  "thread", "artifact", "evidence", "delivery", "outcome", "policy", "decision", "action"
]);
const GRAPH_PREDICATES = new Set([
  "LINKED_TO", "NEXT_STEP_FOR", "CONTEXT_FOR", "SUPPORTED_BY", "DERIVED_FROM",
  "REVISION_OF", "SUPERSEDES", "OBSERVED_DURING", "DELIVERED_FOR",
  "PRODUCED_OUTCOME", "PROPOSES_POLICY", "SCOPED_TO", "GOVERNED_BY",
  "PRECEDED", "CORRELATES_WITH", "AUTHORIZED_BY", "PERFORMED"
]);
const GRAPH_EPISTEMIC_CLASSES = new Set([
  "user-asserted", "source-observed", "deterministic-derived", "model-hypothesis"
]);
const GRAPH_DERIVATION_KINDS = new Set(["projection", "rule", "model"]);

/** @param {unknown} value @param {string} label @returns {import("./types.js").GraphRef} */
function parseGraphRef(value, label) {
  const input = plainRecord(value, label, ["id", "kind"]);
  if (typeof input.kind !== "string" || !GRAPH_NODE_KINDS.has(input.kind)) {
    fail("STORE_FAILURE", `${label}.kind is invalid`);
  }
  return Object.freeze({
    id: boundedText(input.id, `${label}.id`),
    kind: /** @type {import("./types.js").GraphNodeKind} */ (input.kind)
  });
}

/** @param {unknown} value @param {string} label @returns {import("./types.js").GraphEvidenceRef} */
function parseEvidenceRef(value, label) {
  const input = plainRecord(value, label, ["id", "namespace", "version"], ["id", "namespace"]);
  if (input.version !== undefined && typeof input.version !== "string") {
    fail("STORE_FAILURE", `${label}.version is invalid`);
  }
  return Object.freeze({
    id: boundedText(input.id, `${label}.id`),
    namespace: boundedText(input.namespace, `${label}.namespace`),
    ...(input.version === undefined
      ? {}
      : { version: boundedText(input.version, `${label}.version`) })
  });
}

/** @param {unknown} value @param {string} label @returns {import("./types.js").GraphDerivation} */
function parseDerivation(value, label) {
  const input = plainRecord(value, label, ["kind", "runId", "version"], ["kind", "version"]);
  if (typeof input.kind !== "string" || !GRAPH_DERIVATION_KINDS.has(input.kind)) {
    fail("STORE_FAILURE", `${label}.kind is invalid`);
  }
  if (input.runId !== undefined && typeof input.runId !== "string") {
    fail("STORE_FAILURE", `${label}.runId is invalid`);
  }
  return Object.freeze({
    kind: /** @type {import("./types.js").GraphDerivationKind} */ (input.kind),
    ...(input.runId === undefined
      ? {}
      : { runId: boundedText(input.runId, `${label}.runId`) }),
    version: boundedText(input.version, `${label}.version`)
  });
}

/** @param {unknown} value @param {string} label @returns {import("./types.js").GraphAssertion} */
function parseAssertion(value, label) {
  const input = plainRecord(value, label, [
    "schemaVersion", "id", "subject", "predicate", "object", "epistemicClass",
    "sourceRefs", "validFrom", "validTo", "recordedAt", "supersededAt", "derivation"
  ], [
    "schemaVersion", "id", "subject", "predicate", "object", "epistemicClass",
    "sourceRefs", "recordedAt", "derivation"
  ]);
  if (
    input.schemaVersion !== 1
    || typeof input.predicate !== "string"
    || !GRAPH_PREDICATES.has(input.predicate)
    || typeof input.epistemicClass !== "string"
    || !GRAPH_EPISTEMIC_CLASSES.has(input.epistemicClass)
    || !Array.isArray(input.sourceRefs)
  ) fail("STORE_FAILURE", `${label} is invalid`);
  for (const optional of ["validFrom", "validTo", "supersededAt"]) {
    if (input[optional] !== undefined && typeof input[optional] !== "string") {
      fail("STORE_FAILURE", `${label}.${optional} is invalid`);
    }
  }
  return Object.freeze({
    schemaVersion: 1,
    id: boundedText(input.id, `${label}.id`),
    subject: parseGraphRef(input.subject, `${label}.subject`),
    predicate: /** @type {import("./types.js").GraphPredicate} */ (input.predicate),
    object: parseGraphRef(input.object, `${label}.object`),
    epistemicClass: /** @type {import("./types.js").GraphEpistemicClass} */ (input.epistemicClass),
    sourceRefs: Object.freeze(input.sourceRefs.map((item, index) =>
      parseEvidenceRef(item, `${label}.sourceRefs[${index}]`)
    )),
    ...(input.validFrom === undefined ? {} : { validFrom: boundedText(input.validFrom, `${label}.validFrom`) }),
    ...(input.validTo === undefined ? {} : { validTo: boundedText(input.validTo, `${label}.validTo`) }),
    recordedAt: boundedText(input.recordedAt, `${label}.recordedAt`),
    ...(input.supersededAt === undefined ? {} : { supersededAt: boundedText(input.supersededAt, `${label}.supersededAt`) }),
    derivation: parseDerivation(input.derivation, `${label}.derivation`)
  });
}

/**
 * Rebuilds a projection from descriptor-safe, closed graph structures.
 * @param {unknown} value
 * @param {AttuneGraphScope} scope
 * @returns {AttuneGraphStoredProjection}
 */
export function parseProjection(value, scope) {
  const admitted = admitJsonData(value, "projection");
  const input = plainRecord(admitted, "projection", [
    "schemaVersion",
    "snapshot",
    "observationId",
    "canonicalProjection",
    "projectionFingerprint",
    "observedAt",
    "sourceFreshness",
    "assertions"
  ]);
  const snapshot = parseSnapshot(input.snapshot, scope, "projection.snapshot");
  const observationId = boundedText(input.observationId, "projection.observationId");
  const fingerprint = boundedText(input.projectionFingerprint, "projection.projectionFingerprint");
  if (
    input.schemaVersion !== 1
    || observationId !== fingerprint
    || snapshot.commitId !== `attunegraph-commit:${observationId}`
    || typeof input.canonicalProjection !== "string"
    || typeof input.observedAt !== "string"
    || !Array.isArray(input.assertions)
  ) fail("STORE_FAILURE", "projection is incoherent");
  const freshness = plainRecord(input.sourceFreshness, "projection.sourceFreshness", [
    "state", "observedAt"
  ]);
  if (
    freshness.state !== "fresh"
    && freshness.state !== "stale"
    && freshness.state !== "unknown"
  ) fail("STORE_FAILURE", "projection.sourceFreshness.state is invalid");
  return Object.freeze({
    schemaVersion: 1,
    snapshot,
    observationId,
    canonicalProjection: input.canonicalProjection,
    projectionFingerprint: fingerprint,
    observedAt: input.observedAt,
    sourceFreshness: Object.freeze({
      state: freshness.state,
      observedAt: boundedText(freshness.observedAt, "projection.sourceFreshness.observedAt")
    }),
    assertions: Object.freeze(input.assertions.map((assertion, index) =>
      parseAssertion(assertion, `projection.assertions[${index}]`)
    ))
  });
}
