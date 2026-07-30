import {
  GRAPH_DERIVATION_KINDS,
  GRAPH_DIRECTIONS,
  GRAPH_EPISTEMIC_CLASSES,
  GRAPH_NODE_KINDS,
  GRAPH_PREDICATES,
  type GraphAssertion,
  type GraphDerivation,
  type GraphDirection,
  type GraphEvidenceRef,
  type GraphForgetScope,
  type GraphNodeKind,
  type GraphPredicate,
  type GraphQueryPlan,
  type GraphRecordedRange,
  type GraphRef
} from "./types.js";
import {
  MAX_GRAPH_QUERY_ASSERTIONS,
  MAX_GRAPH_ASSERTION_SOURCE_REFS,
  MAX_GRAPH_APPEND_BATCH_ASSERTIONS,
  MAX_GRAPH_QUERY_CONSIDERED_ASSERTIONS,
  MAX_GRAPH_QUERY_DEPTH,
  MAX_GRAPH_QUERY_SEEDS,
  MAX_GRAPH_QUERY_VISITED_REFS
} from "./constants.js";
import { AttuneGraphDataError } from "./error.js";

const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/u;
const MAX_ID_CHARACTERS = 512;
const MAX_NAMESPACE_CHARACTERS = 128;
const MAX_VERSION_CHARACTERS = 128;

const HYPOTHESIS_FORBIDDEN_PREDICATES: ReadonlySet<GraphPredicate> = new Set([
  "AUTHORIZED_BY",
  "GOVERNED_BY",
  "PERFORMED",
  "PRODUCED_OUTCOME",
  "SUPERSEDES"
]);

const SUBJECT_KIND_RULES: Partial<Readonly<Record<GraphPredicate, readonly GraphNodeKind[]>>> = {
  AUTHORIZED_BY: ["action"],
  DELIVERED_FOR: ["delivery"],
  GOVERNED_BY: ["delivery", "decision", "action"],
  LINKED_TO: ["artifact"],
  NEXT_STEP_FOR: ["artifact"],
  CONTEXT_FOR: ["artifact"],
  OBSERVED_DURING: ["evidence"],
  PERFORMED: ["decision"],
  PRODUCED_OUTCOME: ["delivery"],
  PROPOSES_POLICY: ["decision"],
  SCOPED_TO: ["policy"]
};

const OBJECT_KIND_RULES: Partial<Readonly<Record<GraphPredicate, readonly GraphNodeKind[]>>> = {
  AUTHORIZED_BY: ["evidence"],
  DELIVERED_FOR: ["thread"],
  DERIVED_FROM: ["evidence"],
  GOVERNED_BY: ["policy"],
  LINKED_TO: ["thread"],
  NEXT_STEP_FOR: ["thread"],
  CONTEXT_FOR: ["thread"],
  OBSERVED_DURING: ["thread"],
  PERFORMED: ["action"],
  PRODUCED_OUTCOME: ["outcome"],
  PROPOSES_POLICY: ["policy"],
  SCOPED_TO: ["thread"],
  SUPPORTED_BY: ["evidence"]
};

const SAME_KIND_PREDICATES: ReadonlySet<GraphPredicate> = new Set([
  "REVISION_OF",
  "SUPERSEDES"
]);

interface DataRecord {
  readonly descriptors: PropertyDescriptorMap;
  readonly keys: readonly string[];
}

function dataArray(value: unknown, label: string, maxItems: number): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    invalid(`${label} must be a plain array`);
  }
  const descriptors: PropertyDescriptorMap = Object.getOwnPropertyDescriptors(
    value as object
  );
  const lengthValue = descriptors["length"]?.value;
  if (
    !Number.isSafeInteger(lengthValue)
    || (lengthValue as number) < 0
    || (lengthValue as number) > maxItems
  ) {
    invalid(`${label} exceeds its maximum item count`);
  }
  const length = lengthValue as number;
  const allowedKeys = new Set(["length"]);
  const values: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const key = index.toString();
    allowedKeys.add(key);
    const descriptor = descriptors[key];
    if (!descriptor || !("value" in descriptor)) {
      invalid(`${label} must be dense and contain only data properties`);
    }
    values.push(descriptor.value);
  }
  if (Reflect.ownKeys(value).some((key) =>
    typeof key !== "string" || !allowedKeys.has(key)
  )) {
    invalid(`${label} must not contain extra or symbol properties`);
  }
  return values;
}

function queryDataArray(value: unknown, label: string, maxItems: number): readonly unknown[] {
  try {
    return dataArray(value, label, maxItems);
  } catch (cause) {
    if (cause instanceof AttuneGraphDataError) invalidQuery(cause.message);
    throw cause;
  }
}

function dataRecord(
  value: unknown,
  label: string,
  allowedKeys: readonly string[],
  requiredKeys: readonly string[]
): DataRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalid(`${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    invalid(`${label} must be a plain object`);
  }
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== "string")) {
    invalid(`${label} must not contain symbol keys`);
  }
  const keys = ownKeys as string[];
  const allowed = new Set(allowedKeys);
  if (keys.some((key) => !allowed.has(key))) {
    invalid(`${label} contains unknown fields`);
  }
  if (requiredKeys.some((key) => !keys.includes(key))) {
    invalid(`${label} is missing required fields`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (keys.some((key) => !descriptors[key] || !("value" in descriptors[key]))) {
    invalid(`${label} fields must be plain data properties`);
  }
  return { descriptors, keys };
}

function queryDataRecord(
  value: unknown,
  label: string,
  allowedKeys: readonly string[],
  requiredKeys: readonly string[]
): DataRecord {
  try {
    return dataRecord(value, label, allowedKeys, requiredKeys);
  } catch (cause) {
    if (cause instanceof AttuneGraphDataError) invalidQuery(cause.message);
    throw cause;
  }
}

function dataValue(record: DataRecord, key: string): unknown {
  return record.descriptors[key]?.value;
}

function invalid(message: string): never {
  throw new AttuneGraphDataError("INVALID_ASSERTION", message);
}

function invalidQuery(message: string): never {
  throw new AttuneGraphDataError("INVALID_QUERY", message);
}

function safeText(value: unknown, label: string, maxCharacters: number): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value !== value.trim()
    || Array.from(value).length > maxCharacters
    || CONTROL_CHARACTERS.test(value)
  ) {
    invalid(`${label} must be non-empty, trimmed, bounded text without control characters`);
  }
  return value;
}

function canonicalInstant(value: unknown, label: string): string {
  if (typeof value !== "string") invalid(`${label} must be a canonical ISO instant`);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    invalid(`${label} must be a canonical ISO instant`);
  }
  return value;
}

export function instantEpoch(value: string): number {
  return new Date(value).getTime();
}

function queryInstant(value: unknown, label: string): string {
  try {
    return canonicalInstant(value, label);
  } catch (cause) {
    if (cause instanceof AttuneGraphDataError) invalidQuery(cause.message);
    throw cause;
  }
}

function oneOf<const T extends readonly string[]>(
  value: unknown,
  values: T,
  label: string
): T[number] {
  if (typeof value !== "string" || !values.includes(value as T[number])) {
    invalid(`${label} is not supported`);
  }
  return value as T[number];
}

function normalizeGraphRef(value: unknown, label: string): GraphRef {
  const record = dataRecord(value, label, ["id", "kind"], ["id", "kind"]);
  return Object.freeze({
    id: safeText(dataValue(record, "id"), `${label}.id`, MAX_ID_CHARACTERS),
    kind: oneOf(dataValue(record, "kind"), GRAPH_NODE_KINDS, `${label}.kind`)
  });
}

function normalizeEvidenceRef(value: unknown, label: string): GraphEvidenceRef {
  const record = dataRecord(
    value,
    label,
    ["id", "namespace", "version"],
    ["id", "namespace"]
  );
  const version = record.keys.includes("version")
    ? safeText(dataValue(record, "version"), `${label}.version`, MAX_VERSION_CHARACTERS)
    : undefined;
  return Object.freeze({
    id: safeText(dataValue(record, "id"), `${label}.id`, MAX_ID_CHARACTERS),
    namespace: safeText(
      dataValue(record, "namespace"),
      `${label}.namespace`,
      MAX_NAMESPACE_CHARACTERS
    ),
    ...(version ? { version } : {})
  });
}

function normalizeDerivation(value: unknown): GraphDerivation {
  const record = dataRecord(
    value,
    "assertion.derivation",
    ["kind", "runId", "version"],
    ["kind", "version"]
  );
  const runId = record.keys.includes("runId")
    ? safeText(dataValue(record, "runId"), "assertion.derivation.runId", MAX_ID_CHARACTERS)
    : undefined;
  return Object.freeze({
    kind: oneOf(
      dataValue(record, "kind"),
      GRAPH_DERIVATION_KINDS,
      "assertion.derivation.kind"
    ),
    ...(runId ? { runId } : {}),
    version: safeText(
      dataValue(record, "version"),
      "assertion.derivation.version",
      MAX_VERSION_CHARACTERS
    )
  });
}

function assertEndpointContract(
  predicate: GraphPredicate,
  subject: GraphRef,
  object: GraphRef
): void {
  if (graphRefKey(subject) === graphRefKey(object)) {
    invalid("assertion endpoints must be distinct");
  }
  const subjectKinds = SUBJECT_KIND_RULES[predicate];
  if (subjectKinds && !subjectKinds.includes(subject.kind)) {
    invalid(`${predicate} does not accept subject kind ${subject.kind}`);
  }
  const objectKinds = OBJECT_KIND_RULES[predicate];
  if (objectKinds && !objectKinds.includes(object.kind)) {
    invalid(`${predicate} does not accept object kind ${object.kind}`);
  }
  if (SAME_KIND_PREDICATES.has(predicate) && subject.kind !== object.kind) {
    invalid(`${predicate} requires endpoints of the same kind`);
  }
}

export function normalizeGraphAssertion(value: unknown): GraphAssertion {
  const record = dataRecord(
    value,
    "assertion",
    [
      "schemaVersion",
      "id",
      "subject",
      "predicate",
      "object",
      "epistemicClass",
      "sourceRefs",
      "validFrom",
      "validTo",
      "recordedAt",
      "supersededAt",
      "derivation"
    ],
    [
      "schemaVersion",
      "id",
      "subject",
      "predicate",
      "object",
      "epistemicClass",
      "sourceRefs",
      "recordedAt",
      "derivation"
    ]
  );
  if (dataValue(record, "schemaVersion") !== 1) {
    invalid("assertion.schemaVersion must be 1");
  }
  const id = safeText(dataValue(record, "id"), "assertion.id", MAX_ID_CHARACTERS);
  const subject = normalizeGraphRef(dataValue(record, "subject"), "assertion.subject");
  const object = normalizeGraphRef(dataValue(record, "object"), "assertion.object");
  const predicate = oneOf(
    dataValue(record, "predicate"),
    GRAPH_PREDICATES,
    "assertion.predicate"
  );
  const epistemicClass = oneOf(
    dataValue(record, "epistemicClass"),
    GRAPH_EPISTEMIC_CLASSES,
    "assertion.epistemicClass"
  );
  const rawSourceRefs = dataArray(
    dataValue(record, "sourceRefs"),
    "assertion.sourceRefs",
    MAX_GRAPH_ASSERTION_SOURCE_REFS
  );
  if (rawSourceRefs.length === 0) {
    invalid("assertion.sourceRefs must contain at least one exact source");
  }
  const sourceRefs = rawSourceRefs.map((source, index) =>
    normalizeEvidenceRef(source, `assertion.sourceRefs[${index.toString()}]`)
  ).sort((left, right) => evidenceRefKey(left).localeCompare(evidenceRefKey(right)));
  if (new Set(sourceRefs.map(evidenceRefKey)).size !== sourceRefs.length) {
    invalid("assertion.sourceRefs must not contain duplicates");
  }
  const validFrom = record.keys.includes("validFrom")
    ? canonicalInstant(dataValue(record, "validFrom"), "assertion.validFrom")
    : undefined;
  const validTo = record.keys.includes("validTo")
    ? canonicalInstant(dataValue(record, "validTo"), "assertion.validTo")
    : undefined;
  const recordedAt = canonicalInstant(dataValue(record, "recordedAt"), "assertion.recordedAt");
  const supersededAt = record.keys.includes("supersededAt")
    ? canonicalInstant(dataValue(record, "supersededAt"), "assertion.supersededAt")
    : undefined;
  if (validFrom && validTo && instantEpoch(validFrom) >= instantEpoch(validTo)) {
    invalid("assertion.validTo must be later than validFrom");
  }
  if (supersededAt && instantEpoch(supersededAt) < instantEpoch(recordedAt)) {
    invalid("assertion.supersededAt must not precede recordedAt");
  }
  const derivation = normalizeDerivation(dataValue(record, "derivation"));
  if (epistemicClass === "deterministic-derived" && derivation.kind !== "rule") {
    invalid("deterministic-derived assertions require rule derivation");
  }
  if (epistemicClass === "model-hypothesis" && derivation.kind !== "model") {
    invalid("model-hypothesis assertions require model derivation");
  }
  if (
    epistemicClass === "model-hypothesis"
    && HYPOTHESIS_FORBIDDEN_PREDICATES.has(predicate)
  ) {
    invalid(`model-hypothesis cannot assert ${predicate}`);
  }
  assertEndpointContract(predicate, subject, object);

  return Object.freeze({
    schemaVersion: 1 as const,
    id,
    subject,
    predicate,
    object,
    epistemicClass,
    sourceRefs: Object.freeze(sourceRefs),
    ...(validFrom ? { validFrom } : {}),
    ...(validTo ? { validTo } : {}),
    recordedAt,
    ...(supersededAt ? { supersededAt } : {}),
    derivation
  });
}

export function canonicalAssertion(assertion: GraphAssertion): string {
  return JSON.stringify(assertion);
}

export function graphRefKey(ref: GraphRef): string {
  return JSON.stringify([ref.kind, ref.id]);
}

export function evidenceRefKey(ref: GraphEvidenceRef): string {
  return JSON.stringify([ref.namespace, ref.id, ref.version ?? null]);
}

export function evidenceRefBaseKey(ref: Pick<GraphEvidenceRef, "id" | "namespace">): string {
  return JSON.stringify([ref.namespace, ref.id]);
}

export function normalizeGraphAssertionBatch(value: unknown): readonly GraphAssertion[] {
  return Object.freeze(
    dataArray(value, "append assertions", MAX_GRAPH_APPEND_BATCH_ASSERTIONS)
      .map((assertion) => normalizeGraphAssertion(assertion))
  );
}

function boundedInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number
): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    invalidQuery(`${label} must be an integer from ${minimum.toString()} to ${maximum.toString()}`);
  }
  return value as number;
}

function normalizeQueryRef(value: unknown, label: string): GraphRef {
  try {
    return normalizeGraphRef(value, label);
  } catch (cause) {
    if (cause instanceof AttuneGraphDataError) invalidQuery(cause.message);
    throw cause;
  }
}

function normalizeQueryEnum<const T extends readonly string[]>(
  value: unknown,
  values: T,
  label: string
): T[number] {
  try {
    return oneOf(value, values, label);
  } catch (cause) {
    if (cause instanceof AttuneGraphDataError) invalidQuery(cause.message);
    throw cause;
  }
}

export function normalizeGraphQueryPlan(value: GraphQueryPlan): GraphQueryPlan {
  const record = queryDataRecord(
    value,
    "query",
    [
      "seeds",
      "predicates",
      "direction",
      "maxDepth",
      "maxAssertions",
      "maxConsideredAssertions",
      "maxVisitedRefs",
      "validAt",
      "recordedAtOrBefore",
      "epistemicClasses",
      "includeSuperseded"
    ],
    [
      "seeds",
      "predicates",
      "direction",
      "maxDepth",
      "maxAssertions",
      "maxConsideredAssertions",
      "maxVisitedRefs"
    ]
  );
  const rawSeeds = queryDataArray(
    dataValue(record, "seeds"),
    "query.seeds",
    MAX_GRAPH_QUERY_SEEDS
  );
  if (rawSeeds.length === 0) {
    invalidQuery(`query.seeds must contain 1-${MAX_GRAPH_QUERY_SEEDS.toString()} refs`);
  }
  const seeds = rawSeeds.map((seed, index) =>
    normalizeQueryRef(seed, `query.seeds[${index.toString()}]`)
  ).sort((left, right) => graphRefKey(left).localeCompare(graphRefKey(right)));
  if (new Set(seeds.map(graphRefKey)).size !== seeds.length) {
    invalidQuery("query.seeds must not contain duplicates");
  }
  const rawPredicates = queryDataArray(
    dataValue(record, "predicates"),
    "query.predicates",
    GRAPH_PREDICATES.length
  );
  if (rawPredicates.length === 0) {
    invalidQuery("query.predicates must contain at least one allowlisted predicate");
  }
  const predicates = rawPredicates.map((predicate) =>
    normalizeQueryEnum(predicate, GRAPH_PREDICATES, "query predicate")
  );
  if (new Set(predicates).size !== predicates.length) {
    invalidQuery("query.predicates must not contain duplicates");
  }
  const rawClasses = dataValue(record, "epistemicClasses");
  const normalizedRawClasses = rawClasses === undefined
    ? undefined
    : queryDataArray(
      rawClasses,
      "query.epistemicClasses",
      GRAPH_EPISTEMIC_CLASSES.length
    );
  const epistemicClasses = rawClasses === undefined
    ? undefined
    : normalizedRawClasses && normalizedRawClasses.length > 0
      ? normalizedRawClasses.map((epistemicClass) =>
        normalizeQueryEnum(
          epistemicClass,
          GRAPH_EPISTEMIC_CLASSES,
          "query epistemic class"
        )
      )
      : invalidQuery("query.epistemicClasses must be a non-empty array when supplied");
  if (epistemicClasses && new Set(epistemicClasses).size !== epistemicClasses.length) {
    invalidQuery("query.epistemicClasses must not contain duplicates");
  }
  const includeSuperseded = dataValue(record, "includeSuperseded");
  if (includeSuperseded !== undefined && typeof includeSuperseded !== "boolean") {
    invalidQuery("query.includeSuperseded must be boolean");
  }
  const validAt = record.keys.includes("validAt")
    ? queryInstant(dataValue(record, "validAt"), "query.validAt")
    : undefined;
  const recordedAtOrBefore = record.keys.includes("recordedAtOrBefore")
    ? queryInstant(dataValue(record, "recordedAtOrBefore"), "query.recordedAtOrBefore")
    : undefined;
  const maxAssertions = boundedInteger(
    dataValue(record, "maxAssertions"),
    "query.maxAssertions",
    1,
    MAX_GRAPH_QUERY_ASSERTIONS
  );
  const maxConsideredAssertions = boundedInteger(
    dataValue(record, "maxConsideredAssertions"),
    "query.maxConsideredAssertions",
    1,
    MAX_GRAPH_QUERY_CONSIDERED_ASSERTIONS
  );
  const maxVisitedRefs = boundedInteger(
    dataValue(record, "maxVisitedRefs"),
    "query.maxVisitedRefs",
    1,
    MAX_GRAPH_QUERY_VISITED_REFS
  );
  if (maxConsideredAssertions < maxAssertions) {
    invalidQuery("query.maxConsideredAssertions must be at least maxAssertions");
  }
  if (maxVisitedRefs < seeds.length) {
    invalidQuery("query.maxVisitedRefs must be at least the exact seed count");
  }
  return Object.freeze({
    seeds: Object.freeze(seeds),
    predicates: Object.freeze(predicates),
    direction: normalizeQueryEnum(
      dataValue(record, "direction"),
      GRAPH_DIRECTIONS,
      "query.direction"
    ) as GraphDirection,
    maxDepth: boundedInteger(
      dataValue(record, "maxDepth"),
      "query.maxDepth",
      0,
      MAX_GRAPH_QUERY_DEPTH
    ),
    maxAssertions,
    maxConsideredAssertions,
    maxVisitedRefs,
    ...(validAt ? { validAt } : {}),
    ...(recordedAtOrBefore ? { recordedAtOrBefore } : {}),
    ...(epistemicClasses ? { epistemicClasses: Object.freeze(epistemicClasses) } : {}),
    ...(includeSuperseded === true ? { includeSuperseded: true } : {})
  });
}

export function normalizeRecordedRange(value: GraphRecordedRange): GraphRecordedRange {
  const record = queryDataRecord(
    value,
    "recorded range",
    ["after", "through", "limit"],
    ["limit"]
  );
  const after = record.keys.includes("after")
    ? queryInstant(dataValue(record, "after"), "recorded range.after")
    : undefined;
  const through = record.keys.includes("through")
    ? queryInstant(dataValue(record, "through"), "recorded range.through")
    : undefined;
  if (after && through && instantEpoch(after) >= instantEpoch(through)) {
    invalidQuery("recorded range.through must be later than after");
  }
  return Object.freeze({
    ...(after ? { after } : {}),
    ...(through ? { through } : {}),
    limit: boundedInteger(
      dataValue(record, "limit"),
      "recorded range.limit",
      1,
      MAX_GRAPH_QUERY_ASSERTIONS
    )
  });
}

export function normalizeForgetScope(value: GraphForgetScope): GraphForgetScope {
  try {
    const record = dataRecord(
      value,
      "forget scope",
      ["assertionIds", "graphRefs", "sourceRefs"],
      []
    );
    const assertionIds = record.keys.includes("assertionIds")
      ? normalizeTextArray(
        dataValue(record, "assertionIds"),
        "forget scope.assertionIds",
        MAX_GRAPH_QUERY_CONSIDERED_ASSERTIONS
      )
      : undefined;
    const rawGraphRefs = dataValue(record, "graphRefs");
    const graphRefs = rawGraphRefs === undefined
      ? undefined
      : dataArray(
        rawGraphRefs,
        "forget scope.graphRefs",
        MAX_GRAPH_QUERY_VISITED_REFS
      ).map((ref, index) =>
        normalizeGraphRef(ref, `forget scope.graphRefs[${index.toString()}]`)
      );
    const rawSourceRefs = dataValue(record, "sourceRefs");
    const sourceRefs = rawSourceRefs === undefined
      ? undefined
      : dataArray(
        rawSourceRefs,
        "forget scope.sourceRefs",
        MAX_GRAPH_QUERY_CONSIDERED_ASSERTIONS
      ).map((ref, index) =>
        normalizeEvidenceRef(ref, `forget scope.sourceRefs[${index.toString()}]`)
      );
    if (
      (assertionIds?.length ?? 0) === 0
      && (graphRefs?.length ?? 0) === 0
      && (sourceRefs?.length ?? 0) === 0
    ) {
      throw new AttuneGraphDataError(
        "INVALID_FORGET_SCOPE",
        "forget scope must name at least one assertion, graph ref, or source ref"
      );
    }
    return Object.freeze({
      ...(assertionIds ? { assertionIds: Object.freeze(assertionIds) } : {}),
      ...(graphRefs ? { graphRefs: Object.freeze(graphRefs) } : {}),
      ...(sourceRefs ? { sourceRefs: Object.freeze(sourceRefs) } : {})
    });
  } catch (cause) {
    if (cause instanceof AttuneGraphDataError && cause.code === "INVALID_ASSERTION") {
      throw new AttuneGraphDataError("INVALID_FORGET_SCOPE", cause.message);
    }
    throw cause;
  }
}

function normalizeTextArray(value: unknown, label: string, maxItems: number): string[] {
  const items = dataArray(value, label, maxItems).map((item, index) =>
    safeText(item, `${label}[${index.toString()}]`, MAX_ID_CHARACTERS)
  );
  if (new Set(items).size !== items.length) invalid(`${label} must not contain duplicates`);
  return items;
}
