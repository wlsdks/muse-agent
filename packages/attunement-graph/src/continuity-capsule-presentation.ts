import { createHash } from "node:crypto";

import {
  ARTIFACT_ROLES,
  ARTIFACT_TYPES,
  isCoherentArtifactProvider,
  type ArtifactReference,
  type ContinuityEvidence
} from "@muse/attunement";
import type {
  ContinuityScopedSourceObservationReceipt
} from "@muse/attunement/continuity-source-observations";

import {
  CONTINUITY_CAPSULE_MANIFEST_LIMITS,
  ContinuityCapsuleManifestError,
  compileContinuityCapsuleContext,
  type CapsuleArtifactSnapshot,
  type ContinuityCapsuleContext,
  type ContinuityCapsulePreparedWork
} from "./continuity-capsule-manifest.js";
import type {
  ContinuityChangeAbstention,
  ContinuityChangeAbstentionCode,
  ContinuityChangeKind,
  ContinuityChangeStatus,
  ContinuityChangeTemporalBasis,
  ExplainedContinuityChange
} from "./continuity-change-contracts.js";
import type {
  ContinuityObservationReceipt
} from "./continuity-observation.js";
import {
  deriveContinuityArtifactGraphRef
} from "./continuity-projection-identity.js";
import type {
  GraphEpistemicClass,
  GraphEvidenceRef,
  GraphPredicate,
  GraphRef
} from "./types.js";

export const CONTINUITY_CAPSULE_PRESENTATION_FORMAT_VERSION =
  "muse.continuity-capsule-presentation.v1" as const;

export const CONTINUITY_CAPSULE_PRESENTATION_LIMITS = Object.freeze({
  maxAbstentions: 32,
  maxAggregateStringBytes: 262_144,
  maxArtifactSources: 64,
  maxChanges: 32,
  maxDescriptors: 16_384,
  maxGraphSources: 128,
  maxGraphSourcesPerChange: 4,
  maxNestingDepth: 12,
  maxPathAssertionIdsPerChange: 4,
  maxPresentationBytes: 131_072,
  maxSourceDisplayBytes: 16_384,
  maxTechnicalStringBytes: 16_384
});

const HASH_DOMAIN = "muse.attunement.continuity-capsule-presentation.v1\0";
const PRESENTATION_ID_PREFIX =
  "muse-continuity-capsule-presentation:v1:sha256:";
const PRESENTATION_ID_PLACEHOLDER =
  `${PRESENTATION_ID_PREFIX}${"0".repeat(64)}`;
const PRESENTATION_ID_PATTERN =
  /^muse-continuity-capsule-presentation:v1:sha256:[0-9a-f]{64}$/u;
const ARTIFACT_SOURCE_HASH_DOMAIN =
  "muse.attunement.capsule-artifact-source.v1\0";
const ARTIFACT_SOURCE_ID_PREFIX =
  "muse-capsule-artifact-source:v1:sha256:";
const ARTIFACT_SOURCE_ID_PATTERN =
  /^muse-capsule-artifact-source:v1:sha256:[0-9a-f]{64}$/u;
const GRAPH_SOURCE_HASH_DOMAIN =
  "muse.attunement.capsule-graph-source.v1\0";
const GRAPH_SOURCE_ID_PREFIX =
  "muse-capsule-graph-source:v1:sha256:";
const GRAPH_SOURCE_ID_PATTERN =
  /^muse-capsule-graph-source:v1:sha256:[0-9a-f]{64}$/u;
const SOURCE_RECEIPT_ID_PATTERN =
  /^muse-continuity-scoped-source-observation:v1:sha256:[0-9a-f]{64}$/u;
const GRAPH_RECEIPT_ID_PATTERN =
  /^muse-continuity-observation:v1:sha256:[0-9a-f]{64}$/u;
const MANIFEST_ID_PATTERN =
  /^muse-continuity-capsule-manifest:v2:sha256:[0-9a-f]{64}$/u;
const CHANGE_RESULT_ID_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const PREPARED_TITLE_CONTROL = /[\u0000-\u001F\u007F]/u;
const PREPARED_CONTENT_CONTROL =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u;

const FORBIDDEN_OWN_KEYS = new Set([
  "toolName",
  "arguments",
  "args",
  "effectId",
  "recipient",
  "approvalToken",
  "callback",
  "execute",
  "execution",
  "callable",
  "actionPayload"
]);

type CapsuleLocale = "en" | "ko";
type ArtifactObservation = "previous" | "current";
type DisplayBinding = "named-source" | "technical-reference-only";

type CapsuleChangeCategory =
  | "action"
  | "authority"
  | "context"
  | "correlation"
  | "delivery"
  | "derivation"
  | "link"
  | "next-step"
  | "observation"
  | "outcome"
  | "policy"
  | "revision"
  | "sequence"
  | "support";

interface CapsuleAttributedThread {
  readonly textOrigin: "source-receipt-snapshot";
  readonly id: string;
  readonly title: string;
}

interface CapsuleSystemCopy {
  readonly textOrigin: "deterministic-system-copy";
  readonly headline: string;
  readonly whyShown: string;
  readonly timingCaveat: string;
  readonly resumeHeading: string;
  readonly changeSummary: string;
  readonly currentNextStepHeading: string;
  readonly supportHeading: string;
  readonly preparedHeading: string;
  readonly sourceHeading: string;
  readonly privacyNotice: string;
  readonly actionBoundary: string;
}

interface CapsuleChangeSystemCopy {
  readonly textOrigin: "deterministic-system-copy";
  readonly relationLabel: string;
  readonly kindLabel: string;
  readonly temporalBasisLabel: string;
  readonly bindingLabel: string;
}

interface CapsuleAbstentionSystemCopy {
  readonly textOrigin: "deterministic-system-copy";
  readonly label: string;
}

interface CapsuleArtifactSource {
  readonly sourceKey: string;
  readonly textOrigin: "source-receipt-snapshot";
  readonly observation: ArtifactObservation;
  readonly reference: ArtifactReference;
  readonly status: "available" | "unavailable";
  readonly title?: string;
  readonly summary?: string;
}

interface CapsuleGraphSource {
  readonly sourceKey: string;
  readonly reference: GraphEvidenceRef;
}

interface CapsuleEndpointBinding {
  readonly endpoint: "subject" | "object";
  readonly sourceKeys: readonly string[];
}

interface CapsuleChangeRow {
  readonly assertionId: string;
  readonly replacedAssertionId?: string;
  readonly kind: ContinuityChangeKind;
  readonly predicate: GraphPredicate;
  readonly category: CapsuleChangeCategory;
  readonly temporalBasis: ContinuityChangeTemporalBasis;
  readonly epistemicClass: GraphEpistemicClass;
  readonly recordedAt: string;
  readonly displayBinding: DisplayBinding;
  readonly endpointBindings: readonly CapsuleEndpointBinding[];
  readonly pathAssertionIds: readonly string[];
  readonly graphSourceKeys: readonly string[];
  readonly graphSources: {
    readonly total: number;
    readonly displayed: number;
    readonly omitted: number;
  };
  readonly systemCopy: CapsuleChangeSystemCopy;
}

interface CapsuleAbstentionRow {
  readonly code: ContinuityChangeAbstentionCode;
  readonly global: boolean;
  readonly affectedCount: number;
  readonly affectedCountUnit: "assertions" | "candidates";
  readonly affectedAssertionIds: readonly string[];
  readonly systemCopy: CapsuleAbstentionSystemCopy;
}

interface CapsuleArtifactCandidate {
  readonly source: CapsuleArtifactSource;
  readonly graphRef: GraphRef;
}

interface GraphSourceSelection {
  readonly rowKeys: ReadonlyMap<string, readonly string[]>;
  readonly rowTotals: ReadonlyMap<string, number>;
  readonly total: number;
  readonly items: readonly CapsuleGraphSource[];
}

export type ContinuityCapsulePresentationErrorCode =
  | "INVALID_INPUT"
  | "INVALID_PRESENTATION"
  | "INVALID_DEPENDENCY"
  | "DEPENDENCY_MISMATCH"
  | "MISSING_RESUME_EVIDENCE"
  | "BUDGET_EXCEEDED"
  | "INTEGRITY_MISMATCH";

export class ContinuityCapsulePresentationError extends Error {
  readonly code: ContinuityCapsulePresentationErrorCode;
  readonly details: Readonly<Record<string, number | string>>;

  constructor(
    code: ContinuityCapsulePresentationErrorCode,
    message: string,
    details: Readonly<Record<string, number | string>> = {}
  ) {
    super(message);
    this.name = "ContinuityCapsulePresentationError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

export interface ContinuityCapsulePresentationInput {
  readonly schemaVersion: 1;
  readonly locale: CapsuleLocale;
  readonly invocation: {
    readonly authority: "caller-declared-owner-request";
  };
  readonly previousSourceObservationReceipt: ContinuityScopedSourceObservationReceipt;
  readonly previousGraphObservationReceipt: ContinuityObservationReceipt;
  readonly currentSourceObservationReceipt: ContinuityScopedSourceObservationReceipt;
  readonly currentGraphObservationReceipt: ContinuityObservationReceipt;
  readonly preparation: {
    readonly preparedAt: string;
    readonly supportingEvidenceRefs: readonly ArtifactReference[];
    readonly preparedWork: ContinuityCapsulePreparedWork;
  };
}

export interface ContinuityCapsulePresentation {
  readonly schemaVersion: 1;
  readonly formatVersion: typeof CONTINUITY_CAPSULE_PRESENTATION_FORMAT_VERSION;
  readonly locale: CapsuleLocale;
  readonly verification: "canonical-self-consistency";
  readonly authority: {
    readonly invocation: "caller-declared-owner-request";
    readonly automaticTiming: "not-performed";
    readonly observation: "caller-declared-observation";
    readonly preparation: "caller-declared-preparation";
    readonly sourceFreshness: "not-proven";
    readonly authenticatedWitness: "not-proven";
  };
  readonly thread: CapsuleAttributedThread;
  readonly systemCopy: CapsuleSystemCopy;
  readonly resume: {
    readonly observedAt: string;
    readonly previousNextStepSourceKey: string;
    readonly currentAvailability: "available" | "unavailable";
  };
  readonly changeSummary: {
    readonly status: ContinuityChangeStatus;
    readonly candidateCount: number;
    readonly answeredCount: number;
    readonly totalChanges: number;
    readonly namedChanges: number;
    readonly technicalOnlyChanges: number;
    readonly abstentionCount: number;
  };
  readonly changes: readonly CapsuleChangeRow[];
  readonly abstentions: readonly CapsuleAbstentionRow[];
  readonly currentNextStepSourceKey: string;
  readonly supportingEvidenceSourceKeys: readonly string[];
  readonly preparedWork: {
    readonly textOrigin: "caller-declared-preparation";
    readonly kind: "draft" | "action-preview";
    readonly actionMode: "display-only" | "requires-new-approval";
    readonly title: string;
    readonly content: string;
    readonly expectedMinutes: number;
  };
  readonly sourceDrawer: {
    readonly dataClass: "local-personal-linkable";
    readonly telemetrySafe: false;
    readonly previousObservedAt: string;
    readonly currentObservedAt: string;
    readonly preparedAt: string;
    readonly previousSourceObservationReceiptId: string;
    readonly previousGraphObservationReceiptId: string;
    readonly currentSourceObservationReceiptId: string;
    readonly currentGraphObservationReceiptId: string;
    readonly manifestId: string;
    readonly changeResultId: string;
    readonly artifactSources: readonly CapsuleArtifactSource[];
    readonly graphSources: {
      readonly total: number;
      readonly displayed: number;
      readonly omitted: number;
      readonly items: readonly CapsuleGraphSource[];
    };
  };
  readonly presentationId: string;
}

type PresentationBody = Omit<ContinuityCapsulePresentation, "presentationId">;
type InvalidPresentationCode = "INVALID_INPUT" | "INVALID_PRESENTATION";

const COPY = Object.freeze({
  en: Object.freeze({
    headline: "Continuity Capsule",
    whyShown: "Shown because the caller declared that you requested this Capsule.",
    timingCaveat: "Muse did not evaluate whether now was a good time.",
    resumeHeading: "Previously recorded next step",
    currentNextStepHeading: "Current next step",
    supportHeading: "Supporting sources",
    preparedHeading: "Prepared work",
    sourceHeading: "Sources and integrity details",
    privacyNotice:
      "Local personal/linkable data. Not telemetry-safe. Source freshness and authenticated observation are not proven.",
    draftBoundary: "Display only. No action will run.",
    previewBoundary: "Preview only. Running it requires a new approval.",
    completeSummary: "All detected graph relation changes were explained.",
    partialSummary:
      "Some detected graph relation changes were explained; others remain unresolved.",
    noChangeSummary:
      "No graph relation changes were detected between these caller-declared observations.",
    abstainedSummary:
      "The graph comparison could not provide a complete change explanation.",
    namedBinding: "Named from an exact Source Receipt snapshot.",
    technicalBinding: "Technical relation only; no exact display name was available."
  }),
  ko: Object.freeze({
    headline: "이어가기 캡슐",
    whyShown: "호출자가 사용자가 이 캡슐을 요청했다고 선언하여 표시됩니다.",
    timingCaveat: "Muse는 지금이 좋은 타이밍인지 평가하지 않았습니다.",
    resumeHeading: "이전에 기록된 다음 단계",
    currentNextStepHeading: "현재 다음 단계",
    supportHeading: "참고 출처",
    preparedHeading: "준비된 작업",
    sourceHeading: "출처 및 무결성 정보",
    privacyNotice:
      "로컬 개인·연결 가능 데이터입니다. 텔레메트리에 안전하지 않으며, 출처 최신성과 인증된 관찰은 증명되지 않았습니다.",
    draftBoundary: "표시 전용입니다. 어떤 행동도 실행되지 않습니다.",
    previewBoundary: "미리보기 전용입니다. 실행하려면 새로운 승인이 필요합니다.",
    completeSummary: "감지된 그래프 관계 변경을 모두 설명했습니다.",
    partialSummary:
      "감지된 그래프 관계 변경 일부를 설명했으며, 나머지는 아직 확인되지 않았습니다.",
    noChangeSummary:
      "호출자가 선언한 두 관찰 사이에서 그래프 관계 변경이 감지되지 않았습니다.",
    abstainedSummary: "그래프 비교가 완전한 변경 설명을 제공하지 못했습니다.",
    namedBinding: "정확한 Source Receipt 스냅샷에서 이름을 가져왔습니다.",
    technicalBinding: "기술적 관계만 확인되었으며 정확한 표시 이름은 없습니다."
  })
});

const STATUS_COPY_KEY = Object.freeze({
  complete: "completeSummary",
  partial: "partialSummary",
  "no-change": "noChangeSummary",
  abstained: "abstainedSummary"
} as const);

const CHANGE_KIND_COPY = Object.freeze({
  en: Object.freeze({ added: "Added", revised: "Revised" }),
  ko: Object.freeze({ added: "추가됨", revised: "수정됨" })
});

const TEMPORAL_COPY = Object.freeze({
  en: Object.freeze({
    "world-valid": "Changed in the user's world",
    "learned-after": "Learned after the previous observation"
  }),
  ko: Object.freeze({
    "world-valid": "사용자 환경에서 변경됨",
    "learned-after": "이전 관찰 후에 알게 됨"
  })
});

const PREDICATE_COPY = Object.freeze({
  LINKED_TO: Object.freeze({
    category: "link",
    en: "A link relation changed.",
    ko: "연결 관계가 바뀌었습니다."
  }),
  NEXT_STEP_FOR: Object.freeze({
    category: "next-step",
    en: "A next-step relation changed.",
    ko: "다음 단계 관계가 바뀌었습니다."
  }),
  CONTEXT_FOR: Object.freeze({
    category: "context",
    en: "A context relation changed.",
    ko: "참고 맥락 관계가 바뀌었습니다."
  }),
  SUPPORTED_BY: Object.freeze({
    category: "support",
    en: "A support relation changed.",
    ko: "근거 관계가 바뀌었습니다."
  }),
  DERIVED_FROM: Object.freeze({
    category: "derivation",
    en: "A derivation relation changed.",
    ko: "파생 관계가 바뀌었습니다."
  }),
  REVISION_OF: Object.freeze({
    category: "revision",
    en: "A revision relation changed.",
    ko: "수정 관계가 바뀌었습니다."
  }),
  SUPERSEDES: Object.freeze({
    category: "revision",
    en: "A replacement relation changed.",
    ko: "대체 관계가 바뀌었습니다."
  }),
  OBSERVED_DURING: Object.freeze({
    category: "observation",
    en: "An observation-window relation changed.",
    ko: "관찰 구간 관계가 바뀌었습니다."
  }),
  DELIVERED_FOR: Object.freeze({
    category: "delivery",
    en: "A delivery relation changed.",
    ko: "전달 관계가 바뀌었습니다."
  }),
  PRODUCED_OUTCOME: Object.freeze({
    category: "outcome",
    en: "An explicit outcome relation changed.",
    ko: "명시적 결과 관계가 바뀌었습니다."
  }),
  PROPOSES_POLICY: Object.freeze({
    category: "policy",
    en: "A policy-proposal relation changed.",
    ko: "정책 제안 관계가 바뀌었습니다."
  }),
  SCOPED_TO: Object.freeze({
    category: "policy",
    en: "A policy-scope relation changed.",
    ko: "정책 범위 관계가 바뀌었습니다."
  }),
  GOVERNED_BY: Object.freeze({
    category: "policy",
    en: "A governing-policy relation changed.",
    ko: "적용 정책 관계가 바뀌었습니다."
  }),
  PRECEDED: Object.freeze({
    category: "sequence",
    en: "A sequence relation changed.",
    ko: "순서 관계가 바뀌었습니다."
  }),
  CORRELATES_WITH: Object.freeze({
    category: "correlation",
    en: "A correlation relation changed.",
    ko: "상관 관계가 바뀌었습니다."
  }),
  AUTHORIZED_BY: Object.freeze({
    category: "authority",
    en: "An authorization relation changed.",
    ko: "승인 관계가 바뀌었습니다."
  }),
  PERFORMED: Object.freeze({
    category: "action",
    en: "A performed-action relation changed.",
    ko: "실행된 행동 관계가 바뀌었습니다."
  })
} as const satisfies Record<
  GraphPredicate,
  { readonly category: CapsuleChangeCategory; readonly en: string; readonly ko: string }
>);

const ABSTENTION_COPY = Object.freeze({
  AMBIGUOUS_REVISION: Object.freeze({
    en: "Multiple valid revision pairings remained.",
    ko: "가능한 수정 연결이 여러 개 남았습니다."
  }),
  REMOVAL_TIME_UNKNOWN: Object.freeze({
    en: "A removal time was not evidenced.",
    ko: "삭제 시점을 뒷받침하는 근거가 없습니다."
  }),
  OUTSIDE_INTERVAL: Object.freeze({
    en: "A change fell outside the observation interval.",
    ko: "변경이 관찰 구간 밖에 있습니다."
  }),
  NO_PATH_WITHIN_DEPTH: Object.freeze({
    en: "No explanation path fit the traversal depth.",
    ko: "탐색 깊이 안에서 설명 경로를 찾지 못했습니다."
  }),
  INCONSISTENT_OBSERVATION: Object.freeze({
    en: "Observation timestamps conflict with assertion times.",
    ko: "관찰 시각과 관계 시각이 일치하지 않습니다."
  }),
  VISITED_REF_BUDGET_EXCEEDED: Object.freeze({
    en: "The explanation traversal reached its reference budget.",
    ko: "설명 탐색이 참조 예산에 도달했습니다."
  }),
  OUTPUT_BUDGET_EXCEEDED: Object.freeze({
    en: "The explanation output reached its change budget.",
    ko: "설명 출력이 변경 예산에 도달했습니다."
  })
} as const satisfies Record<
  ContinuityChangeAbstentionCode,
  { readonly en: string; readonly ko: string }
>);

function fail(
  code: ContinuityCapsulePresentationErrorCode,
  message: string,
  details: Readonly<Record<string, number | string>> = {}
): never {
  throw new ContinuityCapsulePresentationError(code, message, details);
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function freezeArray<T>(values: readonly T[]): readonly T[] {
  return Object.freeze([...values]);
}

function canonicalValue(value: unknown): unknown {
  if (
    value === null
    || typeof value === "string"
    || typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (Number.isFinite(value)) return value;
    throw new TypeError("canonical Capsule data contains a non-finite number");
  }
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort(compareCodeUnits)) {
      const child = (value as Record<string, unknown>)[key];
      if (child !== undefined) output[key] = canonicalValue(child);
    }
    return output;
  }
  throw new TypeError("canonical Capsule data contains an unsupported value");
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function digest(domain: string, material: string): string {
  return createHash("sha256")
    .update(domain, "utf8")
    .update(material, "utf8")
    .digest("hex");
}

function presentationId(body: PresentationBody): string {
  return `${PRESENTATION_ID_PREFIX}${digest(HASH_DOMAIN, canonicalJson(body))}`;
}

function artifactReferenceKey(reference: ArtifactReference): string {
  return canonicalJson([
    reference.artifactId,
    reference.artifactType,
    reference.providerId,
    reference.role
  ]);
}

function artifactTupleKey(
  observation: ArtifactObservation,
  reference: ArtifactReference
): string {
  return canonicalJson([observation, artifactReferenceKey(reference)]);
}

function artifactSourceKey(
  observation: ArtifactObservation,
  observedAt: string,
  reference: ArtifactReference
): string {
  const material = canonicalJson([
    observation,
    observedAt,
    reference.artifactId,
    reference.artifactType,
    reference.providerId,
    reference.role
  ]);
  return `${ARTIFACT_SOURCE_ID_PREFIX}${digest(
    ARTIFACT_SOURCE_HASH_DOMAIN,
    material
  )}`;
}

function graphReferenceKey(reference: GraphEvidenceRef): string {
  return canonicalJson([
    reference.namespace,
    reference.id,
    reference.version ?? null
  ]);
}

function graphSourceKey(reference: GraphEvidenceRef): string {
  return `${GRAPH_SOURCE_ID_PREFIX}${digest(
    GRAPH_SOURCE_HASH_DOMAIN,
    graphReferenceKey(reference)
  )}`;
}

function exactRecord(
  value: unknown,
  label: string,
  allowed: readonly string[],
  required: readonly string[],
  invalidCode: InvalidPresentationCode
): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(invalidCode, `${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail(invalidCode, `${label} must be a plain object`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== "string")) {
    fail(invalidCode, `${label} must not contain symbol properties`);
  }
  const keys = ownKeys as string[];
  if (
    keys.some((key) => !allowed.includes(key))
    || required.some((key) => !keys.includes(key))
  ) {
    fail(invalidCode, `${label} has missing or unknown fields`);
  }
  const output: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor || !("value" in descriptor)) {
      fail(invalidCode, `${label} must contain only data properties`);
    }
    output[key] = descriptor.value;
  }
  return Object.freeze(output);
}

function strictArray(
  value: unknown,
  label: string,
  invalidCode: InvalidPresentationCode
): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    fail(invalidCode, `${label} must be a dense plain array`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const length = Object.getOwnPropertyDescriptor(value, "length")?.value;
  if (!Number.isSafeInteger(length) || (length as number) < 0) {
    fail(invalidCode, `${label} has an invalid length`);
  }
  const output: unknown[] = [];
  const allowed = new Set(["length"]);
  for (let index = 0; index < (length as number); index += 1) {
    const key = index.toString();
    allowed.add(key);
    const descriptor = descriptors[key];
    if (!descriptor || !("value" in descriptor)) {
      fail(invalidCode, `${label} must be dense data`);
    }
    output.push(descriptor.value);
  }
  if (
    Reflect.ownKeys(value).some(
      (key) => typeof key !== "string" || !allowed.has(key)
    )
  ) {
    fail(invalidCode, `${label} has unknown properties`);
  }
  return freezeArray(output);
}

function requiredText(
  value: unknown,
  label: string,
  invalidCode: InvalidPresentationCode
): string {
  if (typeof value !== "string" || value.length === 0) {
    fail(invalidCode, `${label} must be non-empty text`);
  }
  return value;
}

function canonicalInstant(
  value: unknown,
  label: string,
  invalidCode: InvalidPresentationCode
): string {
  const text = requiredText(value, label, invalidCode);
  const instant = new Date(text);
  if (!Number.isFinite(instant.getTime()) || instant.toISOString() !== text) {
    fail(invalidCode, `${label} must be a canonical instant`);
  }
  return text;
}

function patternedText(
  value: unknown,
  label: string,
  pattern: RegExp
): string {
  const text = requiredText(value, label, "INVALID_PRESENTATION");
  if (!pattern.test(text)) {
    fail("INVALID_PRESENTATION", `${label} has an unsupported format`);
  }
  return text;
}

function safeInteger(
  value: unknown,
  label: string,
  invalidCode: InvalidPresentationCode
): number {
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value < 0
  ) {
    fail(invalidCode, `${label} must be a non-negative safe integer`);
  }
  return value;
}

function sourceFromSnapshot(
  observation: ArtifactObservation,
  observedAt: string,
  snapshot: CapsuleArtifactSnapshot
): CapsuleArtifactSource {
  const output: {
    sourceKey: string;
    textOrigin: "source-receipt-snapshot";
    observation: ArtifactObservation;
    reference: ArtifactReference;
    status: "available" | "unavailable";
    title?: string;
    summary?: string;
  } = {
    sourceKey: artifactSourceKey(observation, observedAt, snapshot.reference),
    textOrigin: "source-receipt-snapshot",
    observation,
    reference: snapshot.reference,
    status: snapshot.status
  };
  if (snapshot.title !== undefined) output.title = snapshot.title;
  if (snapshot.summary !== undefined) output.summary = snapshot.summary;
  return Object.freeze(output);
}

function sourceFromEvidence(
  observation: ArtifactObservation,
  receipt: ContinuityScopedSourceObservationReceipt,
  evidence: ContinuityEvidence
): CapsuleArtifactSource {
  const output: {
    sourceKey: string;
    textOrigin: "source-receipt-snapshot";
    observation: ArtifactObservation;
    reference: ArtifactReference;
    status: "available" | "unavailable";
    title?: string;
    summary?: string;
  } = {
    sourceKey: artifactSourceKey(
      observation,
      receipt.observation.observedAt,
      evidence.reference
    ),
    textOrigin: "source-receipt-snapshot",
    observation,
    reference: evidence.reference,
    status: evidence.status
  };
  if (evidence.status === "available" && evidence.artifact) {
    if (evidence.artifact.title !== undefined) {
      output.title = evidence.artifact.title;
    }
    if (evidence.artifact.summary !== undefined) {
      output.summary = evidence.artifact.summary;
    }
  }
  return Object.freeze(output);
}

function candidatesForReceipt(
  observation: ArtifactObservation,
  receipt: ContinuityScopedSourceObservationReceipt
): readonly CapsuleArtifactCandidate[] {
  return freezeArray(
    receipt.observation.projection.evidence
      .map((evidence) => {
        const source = sourceFromEvidence(observation, receipt, evidence);
        return Object.freeze({
          source,
          graphRef: deriveContinuityArtifactGraphRef(
            receipt.scope.sourceId,
            evidence.reference
          )
        });
      })
      .sort((left, right) =>
        compareCodeUnits(
          artifactReferenceKey(left.source.reference),
          artifactReferenceKey(right.source.reference)
        )
      )
  );
}

function pushUniqueArtifactSource(
  target: CapsuleArtifactSource[],
  seen: Set<string>,
  source: CapsuleArtifactSource
): void {
  const tuple = artifactTupleKey(source.observation, source.reference);
  if (seen.has(tuple)) return;
  if (target.length >= CONTINUITY_CAPSULE_PRESENTATION_LIMITS.maxArtifactSources) {
    return;
  }
  seen.add(tuple);
  target.push(source);
}

function exactGraphRef(left: GraphRef, right: GraphRef): boolean {
  return left.kind === right.kind && left.id === right.id;
}

function selectedArtifactSources(
  context: ContinuityCapsuleContext
): {
  readonly sources: readonly CapsuleArtifactSource[];
  readonly candidates: readonly CapsuleArtifactCandidate[];
  readonly previousNextStepSourceKey: string;
  readonly currentNextStepSourceKey: string;
  readonly supportingEvidenceSourceKeys: readonly string[];
} {
  const { manifest } = context.compilation;
  const sources: CapsuleArtifactSource[] = [];
  const seen = new Set<string>();
  const previousSource = sourceFromSnapshot(
    "previous",
    manifest.previousObservedAt,
    manifest.previousNextStep
  );
  const currentSource = sourceFromSnapshot(
    "current",
    manifest.currentObservedAt,
    manifest.currentNextStep
  );
  pushUniqueArtifactSource(sources, seen, previousSource);
  pushUniqueArtifactSource(sources, seen, currentSource);
  const supportKeys: string[] = [];
  for (const support of manifest.supportingEvidence) {
    const source = sourceFromSnapshot(
      "current",
      manifest.currentObservedAt,
      support
    );
    pushUniqueArtifactSource(sources, seen, source);
    supportKeys.push(source.sourceKey);
  }

  const candidates = freezeArray([
    ...candidatesForReceipt("previous", context.previousSource),
    ...candidatesForReceipt("current", context.currentSource)
  ]);
  for (const change of context.compilation.changeResult.changes) {
    for (const candidate of candidates) {
      if (
        exactGraphRef(candidate.graphRef, change.assertion.subject)
        || exactGraphRef(candidate.graphRef, change.assertion.object)
      ) {
        pushUniqueArtifactSource(sources, seen, candidate.source);
      }
    }
  }
  return Object.freeze({
    sources: freezeArray(sources),
    candidates,
    previousNextStepSourceKey: previousSource.sourceKey,
    currentNextStepSourceKey: currentSource.sourceKey,
    supportingEvidenceSourceKeys: freezeArray(
      [...new Set(supportKeys)].sort(compareCodeUnits)
    )
  });
}

function endpointBindings(
  assertion: ExplainedContinuityChange["assertion"],
  candidates: readonly CapsuleArtifactCandidate[],
  availableSourceKeys: ReadonlySet<string>
): readonly CapsuleEndpointBinding[] {
  const output: CapsuleEndpointBinding[] = [];
  for (const endpoint of ["subject", "object"] as const) {
    const graphRef = assertion[endpoint];
    const sourceKeys = [
      ...new Set(
        candidates
          .filter((candidate) => exactGraphRef(candidate.graphRef, graphRef))
          .map((candidate) => candidate.source.sourceKey)
          .filter((sourceKey) => availableSourceKeys.has(sourceKey))
      )
    ].sort(compareCodeUnits);
    if (sourceKeys.length > 0) {
      output.push(Object.freeze({
        endpoint,
        sourceKeys: freezeArray(sourceKeys)
      }));
    }
  }
  return freezeArray(output);
}

function allChangeGraphRefs(
  change: ExplainedContinuityChange
): readonly GraphEvidenceRef[] {
  const refs = [
    ...change.assertion.sourceRefs,
    ...change.path.flatMap((step) => step.sourceRefs)
  ];
  const byKey = new Map<string, GraphEvidenceRef>();
  for (const reference of refs) {
    byKey.set(graphReferenceKey(reference), reference);
  }
  return freezeArray(
    [...byKey.entries()]
      .sort(([left], [right]) => compareCodeUnits(left, right))
      .map(([, reference]) => reference)
  );
}

function graphSourceSelection(
  changes: readonly ExplainedContinuityChange[]
): GraphSourceSelection {
  const rowKeys = new Map<string, readonly string[]>();
  const rowTotals = new Map<string, number>();
  const globalByKey = new Map<string, GraphEvidenceRef>();
  const rowDisplayedKeys: string[] = [];

  for (const change of changes) {
    const refs = allChangeGraphRefs(change);
    if (
      refs.length
      > CONTINUITY_CAPSULE_PRESENTATION_LIMITS.maxGraphSourcesPerChange
    ) {
      fail(
        "BUDGET_EXCEEDED",
        "Capsule change graph sources exceed their item budget"
      );
    }
    for (const reference of refs) {
      globalByKey.set(graphReferenceKey(reference), reference);
    }
    const keys = freezeArray(refs.map(graphSourceKey));
    rowKeys.set(change.assertion.id, keys);
    rowTotals.set(change.assertion.id, refs.length);
    rowDisplayedKeys.push(...keys);
  }

  const referenceBySourceKey = new Map<string, GraphEvidenceRef>();
  for (const reference of globalByKey.values()) {
    referenceBySourceKey.set(graphSourceKey(reference), reference);
  }
  if (
    referenceBySourceKey.size
    > CONTINUITY_CAPSULE_PRESENTATION_LIMITS.maxGraphSources
  ) {
    fail(
      "BUDGET_EXCEEDED",
      "Capsule graph sources exceed their item budget"
    );
  }
  const selectedKeys: string[] = [];
  const selected = new Set<string>();
  for (const key of rowDisplayedKeys) {
    if (selected.has(key)) continue;
    selected.add(key);
    selectedKeys.push(key);
  }
  const globalKeys = [...referenceBySourceKey.keys()].sort(compareCodeUnits);
  for (const key of globalKeys) {
    if (selected.has(key)) {
      continue;
    }
    selected.add(key);
    selectedKeys.push(key);
  }
  return Object.freeze({
    rowKeys,
    rowTotals,
    total: globalByKey.size,
    items: freezeArray(
      selectedKeys.map((sourceKey) =>
        Object.freeze({
          sourceKey,
          reference: referenceBySourceKey.get(sourceKey)!
        })
      )
    )
  });
}

function isNamedBinding(
  bindings: readonly CapsuleEndpointBinding[],
  sourcesByKey: ReadonlyMap<string, CapsuleArtifactSource>
): boolean {
  return bindings.some((binding) =>
    binding.sourceKeys.some((key) => {
      const source = sourcesByKey.get(key);
      return source?.status === "available"
        && source.title !== undefined
        && source.title.length > 0;
    })
  );
}

function changeSystemCopy(
  locale: CapsuleLocale,
  change: ExplainedContinuityChange,
  binding: DisplayBinding
): CapsuleChangeSystemCopy {
  return Object.freeze({
    textOrigin: "deterministic-system-copy",
    relationLabel: PREDICATE_COPY[change.assertion.predicate][locale],
    kindLabel: CHANGE_KIND_COPY[locale][change.kind],
    temporalBasisLabel: TEMPORAL_COPY[locale][change.temporalBasis],
    bindingLabel:
      binding === "named-source"
        ? COPY[locale].namedBinding
        : COPY[locale].technicalBinding
  });
}

function changeRows(
  locale: CapsuleLocale,
  changes: readonly ExplainedContinuityChange[],
  artifactSources: readonly CapsuleArtifactSource[],
  candidates: readonly CapsuleArtifactCandidate[],
  graphSelection: GraphSourceSelection
): readonly CapsuleChangeRow[] {
  if (changes.length > CONTINUITY_CAPSULE_PRESENTATION_LIMITS.maxChanges) {
    fail("BUDGET_EXCEEDED", "Capsule changes exceed their item budget");
  }
  const sourceKeys = new Set(artifactSources.map((source) => source.sourceKey));
  const sourcesByKey = new Map(
    artifactSources.map((source) => [source.sourceKey, source] as const)
  );
  return freezeArray(changes.map((change) => {
    if (
      change.path.length
      > CONTINUITY_CAPSULE_PRESENTATION_LIMITS.maxPathAssertionIdsPerChange
    ) {
      fail("BUDGET_EXCEEDED", "Capsule path assertion IDs exceed their item budget");
    }
    const bindings = endpointBindings(
      change.assertion,
      candidates,
      sourceKeys
    );
    const displayBinding: DisplayBinding =
      isNamedBinding(bindings, sourcesByKey)
        ? "named-source"
        : "technical-reference-only";
    const keys = graphSelection.rowKeys.get(change.assertion.id) ?? [];
    const total = graphSelection.rowTotals.get(change.assertion.id) ?? 0;
    const body = {
      assertionId: change.assertion.id,
      ...(change.replacedAssertionId === undefined
        ? {}
        : { replacedAssertionId: change.replacedAssertionId }),
      kind: change.kind,
      predicate: change.assertion.predicate,
      category: PREDICATE_COPY[change.assertion.predicate].category,
      temporalBasis: change.temporalBasis,
      epistemicClass: change.assertion.epistemicClass,
      recordedAt: change.assertion.recordedAt,
      displayBinding,
      endpointBindings: bindings,
      pathAssertionIds: freezeArray(change.path.map((step) => step.assertionId)),
      graphSourceKeys: keys,
      graphSources: Object.freeze({
        total,
        displayed: keys.length,
        omitted: total - keys.length
      }),
      systemCopy: changeSystemCopy(locale, change, displayBinding)
    };
    return Object.freeze(body);
  }));
}

function compareStringArrays(
  left: readonly string[],
  right: readonly string[]
): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const compared = compareCodeUnits(left[index]!, right[index]!);
    if (compared !== 0) return compared;
  }
  return left.length - right.length;
}

function compareAbstentions(
  left: ContinuityChangeAbstention,
  right: ContinuityChangeAbstention
): number {
  return compareCodeUnits(left.code, right.code)
    || Number(left.global) - Number(right.global)
    || compareStringArrays(
      left.affectedAssertionIds,
      right.affectedAssertionIds
    )
    || left.affectedCount - right.affectedCount;
}

function abstentionRows(
  locale: CapsuleLocale,
  abstentions: readonly ContinuityChangeAbstention[]
): readonly CapsuleAbstentionRow[] {
  if (
    abstentions.length
    > CONTINUITY_CAPSULE_PRESENTATION_LIMITS.maxAbstentions
  ) {
    fail("BUDGET_EXCEEDED", "Capsule abstentions exceed their item budget");
  }
  return freezeArray(
    [...abstentions]
      .sort(compareAbstentions)
      .map((abstention) => Object.freeze({
        code: abstention.code,
        global: abstention.global,
        affectedCount: abstention.affectedCount,
        affectedCountUnit: abstention.global ? "candidates" : "assertions",
        affectedAssertionIds: freezeArray(abstention.affectedAssertionIds),
        systemCopy: Object.freeze({
          textOrigin: "deterministic-system-copy",
          label: ABSTENTION_COPY[abstention.code][locale]
        })
      }))
  );
}

function systemCopy(
  locale: CapsuleLocale,
  status: ContinuityChangeStatus,
  preparedKind: ContinuityCapsulePreparedWork["kind"]
): CapsuleSystemCopy {
  const copy = COPY[locale];
  return Object.freeze({
    textOrigin: "deterministic-system-copy",
    headline: copy.headline,
    whyShown: copy.whyShown,
    timingCaveat: copy.timingCaveat,
    resumeHeading: copy.resumeHeading,
    changeSummary: copy[STATUS_COPY_KEY[status]],
    currentNextStepHeading: copy.currentNextStepHeading,
    supportHeading: copy.supportHeading,
    preparedHeading: copy.preparedHeading,
    sourceHeading: copy.sourceHeading,
    privacyNotice: copy.privacyNotice,
    actionBoundary:
      preparedKind === "draft"
        ? copy.draftBoundary
        : copy.previewBoundary
  });
}

function buildPresentationBody(
  locale: CapsuleLocale,
  context: ContinuityCapsuleContext
): PresentationBody {
  const { manifest, changeResult } = context.compilation;
  const artifactSelection = selectedArtifactSources(context);
  const graphSelection = graphSourceSelection(changeResult.changes);
  const changes = changeRows(
    locale,
    changeResult.changes,
    artifactSelection.sources,
    artifactSelection.candidates,
    graphSelection
  );
  const abstentions = abstentionRows(locale, changeResult.abstentions);
  const namedChanges = changes.filter(
    (change) => change.displayBinding === "named-source"
  ).length;
  return Object.freeze({
    schemaVersion: 1,
    formatVersion: CONTINUITY_CAPSULE_PRESENTATION_FORMAT_VERSION,
    locale,
    verification: "canonical-self-consistency",
    authority: Object.freeze({
      invocation: "caller-declared-owner-request",
      automaticTiming: "not-performed",
      observation: "caller-declared-observation",
      preparation: "caller-declared-preparation",
      sourceFreshness: "not-proven",
      authenticatedWitness: "not-proven"
    }),
    thread: Object.freeze({
      textOrigin: "source-receipt-snapshot",
      id: manifest.thread.id,
      title: manifest.thread.title
    }),
    systemCopy: systemCopy(locale, changeResult.status, manifest.preparedWork.kind),
    resume: Object.freeze({
      observedAt: manifest.previousObservedAt,
      previousNextStepSourceKey: artifactSelection.previousNextStepSourceKey,
      currentAvailability: manifest.previousNextStepCurrentAvailability
    }),
    changeSummary: Object.freeze({
      status: changeResult.status,
      candidateCount: changeResult.diagnostics.candidateCount,
      answeredCount: changeResult.diagnostics.answeredCount,
      totalChanges: changes.length,
      namedChanges,
      technicalOnlyChanges: changes.length - namedChanges,
      abstentionCount: abstentions.length
    }),
    changes,
    abstentions,
    currentNextStepSourceKey: artifactSelection.currentNextStepSourceKey,
    supportingEvidenceSourceKeys:
      artifactSelection.supportingEvidenceSourceKeys,
    preparedWork: Object.freeze({
      textOrigin: "caller-declared-preparation",
      kind: manifest.preparedWork.kind,
      actionMode: manifest.preparedWork.actionMode,
      title: manifest.preparedWork.title,
      content: manifest.preparedWork.content,
      expectedMinutes: manifest.preparedWork.expectedMinutes
    }),
    sourceDrawer: Object.freeze({
      dataClass: "local-personal-linkable",
      telemetrySafe: false,
      previousObservedAt: manifest.previousObservedAt,
      currentObservedAt: manifest.currentObservedAt,
      preparedAt: manifest.preparedAt,
      previousSourceObservationReceiptId:
        manifest.previousSourceObservationReceiptId,
      previousGraphObservationReceiptId:
        manifest.previousGraphObservationReceiptId,
      currentSourceObservationReceiptId:
        manifest.currentSourceObservationReceiptId,
      currentGraphObservationReceiptId:
        manifest.currentGraphObservationReceiptId,
      manifestId: manifest.manifestId,
      changeResultId: manifest.changeResultId,
      artifactSources: artifactSelection.sources,
      graphSources: Object.freeze({
        total: graphSelection.total,
        displayed: graphSelection.items.length,
        omitted: 0,
        items: graphSelection.items
      })
    })
  });
}

function assertPresentationBytes(body: PresentationBody, id: string): void {
  const bytes = utf8Bytes(canonicalJson({ ...body, presentationId: id }));
  if (
    bytes
    > CONTINUITY_CAPSULE_PRESENTATION_LIMITS.maxPresentationBytes
  ) {
    fail(
      "BUDGET_EXCEEDED",
      "Continuity Capsule presentation exceeds its serialized byte budget",
      {
        bytes,
        limit: CONTINUITY_CAPSULE_PRESENTATION_LIMITS.maxPresentationBytes
      }
    );
  }
}

function parsePresentationEnvelope(input: unknown): {
  readonly locale: CapsuleLocale;
  readonly compilerInput: unknown;
} {
  const record = exactRecord(
    input,
    "Continuity Capsule presentation input",
    [
      "schemaVersion",
      "locale",
      "invocation",
      "previousSourceObservationReceipt",
      "previousGraphObservationReceipt",
      "currentSourceObservationReceipt",
      "currentGraphObservationReceipt",
      "preparation"
    ],
    [
      "schemaVersion",
      "locale",
      "invocation",
      "previousSourceObservationReceipt",
      "previousGraphObservationReceipt",
      "currentSourceObservationReceipt",
      "currentGraphObservationReceipt",
      "preparation"
    ],
    "INVALID_INPUT"
  );
  if (record.schemaVersion !== 1) {
    fail("INVALID_INPUT", "presentation input.schemaVersion must be 1");
  }
  if (record.locale !== "en" && record.locale !== "ko") {
    fail("INVALID_INPUT", "presentation input.locale is unsupported");
  }
  const invocation = exactRecord(
    record.invocation,
    "presentation input.invocation",
    ["authority"],
    ["authority"],
    "INVALID_INPUT"
  );
  if (invocation.authority !== "caller-declared-owner-request") {
    fail("INVALID_INPUT", "presentation invocation authority is unsupported");
  }
  return Object.freeze({
    locale: record.locale,
    compilerInput: Object.freeze({
      schemaVersion: 1,
      previousSourceObservationReceipt:
        record.previousSourceObservationReceipt,
      previousGraphObservationReceipt:
        record.previousGraphObservationReceipt,
      currentSourceObservationReceipt:
        record.currentSourceObservationReceipt,
      currentGraphObservationReceipt:
        record.currentGraphObservationReceipt,
      preparation: record.preparation
    })
  });
}

function mapManifestError(cause: unknown): never {
  if (!(cause instanceof ContinuityCapsuleManifestError)) throw cause;
  const code: ContinuityCapsulePresentationErrorCode =
    cause.code === "INVALID_MANIFEST"
      ? "INVALID_DEPENDENCY"
      : cause.code;
  fail(code, cause.message, cause.details);
}

export function presentContinuityCapsule(
  input: unknown
): ContinuityCapsulePresentation {
  const parsed = parsePresentationEnvelope(input);
  let context: ContinuityCapsuleContext;
  try {
    context = compileContinuityCapsuleContext(parsed.compilerInput);
  } catch (cause) {
    mapManifestError(cause);
  }
  const body = buildPresentationBody(parsed.locale, context);
  assertPresentationBytes(body, PRESENTATION_ID_PLACEHOLDER);
  return parsePresentation(Object.freeze({
    ...body,
    presentationId: presentationId(body)
  }));
}

interface InspectionBudget {
  descriptors: number;
  stringBytes: number;
}

function clonePresentationData(input: unknown): unknown {
  const budget: InspectionBudget = { descriptors: 0, stringBytes: 0 };
  const active = new WeakSet<object>();

  const inspectString = (value: string): string => {
    const bytes = utf8Bytes(value);
    if (
      bytes
      > CONTINUITY_CAPSULE_PRESENTATION_LIMITS.maxTechnicalStringBytes
    ) {
      fail("BUDGET_EXCEEDED", "presentation contains an oversized string", {
        bytes,
        limit:
          CONTINUITY_CAPSULE_PRESENTATION_LIMITS.maxTechnicalStringBytes
      });
    }
    budget.stringBytes += bytes;
    if (
      budget.stringBytes
      > CONTINUITY_CAPSULE_PRESENTATION_LIMITS.maxAggregateStringBytes
    ) {
      fail(
        "BUDGET_EXCEEDED",
        "presentation exceeds its aggregate string-byte budget",
        {
          bytes: budget.stringBytes,
          limit:
            CONTINUITY_CAPSULE_PRESENTATION_LIMITS.maxAggregateStringBytes
        }
      );
    }
    return value;
  };

  const visit = (value: unknown, depth: number): unknown => {
    if (depth > CONTINUITY_CAPSULE_PRESENTATION_LIMITS.maxNestingDepth) {
      fail("BUDGET_EXCEEDED", "presentation exceeds its nesting budget", {
        depth,
        limit: CONTINUITY_CAPSULE_PRESENTATION_LIMITS.maxNestingDepth
      });
    }
    if (typeof value === "string") return inspectString(value);
    if (
      value === null
      || typeof value === "boolean"
      || (typeof value === "number" && Number.isFinite(value))
    ) {
      return value;
    }
    if (typeof value !== "object") {
      fail(
        "INVALID_PRESENTATION",
        "presentation must contain JSON-compatible plain data"
      );
    }
    if (active.has(value)) {
      fail("INVALID_PRESENTATION", "presentation must not contain cycles");
    }
    const prototype = Object.getPrototypeOf(value);
    if (
      Array.isArray(value)
        ? prototype !== Array.prototype
        : prototype !== Object.prototype && prototype !== null
    ) {
      fail(
        "INVALID_PRESENTATION",
        "presentation must contain only plain objects and arrays"
      );
    }
    active.add(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const ownKeys = Reflect.ownKeys(value);
    budget.descriptors += ownKeys.length;
    if (
      budget.descriptors
      > CONTINUITY_CAPSULE_PRESENTATION_LIMITS.maxDescriptors
    ) {
      fail("BUDGET_EXCEEDED", "presentation exceeds its descriptor budget", {
        descriptors: budget.descriptors,
        limit: CONTINUITY_CAPSULE_PRESENTATION_LIMITS.maxDescriptors
      });
    }
    if (ownKeys.some((key) => typeof key !== "string")) {
      fail(
        "INVALID_PRESENTATION",
        "presentation must not contain symbol properties"
      );
    }
    if ((ownKeys as string[]).some((key) => FORBIDDEN_OWN_KEYS.has(key))) {
      fail("INVALID_PRESENTATION", "presentation contains a forbidden field");
    }
    if (Array.isArray(value)) {
      const raw = strictArray(
        value,
        "presentation array",
        "INVALID_PRESENTATION"
      );
      const output = raw.map((entry) => visit(entry, depth + 1));
      active.delete(value);
      return freezeArray(output);
    }
    const output: Record<string, unknown> = Object.create(null);
    for (const key of ownKeys as string[]) {
      inspectString(key);
      const descriptor = descriptors[key];
      if (!descriptor || !("value" in descriptor)) {
        fail(
          "INVALID_PRESENTATION",
          "presentation must contain only data properties"
        );
      }
      output[key] = visit(descriptor.value, depth + 1);
    }
    active.delete(value);
    return Object.freeze(output);
  };

  return visit(input, 0);
}

function enumValue<T extends string>(
  value: unknown,
  values: readonly T[],
  label: string
): T {
  if (typeof value !== "string" || !values.includes(value as T)) {
    fail("INVALID_PRESENTATION", `${label} is unsupported`);
  }
  return value as T;
}

function parseReference(value: unknown, label: string): ArtifactReference {
  const record = exactRecord(
    value,
    label,
    ["artifactId", "artifactType", "providerId", "role"],
    ["artifactId", "artifactType", "providerId", "role"],
    "INVALID_PRESENTATION"
  );
  const artifactId = requiredText(
    record.artifactId,
    `${label}.artifactId`,
    "INVALID_PRESENTATION"
  );
  const artifactType = enumValue(
    record.artifactType,
    ARTIFACT_TYPES,
    `${label}.artifactType`
  );
  const providerId = requiredText(
    record.providerId,
    `${label}.providerId`,
    "INVALID_PRESENTATION"
  );
  const role = enumValue(record.role, ARTIFACT_ROLES, `${label}.role`);
  if (!isCoherentArtifactProvider(artifactType, providerId)) {
    fail("INVALID_PRESENTATION", `${label} has an incoherent provider`);
  }
  return Object.freeze({ artifactId, artifactType, providerId, role });
}

function parseArtifactSource(
  value: unknown,
  index: number,
  seenTuples: Set<string>,
  seenKeys: Set<string>
): CapsuleArtifactSource {
  const label = `sourceDrawer.artifactSources[${index}]`;
  const record = exactRecord(
    value,
    label,
    [
      "sourceKey",
      "textOrigin",
      "observation",
      "reference",
      "status",
      "title",
      "summary"
    ],
    ["sourceKey", "textOrigin", "observation", "reference", "status"],
    "INVALID_PRESENTATION"
  );
  if (record.textOrigin !== "source-receipt-snapshot") {
    fail("INVALID_PRESENTATION", `${label}.textOrigin is invalid`);
  }
  const observation = enumValue(
    record.observation,
    ["previous", "current"],
    `${label}.observation`
  );
  const reference = parseReference(record.reference, `${label}.reference`);
  const status = enumValue(
    record.status,
    ["available", "unavailable"],
    `${label}.status`
  );
  const sourceKey = requiredText(
    record.sourceKey,
    `${label}.sourceKey`,
    "INVALID_PRESENTATION"
  );
  // The observed-at component is verified after the drawer envelope is known.
  if (!ARTIFACT_SOURCE_ID_PATTERN.test(sourceKey)) {
    fail("INVALID_PRESENTATION", `${label}.sourceKey is invalid`);
  }
  const tuple = artifactTupleKey(observation, reference);
  if (seenTuples.has(tuple) || seenKeys.has(sourceKey)) {
    fail("INVALID_PRESENTATION", `${label} is duplicated`);
  }
  seenTuples.add(tuple);
  seenKeys.add(sourceKey);
  const output: {
    sourceKey: string;
    textOrigin: "source-receipt-snapshot";
    observation: ArtifactObservation;
    reference: ArtifactReference;
    status: "available" | "unavailable";
    title?: string;
    summary?: string;
  } = {
    sourceKey,
    textOrigin: "source-receipt-snapshot",
    observation,
    reference,
    status
  };
  if (record.title !== undefined) {
    output.title = requiredText(
      record.title,
      `${label}.title`,
      "INVALID_PRESENTATION"
    );
  }
  if (record.summary !== undefined) {
    if (typeof record.summary !== "string") {
      fail("INVALID_PRESENTATION", `${label}.summary must be text`);
    }
    output.summary = record.summary;
  }
  return Object.freeze(output);
}

function parseGraphReference(value: unknown, label: string): GraphEvidenceRef {
  const record = exactRecord(
    value,
    label,
    ["namespace", "id", "version"],
    ["namespace", "id"],
    "INVALID_PRESENTATION"
  );
  const namespace = requiredText(
    record.namespace,
    `${label}.namespace`,
    "INVALID_PRESENTATION"
  );
  const id = requiredText(record.id, `${label}.id`, "INVALID_PRESENTATION");
  if (record.version !== undefined && typeof record.version !== "string") {
    fail("INVALID_PRESENTATION", `${label}.version must be text`);
  }
  return Object.freeze({
    namespace,
    id,
    ...(record.version === undefined
      ? {}
      : { version: record.version as string })
  });
}

function expectExactJson(
  actual: unknown,
  expected: unknown,
  label: string
): void {
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    fail("INVALID_PRESENTATION", `${label} is not canonical`);
  }
}

function parsePresentation(input: unknown): ContinuityCapsulePresentation {
  const cloned = clonePresentationData(input);
  const record = exactRecord(
    cloned,
    "Continuity Capsule presentation",
    [
      "schemaVersion",
      "formatVersion",
      "locale",
      "verification",
      "authority",
      "thread",
      "systemCopy",
      "resume",
      "changeSummary",
      "changes",
      "abstentions",
      "currentNextStepSourceKey",
      "supportingEvidenceSourceKeys",
      "preparedWork",
      "sourceDrawer",
      "presentationId"
    ],
    [
      "schemaVersion",
      "formatVersion",
      "locale",
      "verification",
      "authority",
      "thread",
      "systemCopy",
      "resume",
      "changeSummary",
      "changes",
      "abstentions",
      "currentNextStepSourceKey",
      "supportingEvidenceSourceKeys",
      "preparedWork",
      "sourceDrawer",
      "presentationId"
    ],
    "INVALID_PRESENTATION"
  );
  if (
    record.schemaVersion !== 1
    || record.formatVersion !== CONTINUITY_CAPSULE_PRESENTATION_FORMAT_VERSION
    || record.verification !== "canonical-self-consistency"
  ) {
    fail("INVALID_PRESENTATION", "presentation envelope is unsupported");
  }
  const locale = enumValue(record.locale, ["en", "ko"], "presentation.locale");
  const authority = exactRecord(
    record.authority,
    "presentation.authority",
    [
      "invocation",
      "automaticTiming",
      "observation",
      "preparation",
      "sourceFreshness",
      "authenticatedWitness"
    ],
    [
      "invocation",
      "automaticTiming",
      "observation",
      "preparation",
      "sourceFreshness",
      "authenticatedWitness"
    ],
    "INVALID_PRESENTATION"
  );
  expectExactJson(authority, {
    invocation: "caller-declared-owner-request",
    automaticTiming: "not-performed",
    observation: "caller-declared-observation",
    preparation: "caller-declared-preparation",
    sourceFreshness: "not-proven",
    authenticatedWitness: "not-proven"
  }, "presentation.authority");

  const drawer = exactRecord(
    record.sourceDrawer,
    "presentation.sourceDrawer",
    [
      "dataClass",
      "telemetrySafe",
      "previousObservedAt",
      "currentObservedAt",
      "preparedAt",
      "previousSourceObservationReceiptId",
      "previousGraphObservationReceiptId",
      "currentSourceObservationReceiptId",
      "currentGraphObservationReceiptId",
      "manifestId",
      "changeResultId",
      "artifactSources",
      "graphSources"
    ],
    [
      "dataClass",
      "telemetrySafe",
      "previousObservedAt",
      "currentObservedAt",
      "preparedAt",
      "previousSourceObservationReceiptId",
      "previousGraphObservationReceiptId",
      "currentSourceObservationReceiptId",
      "currentGraphObservationReceiptId",
      "manifestId",
      "changeResultId",
      "artifactSources",
      "graphSources"
    ],
    "INVALID_PRESENTATION"
  );
  if (
    drawer.dataClass !== "local-personal-linkable"
    || drawer.telemetrySafe !== false
  ) {
    fail("INVALID_PRESENTATION", "source drawer privacy classification is invalid");
  }
  const previousObservedAt = canonicalInstant(
    drawer.previousObservedAt,
    "sourceDrawer.previousObservedAt",
    "INVALID_PRESENTATION"
  );
  const currentObservedAt = canonicalInstant(
    drawer.currentObservedAt,
    "sourceDrawer.currentObservedAt",
    "INVALID_PRESENTATION"
  );
  const preparedAt = canonicalInstant(
    drawer.preparedAt,
    "sourceDrawer.preparedAt",
    "INVALID_PRESENTATION"
  );
  const rawArtifactSources = strictArray(
    drawer.artifactSources,
    "sourceDrawer.artifactSources",
    "INVALID_PRESENTATION"
  );
  if (
    rawArtifactSources.length
    > CONTINUITY_CAPSULE_PRESENTATION_LIMITS.maxArtifactSources
  ) {
    fail("BUDGET_EXCEEDED", "artifact sources exceed their item budget");
  }
  const seenTuples = new Set<string>();
  const seenArtifactKeys = new Set<string>();
  const artifactSources = freezeArray(
    rawArtifactSources.map((entry, index) =>
      parseArtifactSource(entry, index, seenTuples, seenArtifactKeys)
    )
  );
  for (const source of artifactSources) {
    const observedAt =
      source.observation === "previous"
        ? previousObservedAt
        : currentObservedAt;
    if (
      source.sourceKey
      !== artifactSourceKey(source.observation, observedAt, source.reference)
    ) {
      fail("INVALID_PRESENTATION", "artifact source key does not bind its source");
    }
  }

  const graphSourcesRecord = exactRecord(
    drawer.graphSources,
    "sourceDrawer.graphSources",
    ["total", "displayed", "omitted", "items"],
    ["total", "displayed", "omitted", "items"],
    "INVALID_PRESENTATION"
  );
  const rawGraphItems = strictArray(
    graphSourcesRecord.items,
    "sourceDrawer.graphSources.items",
    "INVALID_PRESENTATION"
  );
  if (
    rawGraphItems.length
    > CONTINUITY_CAPSULE_PRESENTATION_LIMITS.maxGraphSources
  ) {
    fail("BUDGET_EXCEEDED", "graph sources exceed their item budget");
  }
  const seenGraphKeys = new Set<string>();
  const graphItems = freezeArray(rawGraphItems.map((entry, index) => {
    const item = exactRecord(
      entry,
      `sourceDrawer.graphSources.items[${index}]`,
      ["sourceKey", "reference"],
      ["sourceKey", "reference"],
      "INVALID_PRESENTATION"
    );
    const reference = parseGraphReference(
      item.reference,
      `sourceDrawer.graphSources.items[${index}].reference`
    );
    const sourceKey = requiredText(
      item.sourceKey,
      `sourceDrawer.graphSources.items[${index}].sourceKey`,
      "INVALID_PRESENTATION"
    );
    if (
      !GRAPH_SOURCE_ID_PATTERN.test(sourceKey)
      || sourceKey !== graphSourceKey(reference)
      || seenGraphKeys.has(sourceKey)
    ) {
      fail("INVALID_PRESENTATION", "graph source key is invalid or duplicated");
    }
    seenGraphKeys.add(sourceKey);
    return Object.freeze({ sourceKey, reference });
  }));
  const graphTotal = safeInteger(
    graphSourcesRecord.total,
    "sourceDrawer.graphSources.total",
    "INVALID_PRESENTATION"
  );
  const graphDisplayed = safeInteger(
    graphSourcesRecord.displayed,
    "sourceDrawer.graphSources.displayed",
    "INVALID_PRESENTATION"
  );
  const graphOmitted = safeInteger(
    graphSourcesRecord.omitted,
    "sourceDrawer.graphSources.omitted",
    "INVALID_PRESENTATION"
  );
  if (
    graphDisplayed !== graphItems.length
    || graphTotal !== graphDisplayed
    || graphOmitted !== 0
  ) {
    fail("INVALID_PRESENTATION", "graph source accounting is invalid");
  }

  const preparedWork = exactRecord(
    record.preparedWork,
    "presentation.preparedWork",
    [
      "textOrigin",
      "kind",
      "actionMode",
      "title",
      "content",
      "expectedMinutes"
    ],
    [
      "textOrigin",
      "kind",
      "actionMode",
      "title",
      "content",
      "expectedMinutes"
    ],
    "INVALID_PRESENTATION"
  );
  const preparedKind = enumValue(
    preparedWork.kind,
    ["draft", "action-preview"],
    "preparedWork.kind"
  );
  const expectedActionMode =
    preparedKind === "draft" ? "display-only" : "requires-new-approval";
  if (
    preparedWork.textOrigin !== "caller-declared-preparation"
    || preparedWork.actionMode !== expectedActionMode
  ) {
    fail("INVALID_PRESENTATION", "prepared work attribution or action mode is invalid");
  }
  const preparedTitle = requiredText(
    preparedWork.title,
    "preparedWork.title",
    "INVALID_PRESENTATION"
  );
  const preparedContent = requiredText(
    preparedWork.content,
    "preparedWork.content",
    "INVALID_PRESENTATION"
  );
  if (
    Array.from(preparedTitle).length
      > CONTINUITY_CAPSULE_MANIFEST_LIMITS.maxPreparedTitleScalars
    || utf8Bytes(preparedTitle)
      > CONTINUITY_CAPSULE_MANIFEST_LIMITS.maxPreparedTitleBytes
  ) {
    fail("BUDGET_EXCEEDED", "preparedWork.title exceeds its budget");
  }
  if (PREPARED_TITLE_CONTROL.test(preparedTitle)) {
    fail(
      "INVALID_PRESENTATION",
      "preparedWork.title contains control characters"
    );
  }
  if (
    utf8Bytes(preparedContent)
      > CONTINUITY_CAPSULE_MANIFEST_LIMITS.maxPreparedContentBytes
  ) {
    fail("BUDGET_EXCEEDED", "preparedWork.content exceeds its byte budget");
  }
  if (PREPARED_CONTENT_CONTROL.test(preparedContent)) {
    fail(
      "INVALID_PRESENTATION",
      "preparedWork.content contains control characters"
    );
  }
  const expectedMinutes = safeInteger(
    preparedWork.expectedMinutes,
    "preparedWork.expectedMinutes",
    "INVALID_PRESENTATION"
  );
  if (expectedMinutes < 1) {
    fail("INVALID_PRESENTATION", "preparedWork.expectedMinutes must be positive");
  }
  if (
    expectedMinutes > CONTINUITY_CAPSULE_MANIFEST_LIMITS.maxExpectedMinutes
  ) {
    fail(
      "BUDGET_EXCEEDED",
      "preparedWork.expectedMinutes exceeds its budget"
    );
  }

  const summary = exactRecord(
    record.changeSummary,
    "presentation.changeSummary",
    [
      "status",
      "candidateCount",
      "answeredCount",
      "totalChanges",
      "namedChanges",
      "technicalOnlyChanges",
      "abstentionCount"
    ],
    [
      "status",
      "candidateCount",
      "answeredCount",
      "totalChanges",
      "namedChanges",
      "technicalOnlyChanges",
      "abstentionCount"
    ],
    "INVALID_PRESENTATION"
  );
  const status = enumValue(
    summary.status,
    ["complete", "partial", "no-change", "abstained"],
    "changeSummary.status"
  );
  const candidateCount = safeInteger(
    summary.candidateCount,
    "changeSummary.candidateCount",
    "INVALID_PRESENTATION"
  );
  const answeredCount = safeInteger(
    summary.answeredCount,
    "changeSummary.answeredCount",
    "INVALID_PRESENTATION"
  );
  const rawChanges = strictArray(
    record.changes,
    "presentation.changes",
    "INVALID_PRESENTATION"
  );
  if (rawChanges.length > CONTINUITY_CAPSULE_PRESENTATION_LIMITS.maxChanges) {
    fail("BUDGET_EXCEEDED", "presentation changes exceed their item budget");
  }
  const sourcesByKey = new Map(
    artifactSources.map((source) => [source.sourceKey, source] as const)
  );
  const parsedChanges = freezeArray(rawChanges.map((entry, index) => {
    const label = `changes[${index}]`;
    const change = exactRecord(
      entry,
      label,
      [
        "assertionId",
        "replacedAssertionId",
        "kind",
        "predicate",
        "category",
        "temporalBasis",
        "epistemicClass",
        "recordedAt",
        "displayBinding",
        "endpointBindings",
        "pathAssertionIds",
        "graphSourceKeys",
        "graphSources",
        "systemCopy"
      ],
      [
        "assertionId",
        "kind",
        "predicate",
        "category",
        "temporalBasis",
        "epistemicClass",
        "recordedAt",
        "displayBinding",
        "endpointBindings",
        "pathAssertionIds",
        "graphSourceKeys",
        "graphSources",
        "systemCopy"
      ],
      "INVALID_PRESENTATION"
    );
    const assertionId = requiredText(
      change.assertionId,
      `${label}.assertionId`,
      "INVALID_PRESENTATION"
    );
    const kind = enumValue(change.kind, ["added", "revised"], `${label}.kind`);
    const predicate = enumValue(
      change.predicate,
      Object.keys(PREDICATE_COPY) as GraphPredicate[],
      `${label}.predicate`
    );
    const temporalBasis = enumValue(
      change.temporalBasis,
      ["world-valid", "learned-after"],
      `${label}.temporalBasis`
    );
    const epistemicClass = enumValue(
      change.epistemicClass,
      [
        "user-asserted",
        "source-observed",
        "deterministic-derived",
        "model-hypothesis"
      ],
      `${label}.epistemicClass`
    );
    const displayBinding = enumValue(
      change.displayBinding,
      ["named-source", "technical-reference-only"],
      `${label}.displayBinding`
    );
    if (change.category !== PREDICATE_COPY[predicate].category) {
      fail("INVALID_PRESENTATION", `${label}.category is invalid`);
    }
    const rawBindings = strictArray(
      change.endpointBindings,
      `${label}.endpointBindings`,
      "INVALID_PRESENTATION"
    );
    if (rawBindings.length > 2) {
      fail("INVALID_PRESENTATION", `${label}.endpointBindings is too long`);
    }
    const bindings = freezeArray(rawBindings.map((bindingValue, bindingIndex) => {
      const binding = exactRecord(
        bindingValue,
        `${label}.endpointBindings[${bindingIndex}]`,
        ["endpoint", "sourceKeys"],
        ["endpoint", "sourceKeys"],
        "INVALID_PRESENTATION"
      );
      const endpoint = enumValue(
        binding.endpoint,
        ["subject", "object"],
        `${label}.endpointBindings[${bindingIndex}].endpoint`
      );
      const keys = strictArray(
        binding.sourceKeys,
        `${label}.endpointBindings[${bindingIndex}].sourceKeys`,
        "INVALID_PRESENTATION"
      ).map((key) =>
        requiredText(
          key,
          `${label}.endpointBindings[${bindingIndex}].sourceKeys`,
          "INVALID_PRESENTATION"
        )
      );
      const canonicalKeys = [...new Set(keys)].sort(compareCodeUnits);
      if (
        canonicalJson(keys) !== canonicalJson(canonicalKeys)
        || canonicalKeys.some((key) => !sourcesByKey.has(key))
      ) {
        fail("INVALID_PRESENTATION", `${label} has invalid endpoint source keys`);
      }
      return Object.freeze({ endpoint, sourceKeys: freezeArray(keys) });
    }));
    const expectedEndpoints = bindings.map((binding) => binding.endpoint);
    if (
      canonicalJson(expectedEndpoints)
      !== canonicalJson(
        [...new Set(expectedEndpoints)].sort((left, right) =>
          left === right ? 0 : left === "subject" ? -1 : 1
        )
      )
    ) {
      fail("INVALID_PRESENTATION", `${label}.endpointBindings is not canonical`);
    }
    const computedBinding: DisplayBinding =
      isNamedBinding(bindings, sourcesByKey)
        ? "named-source"
        : "technical-reference-only";
    if (displayBinding !== computedBinding) {
      fail("INVALID_PRESENTATION", `${label}.displayBinding is invalid`);
    }
    const pathAssertionIds = strictArray(
      change.pathAssertionIds,
      `${label}.pathAssertionIds`,
      "INVALID_PRESENTATION"
    ).map((id) =>
      requiredText(
        id,
        `${label}.pathAssertionIds`,
        "INVALID_PRESENTATION"
      )
    );
    if (
      pathAssertionIds.length
      > CONTINUITY_CAPSULE_PRESENTATION_LIMITS.maxPathAssertionIdsPerChange
    ) {
      fail("BUDGET_EXCEEDED", `${label}.pathAssertionIds exceeds its budget`);
    }
    const rowGraphKeys = strictArray(
      change.graphSourceKeys,
      `${label}.graphSourceKeys`,
      "INVALID_PRESENTATION"
    ).map((key) =>
      requiredText(
        key,
        `${label}.graphSourceKeys`,
        "INVALID_PRESENTATION"
      )
    );
    if (
      rowGraphKeys.length
      > CONTINUITY_CAPSULE_PRESENTATION_LIMITS.maxGraphSourcesPerChange
    ) {
      fail(
        "BUDGET_EXCEEDED",
        `${label}.graphSourceKeys exceeds its item budget`
      );
    }
    if (
      canonicalJson(rowGraphKeys)
        !== canonicalJson([...new Set(rowGraphKeys)].sort(compareCodeUnits))
      || rowGraphKeys.some((key) => !seenGraphKeys.has(key))
    ) {
      fail("INVALID_PRESENTATION", `${label}.graphSourceKeys is invalid`);
    }
    const rowGraphAccounting = exactRecord(
      change.graphSources,
      `${label}.graphSources`,
      ["total", "displayed", "omitted"],
      ["total", "displayed", "omitted"],
      "INVALID_PRESENTATION"
    );
    const rowTotal = safeInteger(
      rowGraphAccounting.total,
      `${label}.graphSources.total`,
      "INVALID_PRESENTATION"
    );
    const rowDisplayed = safeInteger(
      rowGraphAccounting.displayed,
      `${label}.graphSources.displayed`,
      "INVALID_PRESENTATION"
    );
    const rowOmitted = safeInteger(
      rowGraphAccounting.omitted,
      `${label}.graphSources.omitted`,
      "INVALID_PRESENTATION"
    );
    if (
      rowDisplayed !== rowGraphKeys.length
      || rowTotal !== rowDisplayed
      || rowOmitted !== 0
    ) {
      fail("INVALID_PRESENTATION", `${label}.graphSources accounting is invalid`);
    }
    const expectedCopy = Object.freeze({
      textOrigin: "deterministic-system-copy",
      relationLabel: PREDICATE_COPY[predicate][locale],
      kindLabel: CHANGE_KIND_COPY[locale][kind],
      temporalBasisLabel: TEMPORAL_COPY[locale][temporalBasis],
      bindingLabel:
        displayBinding === "named-source"
          ? COPY[locale].namedBinding
          : COPY[locale].technicalBinding
    });
    expectExactJson(change.systemCopy, expectedCopy, `${label}.systemCopy`);
    if (
      change.replacedAssertionId !== undefined
      && typeof change.replacedAssertionId !== "string"
    ) {
      fail("INVALID_PRESENTATION", `${label}.replacedAssertionId must be text`);
    }
    return Object.freeze({
      assertionId,
      ...(change.replacedAssertionId === undefined
        ? {}
        : { replacedAssertionId: change.replacedAssertionId as string }),
      kind,
      predicate,
      category: PREDICATE_COPY[predicate].category,
      temporalBasis,
      epistemicClass,
      recordedAt: canonicalInstant(
        change.recordedAt,
        `${label}.recordedAt`,
        "INVALID_PRESENTATION"
      ),
      displayBinding,
      endpointBindings: bindings,
      pathAssertionIds: freezeArray(pathAssertionIds),
      graphSourceKeys: freezeArray(rowGraphKeys),
      graphSources: Object.freeze({
        total: rowTotal,
        displayed: rowDisplayed,
        omitted: rowOmitted
      }),
      systemCopy: expectedCopy
    });
  }));
  for (let index = 1; index < parsedChanges.length; index += 1) {
    if (
      compareCodeUnits(
        parsedChanges[index - 1]!.assertionId,
        parsedChanges[index]!.assertionId
      ) >= 0
    ) {
      fail(
        "INVALID_PRESENTATION",
        "presentation changes must be strictly ordered and unique"
      );
    }
  }
  const rowGraphSourcePrefix: string[] = [];
  const rowGraphSourceSet = new Set<string>();
  for (const change of parsedChanges) {
    for (const sourceKey of change.graphSourceKeys) {
      if (rowGraphSourceSet.has(sourceKey)) continue;
      rowGraphSourceSet.add(sourceKey);
      rowGraphSourcePrefix.push(sourceKey);
    }
  }
  const drawerGraphKeys = graphItems.map((item) => item.sourceKey);
  if (
    canonicalJson(drawerGraphKeys.slice(0, rowGraphSourcePrefix.length))
      !== canonicalJson(rowGraphSourcePrefix)
  ) {
    fail(
      "INVALID_PRESENTATION",
      "graph source drawer does not begin with the displayed row-source union"
    );
  }
  const remainingDrawerGraphKeys = drawerGraphKeys.slice(
    rowGraphSourcePrefix.length
  );
  if (
    canonicalJson(remainingDrawerGraphKeys)
      !== canonicalJson([...remainingDrawerGraphKeys].sort(compareCodeUnits))
  ) {
    fail(
      "INVALID_PRESENTATION",
      "remaining graph source drawer items are not canonical"
    );
  }

  const rawAbstentions = strictArray(
    record.abstentions,
    "presentation.abstentions",
    "INVALID_PRESENTATION"
  );
  if (
    rawAbstentions.length
    > CONTINUITY_CAPSULE_PRESENTATION_LIMITS.maxAbstentions
  ) {
    fail("BUDGET_EXCEEDED", "presentation abstentions exceed their item budget");
  }
  const parsedAbstentions = freezeArray(rawAbstentions.map((entry, index) => {
    const label = `abstentions[${index}]`;
    const abstention = exactRecord(
      entry,
      label,
      [
        "code",
        "global",
        "affectedCount",
        "affectedCountUnit",
        "affectedAssertionIds",
        "systemCopy"
      ],
      [
        "code",
        "global",
        "affectedCount",
        "affectedCountUnit",
        "affectedAssertionIds",
        "systemCopy"
      ],
      "INVALID_PRESENTATION"
    );
    const code = enumValue(
      abstention.code,
      Object.keys(ABSTENTION_COPY) as ContinuityChangeAbstentionCode[],
      `${label}.code`
    );
    if (typeof abstention.global !== "boolean") {
      fail("INVALID_PRESENTATION", `${label}.global must be boolean`);
    }
    const affectedCount = safeInteger(
      abstention.affectedCount,
      `${label}.affectedCount`,
      "INVALID_PRESENTATION"
    );
    const affectedAssertionIds = strictArray(
      abstention.affectedAssertionIds,
      `${label}.affectedAssertionIds`,
      "INVALID_PRESENTATION"
    ).map((id) =>
      requiredText(
        id,
        `${label}.affectedAssertionIds`,
        "INVALID_PRESENTATION"
      )
    );
    if (
      canonicalJson(affectedAssertionIds)
        !== canonicalJson(
          [...new Set(affectedAssertionIds)].sort(compareCodeUnits)
        )
    ) {
      fail(
        "INVALID_PRESENTATION",
        `${label}.affectedAssertionIds must be sorted and unique`
      );
    }
    const expectedUnit =
      abstention.global ? "candidates" : "assertions";
    if (abstention.affectedCountUnit !== expectedUnit) {
      fail("INVALID_PRESENTATION", `${label}.affectedCountUnit is invalid`);
    }
    expectExactJson(abstention.systemCopy, {
      textOrigin: "deterministic-system-copy",
      label: ABSTENTION_COPY[code][locale]
    }, `${label}.systemCopy`);
    return Object.freeze({
      code,
      global: abstention.global,
      affectedCount,
      affectedCountUnit: expectedUnit,
      affectedAssertionIds: freezeArray(affectedAssertionIds),
      systemCopy: Object.freeze({
        textOrigin: "deterministic-system-copy" as const,
        label: ABSTENTION_COPY[code][locale]
      })
    });
  }));
  for (let index = 1; index < parsedAbstentions.length; index += 1) {
    if (
      compareAbstentions(
        parsedAbstentions[index - 1]!,
        parsedAbstentions[index]!
      ) >= 0
    ) {
      fail(
        "INVALID_PRESENTATION",
        "presentation abstentions must be strictly ordered and unique"
      );
    }
  }

  const namedChanges = parsedChanges.filter(
    (change) => change.displayBinding === "named-source"
  ).length;
  if (
    safeInteger(
      summary.totalChanges,
      "changeSummary.totalChanges",
      "INVALID_PRESENTATION"
    ) !== parsedChanges.length
    || safeInteger(
      summary.namedChanges,
      "changeSummary.namedChanges",
      "INVALID_PRESENTATION"
    ) !== namedChanges
    || safeInteger(
      summary.technicalOnlyChanges,
      "changeSummary.technicalOnlyChanges",
      "INVALID_PRESENTATION"
    ) !== parsedChanges.length - namedChanges
    || safeInteger(
      summary.abstentionCount,
      "changeSummary.abstentionCount",
      "INVALID_PRESENTATION"
    ) !== parsedAbstentions.length
    || answeredCount !== parsedChanges.length
    || answeredCount > candidateCount
  ) {
    fail("INVALID_PRESENTATION", "change summary accounting is invalid");
  }

  const expectedSystemCopy = systemCopy(locale, status, preparedKind);
  expectExactJson(
    record.systemCopy,
    expectedSystemCopy,
    "presentation.systemCopy"
  );
  const thread = exactRecord(
    record.thread,
    "presentation.thread",
    ["textOrigin", "id", "title"],
    ["textOrigin", "id", "title"],
    "INVALID_PRESENTATION"
  );
  if (thread.textOrigin !== "source-receipt-snapshot") {
    fail("INVALID_PRESENTATION", "thread.textOrigin is invalid");
  }
  const resume = exactRecord(
    record.resume,
    "presentation.resume",
    ["observedAt", "previousNextStepSourceKey", "currentAvailability"],
    ["observedAt", "previousNextStepSourceKey", "currentAvailability"],
    "INVALID_PRESENTATION"
  );
  if (
    resume.observedAt !== previousObservedAt
    || (resume.currentAvailability !== "available"
      && resume.currentAvailability !== "unavailable")
    || typeof resume.previousNextStepSourceKey !== "string"
    || !sourcesByKey.has(resume.previousNextStepSourceKey)
    || sourcesByKey.get(resume.previousNextStepSourceKey)?.observation
      !== "previous"
  ) {
    fail("INVALID_PRESENTATION", "resume source binding is invalid");
  }
  if (
    typeof record.currentNextStepSourceKey !== "string"
    || !sourcesByKey.has(record.currentNextStepSourceKey)
    || sourcesByKey.get(record.currentNextStepSourceKey)?.observation
      !== "current"
  ) {
    fail("INVALID_PRESENTATION", "current next-step source binding is invalid");
  }
  const supportingKeys = strictArray(
    record.supportingEvidenceSourceKeys,
    "supportingEvidenceSourceKeys",
    "INVALID_PRESENTATION"
  ).map((key) =>
    requiredText(
      key,
      "supportingEvidenceSourceKeys",
      "INVALID_PRESENTATION"
    )
  );
  if (
    canonicalJson(supportingKeys)
      !== canonicalJson([...new Set(supportingKeys)].sort(compareCodeUnits))
    || supportingKeys.some((key) =>
      !sourcesByKey.has(key)
      || sourcesByKey.get(key)?.observation !== "current"
    )
  ) {
    fail("INVALID_PRESENTATION", "supporting evidence source keys are invalid");
  }
  if (
    artifactSources[0]?.sourceKey !== resume.previousNextStepSourceKey
    || artifactSources[1]?.sourceKey !== record.currentNextStepSourceKey
  ) {
    fail(
      "INVALID_PRESENTATION",
      "artifact source drawer does not begin with the resume and current next-step sources"
    );
  }
  const statusIsCoherent =
    (status === "complete"
      && parsedChanges.length > 0
      && parsedAbstentions.length === 0)
    || (status === "partial"
      && parsedChanges.length > 0
      && parsedAbstentions.length > 0)
    || (status === "no-change"
      && parsedChanges.length === 0
      && parsedAbstentions.length === 0)
    || (status === "abstained"
      && parsedChanges.length === 0
      && parsedAbstentions.length > 0);
  if (!statusIsCoherent) {
    fail("INVALID_PRESENTATION", "change status is incoherent with its rows");
  }
  if (
    new Date(previousObservedAt).getTime()
      > new Date(currentObservedAt).getTime()
    || preparedAt !== currentObservedAt
  ) {
    fail("INVALID_PRESENTATION", "presentation observation times are incoherent");
  }

  const normalizedBody = {
    schemaVersion: 1 as const,
    formatVersion: CONTINUITY_CAPSULE_PRESENTATION_FORMAT_VERSION,
    locale,
    verification: "canonical-self-consistency" as const,
    authority: Object.freeze({
      invocation: "caller-declared-owner-request" as const,
      automaticTiming: "not-performed" as const,
      observation: "caller-declared-observation" as const,
      preparation: "caller-declared-preparation" as const,
      sourceFreshness: "not-proven" as const,
      authenticatedWitness: "not-proven" as const
    }),
    thread: Object.freeze({
      textOrigin: "source-receipt-snapshot" as const,
      id: requiredText(thread.id, "thread.id", "INVALID_PRESENTATION"),
      title: requiredText(
        thread.title,
        "thread.title",
        "INVALID_PRESENTATION"
      )
    }),
    systemCopy: expectedSystemCopy,
    resume: Object.freeze({
      observedAt: previousObservedAt,
      previousNextStepSourceKey: resume.previousNextStepSourceKey as string,
      currentAvailability: resume.currentAvailability as
        | "available"
        | "unavailable"
    }),
    changeSummary: Object.freeze({
      status,
      candidateCount,
      answeredCount,
      totalChanges: parsedChanges.length,
      namedChanges,
      technicalOnlyChanges: parsedChanges.length - namedChanges,
      abstentionCount: parsedAbstentions.length
    }),
    changes: parsedChanges,
    abstentions: parsedAbstentions,
    currentNextStepSourceKey: record.currentNextStepSourceKey as string,
    supportingEvidenceSourceKeys: freezeArray(supportingKeys),
    preparedWork: Object.freeze({
      textOrigin: "caller-declared-preparation" as const,
      kind: preparedKind,
      actionMode: expectedActionMode,
      title: preparedTitle,
      content: preparedContent,
      expectedMinutes
    }),
    sourceDrawer: Object.freeze({
      dataClass: "local-personal-linkable" as const,
      telemetrySafe: false as const,
      previousObservedAt,
      currentObservedAt,
      preparedAt,
      previousSourceObservationReceiptId: patternedText(
        drawer.previousSourceObservationReceiptId,
        "previousSourceObservationReceiptId",
        SOURCE_RECEIPT_ID_PATTERN
      ),
      previousGraphObservationReceiptId: patternedText(
        drawer.previousGraphObservationReceiptId,
        "previousGraphObservationReceiptId",
        GRAPH_RECEIPT_ID_PATTERN
      ),
      currentSourceObservationReceiptId: patternedText(
        drawer.currentSourceObservationReceiptId,
        "currentSourceObservationReceiptId",
        SOURCE_RECEIPT_ID_PATTERN
      ),
      currentGraphObservationReceiptId: patternedText(
        drawer.currentGraphObservationReceiptId,
        "currentGraphObservationReceiptId",
        GRAPH_RECEIPT_ID_PATTERN
      ),
      manifestId: patternedText(
        drawer.manifestId,
        "manifestId",
        MANIFEST_ID_PATTERN
      ),
      changeResultId: patternedText(
        drawer.changeResultId,
        "changeResultId",
        CHANGE_RESULT_ID_PATTERN
      ),
      artifactSources,
      graphSources: Object.freeze({
        total: graphTotal,
        displayed: graphDisplayed,
        omitted: graphOmitted,
        items: graphItems
      })
    })
  } satisfies PresentationBody;
  const suppliedId = requiredText(
    record.presentationId,
    "presentationId",
    "INVALID_PRESENTATION"
  );
  assertPresentationBytes(normalizedBody, suppliedId);
  if (
    !PRESENTATION_ID_PATTERN.test(suppliedId)
    || presentationId(normalizedBody) !== suppliedId
  ) {
    fail(
      "INTEGRITY_MISMATCH",
      "presentationId does not bind the Continuity Capsule presentation"
    );
  }
  return Object.freeze({
    ...normalizedBody,
    presentationId: suppliedId
  });
}

/**
 * Proves the serialized Capsule's canonical self-consistency only. It does not
 * authenticate the caller, prove source freshness, or re-open Source Receipts.
 */
export function verifyContinuityCapsulePresentation(
  input: unknown
): ContinuityCapsulePresentation {
  return parsePresentation(input);
}
