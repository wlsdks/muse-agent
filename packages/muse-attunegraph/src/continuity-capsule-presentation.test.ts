import { createHash } from "node:crypto";

import type {
  ArtifactLink,
  ArtifactReference,
  AttunementState,
  ContinuityPack,
  ResolvedArtifact
} from "@muse/attunement";
import { fingerprintContinuityTaskState } from "@muse/attunement";
import {
  captureScopedContinuitySourceObservation
} from "@muse/attunement/continuity-source-observations";
import { describe, expect, it, vi } from "vitest";

import {
  CONTINUITY_CAPSULE_PRESENTATION_FORMAT_VERSION,
  CONTINUITY_CAPSULE_PRESENTATION_LIMITS,
  ContinuityCapsulePresentationError,
  presentContinuityCapsule,
  verifyContinuityCapsulePresentation
} from "./continuity-capsule-presentation.js";
import { captureContinuityObservation } from "./continuity-observation.js";
import { GRAPH_PREDICATES } from "@attunegraph/core";

const PREVIOUS_AT = "2026-07-29T08:00:00.000Z";
const CURRENT_AT = "2026-07-29T10:00:00.000Z";
const SCOPE = { sourceId: "default", threadId: "thread_capsule_presentation" } as const;
const PRESENTATION_HASH_DOMAIN = "muse.attunement.continuity-capsule-presentation.v1\0";
const PRESENTATION_ID_PREFIX = "muse-continuity-capsule-presentation:v1:sha256:";
const ARTIFACT_SOURCE_HASH_DOMAIN = "muse.attunement.capsule-artifact-source.v1\0";
const ARTIFACT_SOURCE_PREFIX = "muse-capsule-artifact-source:v1:sha256:";
const GRAPH_SOURCE_HASH_DOMAIN = "muse.attunement.capsule-graph-source.v1\0";
const GRAPH_SOURCE_PREFIX = "muse-capsule-graph-source:v1:sha256:";

type Data = Record<string, unknown>;

const TASK: ArtifactReference = {
  artifactId: "task_capsule_resume",
  artifactType: "task",
  providerId: "local",
  role: "next-step"
};

function support(index: number): ArtifactReference {
  return {
    artifactId: `note_capsule_${index.toString()}`,
    artifactType: "note",
    providerId: "local",
    role: "context"
  };
}

function syntheticArtifactSource(index: number, observedAt: unknown): Data {
  const reference = support(10_000 + index);
  return {
    sourceKey: `${ARTIFACT_SOURCE_PREFIX}${sha256(
      ARTIFACT_SOURCE_HASH_DOMAIN,
      [
        "current",
        observedAt,
        reference.artifactId,
        reference.artifactType,
        reference.providerId,
        reference.role
      ]
    )}`,
    textOrigin: "source-receipt-snapshot",
    observation: "current",
    reference,
    status: "available",
    title: `Synthetic source ${index.toString()}`
  };
}

function syntheticGraphSource(index: number): Data {
  const reference = {
    namespace: "muse.test.capsule-limit",
    id: `source_${index.toString().padStart(3, "0")}`,
    version: "sha256:fixture"
  };
  return {
    sourceKey: `${GRAPH_SOURCE_PREFIX}${sha256(
      GRAPH_SOURCE_HASH_DOMAIN,
      [reference.namespace, reference.id, reference.version]
    )}`,
    reference
  };
}

function artifact(reference: ArtifactReference, summary?: string): ResolvedArtifact {
  return {
    ...reference,
    ...(reference.artifactType === "task" ? { taskStatus: "open" as const } : {}),
    title: reference.artifactType === "task" ? "Resume booking" : `Support ${reference.artifactId}`,
    ...(summary === undefined ? {} : { summary })
  };
}

function state(
  supports: readonly ArtifactReference[],
  newlyLinkedArtifactIds: ReadonlySet<string> = new Set()
): AttunementState {
  const links: readonly ArtifactLink[] = [
    {
      ...TASK,
      linkedAt: "2026-07-29T01:00:00.000Z",
      linkedBy: "user",
      threadId: SCOPE.threadId
    },
    ...supports.map((reference, index) => ({
      ...reference,
      linkedAt: newlyLinkedArtifactIds.has(reference.artifactId)
        ? `2026-07-29T09:${(index + 1).toString().padStart(2, "0")}:00.000Z`
        : `2026-07-29T01:${(index + 1).toString().padStart(2, "0")}:00.000Z`,
      linkedBy: "user" as const,
      threadId: SCOPE.threadId
    }))
  ];
  return {
    deliveries: [],
    experienceLearningPolicyAudits: [],
    interactionReceipts: [],
    nextPolicyVersion: 1,
    resetReceipts: [],
    schemaVersion: 12,
    threads: [{
      createdAt: "2026-07-29T00:00:00.000Z",
      id: SCOPE.threadId,
      kind: "work",
      links,
      policy: { detail: "compact", nextStep: "direct", suppression: "none", version: 0 },
      title: "Private capsule thread"
    }],
    undoResetReceipts: []
  };
}

function sourceReceipt(
  observedAt: string,
  supports: readonly ArtifactReference[],
  hasNextStep = true
) {
  const nextStep = hasNextStep ? artifact(TASK) : { ...TASK, title: "Resume booking" } as ResolvedArtifact;
  const evidence = [
    { artifact: nextStep, reference: TASK, status: "available" as const },
    ...supports.map((reference, index) => ({
      artifact: artifact(reference, `Caller source ${index.toString()}`),
      reference,
      status: "available" as const
    }))
  ];
  const pack: ContinuityPack = {
    deliveryPolicyVersion: 0,
    evidence,
    evidenceRefs: evidence.map((entry) => entry.reference),
    ...(hasNextStep ? { interactionAnchor: {
      artifactId: TASK.artifactId,
      linkedAt: "2026-07-29T01:00:00.000Z",
      observedStatus: "open",
      openStateFingerprint: fingerprintContinuityTaskState({
        artifactId: TASK.artifactId,
        status: "open",
        updatedAt: ""
      }),
      providerId: "local",
      role: "next-step"
    } } : {}),
    ...(hasNextStep ? { nextStep: artifact(TASK) } : {}),
    policy: { detail: "compact", nextStep: "direct", suppression: "none", version: 0 },
    thread: { id: SCOPE.threadId, kind: "work", title: "Private capsule thread" }
  };
  return captureScopedContinuitySourceObservation({ scope: SCOPE, observedAt, pack });
}

function presentationInput(options: {
  readonly previousSupports?: readonly ArtifactReference[];
  readonly currentSupports?: readonly ArtifactReference[];
  readonly kind?: "draft" | "action-preview";
  readonly actionMode?: "display-only" | "requires-new-approval";
  readonly title?: string;
  readonly content?: string;
  readonly expectedMinutes?: number;
  readonly previousHasNextStep?: boolean;
  readonly currentHasNextStep?: boolean;
} = {}) {
  const previousSupports = options.previousSupports ?? [support(0)];
  const currentSupports = options.currentSupports ?? previousSupports;
  const kind = options.kind ?? "draft";
  const actionMode = options.actionMode ?? "display-only";
  const previousArtifactIds = new Set(
    previousSupports.map((reference) => reference.artifactId)
  );
  const newlyLinkedArtifactIds = new Set(
    currentSupports
      .filter((reference) => !previousArtifactIds.has(reference.artifactId))
      .map((reference) => reference.artifactId)
  );
  return {
    schemaVersion: 1,
    locale: "en" as const,
    invocation: { authority: "caller-declared-owner-request" as const },
    previousSourceObservationReceipt: sourceReceipt(PREVIOUS_AT, previousSupports, options.previousHasNextStep ?? true),
    previousGraphObservationReceipt: captureContinuityObservation({
      scope: SCOPE,
      sourceObservedAt: PREVIOUS_AT,
      state: state(previousSupports)
    }),
    currentSourceObservationReceipt: sourceReceipt(CURRENT_AT, currentSupports, options.currentHasNextStep ?? true),
    currentGraphObservationReceipt: captureContinuityObservation({
      scope: SCOPE,
      sourceObservedAt: CURRENT_AT,
      state: state(currentSupports, newlyLinkedArtifactIds)
    }),
    preparation: {
      preparedAt: CURRENT_AT,
      supportingEvidenceRefs: currentSupports,
      preparedWork: {
        kind,
        actionMode,
        title: options.title ?? "Prepare the booking draft",
        content: options.content ?? "Review the hotel options and prepare a draft.",
        expectedMinutes: options.expectedMinutes ?? 15
      }
    }
  };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function canonical(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("non-finite fixture value");
    return value;
  }
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === "object") {
    return Object.fromEntries(Object.keys(value as Data).sort().flatMap((key) => {
      const child = (value as Data)[key];
      return child === undefined ? [] : [[key, canonical(child)]];
    }));
  }
  throw new TypeError("unsupported fixture value");
}

function sha256(domain: string, material: unknown): string {
  return createHash("sha256")
    .update(domain, "utf8")
    .update(JSON.stringify(canonical(material)), "utf8")
    .digest("hex");
}

function rehash(presentation: Data): Data {
  const { presentationId: _presentationId, ...body } = presentation;
  return {
    ...body,
    presentationId: `${PRESENTATION_ID_PREFIX}${sha256(PRESENTATION_HASH_DOMAIN, body)}`
  };
}

function presentationAtByteSize(targetBytes: number): Data {
  const candidate = clone(
    presentContinuityCapsule(presentationInput())
  ) as unknown as Data;
  const thread = candidate.thread as Data;
  const preparedWork = candidate.preparedWork as Data;
  const artifactSources = (
    (candidate.sourceDrawer as Data).artifactSources as Data[]
  );
  thread.title = "x";
  preparedWork.content = "x";
  for (const source of artifactSources) {
    source.title = "x";
    source.summary = "";
  }
  const fields: { owner: Data; key: string; capacity: number }[] = [
    { owner: thread, key: "title", capacity: 16_384 },
    { owner: preparedWork, key: "content", capacity: 16_384 },
    ...artifactSources.flatMap((source) => [
      { owner: source, key: "title", capacity: 16_384 },
      { owner: source, key: "summary", capacity: 16_384 }
    ])
  ];
  let output = rehash(candidate);
  let remaining = targetBytes - utf8Bytes(JSON.stringify(output));
  if (remaining < 0) throw new Error("target presentation byte size is too small");
  for (const field of fields) {
    if (remaining === 0) break;
    const current = field.owner[field.key] as string;
    const added = Math.min(remaining, field.capacity - utf8Bytes(current));
    field.owner[field.key] = `${current}${"x".repeat(added)}`;
    remaining -= added;
  }
  if (remaining !== 0) {
    throw new Error(`fixture lacks ${remaining.toString()} bytes of capacity`);
  }
  output = rehash(candidate);
  if (utf8Bytes(JSON.stringify(output)) !== targetBytes) {
    throw new Error("fixture did not reach its exact serialized byte target");
  }
  return output;
}

function expectPresentationError(fn: () => unknown, code: string): void {
  try {
    fn();
    throw new Error("expected presentation operation to fail");
  } catch (cause) {
    expect(cause).toBeInstanceOf(ContinuityCapsulePresentationError);
    expect((cause as { code: string }).code).toBe(code);
  }
}

function ownKeysRecursively(value: unknown, seen = new Set<object>()): readonly string[] {
  if (value === null || typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const own = Reflect.ownKeys(value).filter((key): key is string => typeof key === "string");
  return [...own, ...Object.values(value).flatMap((child) => ownKeysRecursively(child, seen))];
}

function expectDeepFrozen(value: unknown, seen = new Set<object>()): void {
  if (value === null || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  expect(Object.isFrozen(value)).toBe(true);
  for (const child of Object.values(value)) expectDeepFrozen(child, seen);
}

function firstChangedPresentation(locale: "en" | "ko" = "en"): Data {
  return presentContinuityCapsule({
    ...presentationInput({
    previousSupports: [],
    currentSupports: [support(0)]
    }),
    locale
  }) as unknown as Data;
}

function standaloneStatusFixture(
  status: "complete" | "partial" | "no-change" | "abstained",
  actionMode: "display-only" | "requires-new-approval",
  kind: "draft" | "action-preview"
): Data {
  const base = status === "complete" || status === "partial"
    ? firstChangedPresentation()
    : presentContinuityCapsule(presentationInput()) as unknown as Data;
  const candidate = clone(base) as Data;
  const summary = candidate.changeSummary as Data;
  const copy = candidate.systemCopy as Data;
  const abstentions = status === "partial" || status === "abstained"
    ? [{
      code: "INCONSISTENT_OBSERVATION",
      global: true,
      affectedCount: 0,
      affectedCountUnit: "candidates",
      affectedAssertionIds: ["assertion_retained_even_when_candidate_count_is_zero"],
      systemCopy: {
        textOrigin: "deterministic-system-copy",
        label: ABSTENTION_COPY.INCONSISTENT_OBSERVATION![0]
      }
    }]
    : [];
  candidate.preparedWork = { ...(candidate.preparedWork as Data), kind, actionMode };
  candidate.abstentions = abstentions;
  candidate.changeSummary = {
    ...summary,
    status,
    candidateCount: status === "abstained" ? 0 : summary.candidateCount,
    answeredCount: status === "abstained" ? 0 : summary.answeredCount,
    totalChanges: status === "abstained" ? 0 : summary.totalChanges,
    namedChanges: status === "abstained" ? 0 : summary.namedChanges,
    technicalOnlyChanges: status === "abstained" ? 0 : summary.technicalOnlyChanges,
    abstentionCount: abstentions.length
  };
  if (status === "abstained") candidate.changes = [];
  candidate.systemCopy = {
    ...copy,
    changeSummary: COPY.en.summaries[status],
    actionBoundary: COPY.en.action[actionMode]
  };
  return rehash(candidate);
}

const COPY = {
  en: {
    headline: "Continuity Capsule",
    whyShown: "Shown because the caller declared that you requested this Capsule.",
    timingCaveat: "Muse did not evaluate whether now was a good time.",
    summaries: {
      complete: "All detected graph relation changes were explained.",
      partial: "Some detected graph relation changes were explained; others remain unresolved.",
      "no-change": "No graph relation changes were detected between these caller-declared observations.",
      abstained: "The graph comparison could not provide a complete change explanation."
    },
    action: {
      "display-only": "Display only. No action will run.",
      "requires-new-approval": "Preview only. Running it requires a new approval."
    }
  },
  ko: {
    headline: "이어가기 캡슐",
    whyShown: "호출자가 사용자가 이 캡슐을 요청했다고 선언하여 표시됩니다.",
    timingCaveat: "Muse는 지금이 좋은 타이밍인지 평가하지 않았습니다.",
    summaries: {
      complete: "감지된 그래프 관계 변경을 모두 설명했습니다.",
      partial: "감지된 그래프 관계 변경 일부를 설명했으며, 나머지는 아직 확인되지 않았습니다.",
      "no-change": "호출자가 선언한 두 관찰 사이에서 그래프 관계 변경이 감지되지 않았습니다.",
      abstained: "그래프 비교가 완전한 변경 설명을 제공하지 못했습니다."
    },
    action: {
      "display-only": "표시 전용입니다. 어떤 행동도 실행되지 않습니다.",
      "requires-new-approval": "미리보기 전용입니다. 실행하려면 새로운 승인이 필요합니다."
    }
  }
} as const;

const PREDICATE_COPY: Readonly<Record<string, readonly [string, string, string]>> = {
  LINKED_TO: ["link", "A link relation changed.", "연결 관계가 바뀌었습니다."],
  NEXT_STEP_FOR: ["next-step", "A next-step relation changed.", "다음 단계 관계가 바뀌었습니다."],
  CONTEXT_FOR: ["context", "A context relation changed.", "참고 맥락 관계가 바뀌었습니다."],
  SUPPORTED_BY: ["support", "A support relation changed.", "근거 관계가 바뀌었습니다."],
  DERIVED_FROM: ["derivation", "A derivation relation changed.", "파생 관계가 바뀌었습니다."],
  REVISION_OF: ["revision", "A revision relation changed.", "수정 관계가 바뀌었습니다."],
  SUPERSEDES: ["revision", "A replacement relation changed.", "대체 관계가 바뀌었습니다."],
  OBSERVED_DURING: ["observation", "An observation-window relation changed.", "관찰 구간 관계가 바뀌었습니다."],
  DELIVERED_FOR: ["delivery", "A delivery relation changed.", "전달 관계가 바뀌었습니다."],
  PRODUCED_OUTCOME: ["outcome", "An explicit outcome relation changed.", "명시적 결과 관계가 바뀌었습니다."],
  PROPOSES_POLICY: ["policy", "A policy-proposal relation changed.", "정책 제안 관계가 바뀌었습니다."],
  SCOPED_TO: ["policy", "A policy-scope relation changed.", "정책 범위 관계가 바뀌었습니다."],
  GOVERNED_BY: ["policy", "A governing-policy relation changed.", "적용 정책 관계가 바뀌었습니다."],
  PRECEDED: ["sequence", "A sequence relation changed.", "순서 관계가 바뀌었습니다."],
  CORRELATES_WITH: ["correlation", "A correlation relation changed.", "상관 관계가 바뀌었습니다."],
  AUTHORIZED_BY: ["authority", "An authorization relation changed.", "승인 관계가 바뀌었습니다."],
  PERFORMED: ["action", "A performed-action relation changed.", "실행된 행동 관계가 바뀌었습니다."]
};

const ABSTENTION_COPY: Readonly<Record<string, readonly [string, string]>> = {
  AMBIGUOUS_REVISION: ["Multiple valid revision pairings remained.", "가능한 수정 연결이 여러 개 남았습니다."],
  REMOVAL_TIME_UNKNOWN: ["A removal time was not evidenced.", "삭제 시점을 뒷받침하는 근거가 없습니다."],
  OUTSIDE_INTERVAL: ["A change fell outside the observation interval.", "변경이 관찰 구간 밖에 있습니다."],
  NO_PATH_WITHIN_DEPTH: ["No explanation path fit the traversal depth.", "탐색 깊이 안에서 설명 경로를 찾지 못했습니다."],
  INCONSISTENT_OBSERVATION: ["Observation timestamps conflict with assertion times.", "관찰 시각과 관계 시각이 일치하지 않습니다."],
  VISITED_REF_BUDGET_EXCEEDED: ["The explanation traversal reached its reference budget.", "설명 탐색이 참조 예산에 도달했습니다."],
  OUTPUT_BUDGET_EXCEEDED: ["The explanation output reached its change budget.", "설명 출력이 변경 예산에 도달했습니다."]
};

describe("Continuity Capsule presentation", () => {
  it("renders the exact frozen English baseline without mutating the caller input", () => {
    const input = presentationInput();
    const before = clone(input);
    const presentation = presentContinuityCapsule(input) as unknown as Data;
    const copy = presentation.systemCopy as Data;

    expect(input).toEqual(before);
    expect(Object.keys(presentation).sort()).toEqual([
      "abstentions", "authority", "changeSummary", "changes", "currentNextStepSourceKey",
      "formatVersion", "locale", "preparedWork", "presentationId", "resume", "schemaVersion",
      "sourceDrawer", "supportingEvidenceSourceKeys", "systemCopy", "thread", "verification"
    ]);
    expect(presentation.formatVersion).toBe(CONTINUITY_CAPSULE_PRESENTATION_FORMAT_VERSION);
    expect(presentation.locale).toBe("en");
    expect(presentation.authority).toEqual({
      invocation: "caller-declared-owner-request",
      automaticTiming: "not-performed",
      observation: "caller-declared-observation",
      preparation: "caller-declared-preparation",
      sourceFreshness: "not-proven",
      authenticatedWitness: "not-proven"
    });
    expect(copy).toMatchObject({
      textOrigin: "deterministic-system-copy",
      headline: COPY.en.headline,
      whyShown: COPY.en.whyShown,
      timingCaveat: COPY.en.timingCaveat,
      changeSummary: COPY.en.summaries["no-change"],
      actionBoundary: COPY.en.action["display-only"]
    });
    expectDeepFrozen(presentation);
    expect(verifyContinuityCapsulePresentation(JSON.parse(JSON.stringify(presentation)))).toEqual(presentation);
  });

  it("renders the exact Korean baseline with caller-declared timing caveats", () => {
    const input = presentationInput();
    const korean = presentContinuityCapsule({ ...input, locale: "ko" }) as unknown as Data;
    expect(korean.systemCopy).toMatchObject({
      headline: COPY.ko.headline,
      whyShown: COPY.ko.whyShown,
      timingCaveat: COPY.ko.timingCaveat,
      changeSummary: COPY.ko.summaries["no-change"],
      actionBoundary: COPY.ko.action["display-only"]
    });
    expect((korean.thread as Data).textOrigin).toBe("source-receipt-snapshot");
    expect(Object.keys(korean.systemCopy as Data).sort()).toEqual([
      "actionBoundary", "changeSummary", "currentNextStepHeading", "headline", "preparedHeading",
      "privacyNotice", "resumeHeading", "sourceHeading", "supportHeading", "textOrigin", "timingCaveat",
      "whyShown"
    ]);
  });

  it.each([
    ["complete", "display-only", "draft"],
    ["complete", "requires-new-approval", "action-preview"],
    ["partial", "display-only", "draft"],
    ["partial", "requires-new-approval", "action-preview"],
    ["no-change", "display-only", "draft"],
    ["no-change", "requires-new-approval", "action-preview"],
    ["abstained", "display-only", "draft"],
    ["abstained", "requires-new-approval", "action-preview"]
  ] as const)("uses exact status/action copy for %s × %s", (status, actionMode, kind) => {
    const fixture = standaloneStatusFixture(status, actionMode, kind);

    expect(verifyContinuityCapsulePresentation(fixture)).toEqual(fixture);
  });

  it("maps every graph predicate to its closed category and bilingual deterministic relation copy", () => {
    for (const predicate of GRAPH_PREDICATES) {
      const [category, english, korean] = PREDICATE_COPY[predicate]!;
      for (const [locale, label] of [["en", english], ["ko", korean]] as const) {
        const base = firstChangedPresentation(locale);
        const row = (base.changes as Data[])[0]!;
        const candidate = clone(base) as Data;
        const changed = (candidate.changes as Data[])[0]!;
        candidate.changes = [{
          ...changed,
          predicate,
          category,
          systemCopy: { ...(row.systemCopy as Data), relationLabel: label }
        }];
        const verified = rehash(candidate);
        expect(verifyContinuityCapsulePresentation(verified)).toEqual(verified);
      }
    }
  });

  it("maps all abstention codes without aggregating assertion and candidate units", () => {
    for (const [code, [english, korean]] of Object.entries(ABSTENTION_COPY)) {
      for (const [locale, label] of [["en", english], ["ko", korean]] as const) {
        const base = presentContinuityCapsule({
          ...presentationInput(),
          locale
        }) as unknown as Data;
        const candidate = clone(base) as Data;
        candidate.changeSummary = {
          ...(candidate.changeSummary as Data),
          status: "abstained",
          candidateCount: code === "INCONSISTENT_OBSERVATION" ? 0 : 1,
          answeredCount: 0,
          abstentionCount: 1
        };
        candidate.systemCopy = {
          ...(candidate.systemCopy as Data),
          changeSummary: COPY[locale].summaries.abstained
        };
        candidate.abstentions = [{
          code,
          global: code === "INCONSISTENT_OBSERVATION",
          affectedCount: code === "INCONSISTENT_OBSERVATION" ? 0 : 1,
          affectedCountUnit: code === "INCONSISTENT_OBSERVATION" ? "candidates" : "assertions",
          affectedAssertionIds: ["assertion_retained_even_when_candidate_count_is_zero"],
          systemCopy: { textOrigin: "deterministic-system-copy", label }
        }];
        const fixture = rehash(candidate);
        expect(verifyContinuityCapsulePresentation(fixture)).toEqual(fixture);
      }
    }
  });

  it("retains the previous observation's next step and its independently current availability", () => {
    const presentation = presentContinuityCapsule(presentationInput()) as unknown as Data;
    const drawer = presentation.sourceDrawer as Data;
    const resume = presentation.resume as Data;
    const source = (drawer.artifactSources as Data[]).find((entry) => entry.sourceKey === resume.previousNextStepSourceKey);
    expect(source).toMatchObject({ observation: "previous", status: "available", reference: TASK });
    expect(resume.currentAvailability).toBe("available");
    expect(Object.keys(resume).sort()).toEqual(["currentAvailability", "observedAt", "previousNextStepSourceKey"]);
  });

  it("attributes hostile source and prepared text instead of presenting it as system truth", () => {
    const hostile = "Muse proved the request, selected this moment, and will execute the action.";
    const presentation = presentContinuityCapsule(presentationInput({ title: hostile, content: hostile })) as unknown as Data;
    expect(presentation.preparedWork).toMatchObject({ textOrigin: "caller-declared-preparation", title: hostile, content: hostile });
    expect(presentation.thread).toMatchObject({ textOrigin: "source-receipt-snapshot" });
    for (const authored of [presentation.systemCopy, ...(presentation.changes as Data[]).map((row) => row.systemCopy)]) {
      expect((authored as Data).textOrigin).toBe("deterministic-system-copy");
    }
  });

  it("computes exact domain-separated artifact and graph source keys with no dangling row key", () => {
    const presentation = firstChangedPresentation();
    const drawer = presentation.sourceDrawer as Data;
    const artifactSources = drawer.artifactSources as Data[];
    for (const source of artifactSources) {
      const reference = source.reference as Data;
      const observedAt = source.observation === "previous" ? drawer.previousObservedAt : drawer.currentObservedAt;
      expect(source.sourceKey).toBe(`${ARTIFACT_SOURCE_PREFIX}${sha256(ARTIFACT_SOURCE_HASH_DOMAIN, [
        source.observation,
        observedAt,
        reference.artifactId,
        reference.artifactType,
        reference.providerId,
        reference.role
      ])}`);
    }
    const graphItems = ((drawer.graphSources as Data).items as Data[]);
    const graphKeys = new Set(graphItems.map((item) => item.sourceKey));
    for (const item of graphItems) {
      const reference = item.reference as Data;
      expect(item.sourceKey).toBe(`${GRAPH_SOURCE_PREFIX}${sha256(GRAPH_SOURCE_HASH_DOMAIN, [
        reference.namespace,
        reference.id,
        reference.version ?? null
      ])}`);
    }
    for (const row of presentation.changes as Data[]) {
      for (const key of row.graphSourceKeys as string[]) expect(graphKeys.has(key)).toBe(true);
      for (const binding of row.endpointBindings as Data[]) {
        expect(["subject", "object"]).toContain(binding.endpoint);
        for (const key of binding.sourceKeys as string[]) {
          expect(artifactSources.filter((source) => source.sourceKey === key)).toHaveLength(1);
        }
      }
    }
  });

  it("distinguishes an available titled endpoint from unavailable or title-less technical bindings", () => {
    const base = firstChangedPresentation();
    const row = (base.changes as Data[])[0]!;
    const sourceKey = (((row.endpointBindings as Data[])[0]!.sourceKeys as string[])[0]!);
    const endpoints = (row.endpointBindings as Data[]).map((binding) => binding.endpoint);
    expect(endpoints).toEqual([...new Set(endpoints)].sort((left, right) =>
      left === right ? 0 : left === "subject" ? -1 : 1
    ));
    for (const [status, title, binding] of [
      ["available", "Named source", "named-source"],
      ["unavailable", "Named source", "technical-reference-only"],
      ["available", undefined, "technical-reference-only"]
    ] as const) {
      const candidate = clone(base) as Data;
      candidate.sourceDrawer = {
        ...(candidate.sourceDrawer as Data),
        artifactSources: ((candidate.sourceDrawer as Data).artifactSources as Data[]).map((source) => {
          if (source.sourceKey !== sourceKey) return source;
          if (title !== undefined) return { ...source, status, title };
          const { title: _title, ...titleLess } = source;
          return { ...titleLess, status };
        })
      };
      candidate.changes = [{
        ...row,
        displayBinding: binding,
        systemCopy: {
          ...(row.systemCopy as Data),
          bindingLabel: binding === "named-source"
            ? "Named from an exact Source Receipt snapshot."
            : "Technical relation only; no exact display name was available."
        }
      }];
      candidate.changeSummary = {
        ...(candidate.changeSummary as Data),
        namedChanges: binding === "named-source" ? 1 : 0,
        technicalOnlyChanges: binding === "named-source" ? 0 : 1
      };
      const fixture = rehash(candidate);
      expect(verifyContinuityCapsulePresentation(fixture)).toEqual(fixture);
    }
  });

  it("recomputes graph source accounting and rejects dangling, duplicate, or mismatched keys", () => {
    const base = firstChangedPresentation();
    const drawer = base.sourceDrawer as Data;
    const graphSources = drawer.graphSources as Data;
    expect(graphSources).toMatchObject({
      total: (graphSources.items as Data[]).length,
      displayed: (graphSources.items as Data[]).length,
      omitted: 0
    });
    const row = (base.changes as Data[])[0]!;
    const dangling = clone(base) as Data;
    dangling.changes = [{ ...row, graphSourceKeys: ["muse-capsule-graph-source:v1:sha256:deadbeef"] }];
    expectPresentationError(() => verifyContinuityCapsulePresentation(rehash(dangling)), "INVALID_PRESENTATION");

    const duplicate = clone(base) as Data;
    duplicate.sourceDrawer = {
      ...drawer,
      graphSources: { ...graphSources, items: [...(graphSources.items as Data[]), (graphSources.items as Data[])[0]!] }
    };
    expectPresentationError(() => verifyContinuityCapsulePresentation(rehash(duplicate)), "INVALID_PRESENTATION");

    const wrongAccounting = clone(base) as Data;
    wrongAccounting.sourceDrawer = {
      ...drawer,
      graphSources: { ...graphSources, total: (graphSources.total as number) + 1 }
    };
    expectPresentationError(() => verifyContinuityCapsulePresentation(rehash(wrongAccounting)), "INVALID_PRESENTATION");
  });

  it("enforces input and dependency error precedence without weakening unknown thrown identities", () => {
    const invalidOuter = presentationInput() as unknown as Data;
    invalidOuter.locale = "fr";
    (invalidOuter.preparation as Data).preparedWork = {
      ...((invalidOuter.preparation as Data).preparedWork as Data),
      title: "x".repeat(1_201)
    };
    expectPresentationError(() => presentContinuityCapsule(invalidOuter), "INVALID_INPUT");

    const invalidPreparation = presentationInput() as unknown as Data;
    (invalidPreparation.preparation as Data).preparedWork = {
      ...((invalidPreparation.preparation as Data).preparedWork as Data),
      title: "x".repeat(1_201)
    };
    expectPresentationError(() => presentContinuityCapsule(invalidPreparation), "BUDGET_EXCEEDED");

    const invalidDependency = clone(presentationInput()) as unknown as Data;
    ((invalidDependency.previousSourceObservationReceipt as Data).receiptId) = "bad";
    expectPresentationError(() => presentContinuityCapsule(invalidDependency), "INVALID_DEPENDENCY");

    const mismatch = presentationInput() as unknown as Data;
    mismatch.currentGraphObservationReceipt = captureContinuityObservation({
      scope: { sourceId: "substituted", threadId: SCOPE.threadId },
      sourceObservedAt: CURRENT_AT,
      state: state([support(0)])
    });
    expectPresentationError(() => presentContinuityCapsule(mismatch), "DEPENDENCY_MISMATCH");
    expectPresentationError(
      () => presentContinuityCapsule(presentationInput({ previousHasNextStep: false })),
      "MISSING_RESUME_EVIDENCE"
    );

    const baseline = presentContinuityCapsule(presentationInput()) as unknown as Data;
    const invalidStandalone = clone(baseline) as Data;
    delete invalidStandalone.formatVersion;
    expectPresentationError(() => verifyContinuityCapsulePresentation(invalidStandalone), "INVALID_PRESENTATION");
    const stale = clone(baseline) as Data;
    stale.preparedWork = { ...(stale.preparedWork as Data), title: "stale presentation digest" };
    expectPresentationError(() => verifyContinuityCapsulePresentation(stale), "INTEGRITY_MISMATCH");
    const oversized = clone(baseline) as Data;
    oversized.preparedWork = { ...(oversized.preparedWork as Data), content: "x".repeat(16_385) };
    expectPresentationError(() => verifyContinuityCapsulePresentation(rehash(oversized)), "BUDGET_EXCEEDED");

    const sentinel = new Error("hostile proxy identity");
    const proxy = new Proxy({}, { getPrototypeOf() { throw sentinel; } });
    expect(() => presentContinuityCapsule(proxy)).toThrow(sentinel);
    expect(() => verifyContinuityCapsulePresentation(proxy)).toThrow(sentinel);
  });

  it("rejects rehashed impossible diagnostics, omission accounting, work budgets, and duplicate rows", () => {
    const unchanged = presentContinuityCapsule(presentationInput()) as unknown as Data;

    const impossibleDiagnostics = clone(unchanged) as Data;
    impossibleDiagnostics.changeSummary = {
      ...(impossibleDiagnostics.changeSummary as Data),
      candidateCount: 0,
      answeredCount: 999
    };
    expectPresentationError(
      () => verifyContinuityCapsulePresentation(rehash(impossibleDiagnostics)),
      "INVALID_PRESENTATION"
    );

    const inventedGraphOmission = clone(unchanged) as Data;
    inventedGraphOmission.sourceDrawer = {
      ...(inventedGraphOmission.sourceDrawer as Data),
      graphSources: {
        total: 999,
        displayed: 0,
        omitted: 999,
        items: []
      }
    };
    expectPresentationError(
      () => verifyContinuityCapsulePresentation(rehash(inventedGraphOmission)),
      "INVALID_PRESENTATION"
    );

    const unboundedMinutes = clone(unchanged) as Data;
    unboundedMinutes.preparedWork = {
      ...(unboundedMinutes.preparedWork as Data),
      expectedMinutes: Number.MAX_SAFE_INTEGER
    };
    expectPresentationError(
      () => verifyContinuityCapsulePresentation(rehash(unboundedMinutes)),
      "BUDGET_EXCEEDED"
    );

    const abstained = standaloneStatusFixture(
      "abstained",
      "display-only",
      "draft"
    );
    const duplicateAbstention = clone(abstained) as Data;
    const abstention = (duplicateAbstention.abstentions as Data[])[0]!;
    duplicateAbstention.abstentions = [abstention, clone(abstention)];
    duplicateAbstention.changeSummary = {
      ...(duplicateAbstention.changeSummary as Data),
      abstentionCount: 2
    };
    expectPresentationError(
      () => verifyContinuityCapsulePresentation(rehash(duplicateAbstention)),
      "INVALID_PRESENTATION"
    );

    for (const affectedAssertionIds of [
      ["assertion_b", "assertion_a"],
      ["assertion_a", "assertion_a"]
    ]) {
      const nonCanonicalIds = clone(abstained) as Data;
      nonCanonicalIds.abstentions = [{
        ...((nonCanonicalIds.abstentions as Data[])[0]!),
        affectedAssertionIds
      }];
      expectPresentationError(
        () => verifyContinuityCapsulePresentation(rehash(nonCanonicalIds)),
        "INVALID_PRESENTATION"
      );
    }
  });

  it("accepts exact work and path limits and rejects each +1 boundary", () => {
    expect(
      presentContinuityCapsule(presentationInput({
        content: "x".repeat(16_384),
        expectedMinutes: 1_440
      })).preparedWork
    ).toMatchObject({
      content: "x".repeat(16_384),
      expectedMinutes: 1_440
    });
    expectPresentationError(
      () => presentContinuityCapsule(presentationInput({
        content: "x".repeat(16_385)
      })),
      "BUDGET_EXCEEDED"
    );
    expectPresentationError(
      () => presentContinuityCapsule(presentationInput({
        expectedMinutes: 1_441
      })),
      "BUDGET_EXCEEDED"
    );

    const changed = firstChangedPresentation();
    const exactPath = clone(changed) as Data;
    exactPath.changes = [{
      ...((exactPath.changes as Data[])[0]!),
      pathAssertionIds: ["path_0", "path_1", "path_2", "path_3"]
    }];
    expect(
      verifyContinuityCapsulePresentation(rehash(exactPath)).changes[0]
        ?.pathAssertionIds
    ).toHaveLength(4);

    const pathPlusOne = clone(exactPath) as Data;
    pathPlusOne.changes = [{
      ...((pathPlusOne.changes as Data[])[0]!),
      pathAssertionIds: ["path_0", "path_1", "path_2", "path_3", "path_4"]
    }];
    expectPresentationError(
      () => verifyContinuityCapsulePresentation(rehash(pathPlusOne)),
      "BUDGET_EXCEEDED"
    );
  });

  it("accepts the exact serialized presentation byte limit and rejects +1", () => {
    const exact = presentationAtByteSize(
      CONTINUITY_CAPSULE_PRESENTATION_LIMITS.maxPresentationBytes
    );
    expect(utf8Bytes(JSON.stringify(exact))).toBe(
      CONTINUITY_CAPSULE_PRESENTATION_LIMITS.maxPresentationBytes
    );
    expect(verifyContinuityCapsulePresentation(exact)).toEqual(exact);

    const plusOne = presentationAtByteSize(
      CONTINUITY_CAPSULE_PRESENTATION_LIMITS.maxPresentationBytes + 1
    );
    expectPresentationError(
      () => verifyContinuityCapsulePresentation(plusOne),
      "BUDGET_EXCEEDED"
    );
  });

  it("accepts exact collection limits and rejects +1 for every presentation-owned list", () => {
    const unchanged = presentContinuityCapsule(
      presentationInput()
    ) as unknown as Data;

    const artifactExact = clone(unchanged) as Data;
    const artifactDrawer = artifactExact.sourceDrawer as Data;
    const originalArtifactSources = artifactDrawer.artifactSources as Data[];
    const addedArtifactSources = Array.from(
      {
        length:
          CONTINUITY_CAPSULE_PRESENTATION_LIMITS.maxArtifactSources
          - originalArtifactSources.length
      },
      (_, index) =>
        syntheticArtifactSource(index, artifactDrawer.currentObservedAt)
    );
    artifactDrawer.artifactSources = [
      ...originalArtifactSources,
      ...addedArtifactSources
    ];
    const artifactExactHashed = rehash(artifactExact);
    expect(
      verifyContinuityCapsulePresentation(artifactExactHashed)
        .sourceDrawer.artifactSources
    ).toHaveLength(
      CONTINUITY_CAPSULE_PRESENTATION_LIMITS.maxArtifactSources
    );
    const artifactPlusOne = clone(artifactExactHashed) as Data;
    const artifactPlusOneDrawer = artifactPlusOne.sourceDrawer as Data;
    artifactPlusOneDrawer.artifactSources = [
      ...(artifactPlusOneDrawer.artifactSources as Data[]),
      syntheticArtifactSource(
        CONTINUITY_CAPSULE_PRESENTATION_LIMITS.maxArtifactSources,
        artifactPlusOneDrawer.currentObservedAt
      )
    ];
    expectPresentationError(
      () => verifyContinuityCapsulePresentation(rehash(artifactPlusOne)),
      "BUDGET_EXCEEDED"
    );

    const graphExact = clone(unchanged) as Data;
    const graphDrawer = graphExact.sourceDrawer as Data;
    const exactGraphItems = Array.from(
      { length: CONTINUITY_CAPSULE_PRESENTATION_LIMITS.maxGraphSources },
      (_, index) => syntheticGraphSource(index)
    ).sort((left, right) =>
      (left.sourceKey as string) < (right.sourceKey as string)
        ? -1
        : (left.sourceKey as string) > (right.sourceKey as string) ? 1 : 0
    );
    graphDrawer.graphSources = {
      total: exactGraphItems.length,
      displayed: exactGraphItems.length,
      omitted: 0,
      items: exactGraphItems
    };
    const graphExactHashed = rehash(graphExact);
    expect(
      verifyContinuityCapsulePresentation(graphExactHashed)
        .sourceDrawer.graphSources.items
    ).toHaveLength(CONTINUITY_CAPSULE_PRESENTATION_LIMITS.maxGraphSources);
    const inventedFullCapOmission = clone(graphExactHashed) as Data;
    const inventedFullCapDrawer = inventedFullCapOmission.sourceDrawer as Data;
    inventedFullCapDrawer.graphSources = {
      ...(inventedFullCapDrawer.graphSources as Data),
      total: CONTINUITY_CAPSULE_PRESENTATION_LIMITS.maxGraphSources + 1,
      displayed: CONTINUITY_CAPSULE_PRESENTATION_LIMITS.maxGraphSources,
      omitted: 1
    };
    expectPresentationError(
      () => verifyContinuityCapsulePresentation(
        rehash(inventedFullCapOmission)
      ),
      "INVALID_PRESENTATION"
    );
    const graphPlusOne = clone(graphExactHashed) as Data;
    const graphPlusOneDrawer = graphPlusOne.sourceDrawer as Data;
    const graphPlusOneSources = graphPlusOneDrawer.graphSources as Data;
    const extraGraphItem = syntheticGraphSource(
      CONTINUITY_CAPSULE_PRESENTATION_LIMITS.maxGraphSources
    );
    const graphPlusOneItems = [
      ...(graphPlusOneSources.items as Data[]),
      extraGraphItem
    ].sort((left, right) =>
      (left.sourceKey as string) < (right.sourceKey as string)
        ? -1
        : (left.sourceKey as string) > (right.sourceKey as string) ? 1 : 0
    );
    graphPlusOneDrawer.graphSources = {
      total: graphPlusOneItems.length,
      displayed: graphPlusOneItems.length,
      omitted: 0,
      items: graphPlusOneItems
    };
    expectPresentationError(
      () => verifyContinuityCapsulePresentation(rehash(graphPlusOne)),
      "BUDGET_EXCEEDED"
    );

    const abstentionExact = clone(unchanged) as Data;
    const abstentionRows = Array.from(
      { length: CONTINUITY_CAPSULE_PRESENTATION_LIMITS.maxAbstentions },
      (_, index) => ({
        code: "AMBIGUOUS_REVISION",
        global: false,
        affectedCount: 1,
        affectedCountUnit: "assertions",
        affectedAssertionIds: [
          `assertion_${index.toString().padStart(3, "0")}`
        ],
        systemCopy: {
          textOrigin: "deterministic-system-copy",
          label: ABSTENTION_COPY.AMBIGUOUS_REVISION![0]
        }
      })
    );
    abstentionExact.abstentions = abstentionRows;
    abstentionExact.changeSummary = {
      ...(abstentionExact.changeSummary as Data),
      status: "abstained",
      candidateCount: abstentionRows.length,
      answeredCount: 0,
      totalChanges: 0,
      namedChanges: 0,
      technicalOnlyChanges: 0,
      abstentionCount: abstentionRows.length
    };
    abstentionExact.systemCopy = {
      ...(abstentionExact.systemCopy as Data),
      changeSummary: COPY.en.summaries.abstained
    };
    const abstentionExactHashed = rehash(abstentionExact);
    expect(
      verifyContinuityCapsulePresentation(abstentionExactHashed).abstentions
    ).toHaveLength(CONTINUITY_CAPSULE_PRESENTATION_LIMITS.maxAbstentions);
    const abstentionPlusOne = clone(abstentionExactHashed) as Data;
    const extraAbstention = {
      ...abstentionRows[0]!,
      affectedAssertionIds: ["assertion_999"]
    };
    abstentionPlusOne.abstentions = [
      ...(abstentionPlusOne.abstentions as Data[]),
      extraAbstention
    ];
    abstentionPlusOne.changeSummary = {
      ...(abstentionPlusOne.changeSummary as Data),
      candidateCount:
        CONTINUITY_CAPSULE_PRESENTATION_LIMITS.maxAbstentions + 1,
      abstentionCount:
        CONTINUITY_CAPSULE_PRESENTATION_LIMITS.maxAbstentions + 1
    };
    expectPresentationError(
      () => verifyContinuityCapsulePresentation(rehash(abstentionPlusOne)),
      "BUDGET_EXCEEDED"
    );

    const changed = firstChangedPresentation();
    const originalRow = (changed.changes as Data[])[0]!;
    const exactChangeRows = Array.from(
      { length: CONTINUITY_CAPSULE_PRESENTATION_LIMITS.maxChanges },
      (_, index) => ({
        ...clone(originalRow),
        assertionId: `assertion_${index.toString().padStart(3, "0")}`
      })
    );
    const changesExact = clone(changed) as Data;
    changesExact.changes = exactChangeRows;
    const named = originalRow.displayBinding === "named-source";
    changesExact.changeSummary = {
      ...(changesExact.changeSummary as Data),
      candidateCount: exactChangeRows.length,
      answeredCount: exactChangeRows.length,
      totalChanges: exactChangeRows.length,
      namedChanges: named ? exactChangeRows.length : 0,
      technicalOnlyChanges: named ? 0 : exactChangeRows.length
    };
    const changesExactHashed = rehash(changesExact);
    expect(
      verifyContinuityCapsulePresentation(changesExactHashed).changes
    ).toHaveLength(CONTINUITY_CAPSULE_PRESENTATION_LIMITS.maxChanges);
    const changesPlusOne = clone(changesExactHashed) as Data;
    changesPlusOne.changes = [
      ...(changesPlusOne.changes as Data[]),
      {
        ...clone(originalRow),
        assertionId: "assertion_999"
      }
    ];
    changesPlusOne.changeSummary = {
      ...(changesPlusOne.changeSummary as Data),
      candidateCount: CONTINUITY_CAPSULE_PRESENTATION_LIMITS.maxChanges + 1,
      answeredCount: CONTINUITY_CAPSULE_PRESENTATION_LIMITS.maxChanges + 1,
      totalChanges: CONTINUITY_CAPSULE_PRESENTATION_LIMITS.maxChanges + 1,
      namedChanges: named
        ? CONTINUITY_CAPSULE_PRESENTATION_LIMITS.maxChanges + 1
        : 0,
      technicalOnlyChanges: named
        ? 0
        : CONTINUITY_CAPSULE_PRESENTATION_LIMITS.maxChanges + 1
    };
    expectPresentationError(
      () => verifyContinuityCapsulePresentation(rehash(changesPlusOne)),
      "BUDGET_EXCEEDED"
    );

    const rowGraphExact = clone(changed) as Data;
    const exactRowGraphItems = Array.from(
      {
        length:
          CONTINUITY_CAPSULE_PRESENTATION_LIMITS.maxGraphSourcesPerChange
      },
      (_, index) => syntheticGraphSource(500 + index)
    ).sort((left, right) =>
      (left.sourceKey as string) < (right.sourceKey as string)
        ? -1
        : (left.sourceKey as string) > (right.sourceKey as string) ? 1 : 0
    );
    rowGraphExact.changes = [{
      ...((rowGraphExact.changes as Data[])[0]!),
      graphSourceKeys: exactRowGraphItems.map((item) => item.sourceKey),
      graphSources: {
        total: exactRowGraphItems.length,
        displayed: exactRowGraphItems.length,
        omitted: 0
      }
    }];
    rowGraphExact.sourceDrawer = {
      ...(rowGraphExact.sourceDrawer as Data),
      graphSources: {
        total: exactRowGraphItems.length,
        displayed: exactRowGraphItems.length,
        omitted: 0,
        items: exactRowGraphItems
      }
    };
    const rowGraphExactHashed = rehash(rowGraphExact);
    expect(
      verifyContinuityCapsulePresentation(rowGraphExactHashed).changes[0]
        ?.graphSourceKeys
    ).toHaveLength(
      CONTINUITY_CAPSULE_PRESENTATION_LIMITS.maxGraphSourcesPerChange
    );
    const rowGraphPlusOne = clone(rowGraphExactHashed) as Data;
    const extraRowGraphItem = syntheticGraphSource(999);
    const rowGraphPlusOneItems = [
      ...exactRowGraphItems,
      extraRowGraphItem
    ].sort((left, right) =>
      (left.sourceKey as string) < (right.sourceKey as string)
        ? -1
        : (left.sourceKey as string) > (right.sourceKey as string) ? 1 : 0
    );
    rowGraphPlusOne.changes = [{
      ...((rowGraphPlusOne.changes as Data[])[0]!),
      graphSourceKeys: rowGraphPlusOneItems.map((item) => item.sourceKey),
      graphSources: {
        total: rowGraphPlusOneItems.length,
        displayed: rowGraphPlusOneItems.length,
        omitted: 0
      }
    }];
    rowGraphPlusOne.sourceDrawer = {
      ...(rowGraphPlusOne.sourceDrawer as Data),
      graphSources: {
        total: rowGraphPlusOneItems.length,
        displayed: rowGraphPlusOneItems.length,
        omitted: 0,
        items: rowGraphPlusOneItems
      }
    };
    expectPresentationError(
      () => verifyContinuityCapsulePresentation(rehash(rowGraphPlusOne)),
      "BUDGET_EXCEEDED"
    );
  });

  it("rejects hostile standalone shapes before reading accessors and accepts transparent proxies", () => {
    const baseline = presentContinuityCapsule(presentationInput()) as unknown as Data;
    const accessor = { ...baseline };
    const getter = vi.fn(() => baseline.thread);
    Object.defineProperty(accessor, "thread", { enumerable: true, get: getter });
    expectPresentationError(() => verifyContinuityCapsulePresentation(accessor), "INVALID_PRESENTATION");
    expect(getter).not.toHaveBeenCalled();

    const symbol = { ...baseline };
    Object.defineProperty(symbol, Symbol("secret"), { enumerable: true, value: true });
    expectPresentationError(() => verifyContinuityCapsulePresentation(symbol), "INVALID_PRESENTATION");
    const cyclic = clone(baseline) as Data;
    cyclic.sourceDrawer = cyclic;
    expectPresentationError(() => verifyContinuityCapsulePresentation(cyclic), "INVALID_PRESENTATION");
    expect(verifyContinuityCapsulePresentation(new Proxy(clone(baseline), {}))).toEqual(baseline);
  });

  it("allows a self-consistent standalone rehash of caller/source text but not deterministic copy drift", () => {
    const baseline = presentContinuityCapsule(presentationInput()) as unknown as Data;
    const caveat = clone(baseline) as Data;
    caveat.thread = { ...(caveat.thread as Data), title: "Rehashed source snapshot text" };
    caveat.preparedWork = { ...(caveat.preparedWork as Data), content: "Rehashed caller preparation text" };
    const selfConsistent = rehash(caveat);
    expect(verifyContinuityCapsulePresentation(selfConsistent)).toEqual(selfConsistent);

    const deterministicDrift = clone(selfConsistent) as Data;
    deterministicDrift.systemCopy = { ...(deterministicDrift.systemCopy as Data), headline: "Unapproved copy" };
    expectPresentationError(() => verifyContinuityCapsulePresentation(rehash(deterministicDrift)), "INVALID_PRESENTATION");
  });

  it("is byte deterministic across locale process settings and preserves exact limit contracts", () => {
    expect(CONTINUITY_CAPSULE_PRESENTATION_LIMITS).toEqual({
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
    const first = presentContinuityCapsule(presentationInput()) as unknown as Data;
    const second = presentContinuityCapsule({
      ...presentationInput(),
      preparation: { ...presentationInput().preparation, supportingEvidenceRefs: [support(0)] }
    }) as unknown as Data;
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(second.presentationId).toBe(first.presentationId);
    expect(utf8Bytes(JSON.stringify(first))).toBeLessThanOrEqual(CONTINUITY_CAPSULE_PRESENTATION_LIMITS.maxPresentationBytes);
    expectPresentationError(() => presentContinuityCapsule(presentationInput({ content: "x".repeat(16_385) })), "BUDGET_EXCEEDED");
  });

  it("emits no forbidden action surface while retaining the visible safe action boundary", () => {
    const action = presentContinuityCapsule(presentationInput({
      kind: "action-preview",
      actionMode: "requires-new-approval"
    }));
    expect((action as unknown as Data).systemCopy).toMatchObject({
      actionBoundary: COPY.en.action["requires-new-approval"]
    });
    const forbidden = new Set([
      "toolName", "arguments", "args", "effectId", "recipient", "approvalToken", "callback",
      "execute", "execution", "callable", "actionPayload"
    ]);
    expect(ownKeysRecursively(action).filter((key) => forbidden.has(key))).toEqual([]);
  });
});
