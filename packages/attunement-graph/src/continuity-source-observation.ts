import {
  CONTINUITY_CHANGE_LIMITS
} from "./continuity-change-semantics.js";
import {
  ContinuityProjectionError,
  projectContinuityState,
  type ContinuityGraphProjection,
  type ContinuityProjectionInput
} from "./continuity-projection.js";
import {
  ContinuityChangeQueryError,
  continuityCanonicalInstant,
  continuityDataArray,
  continuityDataObject,
  inspectContinuityData,
  parseContinuityProjectionScope,
  queryError,
  type ContinuityDataInspection
} from "./continuity-change-primitives.js";

interface SourceAccounting extends ContinuityDataInspection {
  readonly sourceRecords: number;
}

export interface PreparedContinuitySourceObservation {
  readonly diagnostics: {
    readonly descriptorsInspected: number;
    readonly projectedAssertions: number;
    readonly sourceRecordsInspected: number;
    readonly stringBytesInspected: number;
  };
  readonly input: ContinuityProjectionInput;
  readonly projection: ContinuityGraphProjection;
}

function parseProjectionInput(
  value: unknown,
  label: string
): ContinuityProjectionInput {
  const record = continuityDataObject(value, label, [
    "scope",
    "sourceObservedAt",
    "state"
  ]);
  return Object.freeze({
    scope: parseContinuityProjectionScope(record.scope, `${label}.scope`),
    sourceObservedAt: continuityCanonicalInstant(
      record.sourceObservedAt,
      `${label}.sourceObservedAt`
    ),
    state: record.state
  });
}

function readField(value: unknown, key: string, label: string): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    queryError("INVALID_INPUT", `${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    queryError("INVALID_INPUT", `${label} must be a plain object`);
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !("value" in descriptor)) {
    queryError("INVALID_INPUT", `${label}.${key} must be a data property`);
  }
  return descriptor.value;
}

function countSource(
  input: ContinuityProjectionInput,
  label: string
): SourceAccounting {
  const inspection = inspectContinuityData(input.state, `${label}.state`);
  const state = continuityDataObject(
    input.state,
    `${label}.state`,
    [
      "deliveries",
      "experienceLearningPolicyAudits",
      "experienceLearningPromotionHandles",
      "interactionReceipts",
      "nextPolicyVersion",
      "resetReceipts",
      "schemaVersion",
      "threads",
      "undoResetReceipts"
    ],
    [
      "deliveries",
      "interactionReceipts",
      "nextPolicyVersion",
      "resetReceipts",
      "schemaVersion",
      "threads",
      "undoResetReceipts"
    ]
  );
  const threads = continuityDataArray(state.threads, `${label}.state.threads`);
  const deliveries = continuityDataArray(
    state.deliveries,
    `${label}.state.deliveries`
  );
  const interactions = continuityDataArray(
    state.interactionReceipts,
    `${label}.state.interactionReceipts`
  );
  const policyAudits = state.experienceLearningPolicyAudits === undefined
    ? []
    : continuityDataArray(
      state.experienceLearningPolicyAudits,
      `${label}.state.experienceLearningPolicyAudits`
    );
  const promotionHandles = state.experienceLearningPromotionHandles === undefined
    ? []
    : continuityDataArray(
      state.experienceLearningPromotionHandles,
      `${label}.state.experienceLearningPromotionHandles`
    );
  const resets = continuityDataArray(
    state.resetReceipts,
    `${label}.state.resetReceipts`
  );
  const undos = continuityDataArray(
    state.undoResetReceipts,
    `${label}.state.undoResetReceipts`
  );
  let links = 0;
  let selectedLinks = 0;
  for (const [index, thread] of threads.entries()) {
    const threadLabel = `${label}.state.threads[${index.toString()}]`;
    const threadId = readField(thread, "id", threadLabel);
    const threadLinks = continuityDataArray(
      readField(thread, "links", threadLabel),
      `${threadLabel}.links`
    );
    links += threadLinks.length;
    if (threadId === input.scope.threadId) selectedLinks += threadLinks.length;
  }
  let evidenceRefs = 0;
  let selectedDeliveries = 0;
  let selectedEvidenceRefs = 0;
  for (const [index, delivery] of deliveries.entries()) {
    const deliveryLabel = `${label}.state.deliveries[${index.toString()}]`;
    const deliveryThread = readField(delivery, "threadId", deliveryLabel);
    const refs = continuityDataArray(
      readField(delivery, "evidenceRefs", deliveryLabel),
      `${deliveryLabel}.evidenceRefs`
    );
    evidenceRefs += refs.length;
    if (deliveryThread === input.scope.threadId) {
      selectedDeliveries += 1;
      selectedEvidenceRefs += refs.length;
    }
  }
  const selectedInteractions = interactions.filter((item, index) =>
    readField(
      item,
      "threadId",
      `${label}.state.interactionReceipts[${index.toString()}]`
    ) === input.scope.threadId
  ).length;
  const selectedResets = resets.filter((item, index) =>
    readField(
      item,
      "threadId",
      `${label}.state.resetReceipts[${index.toString()}]`
    ) === input.scope.threadId
  ).length;
  const selectedUndos = undos.filter((item, index) =>
    readField(
      item,
      "threadId",
      `${label}.state.undoResetReceipts[${index.toString()}]`
    ) === input.scope.threadId
  ).length;
  const sourceRecords =
    threads.length
    + links
    + deliveries.length
    + evidenceRefs
    + interactions.length
    + policyAudits.length
    + promotionHandles.length
    + resets.length
    + undos.length;
  const checks: readonly [number, number, string][] = [
    [threads.length, CONTINUITY_CHANGE_LIMITS.maxThreads, "threads"],
    [links, CONTINUITY_CHANGE_LIMITS.maxLinks, "links"],
    [deliveries.length, CONTINUITY_CHANGE_LIMITS.maxSourceDeliveries, "deliveries"],
    [evidenceRefs, CONTINUITY_CHANGE_LIMITS.maxEvidenceRefs, "evidence refs"],
    [interactions.length, CONTINUITY_CHANGE_LIMITS.maxInteractions, "interactions"],
    [resets.length, CONTINUITY_CHANGE_LIMITS.maxResets, "resets"],
    [undos.length, CONTINUITY_CHANGE_LIMITS.maxUndos, "undos"],
    [sourceRecords, CONTINUITY_CHANGE_LIMITS.maxSourceRecords, "source records"],
    [selectedLinks, CONTINUITY_CHANGE_LIMITS.maxSelectedLinks, "selected links"],
    [
      selectedDeliveries,
      CONTINUITY_CHANGE_LIMITS.maxSelectedDeliveries,
      "selected deliveries"
    ],
    [
      selectedEvidenceRefs,
      CONTINUITY_CHANGE_LIMITS.maxSelectedEvidenceRefs,
      "selected evidence refs"
    ],
    [
      selectedInteractions,
      CONTINUITY_CHANGE_LIMITS.maxSelectedInteractions,
      "selected interactions"
    ],
    [selectedResets, CONTINUITY_CHANGE_LIMITS.maxSelectedResets, "selected resets"],
    [selectedUndos, CONTINUITY_CHANGE_LIMITS.maxSelectedUndos, "selected undos"]
  ];
  for (const [actual, limit, name] of checks) {
    if (actual > limit) {
      queryError("SOURCE_BUDGET_EXCEEDED", `${label} exceeds ${name} budget`, {
        actual,
        limit
      });
    }
  }
  return Object.freeze({ ...inspection, sourceRecords });
}

function project(
  input: ContinuityProjectionInput,
  accounting: SourceAccounting
): Omit<PreparedContinuitySourceObservation, "input"> {
  try {
    const projection = projectContinuityState(input);
    if (
      projection.assertions.length
      > CONTINUITY_CHANGE_LIMITS.maxProjectionAssertions
    ) {
      queryError("SOURCE_BUDGET_EXCEEDED", "projection exceeds query budget", {
        actual: projection.assertions.length,
        limit: CONTINUITY_CHANGE_LIMITS.maxProjectionAssertions
      });
    }
    return Object.freeze({
      diagnostics: Object.freeze({
        descriptorsInspected: accounting.descriptors,
        projectedAssertions: projection.assertions.length,
        sourceRecordsInspected: accounting.sourceRecords,
        stringBytesInspected: accounting.stringBytes
      }),
      projection
    });
  } catch (cause) {
    if (cause instanceof ContinuityChangeQueryError) throw cause;
    if (cause instanceof ContinuityProjectionError) {
      if (cause.code === "PROJECTION_LIMIT") {
        queryError("SOURCE_BUDGET_EXCEEDED", cause.message, {
          causeCode: cause.code
        });
      }
      queryError("INVALID_INPUT", cause.message, { causeCode: cause.code });
    }
    throw cause;
  }
}

export function prepareContinuitySourceObservation(
  value: unknown,
  label: string
): PreparedContinuitySourceObservation {
  const input = parseProjectionInput(value, label);
  let prepared: Omit<PreparedContinuitySourceObservation, "input"> | undefined;
  // Keep envelope parsing eager but materialize source truth only after a caller has
  // validated relationships between observations (scope, interval, boundary). The
  // memoized getters preserve that public error precedence and still project once.
  const materialize = (): Omit<PreparedContinuitySourceObservation, "input"> => {
    prepared ??= project(input, countSource(input, label));
    return prepared;
  };
  return Object.freeze({
    get diagnostics() {
      return materialize().diagnostics;
    },
    input,
    get projection() {
      return materialize().projection;
    }
  });
}
