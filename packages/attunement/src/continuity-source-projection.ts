import { fingerprintContinuityTaskState } from "./interaction-evidence.js";
import {
  ARTIFACT_ROLES,
  ARTIFACT_TYPES,
  DETAIL_LEVELS,
  NEXT_STEP_PRESENTATIONS,
  OUTCOMES,
  SUPPRESSION_MODES,
  THREAD_KINDS,
  isCoherentArtifactProvider,
  type ArtifactReference,
  type ArtifactType,
  type ContinuityEvidence,
  type ContinuityOutcome,
  type ContinuityPolicy,
  type PersonalThread,
  type ResolvedArtifact
} from "./types.js";

export const CONTINUITY_SOURCE_PROJECTION_LIMITS = Object.freeze({
  maxAggregateStringBytes: 1_048_576,
  maxDescriptors: 4_096,
  maxEvidence: 128,
  maxNestingDepth: 12,
  maxSerializedBytes: 1_048_576,
  maxSetItems: 64,
  maxStringBytes: 16_384
});

export type ContinuitySourceProjectionErrorCode =
  | "INVALID_PACK"
  | "BUDGET_EXCEEDED";

export class ContinuitySourceProjectionError extends Error {
  readonly code: ContinuitySourceProjectionErrorCode;
  readonly details: Readonly<Record<string, number | string>>;

  constructor(
    code: ContinuitySourceProjectionErrorCode,
    message: string,
    details: Readonly<Record<string, number | string>> = {}
  ) {
    super(message);
    this.name = "ContinuitySourceProjectionError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

export interface ContinuitySourceProjection {
  readonly deliveryPolicyVersion: number;
  readonly evidence: readonly ContinuityEvidence[];
  readonly nextStep?: ResolvedArtifact;
  readonly policy: ContinuityPolicy;
  readonly previousOutcome?: ContinuityOutcome;
  readonly schemaVersion: 1;
  readonly thread: Pick<PersonalThread, "id" | "kind" | "title">;
}

interface InspectionBudget {
  descriptors: number;
  stringBytes: number;
}

const COMMON_ARTIFACT_FIELDS = [
  "artifactId",
  "artifactType",
  "providerId",
  "role",
  "summary",
  "title",
  "updatedAt"
] as const;

const TYPE_ARTIFACT_FIELDS = {
  "browsing-visit": ["browsingUrl", "browsingVisitedAt"],
  "calendar-event": [
    "calendarAllDay",
    "calendarEndsAt",
    "calendarLocation",
    "calendarStartsAt",
    "calendarTimeState"
  ],
  checkpoint: ["checkpointPhase", "checkpointRecordedAt", "checkpointStep"],
  contact: ["contactBirthday", "contactRelationship"],
  conversation: [
    "conversationLastOwnerPrompt",
    "conversationOrigin",
    "conversationUpdatedAt"
  ],
  note: [],
  reminder: ["reminderDueAt", "reminderDueState", "reminderStatus"],
  resource: [],
  run: ["runOutcome", "runRecordedAt", "runSuccess", "runToolNames"],
  task: ["taskDueAt", "taskDueState", "taskStatus", "taskTags"],
  work: [
    "workBoardTaskCount",
    "workFlowCount",
    "workOutcomeCount",
    "workStatus",
    "workUpdatedAt"
  ]
} as const satisfies Record<ArtifactType, readonly string[]>;

const ARTIFACT_FIELD_ORDER = [
  ...COMMON_ARTIFACT_FIELDS,
  "browsingUrl",
  "browsingVisitedAt",
  "calendarAllDay",
  "calendarEndsAt",
  "calendarLocation",
  "calendarStartsAt",
  "calendarTimeState",
  "checkpointPhase",
  "checkpointRecordedAt",
  "checkpointStep",
  "contactBirthday",
  "contactRelationship",
  "conversationLastOwnerPrompt",
  "conversationOrigin",
  "conversationUpdatedAt",
  "reminderDueAt",
  "reminderDueState",
  "reminderStatus",
  "runOutcome",
  "runRecordedAt",
  "runSuccess",
  "runToolNames",
  "taskDueAt",
  "taskDueState",
  "taskStatus",
  "taskTags",
  "workBoardTaskCount",
  "workFlowCount",
  "workOutcomeCount",
  "workStatus",
  "workUpdatedAt"
] as const;

function fail(
  code: ContinuitySourceProjectionErrorCode,
  message: string,
  details: Readonly<Record<string, number | string>> = {}
): never {
  throw new ContinuitySourceProjectionError(code, message, details);
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function clonePlainData(value: unknown, label: string): unknown {
  const budget: InspectionBudget = { descriptors: 0, stringBytes: 0 };
  const active = new WeakSet<object>();

  const countString = (text: string): void => {
    const bytes = utf8Bytes(text);
    if (bytes > CONTINUITY_SOURCE_PROJECTION_LIMITS.maxStringBytes) {
      fail("BUDGET_EXCEEDED", `${label} contains an oversized string`, {
        bytes,
        limit: CONTINUITY_SOURCE_PROJECTION_LIMITS.maxStringBytes
      });
    }
    budget.stringBytes += bytes;
    if (
      budget.stringBytes
      > CONTINUITY_SOURCE_PROJECTION_LIMITS.maxAggregateStringBytes
    ) {
      fail("BUDGET_EXCEEDED", `${label} exceeds its string-byte budget`, {
        bytes: budget.stringBytes,
        limit: CONTINUITY_SOURCE_PROJECTION_LIMITS.maxAggregateStringBytes
      });
    }
  };

  const visit = (current: unknown, depth: number): unknown => {
    if (depth > CONTINUITY_SOURCE_PROJECTION_LIMITS.maxNestingDepth) {
      fail("BUDGET_EXCEEDED", `${label} exceeds its nesting budget`, {
        depth,
        limit: CONTINUITY_SOURCE_PROJECTION_LIMITS.maxNestingDepth
      });
    }
    if (typeof current === "string") {
      countString(current);
      return current;
    }
    if (
      current === null
      || typeof current === "boolean"
      || (typeof current === "number" && Number.isFinite(current))
    ) {
      return current;
    }
    if (typeof current !== "object") {
      fail("INVALID_PACK", `${label} must contain only JSON-compatible plain data`);
    }
    if (active.has(current)) {
      fail("INVALID_PACK", `${label} must not contain cycles`);
    }
    const prototype = Object.getPrototypeOf(current);
    if (
      Array.isArray(current)
        ? prototype !== Array.prototype
        : prototype !== Object.prototype && prototype !== null
    ) {
      fail("INVALID_PACK", `${label} must contain only plain objects and arrays`);
    }
    active.add(current);
    const descriptors = Object.getOwnPropertyDescriptors(current);
    const ownKeys = Reflect.ownKeys(current);
    budget.descriptors += ownKeys.length;
    if (
      budget.descriptors
      > CONTINUITY_SOURCE_PROJECTION_LIMITS.maxDescriptors
    ) {
      fail("BUDGET_EXCEEDED", `${label} exceeds its descriptor budget`, {
        descriptors: budget.descriptors,
        limit: CONTINUITY_SOURCE_PROJECTION_LIMITS.maxDescriptors
      });
    }
    if (ownKeys.some((key) => typeof key !== "string")) {
      fail("INVALID_PACK", `${label} must not contain symbol properties`);
    }

    if (Array.isArray(current)) {
      const length = descriptors.length?.value;
      if (!Number.isSafeInteger(length) || (length as number) < 0) {
        fail("INVALID_PACK", `${label} contains an invalid array`);
      }
      const allowed = new Set(["length"]);
      const output: unknown[] = [];
      for (let index = 0; index < (length as number); index += 1) {
        const key = index.toString();
        allowed.add(key);
        const descriptor = descriptors[key];
        if (!descriptor || !("value" in descriptor)) {
          fail("INVALID_PACK", `${label} arrays must be dense data arrays`);
        }
        output.push(visit(descriptor.value, depth + 1));
      }
      if ((ownKeys as string[]).some((key) => !allowed.has(key))) {
        fail("INVALID_PACK", `${label} arrays must not contain extra properties`);
      }
      active.delete(current);
      return Object.freeze(output);
    }

    const output: Record<string, unknown> = Object.create(null);
    for (const key of ownKeys as string[]) {
      countString(key);
      const descriptor = descriptors[key];
      if (!descriptor || !("value" in descriptor)) {
        fail("INVALID_PACK", `${label} must contain only data properties`);
      }
      output[key] = visit(descriptor.value, depth + 1);
    }
    active.delete(current);
    return Object.freeze(output);
  };

  const cloned = visit(value, 0);
  const bytes = utf8Bytes(JSON.stringify(cloned));
  if (bytes > CONTINUITY_SOURCE_PROJECTION_LIMITS.maxSerializedBytes) {
    fail("BUDGET_EXCEEDED", `${label} exceeds its serialized-byte budget`, {
      bytes,
      limit: CONTINUITY_SOURCE_PROJECTION_LIMITS.maxSerializedBytes
    });
  }
  return cloned;
}

function dataRecord(
  value: unknown,
  label: string,
  allowed: readonly string[],
  required: readonly string[]
): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("INVALID_PACK", `${label} must be an object`);
  }
  const record = value as Readonly<Record<string, unknown>>;
  const keys = Object.keys(record);
  if (keys.some((key) => !allowed.includes(key))) {
    fail("INVALID_PACK", `${label} contains an unknown field`);
  }
  if (required.some((key) => !keys.includes(key))) {
    fail("INVALID_PACK", `${label} is missing a required field`);
  }
  return record;
}

function dataArray(
  value: unknown,
  label: string,
  maximum: number
): readonly unknown[] {
  if (!Array.isArray(value)) {
    fail("INVALID_PACK", `${label} must be an array`);
  }
  if (value.length > maximum) {
    fail("BUDGET_EXCEEDED", `${label} exceeds its item budget`, {
      items: value.length,
      limit: maximum
    });
  }
  return value;
}

function text(value: unknown, label: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    fail("INVALID_PACK", `${label} must be a bounded string`);
  }
  return value;
}

function oneOf<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  label: string
): T[number] {
  if (typeof value !== "string" || !allowed.includes(value as T[number])) {
    fail("INVALID_PACK", `${label} is not supported`);
  }
  return value as T[number];
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    fail("INVALID_PACK", `${label} must be a non-negative safe integer`);
  }
  return value as number;
}

function semanticInstant(value: unknown, label: string): string {
  if (typeof value !== "string") {
    fail("INVALID_PACK", `${label} must be a parseable instant`);
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    fail("INVALID_PACK", `${label} must be a parseable instant`);
  }
  return parsed.toISOString();
}

function absoluteHttpUrl(value: unknown, label: string): string {
  const raw = text(value, label);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    fail("INVALID_PACK", `${label} must be an absolute HTTP(S) URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    fail("INVALID_PACK", `${label} must be an absolute HTTP(S) URL`);
  }
  return raw;
}

function normalizedSet(
  value: unknown,
  label: string
): readonly string[] {
  const values = dataArray(
    value,
    label,
    CONTINUITY_SOURCE_PROJECTION_LIMITS.maxSetItems
  ).map((item, index) => text(item, `${label}[${index.toString()}]`));
  return Object.freeze([...new Set(values)].sort());
}

function referenceKey(reference: ArtifactReference): string {
  return JSON.stringify([
    reference.artifactId,
    reference.artifactType,
    reference.providerId,
    reference.role
  ]);
}

function parseReferenceFields(
  record: Readonly<Record<string, unknown>>,
  label: string
): ArtifactReference {
  const artifactType = oneOf(record.artifactType, ARTIFACT_TYPES, `${label}.artifactType`);
  const providerId = text(record.providerId, `${label}.providerId`);
  const role = oneOf(record.role, ARTIFACT_ROLES, `${label}.role`);
  if (!isCoherentArtifactProvider(artifactType, providerId)) {
    fail("INVALID_PACK", `${label} provider is incoherent with its artifact type`);
  }
  if (artifactType !== "task" && role !== "context") {
    fail("INVALID_PACK", `${label} only tasks may be next-step artifacts`);
  }
  return Object.freeze({
    artifactId: text(record.artifactId, `${label}.artifactId`),
    artifactType,
    providerId,
    role
  });
}

function parseReference(value: unknown, label: string): ArtifactReference {
  return parseReferenceFields(
    dataRecord(
      value,
      label,
      ["artifactId", "artifactType", "providerId", "role"],
      ["artifactId", "artifactType", "providerId", "role"]
    ),
    label
  );
}

function parseArtifact(value: unknown, label: string): ResolvedArtifact {
  const base = dataRecord(
    value,
    label,
    ARTIFACT_FIELD_ORDER,
    ["artifactId", "artifactType", "providerId", "role", "title"]
  );
  const artifactType = oneOf(
    base.artifactType,
    ARTIFACT_TYPES,
    `${label}.artifactType`
  );
  const allowed = new Set<string>([
    ...COMMON_ARTIFACT_FIELDS,
    ...TYPE_ARTIFACT_FIELDS[artifactType]
  ]);
  if (Object.keys(base).some((key) => !allowed.has(key))) {
    fail("INVALID_PACK", `${label} contains a field for another artifact type`);
  }
  const reference = parseReferenceFields(base, label);
  const output: Record<string, unknown> = {
    ...reference,
    title: text(base.title, `${label}.title`)
  };

  if (base.summary !== undefined) {
    output.summary = text(base.summary, `${label}.summary`, true);
  }
  if (base.updatedAt !== undefined) {
    output.updatedAt = text(base.updatedAt, `${label}.updatedAt`, true);
  }

  const copyInstant = (key: string): void => {
    if (base[key] !== undefined) {
      output[key] = semanticInstant(base[key], `${label}.${key}`);
    }
  };
  const copyText = (key: string): void => {
    if (base[key] !== undefined) {
      output[key] = text(base[key], `${label}.${key}`, true);
    }
  };
  const copyInteger = (key: string): void => {
    if (base[key] !== undefined) {
      output[key] = nonNegativeInteger(base[key], `${label}.${key}`);
    }
  };

  switch (artifactType) {
    case "task":
      copyInstant("taskDueAt");
      if (base.taskDueState !== undefined) {
        output.taskDueState = oneOf(
          base.taskDueState,
          ["due", "overdue"] as const,
          `${label}.taskDueState`
        );
      }
      if (base.taskStatus !== undefined) {
        output.taskStatus = oneOf(
          base.taskStatus,
          ["open", "done"] as const,
          `${label}.taskStatus`
        );
      }
      if (base.taskTags !== undefined) {
        output.taskTags = normalizedSet(base.taskTags, `${label}.taskTags`);
      }
      if (output.taskDueState !== undefined && output.taskDueAt === undefined) {
        fail("INVALID_PACK", `${label}.taskDueState requires taskDueAt`);
      }
      break;
    case "note":
    case "resource":
      break;
    case "reminder":
      copyInstant("reminderDueAt");
      if (base.reminderDueState !== undefined) {
        output.reminderDueState = oneOf(
          base.reminderDueState,
          ["due", "overdue"] as const,
          `${label}.reminderDueState`
        );
      }
      if (base.reminderStatus !== undefined) {
        output.reminderStatus = oneOf(
          base.reminderStatus,
          ["pending", "fired"] as const,
          `${label}.reminderStatus`
        );
      }
      if (
        output.reminderDueState !== undefined
        && (
          output.reminderDueAt === undefined
          || output.reminderStatus !== "pending"
        )
      ) {
        fail(
          "INVALID_PACK",
          `${label}.reminderDueState requires a pending reminder with reminderDueAt`
        );
      }
      break;
    case "calendar-event":
      if (base.calendarAllDay !== undefined) {
        if (typeof base.calendarAllDay !== "boolean") {
          fail("INVALID_PACK", `${label}.calendarAllDay must be boolean`);
        }
        output.calendarAllDay = base.calendarAllDay;
      }
      copyInstant("calendarStartsAt");
      copyInstant("calendarEndsAt");
      copyText("calendarLocation");
      if (base.calendarTimeState !== undefined) {
        output.calendarTimeState = oneOf(
          base.calendarTimeState,
          ["upcoming", "happening", "ended"] as const,
          `${label}.calendarTimeState`
        );
      }
      if (
        output.calendarStartsAt !== undefined
        && output.calendarEndsAt !== undefined
        && Date.parse(output.calendarEndsAt as string)
          < Date.parse(output.calendarStartsAt as string)
      ) {
        fail("INVALID_PACK", `${label} calendar end precedes its start`);
      }
      if (
        output.calendarTimeState !== undefined
        && (
          output.calendarStartsAt === undefined
          || output.calendarEndsAt === undefined
        )
      ) {
        fail(
          "INVALID_PACK",
          `${label}.calendarTimeState requires calendar start and end`
        );
      }
      break;
    case "contact":
      copyText("contactBirthday");
      copyText("contactRelationship");
      break;
    case "run":
      if (base.runOutcome !== undefined) {
        output.runOutcome = base.runOutcome === null
          ? null
          : oneOf(
            base.runOutcome,
            [
              "abstain",
              "grounded",
              "misgrounded",
              "contested",
              "ungrounded",
              "error"
            ] as const,
            `${label}.runOutcome`
          );
      }
      copyInstant("runRecordedAt");
      if (base.runSuccess !== undefined) {
        if (base.runSuccess !== null && typeof base.runSuccess !== "boolean") {
          fail("INVALID_PACK", `${label}.runSuccess must be boolean or null`);
        }
        output.runSuccess = base.runSuccess;
      }
      if (base.runToolNames !== undefined) {
        output.runToolNames = normalizedSet(
          base.runToolNames,
          `${label}.runToolNames`
        );
      }
      break;
    case "checkpoint":
      if (base.checkpointPhase !== undefined) {
        output.checkpointPhase = oneOf(
          base.checkpointPhase,
          ["start", "act", "failed", "complete"] as const,
          `${label}.checkpointPhase`
        );
      }
      copyInstant("checkpointRecordedAt");
      copyInteger("checkpointStep");
      break;
    case "browsing-visit":
      if (base.browsingUrl !== undefined) {
        output.browsingUrl = absoluteHttpUrl(
          base.browsingUrl,
          `${label}.browsingUrl`
        );
      }
      copyInstant("browsingVisitedAt");
      break;
    case "conversation":
      copyText("conversationLastOwnerPrompt");
      if (base.conversationOrigin !== undefined) {
        output.conversationOrigin = oneOf(
          base.conversationOrigin,
          ["cli", "web"] as const,
          `${label}.conversationOrigin`
        );
      }
      copyInstant("conversationUpdatedAt");
      break;
    case "work":
      copyInteger("workBoardTaskCount");
      copyInteger("workFlowCount");
      copyInteger("workOutcomeCount");
      if (base.workStatus !== undefined) {
        output.workStatus = oneOf(
          base.workStatus,
          ["active", "paused", "done"] as const,
          `${label}.workStatus`
        );
      }
      copyInstant("workUpdatedAt");
      break;
  }

  return Object.freeze(output) as unknown as ResolvedArtifact;
}

function parseEvidence(
  value: unknown,
  label: string
): ContinuityEvidence {
  const record = dataRecord(
    value,
    label,
    ["artifact", "reference", "status"],
    ["reference", "status"]
  );
  const reference = parseReference(record.reference, `${label}.reference`);
  const status = oneOf(
    record.status,
    ["available", "unavailable"] as const,
    `${label}.status`
  );
  if (status === "unavailable") {
    if (record.artifact !== undefined) {
      fail("INVALID_PACK", `${label} unavailable evidence must not contain an artifact`);
    }
    return Object.freeze({ reference, status });
  }
  if (record.artifact === undefined) {
    fail("INVALID_PACK", `${label} available evidence requires an artifact`);
  }
  const artifact = parseArtifact(record.artifact, `${label}.artifact`);
  if (referenceKey(reference) !== referenceKey(artifact)) {
    fail("INVALID_PACK", `${label} artifact does not match its exact reference`);
  }
  return Object.freeze({ artifact, reference, status });
}

function parsePolicy(
  value: unknown,
  label: string
): ContinuityPolicy {
  const record = dataRecord(
    value,
    label,
    ["detail", "nextStep", "suppression", "version"],
    ["detail", "nextStep", "suppression", "version"]
  );
  return Object.freeze({
    detail: oneOf(record.detail, DETAIL_LEVELS, `${label}.detail`),
    nextStep: oneOf(
      record.nextStep,
      NEXT_STEP_PRESENTATIONS,
      `${label}.nextStep`
    ),
    suppression: oneOf(
      record.suppression,
      SUPPRESSION_MODES,
      `${label}.suppression`
    ),
    version: nonNegativeInteger(record.version, `${label}.version`)
  });
}

function parseThread(
  value: unknown,
  label: string
): Pick<PersonalThread, "id" | "kind" | "title"> {
  const record = dataRecord(
    value,
    label,
    ["id", "kind", "title"],
    ["id", "kind", "title"]
  );
  return Object.freeze({
    id: text(record.id, `${label}.id`),
    kind: oneOf(record.kind, THREAD_KINDS, `${label}.kind`),
    title: text(record.title, `${label}.title`)
  });
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function parseInteractionAnchor(
  value: unknown,
  candidate: ResolvedArtifact | undefined,
  rawCandidate: Readonly<Record<string, unknown>> | undefined
): void {
  if (candidate === undefined) {
    if (value !== undefined) {
      fail("INVALID_PACK", "pack.interactionAnchor exists without an open next-step");
    }
    return;
  }
  const record = dataRecord(
    value,
    "pack.interactionAnchor",
    [
      "artifactId",
      "linkedAt",
      "observedStatus",
      "openStateFingerprint",
      "providerId",
      "role"
    ],
    [
      "artifactId",
      "linkedAt",
      "observedStatus",
      "openStateFingerprint",
      "providerId",
      "role"
    ]
  );
  if (
    record.artifactId !== candidate.artifactId
    || record.providerId !== "local"
    || record.role !== "next-step"
    || record.observedStatus !== "open"
  ) {
    fail("INVALID_PACK", "pack.interactionAnchor does not match its open next-step");
  }
  semanticInstant(record.linkedAt, "pack.interactionAnchor.linkedAt");
  const fingerprint = text(
    record.openStateFingerprint,
    "pack.interactionAnchor.openStateFingerprint"
  );
  const expected = fingerprintContinuityTaskState({
    artifactId: candidate.artifactId,
    status: "open",
    updatedAt: typeof rawCandidate?.updatedAt === "string"
      ? rawCandidate.updatedAt
      : ""
  });
  if (fingerprint !== expected) {
    fail("INVALID_PACK", "pack.interactionAnchor fingerprint does not match its task");
  }
}

interface ProjectionFoundation {
  readonly deliveryPolicyVersion: number;
  readonly evidence: readonly ContinuityEvidence[];
  readonly policy: ContinuityPolicy;
  readonly rawEvidence: readonly unknown[];
}

interface OpenNextStepCandidate {
  readonly artifact: ResolvedArtifact;
  readonly index: number;
}

function parseProjectionFoundation(
  record: Readonly<Record<string, unknown>>,
  label: string
): ProjectionFoundation {
  const policy = parsePolicy(record.policy, `${label}.policy`);
  const deliveryPolicyVersion = nonNegativeInteger(
    record.deliveryPolicyVersion,
    `${label}.deliveryPolicyVersion`
  );
  if (deliveryPolicyVersion !== policy.version) {
    fail(
      "INVALID_PACK",
      `${label} delivery policy version does not match its policy`
    );
  }

  const rawEvidence = dataArray(
    record.evidence,
    `${label}.evidence`,
    CONTINUITY_SOURCE_PROJECTION_LIMITS.maxEvidence
  );
  const evidence = Object.freeze(rawEvidence.map((entry, index) =>
    parseEvidence(entry, `${label}.evidence[${index.toString()}]`)
  ));
  return Object.freeze({
    deliveryPolicyVersion,
    evidence,
    policy,
    rawEvidence
  });
}

function assertUniqueEvidence(
  evidence: readonly ContinuityEvidence[],
  label: string
): void {
  const referenceKeys = evidence.map((entry) => referenceKey(entry.reference));
  if (new Set(referenceKeys).size !== referenceKeys.length) {
    fail("INVALID_PACK", `${label} evidence references must be unique`);
  }
}

function findOpenNextStepCandidate(
  evidence: readonly ContinuityEvidence[],
  label: string
): OpenNextStepCandidate | undefined {
  const candidates = evidence
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) =>
      entry.status === "available"
      && entry.artifact?.artifactType === "task"
      && entry.artifact.providerId === "local"
      && entry.artifact.role === "next-step"
      && entry.artifact.taskStatus === "open"
    );
  if (candidates.length > 1) {
    fail("INVALID_PACK", `${label} has more than one open next-step artifact`);
  }
  const candidate = candidates[0];
  return candidate?.entry.artifact
    ? Object.freeze({ artifact: candidate.entry.artifact, index: candidate.index })
    : undefined;
}

function finishProjection(
  record: Readonly<Record<string, unknown>>,
  foundation: ProjectionFoundation,
  candidate: OpenNextStepCandidate | undefined,
  label: string
): ContinuitySourceProjection {
  let nextStep: ResolvedArtifact | undefined;
  if (record.nextStep !== undefined) {
    nextStep = parseArtifact(record.nextStep, `${label}.nextStep`);
  }
  if (foundation.policy.nextStep === "hidden" || candidate === undefined) {
    if (nextStep !== undefined) {
      fail(
        "INVALID_PACK",
        `${label} exposes a next step forbidden by its policy or evidence`
      );
    }
  } else if (
    nextStep === undefined
    || !sameValue(nextStep, candidate.artifact)
  ) {
    fail(
      "INVALID_PACK",
      `${label}.nextStep does not match its open evidence artifact`
    );
  }

  const previousOutcome = record.previousOutcome === undefined
    ? undefined
    : oneOf(record.previousOutcome, OUTCOMES, `${label}.previousOutcome`);
  if (
    previousOutcome !== undefined
    && foundation.policy.suppression !== "acknowledge-previous"
  ) {
    fail(
      "INVALID_PACK",
      `${label}.previousOutcome is outside its suppression policy`
    );
  }

  const projection = Object.freeze({
    deliveryPolicyVersion: foundation.deliveryPolicyVersion,
    evidence: foundation.evidence,
    ...(nextStep ? { nextStep } : {}),
    policy: foundation.policy,
    ...(previousOutcome ? { previousOutcome } : {}),
    schemaVersion: 1 as const,
    thread: parseThread(record.thread, `${label}.thread`)
  });
  const bytes = utf8Bytes(JSON.stringify(projection));
  if (bytes > CONTINUITY_SOURCE_PROJECTION_LIMITS.maxSerializedBytes) {
    fail(
      "BUDGET_EXCEEDED",
      "continuity source projection exceeds its byte budget",
      {
        bytes,
        limit: CONTINUITY_SOURCE_PROJECTION_LIMITS.maxSerializedBytes
      }
    );
  }
  return projection;
}

/**
 * Internal receipt seam: normalize and revalidate one serialized Source
 * Projection without reconstructing Pack-only delivery evidence.
 */
export function parseContinuitySourceProjection(
  value: unknown
): ContinuitySourceProjection {
  const cloned = clonePlainData(value, "continuity source projection");
  const record = dataRecord(
    cloned,
    "projection",
    [
      "deliveryPolicyVersion",
      "evidence",
      "nextStep",
      "policy",
      "previousOutcome",
      "schemaVersion",
      "thread"
    ],
    [
      "deliveryPolicyVersion",
      "evidence",
      "policy",
      "schemaVersion",
      "thread"
    ]
  );
  if (record.schemaVersion !== 1) {
    fail("INVALID_PACK", "projection.schemaVersion must be 1");
  }
  const foundation = parseProjectionFoundation(record, "projection");
  assertUniqueEvidence(foundation.evidence, "projection");
  return finishProjection(
    record,
    foundation,
    findOpenNextStepCandidate(foundation.evidence, "projection"),
    "projection"
  );
}

export function projectContinuityPackSources(
  pack: unknown
): ContinuitySourceProjection {
  const cloned = clonePlainData(pack, "continuity pack");
  const record = dataRecord(
    cloned,
    "pack",
    [
      "deliveryPolicyVersion",
      "evidence",
      "evidenceRefs",
      "interactionAnchor",
      "nextStep",
      "policy",
      "previousOutcome",
      "thread"
    ],
    ["deliveryPolicyVersion", "evidence", "evidenceRefs", "policy", "thread"]
  );
  const foundation = parseProjectionFoundation(record, "pack");
  const evidenceRefs = dataArray(
    record.evidenceRefs,
    "pack.evidenceRefs",
    CONTINUITY_SOURCE_PROJECTION_LIMITS.maxEvidence
  ).map((entry, index) =>
    parseReference(entry, `pack.evidenceRefs[${index.toString()}]`)
  );
  if (
    evidenceRefs.length !== foundation.evidence.length
    || foundation.evidence.some((entry, index) =>
      referenceKey(entry.reference) !== referenceKey(evidenceRefs[index]!)
    )
  ) {
    fail("INVALID_PACK", "pack.evidenceRefs do not match evidence order");
  }
  assertUniqueEvidence(foundation.evidence, "pack");

  const candidate = findOpenNextStepCandidate(foundation.evidence, "pack");
  const rawCandidateValue = candidate
    ? dataRecord(
      dataRecord(
        foundation.rawEvidence[candidate.index],
        `pack.evidence[${candidate.index.toString()}]`,
        ["artifact", "reference", "status"],
        ["artifact", "reference", "status"]
      ).artifact,
      "pack open next-step artifact",
      ARTIFACT_FIELD_ORDER,
      ["artifactId", "artifactType", "providerId", "role", "title"]
    )
    : undefined;
  parseInteractionAnchor(
    record.interactionAnchor,
    candidate?.artifact,
    rawCandidateValue
  );
  return finishProjection(record, foundation, candidate, "pack");
}
