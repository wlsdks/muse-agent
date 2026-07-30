import {
  createLocalAttunementSnapshotProviderForTesting
} from "../../attunement/src/local-attunement-snapshot-provider.js";
import {
  fingerprintContinuityTaskState,
  type ArtifactReference,
  type ContinuityPack,
  type ContinuityPolicy
} from "@muse/attunement";
import {
  captureScopedContinuitySourceObservation
} from "@muse/attunement/continuity-source-observations";
import type {
  LocalAttunementSnapshotHeadRevalidation
} from "@muse/attunement/continuity-snapshots";
import { parseAttunementState } from "@muse/attunement/state-validation";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CONTINUITY_RESUME_RUNTIME_LIMITS,
  createContinuityResumeRuntimeCaptureAdapter,
  createContinuityResumeRuntimeCoordinator,
  getContinuityResumeRuntimePack,
  presentContinuityResumeRuntimeCapsule,
  validateContinuityResumeRuntimeCapsuleRequest,
  type ContinuityResumeRuntimeCaptureV1
} from "./continuity-resume-runtime.js";
import {
  compileHeadRevalidatedProviderBoundGraphEvidence
} from "./provider-head-revalidated-graph-evidence.js";

vi.mock("@muse/attunement/continuity-snapshots", async () =>
  import("../../attunement/src/continuity-snapshots.js")
);

const SOURCE_ID = "resume-runtime-test";
const BASE_AT = Date.parse("2026-07-30T00:00:00.000Z");
const POLICY: ContinuityPolicy = Object.freeze({
  detail: "compact",
  nextStep: "direct",
  suppression: "none",
  version: 0
});
const UPDATED_POLICY: ContinuityPolicy = Object.freeze({
  detail: "standard",
  nextStep: "direct",
  suppression: "none",
  version: 0
});

function reference(threadId: string): ArtifactReference {
  return Object.freeze({
    artifactId: `task_${threadId}`,
    artifactType: "task",
    providerId: "local",
    role: "next-step"
  });
}

function supportReference(
  threadId: string,
  suffix: string
): ArtifactReference {
  return Object.freeze({
    artifactId: `task_${threadId}_${suffix}`,
    artifactType: "task",
    providerId: "local",
    role: "context"
  });
}

function pack(
  threadId: string,
  title = `Thread ${threadId}`,
  policy: ContinuityPolicy = POLICY,
  extraReferences: readonly ArtifactReference[] = []
): ContinuityPack {
  const nextStep = {
    ...reference(threadId),
    taskStatus: "open" as const,
    title: `Task ${threadId}`
  };
  return {
    deliveryPolicyVersion: policy.version,
    evidence: [{
      artifact: nextStep,
      reference: reference(threadId),
      status: "available"
    }, ...extraReferences.map((extra) => ({
      artifact: {
        ...extra,
        taskStatus: "open" as const,
        title: `Support ${extra.artifactId}`
      },
      reference: extra,
      status: "available" as const
    }))],
    evidenceRefs: [reference(threadId), ...extraReferences],
    interactionAnchor: {
      artifactId: nextStep.artifactId,
      linkedAt: "2026-07-29T23:30:00.000Z",
      observedStatus: "open",
      openStateFingerprint: fingerprintContinuityTaskState({
        artifactId: nextStep.artifactId,
        status: "open",
        updatedAt: ""
      }),
      providerId: "local",
      role: "next-step"
    },
    nextStep,
    policy,
    thread: { id: threadId, kind: "work", title }
  };
}

function state(
  threadId: string,
  title = `Thread ${threadId}`,
  policy: ContinuityPolicy = POLICY,
  extraReferences: readonly ArtifactReference[] = []
) {
  return parseAttunementState({
    deliveries: [],
    interactionReceipts: [],
    nextPolicyVersion: policy.version + 1,
    resetReceipts: [],
    schemaVersion: 11,
    threads: [{
      createdAt: "2026-07-29T23:00:00.000Z",
      id: threadId,
      kind: "work",
      links: [{
        ...reference(threadId),
        linkedAt: "2026-07-29T23:30:00.000Z",
        linkedBy: "user",
        threadId
      }, ...extraReferences.map((extra, index) => ({
        ...extra,
        linkedAt: new Date(
          BASE_AT + (index === 0 ? 30 * 60_000 : 0)
        ).toISOString(),
        linkedBy: "user" as const,
        threadId
      }))],
      policy,
      title
    }],
    undoResetReceipts: []
  });
}

async function capture(
  threadId: string,
  observedAtMs = BASE_AT,
  title = `Thread ${threadId}`,
  policy: ContinuityPolicy = POLICY,
  providerSpanMs = 25,
  providerMaxCaptureSpanMs = 25,
  extraReferences: readonly ArtifactReference[] = []
): Promise<ContinuityResumeRuntimeCaptureV1> {
  let clockCalls = 0;
  const provider = createLocalAttunementSnapshotProviderForTesting(
    {
      attunementFile: "/configured/attunement.json",
      sourceId: SOURCE_ID
    },
    {
      readState: async () => ({
        state: state(threadId, title, policy, extraReferences),
        status: "available" as const
      }),
      clock: () => new Date(
        observedAtMs + (clockCalls++ === 0 ? 0 : providerSpanMs)
      )
    }
  );
  const artifact = await provider.captureHeadRevalidation(
    { sourceId: SOURCE_ID, threadId },
    { maxCaptureSpanMs: providerMaxCaptureSpanMs }
  );
  const currentProviderResult =
    await compileHeadRevalidatedProviderBoundGraphEvidence(artifact);
  if (currentProviderResult.status !== "partial") {
    throw new Error("partial Provider fixture required");
  }
  return Object.freeze({
    currentProviderResult,
    currentSourceObservationReceipt:
      captureScopedContinuitySourceObservation({
        observedAt: new Date(observedAtMs).toISOString(),
        pack: pack(threadId, title, policy, extraReferences),
        scope: { sourceId: SOURCE_ID, threadId }
      })
  });
}

async function headRevalidation(
  threadId: string,
  observedAtMs = BASE_AT
): Promise<LocalAttunementSnapshotHeadRevalidation> {
  let clockCalls = 0;
  const provider = createLocalAttunementSnapshotProviderForTesting(
    {
      attunementFile: "/configured/attunement.json",
      sourceId: SOURCE_ID
    },
    {
      readState: async () => ({
        state: state(threadId),
        status: "available" as const
      }),
      clock: () => new Date(
        observedAtMs + (clockCalls++ === 0 ? 0 : 25)
      )
    }
  );
  return provider.captureHeadRevalidation(
    { sourceId: SOURCE_ID, threadId },
    { maxCaptureSpanMs: 1_000 }
  );
}

async function staleCapture(
  threadId: string
): Promise<ContinuityResumeRuntimeCaptureV1> {
  let reads = 0;
  let clockCalls = 0;
  const provider = createLocalAttunementSnapshotProviderForTesting(
    {
      attunementFile: "/configured/attunement.json",
      sourceId: SOURCE_ID
    },
    {
      readState: async () => ({
        state: state(threadId, reads++ === 0 ? "Before" : "After"),
        status: "available" as const
      }),
      clock: () => new Date(
        BASE_AT + (clockCalls++ === 0 ? 0 : 25)
      )
    }
  );
  const artifact = await provider.captureHeadRevalidation(
    { sourceId: SOURCE_ID, threadId },
    { maxCaptureSpanMs: 25 }
  );
  return Object.freeze({
    currentProviderResult:
      await compileHeadRevalidatedProviderBoundGraphEvidence(artifact),
    currentSourceObservationReceipt:
      captureScopedContinuitySourceObservation({
        observedAt: new Date(BASE_AT).toISOString(),
        pack: pack(threadId),
        scope: { sourceId: SOURCE_ID, threadId }
      })
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function expectFrozenTree(
  value: unknown,
  seen = new WeakSet<object>()
): void {
  if (typeof value !== "object" || value === null || seen.has(value)) return;
  seen.add(value);
  expect(Object.isFrozen(value)).toBe(true);
  for (const descriptor of Object.values(
    Object.getOwnPropertyDescriptors(value)
  )) {
    if ("value" in descriptor) expectFrozenTree(descriptor.value, seen);
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe("continuity resume runtime coordinator", () => {
  it("binds out-of-order exact Packs by identity without freezing resolver objects", async () => {
    const threadIds = ["thread_adapter_a", "thread_adapter_b"] as const;
    const artifacts = new Map(threadIds.map((threadId) => [
      reference(threadId).artifactId,
      {
        ...reference(threadId),
        taskStatus: "open" as const,
        title: `Mutable resolver artifact ${threadId}`
      }
    ]));
    const revalidations = await Promise.all(
      threadIds.map((threadId, index) =>
        headRevalidation(threadId, BASE_AT + index * 60_000)
      )
    );
    const pending = revalidations.map(() =>
      deferred<LocalAttunementSnapshotHeadRevalidation>()
    );
    const providerBounds: number[] = [];
    const adapter = createContinuityResumeRuntimeCaptureAdapter({
      captureHeadRevalidation: async (scope, options) => {
        providerBounds.push(options.maxCaptureSpanMs);
        const index = threadIds.indexOf(
          scope.threadId as typeof threadIds[number]
        );
        if (index < 0) throw new Error("unexpected adapter scope");
        return pending[index]!.promise;
      },
      resolveExactArtifact: async (link) =>
        artifacts.get(link.artifactId)
    });
    const coordinator =
      createContinuityResumeRuntimeCoordinator({
        captureCurrent: adapter
      });
    const first = coordinator.preview({
      sourceId: SOURCE_ID,
      threadId: threadIds[0]
    });
    const second = coordinator.preview({
      sourceId: SOURCE_ID,
      threadId: threadIds[1]
    });
    pending[1]!.resolve(revalidations[1]!);
    const secondResult = await second;
    pending[0]!.resolve(revalidations[0]!);
    const firstResult = await first;

    for (const [result, threadId] of [
      [firstResult, threadIds[0]],
      [secondResult, threadIds[1]]
    ] as const) {
      expect(result).toMatchObject({
        status: "partial",
        state: "process-local-baseline-seeded"
      });
      const sidecar = getContinuityResumeRuntimePack(result);
      expect(sidecar?.thread.id).toBe(threadId);
      expectFrozenTree(sidecar);
      expect(Object.hasOwn(result, "pack")).toBe(false);
      expect(getContinuityResumeRuntimePack({ ...result })).toBeUndefined();
      expect(getContinuityResumeRuntimePack(
        structuredClone(result)
      )).toBeUndefined();
      expect(getContinuityResumeRuntimePack({ result })).toBeUndefined();
    }
    expect(providerBounds).toEqual([1_000, 1_000]);
    for (const artifact of artifacts.values()) {
      expect(Object.isFrozen(artifact)).toBe(false);
    }

    const traps = { get: 0, getOwnPropertyDescriptor: 0, ownKeys: 0 };
    const hostile = new Proxy(firstResult, {
      get() {
        traps.get += 1;
        throw new Error("sidecar getter must not reflect");
      },
      getOwnPropertyDescriptor() {
        traps.getOwnPropertyDescriptor += 1;
        throw new Error("sidecar getter must not inspect descriptors");
      },
      ownKeys() {
        traps.ownKeys += 1;
        throw new Error("sidecar getter must not inspect keys");
      }
    });
    expect(getContinuityResumeRuntimePack(hostile)).toBeUndefined();
    expect(traps).toEqual({ get: 0, getOwnPropertyDescriptor: 0, ownKeys: 0 });
  });

  it("truthfully seeds, reuses an identical baseline, then advances", async () => {
    const threadId = "thread_lifecycle";
    let at = BASE_AT;
    const coordinator = createContinuityResumeRuntimeCoordinator({
      captureCurrent: () => capture(threadId, at)
    });
    const scope = { sourceId: SOURCE_ID, threadId };

    expect(await coordinator.preview(scope)).toEqual({
      schemaVersion: 1,
      status: "partial",
      state: "process-local-baseline-seeded",
      reason: "no-prior-process-local-baseline",
      authority: {
        canAssertCurrentWorldTruth: false,
        canAssertSourceCompleteness: false,
        canGrantActionAuthority: false
      }
    });
    expect(await coordinator.preview(scope)).toMatchObject({
      status: "partial",
      state: "compared-with-baseline-reused",
      comparisonStatus: "no-change",
      resumeContextFacts: { status: "no-change", changes: [] }
    });
    at += 60 * 60_000;
    expect(await coordinator.preview(scope)).toMatchObject({
      status: "partial",
      state: "compared-and-advanced",
      comparisonStatus: "no-change"
    });
  });

  it("presents a Capsule only for an exact compared result and observation-bound preparation", async () => {
    const threadId = "thread_capsule";
    let at = BASE_AT;
    const evidenceOnlyCoordinator = createContinuityResumeRuntimeCoordinator({
      captureCurrent: () => capture(threadId, at)
    });
    const scope = { sourceId: SOURCE_ID, threadId };
    const request = {
      locale: "ko" as const,
      preparedWork: {
        content: "다음 초안을 검토합니다.",
        expectedMinutes: 15,
        kind: "action-preview" as const,
        title: "초안 준비"
      },
      supportingEvidenceRefs: [reference(threadId)]
    };
    await evidenceOnlyCoordinator.preview(scope);
    at += 60_000;
    const evidenceOnlyCompared =
      await evidenceOnlyCoordinator.preview(scope);
    expect(
      presentContinuityResumeRuntimeCapsule(evidenceOnlyCompared, request)
    ).toBeUndefined();

    at = BASE_AT;
    const revalidations = [
      await headRevalidation(threadId, at),
      await headRevalidation(threadId, at + 60_000)
    ];
    let revalidationIndex = 0;
    const adapter = createContinuityResumeRuntimeCaptureAdapter({
      captureHeadRevalidation: async () =>
        revalidations[revalidationIndex++]!,
      resolveExactArtifact: async (link) => ({
        artifactId: link.artifactId,
        artifactType: link.artifactType,
        providerId: link.providerId,
        role: link.role,
        taskStatus: "open" as const,
        title: `Task ${threadId}`
      })
    });
    const runtimeCaptures = [
      await adapter(scope),
      await adapter(scope)
    ];
    let captureIndex = 0;
    const coordinator = createContinuityResumeRuntimeCoordinator({
      captureCurrent: async () => runtimeCaptures[captureIndex++]!
    });
    const seeded = await coordinator.preview(scope);
    expect(presentContinuityResumeRuntimeCapsule(seeded, request)).toBeUndefined();
    at += 60_000;
    const compared = await coordinator.preview(scope);
    expect(compared).toMatchObject({ status: "partial" });
    expect(getContinuityResumeRuntimePack(compared)).toBeDefined();
    expect(validateContinuityResumeRuntimeCapsuleRequest(request)).toBeDefined();
    const capsule = presentContinuityResumeRuntimeCapsule(compared, request);
    expect(capsule).toMatchObject({
      locale: "ko",
      preparedWork: {
        actionMode: "requires-new-approval",
        kind: "action-preview",
        title: "초안 준비"
      },
      sourceDrawer: { preparedAt: new Date(at).toISOString() }
    });
    expect(Object.isFrozen(capsule)).toBe(true);
    expect(presentContinuityResumeRuntimeCapsule({ ...compared }, request)).toBeUndefined();
    expect(presentContinuityResumeRuntimeCapsule(structuredClone(compared), request)).toBeUndefined();
    expect(presentContinuityResumeRuntimeCapsule({ result: compared }, request)).toBeUndefined();

    const traps = { get: 0, getOwnPropertyDescriptor: 0, ownKeys: 0 };
    const wrapped = new Proxy(compared, {
      get() {
        traps.get += 1;
        throw new Error("capsule helper must not inspect wrapped results");
      },
      getOwnPropertyDescriptor() {
        traps.getOwnPropertyDescriptor += 1;
        throw new Error("capsule helper must not inspect wrapped results");
      },
      ownKeys() {
        traps.ownKeys += 1;
        throw new Error("capsule helper must not inspect wrapped results");
      }
    });
    expect(presentContinuityResumeRuntimeCapsule(wrapped, request)).toBeUndefined();
    expect(traps).toEqual({ get: 0, getOwnPropertyDescriptor: 0, ownKeys: 0 });
  });

  it("returns bounded semantic change context without raw evidence", async () => {
    const threadId = "thread_semantic";
    const policy: ContinuityPolicy = POLICY;
    let at = BASE_AT;
    let extraReferences: readonly ArtifactReference[] = [];
    const coordinator = createContinuityResumeRuntimeCoordinator({
      captureCurrent: () => capture(
        threadId,
        at,
        undefined,
        policy,
        25,
        25,
        extraReferences
      )
    });
    const scope = { sourceId: SOURCE_ID, threadId };
    await coordinator.preview(scope);
    extraReferences = [
      supportReference(threadId, "inside"),
      supportReference(threadId, "outside")
    ];
    at += 60 * 60_000;
    const result = await coordinator.preview(scope);
    if (result.status === "unavailable") throw new Error(result.reason);
    expect(result).toMatchObject({
      status: "partial",
      state: "compared-and-advanced",
      comparisonStatus: "partial",
      resumeContextFacts: {
        status: "partial"
      }
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toMatch(
      /receiptId|boundaryId|graphEvidence|reservation|combinedCost|inventory|frontier|ledger|contextStream/
    );
    expect(serialized).toContain("\"canAssertCurrentWorldTruth\":false");
    expectFrozenTree(result);
  });

  it("returns a complete comparison for one eligible in-interval addition", async () => {
    const threadId = "thread_complete";
    let at = BASE_AT;
    let extraReferences: readonly ArtifactReference[] = [];
    const coordinator = createContinuityResumeRuntimeCoordinator({
      captureCurrent: () => capture(
        threadId,
        at,
        undefined,
        POLICY,
        25,
        25,
        extraReferences
      )
    });
    const scope = { sourceId: SOURCE_ID, threadId };
    await coordinator.preview(scope);
    extraReferences = [supportReference(threadId, "complete")];
    at += 60 * 60_000;
    expect(await coordinator.preview(scope)).toMatchObject({
      status: "partial",
      state: "compared-and-advanced",
      comparisonStatus: "complete",
      resumeContextFacts: { status: "partial" }
    });
  });

  it("does not advance after an unusable comparison", async () => {
    const threadId = "thread_abstention";
    let at = BASE_AT;
    let policy: ContinuityPolicy = POLICY;
    const coordinator = createContinuityResumeRuntimeCoordinator({
      captureCurrent: () => capture(threadId, at, undefined, policy)
    });
    const scope = { sourceId: SOURCE_ID, threadId };
    await coordinator.preview(scope);
    at += 60_000;
    policy = UPDATED_POLICY;
    expect(await coordinator.preview(scope)).toMatchObject({
      status: "unavailable",
      reason: "resume-context-unavailable"
    });
    policy = POLICY;
    expect(await coordinator.preview(scope)).toMatchObject({
      status: "partial",
      state: "compared-and-advanced",
      comparisonStatus: "no-change"
    });
  });

  it("rejects regression and same-time conflicting evidence without advancing", async () => {
    const threadId = "thread_monotonic";
    let at = BASE_AT + 60_000;
    let policy: ContinuityPolicy = POLICY;
    const coordinator = createContinuityResumeRuntimeCoordinator({
      captureCurrent: () => capture(threadId, at, undefined, policy)
    });
    const scope = { sourceId: SOURCE_ID, threadId };
    await coordinator.preview(scope);

    at = BASE_AT;
    expect(await coordinator.preview(scope)).toMatchObject({
      status: "unavailable",
      reason: "observation-regressed"
    });
    at = BASE_AT + 60_000;
    policy = UPDATED_POLICY;
    expect(await coordinator.preview(scope)).toMatchObject({
      status: "unavailable",
      reason: "observation-conflict"
    });
    policy = POLICY;
    at += 60_000;
    const advanced = await coordinator.preview(scope);
    if (advanced.status === "unavailable") throw new Error(advanced.reason);
    expect(advanced).toMatchObject({
      status: "partial",
      state: "compared-and-advanced",
      comparisonStatus: "no-change"
    });
  });

  it("rejects same-scope overlap and a fifth live capture", async () => {
    const pending = Array.from({ length: 4 }, () =>
      deferred<ContinuityResumeRuntimeCaptureV1>()
    );
    let index = 0;
    const coordinator = createContinuityResumeRuntimeCoordinator({
      captureCurrent: () => pending[index++]!.promise
    });
    const scopes = pending.map((_, item) => ({
      sourceId: SOURCE_ID,
      threadId: `thread_capacity_${item}`
    }));
    const active = scopes.map((scope) => coordinator.preview(scope));
    await Promise.resolve();

    expect(await coordinator.preview(scopes[0]!)).toMatchObject({
      status: "unavailable",
      reason: "runtime-busy"
    });
    expect(await coordinator.preview({
      sourceId: SOURCE_ID,
      threadId: "thread_capacity_fifth"
    })).toMatchObject({
      status: "unavailable",
      reason: "runtime-capacity"
    });
    for (let item = 0; item < pending.length; item++) {
      pending[item]!.resolve(await capture(scopes[item]!.threadId));
    }
    await Promise.all(active);
  });

  it("does not seed from stale, mismatched, copied, or proxied evidence", async () => {
    const threadId = "thread_invalid_current";
    let mode:
      | "stale"
      | "mismatch"
      | "copied"
      | "proxied"
      | "valid" = "stale";
    const coordinator = createContinuityResumeRuntimeCoordinator({
      captureCurrent: async () => {
        if (mode === "stale") return staleCapture(threadId);
        const current = await capture(threadId);
        if (mode === "valid") return current;
        if (mode === "copied") {
          return Object.freeze({
            ...current,
            currentProviderResult: { ...current.currentProviderResult }
          }) as ContinuityResumeRuntimeCaptureV1;
        }
        if (mode === "proxied") {
          return Object.freeze({
            ...current,
            currentProviderResult:
              new Proxy(current.currentProviderResult, {})
          });
        }
        return Object.freeze({
          ...current,
          currentSourceObservationReceipt:
            captureScopedContinuitySourceObservation({
              observedAt: new Date(BASE_AT).toISOString(),
              pack: pack(threadId),
              scope: { sourceId: "other-source", threadId }
            })
        });
      }
    });
    const scope = { sourceId: SOURCE_ID, threadId };
    expect(await coordinator.preview(scope)).toMatchObject({
      status: "unavailable",
      reason: "provider-not-partial"
    });
    mode = "mismatch";
    expect(await coordinator.preview(scope)).toMatchObject({
      status: "unavailable",
      reason: "current-evidence-invalid"
    });
    mode = "copied";
    expect(await coordinator.preview(scope)).toMatchObject({
      status: "unavailable",
      reason: "current-evidence-invalid"
    });
    mode = "proxied";
    expect(await coordinator.preview(scope)).toMatchObject({
      status: "unavailable",
      reason: "current-evidence-invalid"
    });
    mode = "valid";
    expect(await coordinator.preview(scope)).toMatchObject({
      status: "partial",
      state: "process-local-baseline-seeded"
    });
  });

  it("rejects coordinator and Provider capture spans over the fixed bound", async () => {
    const threadId = "thread_capture_span";
    let nowCalls = 0;
    const coordinator = createContinuityResumeRuntimeCoordinator({
      captureCurrent: () => capture(threadId),
      monotonicNowMs: () => nowCalls++ === 0 ? 0 : 1_001
    });
    const scope = { sourceId: SOURCE_ID, threadId };
    expect(await coordinator.preview(scope)).toMatchObject({
      status: "unavailable",
      reason: "capture-span-exceeded"
    });
    expect(await coordinator.preview(scope)).toMatchObject({
      status: "partial",
      state: "process-local-baseline-seeded"
    });
    const providerOverBound =
      createContinuityResumeRuntimeCoordinator({
        captureCurrent: () => capture(
          threadId,
          BASE_AT,
          undefined,
          POLICY,
          25,
          2_000
        )
      });
    expect(await providerOverBound.preview(scope)).toMatchObject({
      status: "unavailable",
      reason: "capture-span-exceeded"
    });
  });

  it("retains four timed-out global slots until each late capture settles", async () => {
    vi.useFakeTimers();
    const late = Array.from(
      { length: CONTINUITY_RESUME_RUNTIME_LIMITS.maxInFlight },
      () => deferred<ContinuityResumeRuntimeCaptureV1>()
    );
    const replacement = deferred<ContinuityResumeRuntimeCaptureV1>();
    const calls = new Map<string, number>();
    const coordinator = createContinuityResumeRuntimeCoordinator({
      captureCurrent: (scope) => {
        if (scope.threadId === "thread_timeout_replacement") {
          return replacement.promise;
        }
        const index = Number(scope.threadId.split("_").at(-1));
        const count = calls.get(scope.threadId) ?? 0;
        calls.set(scope.threadId, count + 1);
        return count === 0 && Number.isInteger(index) && late[index]
          ? late[index].promise
          : capture(scope.threadId);
      }
    });
    const scopes = late.map((_, index) => ({
      sourceId: SOURCE_ID,
      threadId: `thread_timeout_${index}`
    }));
    const timed = scopes.map((scope) => coordinator.preview(scope));
    await vi.advanceTimersByTimeAsync(
      CONTINUITY_RESUME_RUNTIME_LIMITS.operationTimeoutMs
    );
    for (const result of await Promise.all(timed)) {
      expect(result).toMatchObject({
        status: "unavailable",
        reason: "operation-timeout"
      });
    }
    expect(await coordinator.preview({
      sourceId: SOURCE_ID,
      threadId: "thread_after_four_timeouts"
    })).toMatchObject({
      status: "unavailable",
      reason: "runtime-capacity"
    });

    late[0]!.resolve(await capture(scopes[0]!.threadId, BASE_AT + 60_000));
    await Promise.resolve();
    await Promise.resolve();
    const replacementPreview = coordinator.preview({
      sourceId: SOURCE_ID,
      threadId: "thread_timeout_replacement"
    });
    await Promise.resolve();
    expect(await coordinator.preview({
      sourceId: SOURCE_ID,
      threadId: "thread_still_capacity_limited"
    })).toMatchObject({
      status: "unavailable",
      reason: "runtime-capacity"
    });
    replacement.resolve(await capture("thread_timeout_replacement"));
    expect(await replacementPreview).toMatchObject({
      state: "process-local-baseline-seeded"
    });
    expect(await coordinator.preview(scopes[0]!)).toMatchObject({
      status: "partial",
      state: "process-local-baseline-seeded"
    });
    for (let index = 1; index < late.length; index++) {
      late[index]!.resolve(await capture(scopes[index]!.threadId));
    }
    await Promise.resolve();
    await Promise.resolve();
  });

  it("evicts the least-recently-used baseline and isolates instances", async () => {
    const coordinator = createContinuityResumeRuntimeCoordinator({
      captureCurrent: (scope) => capture(scope.threadId)
    });
    const scopes = Array.from(
      { length: CONTINUITY_RESUME_RUNTIME_LIMITS.maxBaselines },
      (_, index) => ({
        sourceId: SOURCE_ID,
        threadId: `thread_lru_${index}`
      })
    );
    for (const scope of scopes) {
      expect(await coordinator.preview(scope)).toMatchObject({
        state: "process-local-baseline-seeded"
      });
    }
    expect(await coordinator.preview(scopes[0]!)).toMatchObject({
      state: "compared-with-baseline-reused"
    });
    const incoming = {
      sourceId: SOURCE_ID,
      threadId: "thread_lru_incoming"
    };
    expect(await coordinator.preview(incoming)).toMatchObject({
      state: "process-local-baseline-seeded"
    });
    expect(await coordinator.preview(scopes[0]!)).toMatchObject({
      state: "compared-with-baseline-reused"
    });
    expect(await coordinator.preview(scopes[1]!)).toMatchObject({
      state: "process-local-baseline-seeded"
    });
    const fresh = createContinuityResumeRuntimeCoordinator({
      captureCurrent: (scope) => capture(scope.threadId)
    });
    expect(await fresh.preview(scopes[0]!)).toMatchObject({
      state: "process-local-baseline-seeded"
    });
  });

  it("contains thrown capture failures without mutating the retained baseline or evidence", async () => {
    const threadId = "thread_capture_throw";
    const exact = await capture(threadId);
    const before = JSON.stringify(exact);
    let shouldThrow = false;
    let calls = 0;
    const coordinator = createContinuityResumeRuntimeCoordinator({
      captureCurrent: async () => {
        calls += 1;
        if (shouldThrow) throw new Error("fixture capture failure");
        return exact;
      }
    });
    const scope = { sourceId: SOURCE_ID, threadId };
    expect(await coordinator.preview(scope)).toMatchObject({
      state: "process-local-baseline-seeded"
    });
    shouldThrow = true;
    expect(await coordinator.preview(scope)).toMatchObject({
      status: "unavailable",
      reason: "capture-failed"
    });
    shouldThrow = false;
    expect(await coordinator.preview(scope)).toMatchObject({
      state: "compared-with-baseline-reused"
    });
    expect(calls).toBe(3);
    expect(JSON.stringify(exact)).toBe(before);
  });

  it("rejects hostile and malformed scopes before calling the dependency", async () => {
    let calls = 0;
    const coordinator = createContinuityResumeRuntimeCoordinator({
      captureCurrent: async () => {
        calls++;
        return capture("unreachable");
      }
    });
    const hostile = new Proxy({}, {
      ownKeys() {
        throw new Error("must be contained");
      }
    });
    await expect(coordinator.preview(
      hostile as { sourceId: string; threadId: string }
    )).resolves.toMatchObject({
      status: "unavailable",
      reason: "invalid-scope"
    });
    await expect(coordinator.preview({
      sourceId: "../bad",
      threadId: ""
    })).resolves.toMatchObject({
      status: "unavailable",
      reason: "invalid-scope"
    });
    expect(calls).toBe(0);
  });
});
