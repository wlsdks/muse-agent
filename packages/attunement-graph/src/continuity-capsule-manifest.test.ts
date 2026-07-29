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
  CONTINUITY_CAPSULE_MANIFEST_LIMITS,
  ContinuityCapsuleManifestError,
  compileContinuityCapsuleContext,
  compileContinuityCapsuleManifest,
  verifyContinuityCapsuleCompilation,
  verifyContinuityCapsuleManifest,
  type ContinuityCapsuleManifest
} from "./continuity-capsule-manifest.js";
import { captureContinuityObservation } from "./continuity-observation.js";

const PREVIOUS_AT = "2026-07-29T08:00:00.000Z";
const CURRENT_AT = "2026-07-29T10:00:00.000Z";
const SCOPE = { sourceId: "default", threadId: "thread_capsule" } as const;
const HASH_DOMAIN = "muse.attunement.continuity-capsule-manifest.v2\0";
const MANIFEST_ID_PREFIX = "muse-continuity-capsule-manifest:v2:sha256:";

type Data = Record<string, unknown>;
type ScopeFixture = { readonly sourceId: string; readonly threadId: string };

const TASK: ArtifactReference = {
  artifactId: "task_capsule",
  artifactType: "task",
  providerId: "local",
  role: "next-step"
};

function reference(index: number): ArtifactReference {
  return {
    artifactId: `note_capsule_${index.toString()}`,
    artifactType: "note",
    providerId: "local",
    role: "context"
  };
}

function resolvedArtifact(
  ref: ArtifactReference,
  summary?: string
): ResolvedArtifact {
  return {
    ...ref,
    ...(ref.artifactType === "task" ? { taskStatus: "open" as const } : {}),
    title: ref.artifactType === "task" ? "Resume booking" : `Support ${ref.artifactId}`,
    ...(summary === undefined ? {} : { summary })
  };
}

function links(
  supports: readonly ArtifactReference[],
  scope: ScopeFixture = SCOPE
): readonly ArtifactLink[] {
  return [
    {
      ...TASK,
      linkedAt: "2026-07-29T01:00:00.000Z",
      linkedBy: "user",
      threadId: scope.threadId
    },
    ...supports.map((entry, index) => ({
      ...entry,
      linkedAt: `2026-07-29T01:${(index + 1).toString().padStart(2, "0")}:00.000Z`,
      linkedBy: "user" as const,
      threadId: scope.threadId
    }))
  ];
}

function state(
  supports: readonly ArtifactReference[],
  scope: ScopeFixture = SCOPE
): AttunementState {
  return {
    deliveries: [],
    interactionReceipts: [],
    nextPolicyVersion: 1,
    resetReceipts: [],
    schemaVersion: 11,
    threads: [{
      createdAt: "2026-07-29T00:00:00.000Z",
      id: scope.threadId,
      kind: "work",
      links: links(supports, scope),
      policy: {
        detail: "compact",
        nextStep: "direct",
        suppression: "none",
        version: 0
      },
      title: "Private capsule thread"
    }],
    undoResetReceipts: []
  };
}

function sourceReceipt(
  observedAt: string,
  supports: readonly ArtifactReference[],
  summaries: readonly string[] = [],
  options: {
    readonly scope?: ScopeFixture;
    readonly hasNextStep?: boolean;
    readonly unavailableSupportIndexes?: readonly number[];
  } = {}
) {
  const scope = options.scope ?? SCOPE;
  const hasNextStep = options.hasNextStep ?? true;
  const unavailable = new Set(options.unavailableSupportIndexes ?? []);
  const taskArtifact = hasNextStep
    ? resolvedArtifact(TASK)
    : { ...TASK, title: "Resume booking" } as ResolvedArtifact;
  const evidence = [
    {
      artifact: taskArtifact,
      reference: TASK,
      status: "available" as const
    },
    ...supports.map((entry, index) => ({
      ...(unavailable.has(index) ? {} : { artifact: resolvedArtifact(entry, summaries[index]) }),
      reference: entry,
      status: unavailable.has(index) ? "unavailable" as const : "available" as const
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
    ...(hasNextStep ? { nextStep: resolvedArtifact(TASK) } : {}),
    policy: { detail: "compact", nextStep: "direct", suppression: "none", version: 0 },
    thread: { id: scope.threadId, kind: "work", title: "Private capsule thread" }
  };
  return captureScopedContinuitySourceObservation({ scope, observedAt, pack });
}

function graphReceipt(
  observedAt: string,
  supports: readonly ArtifactReference[],
  scope: ScopeFixture = SCOPE
) {
  return captureContinuityObservation({
    scope,
    sourceObservedAt: observedAt,
    state: state(supports, scope)
  });
}

function input(
  summaries: readonly string[] = ["Owner note"],
  preparedWork: Partial<Data> = {},
  supports: readonly ArtifactReference[] = summaries.map((_, index) =>
    reference(index)
  )
) {
  return {
    schemaVersion: 1,
    previousSourceObservationReceipt: sourceReceipt(PREVIOUS_AT, supports, summaries),
    previousGraphObservationReceipt: graphReceipt(PREVIOUS_AT, supports),
    currentSourceObservationReceipt: sourceReceipt(CURRENT_AT, supports, summaries),
    currentGraphObservationReceipt: graphReceipt(CURRENT_AT, supports),
    preparation: {
      preparedAt: CURRENT_AT,
      supportingEvidenceRefs: supports,
      preparedWork: {
        kind: "draft",
        actionMode: "display-only",
        title: "Prepare the booking draft",
        content: "Review the hotel options and prepare a draft.",
        expectedMinutes: 15,
        ...preparedWork
      }
    }
  };
}

function fixture(options: {
  readonly previousAt?: string;
  readonly currentAt?: string;
  readonly previousScope?: ScopeFixture;
  readonly currentScope?: ScopeFixture;
  readonly previousHasNextStep?: boolean;
  readonly currentHasNextStep?: boolean;
  readonly currentUnavailableSupportIndexes?: readonly number[];
  readonly summaries?: readonly string[];
} = {}) {
  const summaries = options.summaries ?? ["Owner note"];
  const supports = summaries.map((_, index) => reference(index));
  const previousAt = options.previousAt ?? PREVIOUS_AT;
  const currentAt = options.currentAt ?? CURRENT_AT;
  const previousScope = options.previousScope ?? SCOPE;
  const currentScope = options.currentScope ?? SCOPE;
  return {
    schemaVersion: 1,
    previousSourceObservationReceipt: sourceReceipt(previousAt, supports, summaries, {
      scope: previousScope,
      hasNextStep: options.previousHasNextStep
    }),
    previousGraphObservationReceipt: graphReceipt(previousAt, supports, previousScope),
    currentSourceObservationReceipt: sourceReceipt(currentAt, supports, summaries, {
      scope: currentScope,
      hasNextStep: options.currentHasNextStep,
      unavailableSupportIndexes: options.currentUnavailableSupportIndexes
    }),
    currentGraphObservationReceipt: graphReceipt(currentAt, supports, currentScope),
    preparation: {
      preparedAt: currentAt,
      supportingEvidenceRefs: supports,
      preparedWork: {
        kind: "draft",
        actionMode: "display-only",
        title: "Prepare the booking draft",
        content: "Review the hotel options and prepare a draft.",
        expectedMinutes: 15
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
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonical);
  return Object.fromEntries(Object.entries(value as Data).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, canonical(child)]));
}

function rehash(manifest: ContinuityCapsuleManifest): ContinuityCapsuleManifest {
  const { manifestId: _manifestId, ...body } = manifest;
  return {
    ...body,
    manifestId: `${MANIFEST_ID_PREFIX}${createHash("sha256")
      .update(HASH_DOMAIN, "utf8")
      .update(JSON.stringify(canonical(body)), "utf8")
      .digest("hex")}`
  };
}

function expectCapsuleError(fn: () => unknown, code: ContinuityCapsuleManifestError["code"]): void {
  try {
    fn();
    throw new Error("expected capsule manifest operation to fail");
  } catch (cause) {
    expect(cause).toBeInstanceOf(ContinuityCapsuleManifestError);
    expect((cause as ContinuityCapsuleManifestError).code).toBe(code);
  }
}

describe("Continuity Capsule Manifest", () => {
  it("compiles frozen render-ready snapshots and keeps all inputs unchanged", () => {
    const compilerInput = input();
    const before = clone(compilerInput);
    const compilation = compileContinuityCapsuleManifest(compilerInput);
    const roundTrip = verifyContinuityCapsuleManifest(JSON.parse(JSON.stringify(compilation.manifest)));

    expect(compilerInput).toEqual(before);
    expect(roundTrip).toEqual(compilation.manifest);
    expect(compilation.manifest.formatVersion).toBe("muse.continuity-capsule-manifest.v2");
    expect(compilation.manifest.manifestId.startsWith(MANIFEST_ID_PREFIX)).toBe(true);
    expect(compilation.manifest.previousNextStep.reference).toEqual(TASK);
    expect(compilation.manifest.previousNextStepCurrentAvailability).toBe("available");
    expect(compilation.manifest.currentNextStep.title).toBe("Resume booking");
    expect(compilation.manifest.supportingEvidence[0]?.summary).toBe("Owner note");
    expect(compilation.manifest.preparedWork.actionMode).toBe("display-only");
    expect(Object.isFrozen(compilation)).toBe(true);
    expect(Object.isFrozen(compilation.manifest)).toBe(true);
    expect(Object.isFrozen(compilation.manifest.supportingEvidence)).toBe(true);
    expect(Object.isFrozen(compilation.manifest.supportingEvidence[0])).toBe(true);
  });

  it("compiles one internal context with the verified scoped source receipts", () => {
    const compilerInput = input();
    const context = compileContinuityCapsuleContext(compilerInput);

    expect(context.compilation).toEqual(compileContinuityCapsuleManifest(compilerInput));
    expect(context.previousSource.receiptId).toBe(compilerInput.previousSourceObservationReceipt.receiptId);
    expect(context.currentSource.receiptId).toBe(compilerInput.currentSourceObservationReceipt.receiptId);
    expect(Object.isFrozen(context)).toBe(true);
  });

  it("enforces action authority and preparation budgets before dependencies", () => {
    const action = compileContinuityCapsuleManifest(input(["note"], {
      kind: "action-preview",
      actionMode: "requires-new-approval"
    }));
    expect(action.manifest.preparedWork.actionMode).toBe("requires-new-approval");
    expectCapsuleError(
      () => compileContinuityCapsuleManifest(input(["note"], { kind: "action-preview", actionMode: "display-only" })),
      "INVALID_INPUT"
    );
    expectCapsuleError(
      () => compileContinuityCapsuleManifest(input(["note"], { title: "x".repeat(301) })),
      "BUDGET_EXCEEDED"
    );
    expectCapsuleError(
      () => compileContinuityCapsuleManifest(input(["note"], { content: "\u0001" })),
      "INVALID_INPUT"
    );
    expectCapsuleError(
      () => compileContinuityCapsuleManifest(input(["note"], { toolName: "tasks.write" })),
      "INVALID_INPUT"
    );
  });

  it("maps scoped receipt failures and source/graph substitution to the dependency codes", () => {
    const badDependency = clone(input());
    (badDependency.previousSourceObservationReceipt as unknown as Data).receiptId = "bad";
    expectCapsuleError(() => compileContinuityCapsuleManifest(badDependency), "INVALID_DEPENDENCY");

    for (const side of ["previous", "current"] as const) {
      const scopeSubstitution = input();
      const observedAt = side === "previous" ? PREVIOUS_AT : CURRENT_AT;
      const substitutedGraph = captureContinuityObservation({
        scope: { sourceId: "other-source", threadId: SCOPE.threadId },
        sourceObservedAt: observedAt,
        state: state([reference(0)])
      });
      if (side === "previous") {
        scopeSubstitution.previousGraphObservationReceipt = substitutedGraph;
      } else {
        scopeSubstitution.currentGraphObservationReceipt = substitutedGraph;
      }
      expectCapsuleError(
        () => compileContinuityCapsuleManifest(scopeSubstitution),
        "DEPENDENCY_MISMATCH"
      );
    }
  });

  it("keeps standalone and dependency-aware verification distinct", () => {
    const dependenciesA = input(["A"]);
    const compilationA = compileContinuityCapsuleManifest(dependenciesA);
    const compilationB = compileContinuityCapsuleManifest(input(["B"]));
    expect(verifyContinuityCapsuleManifest(compilationB.manifest)).toEqual(compilationB.manifest);
    expectCapsuleError(() => verifyContinuityCapsuleCompilation({
      manifest: compilationB.manifest,
      previousSourceObservationReceipt: dependenciesA.previousSourceObservationReceipt,
      previousGraphObservationReceipt: dependenciesA.previousGraphObservationReceipt,
      currentSourceObservationReceipt: dependenciesA.currentSourceObservationReceipt,
      currentGraphObservationReceipt: dependenciesA.currentGraphObservationReceipt
    }), "DEPENDENCY_MISMATCH");
    expect(verifyContinuityCapsuleCompilation({
      manifest: compilationA.manifest,
      previousSourceObservationReceipt: dependenciesA.previousSourceObservationReceipt,
      previousGraphObservationReceipt: dependenciesA.previousGraphObservationReceipt,
      currentSourceObservationReceipt: dependenciesA.currentSourceObservationReceipt,
      currentGraphObservationReceipt: dependenciesA.currentGraphObservationReceipt
    }).manifest).toEqual(compilationA.manifest);

    const alteredSnapshot = rehash({
      ...compilationA.manifest,
      supportingEvidence: compilationA.manifest.supportingEvidence.map((entry, index) => index === 0
        ? { ...entry, summary: "rehashed standalone-only text" }
        : entry)
    });
    expect(verifyContinuityCapsuleManifest(alteredSnapshot)).toEqual(alteredSnapshot);
    expectCapsuleError(() => verifyContinuityCapsuleCompilation({
      manifest: alteredSnapshot,
      previousSourceObservationReceipt: dependenciesA.previousSourceObservationReceipt,
      previousGraphObservationReceipt: dependenciesA.previousGraphObservationReceipt,
      currentSourceObservationReceipt: dependenciesA.currentSourceObservationReceipt,
      currentGraphObservationReceipt: dependenciesA.currentGraphObservationReceipt
    }), "DEPENDENCY_MISMATCH");
  });

  it("preserves unknown thrown identities from hostile standalone input", () => {
    const sentinel = new Error("capsule proxy sentinel");
    const proxy = new Proxy({}, {
      getPrototypeOf() {
        throw sentinel;
      }
    });
    expect(() => verifyContinuityCapsuleManifest(proxy)).toThrow(sentinel);
    expect(() => compileContinuityCapsuleManifest(proxy)).toThrow(sentinel);
  });

  it("canonicalizes key and selected-support order while binding meaningful changes", () => {
    const base = input(["first", "second"]);
    const reordered = {
      currentGraphObservationReceipt: base.currentGraphObservationReceipt,
      preparation: {
        preparedWork: { ...base.preparation.preparedWork },
        supportingEvidenceRefs: [...base.preparation.supportingEvidenceRefs].reverse(),
        preparedAt: base.preparation.preparedAt
      },
      previousSourceObservationReceipt: base.previousSourceObservationReceipt,
      schemaVersion: 1,
      currentSourceObservationReceipt: base.currentSourceObservationReceipt,
      previousGraphObservationReceipt: base.previousGraphObservationReceipt
    };
    const first = compileContinuityCapsuleManifest(base).manifest;
    const second = compileContinuityCapsuleManifest(reordered).manifest;
    expect(second).toEqual(first);
    expect(second.manifestId).toBe(first.manifestId);
    expect(compileContinuityCapsuleManifest(input(["changed", "second"])).manifest.manifestId)
      .not.toBe(first.manifestId);
    expect(compileContinuityCapsuleManifest(input(["first", "second"], { content: "changed prepared work" })).manifest.manifestId)
      .not.toBe(first.manifestId);
  });

  it("uses one locale-independent support order for compilation and verification", () => {
    const mixed = ["a", "Z", "a-", "é"].map((artifactId) => ({
      artifactId,
      artifactType: "note" as const,
      providerId: "local",
      role: "context" as const
    }));
    const base = input(["a", "Z", "punctuation", "unicode"], {}, mixed);
    const reordered = {
      ...base,
      preparation: {
        ...base.preparation,
        supportingEvidenceRefs: [...mixed].reverse()
      }
    };

    const first = compileContinuityCapsuleManifest(base).manifest;
    const second = compileContinuityCapsuleManifest(reordered).manifest;

    expect(second).toEqual(first);
    expect(second.manifestId).toBe(first.manifestId);
    expect(first.supportingEvidence.map((entry) => entry.reference.artifactId))
      .toEqual(["Z", "a", "a-", "é"]);
    expect(verifyContinuityCapsuleManifest(first)).toEqual(first);
  });

  it("accepts equal-time no-change and rejects reversed or cross-thread receipt intervals", () => {
    const equal = compileContinuityCapsuleManifest(fixture({
      previousAt: CURRENT_AT,
      currentAt: CURRENT_AT
    }));
    expect(equal.changeResult.status).toBe("no-change");

    expectCapsuleError(
      () => compileContinuityCapsuleManifest(fixture({
        previousAt: CURRENT_AT,
        currentAt: PREVIOUS_AT
      })),
      "DEPENDENCY_MISMATCH"
    );
    expectCapsuleError(
      () => compileContinuityCapsuleManifest(fixture({
        currentScope: { sourceId: SCOPE.sourceId, threadId: "thread_other" }
      })),
      "DEPENDENCY_MISMATCH"
    );
  });

  it("fails closed when either next step is absent or selected support is unavailable", () => {
    expectCapsuleError(
      () => compileContinuityCapsuleManifest(fixture({ previousHasNextStep: false })),
      "MISSING_RESUME_EVIDENCE"
    );
    expectCapsuleError(
      () => compileContinuityCapsuleManifest(fixture({ currentHasNextStep: false })),
      "MISSING_RESUME_EVIDENCE"
    );
    expectCapsuleError(
      () => compileContinuityCapsuleManifest(fixture({ currentUnavailableSupportIndexes: [0] })),
      "MISSING_RESUME_EVIDENCE"
    );
  });

  it.each([
    ["previous scoped malformed", (value: Data) => {
      ((value.previousSourceObservationReceipt as unknown) as Data).receiptId = "bad";
    }, "INVALID_DEPENDENCY"],
    ["previous graph malformed", (value: Data) => {
      ((value.previousGraphObservationReceipt as unknown) as Data).receiptId = "bad";
    }, "INVALID_DEPENDENCY"],
    ["current scoped sourceId budget", (value: Data) => {
      const scope = (((value.currentSourceObservationReceipt as unknown) as Data).scope as Data);
      scope.sourceId = "s".repeat(129);
    }, "BUDGET_EXCEEDED"],
    ["current graph scope budget", (value: Data) => {
      const graph = (value.currentGraphObservationReceipt as unknown) as Data;
      const projection = graph.projection as Data;
      const scope = projection.scope as Data;
      scope.threadId = "t".repeat(513);
    }, "BUDGET_EXCEEDED"]
  ] as const)("maps dependency failures: %s", (_label, mutate, code) => {
    const value = clone(input()) as unknown as Data;
    mutate(value);
    expectCapsuleError(() => compileContinuityCapsuleManifest(value), code);
  });

  it("uses previous-source, previous-graph, current-source, current-graph verification order", () => {
    const sourceFirst = clone(input()) as unknown as Data;
    ((sourceFirst.previousSourceObservationReceipt as unknown) as Data).receiptId = "bad";
    const currentScope = (((sourceFirst.currentSourceObservationReceipt as unknown) as Data).scope as Data);
    currentScope.sourceId = "s".repeat(129);
    expectCapsuleError(() => compileContinuityCapsuleManifest(sourceFirst), "INVALID_DEPENDENCY");

    const graphSecond = clone(input()) as unknown as Data;
    ((graphSecond.previousGraphObservationReceipt as unknown) as Data).receiptId = "bad";
    const laterScope = (((graphSecond.currentSourceObservationReceipt as unknown) as Data).scope as Data);
    laterScope.sourceId = "s".repeat(129);
    expectCapsuleError(() => compileContinuityCapsuleManifest(graphSecond), "INVALID_DEPENDENCY");
  });

  it("rejects hostile records and arrays while accepting a transparent proxy", () => {
    const manifest = compileContinuityCapsuleManifest(input()).manifest;
    const accessor = { ...manifest } as Data;
    const getter = vi.fn(() => manifest.thread);
    Object.defineProperty(accessor, "thread", { enumerable: true, get: getter });
    expectCapsuleError(() => verifyContinuityCapsuleManifest(accessor), "INVALID_MANIFEST");
    expect(getter).not.toHaveBeenCalled();

    const symbol = { ...manifest } as Data;
    Object.defineProperty(symbol, Symbol("secret"), { enumerable: true, value: true });
    expectCapsuleError(() => verifyContinuityCapsuleManifest(symbol), "INVALID_MANIFEST");
    expectCapsuleError(() => verifyContinuityCapsuleManifest(new Date()), "INVALID_MANIFEST");

    const cyclic = clone(manifest) as unknown as Data;
    cyclic.supportingEvidence = [cyclic];
    expectCapsuleError(() => verifyContinuityCapsuleManifest(cyclic), "INVALID_MANIFEST");
    const sparse = clone(manifest) as unknown as Data;
    sparse.supportingEvidence = new Array(1);
    expectCapsuleError(() => verifyContinuityCapsuleManifest(sparse), "INVALID_MANIFEST");
    const nonFinite = clone(manifest) as unknown as Data;
    ((nonFinite.preparedWork as Data).expectedMinutes) = Number.POSITIVE_INFINITY;
    expectCapsuleError(() => verifyContinuityCapsuleManifest(nonFinite), "INVALID_MANIFEST");
    expect(verifyContinuityCapsuleManifest(new Proxy(clone(manifest), {}))).toEqual(manifest);
  });

  it("rejects standalone shape, semantic-reference, time, ordering, and integrity drift", () => {
    const one = compileContinuityCapsuleManifest(input()).manifest;
    const two = compileContinuityCapsuleManifest(input(["a", "b"])).manifest;
    const cases: readonly [string, ContinuityCapsuleManifest, ContinuityCapsuleManifestError["code"]][] = [
      ["unsupported artifact type", rehash({
        ...one,
        currentNextStep: { ...one.currentNextStep, reference: { ...one.currentNextStep.reference, artifactType: "unknown" as never } }
      }), "INVALID_MANIFEST"],
      ["incoherent provider", rehash({
        ...one,
        currentNextStep: { ...one.currentNextStep, reference: { ...one.currentNextStep.reference, providerId: "mcp:github" } }
      }), "INVALID_MANIFEST"],
      ["noncanonical time", rehash({ ...one, previousObservedAt: "2026-07-29T08:00:00Z" }), "INVALID_MANIFEST"],
      ["unavailable previous next step", rehash({ ...one, previousNextStep: { ...one.previousNextStep, status: "unavailable" } }), "INVALID_MANIFEST"],
      ["unsorted support", rehash({ ...two, supportingEvidence: [...two.supportingEvidence].reverse() }), "INVALID_MANIFEST"],
      ["duplicate support", rehash({ ...two, supportingEvidence: [two.supportingEvidence[0]!, two.supportingEvidence[0]!] }), "INVALID_MANIFEST"]
    ];
    for (const [_label, manifest, code] of cases) {
      expectCapsuleError(() => verifyContinuityCapsuleManifest(manifest), code);
    }
    const stale = clone(one) as unknown as Data;
    (stale.preparedWork as Data).title = "stale hash body";
    expectCapsuleError(() => verifyContinuityCapsuleManifest(stale), "INTEGRITY_MISMATCH");
  });

  it("covers exact preparation scalar, UTF-8, item, and minute boundaries", () => {
    expect(compileContinuityCapsuleManifest(input(["note"], {
      title: "x".repeat(300),
      content: "x".repeat(16_384),
      expectedMinutes: 1
    })).manifest.preparedWork.expectedMinutes).toBe(1);
    expect(compileContinuityCapsuleManifest(input(["note"], {
      title: "😀".repeat(300),
      expectedMinutes: 1_440
    })).manifest.preparedWork.expectedMinutes).toBe(1_440);
    expectCapsuleError(() => compileContinuityCapsuleManifest(input(["note"], { title: "x".repeat(301) })), "BUDGET_EXCEEDED");
    expectCapsuleError(() => compileContinuityCapsuleManifest(input(["note"], { title: "😀".repeat(300) + "x" })), "BUDGET_EXCEEDED");
    expectCapsuleError(() => compileContinuityCapsuleManifest(input(["note"], { content: "x".repeat(16_385) })), "BUDGET_EXCEEDED");
    for (const value of [0, 1_441]) {
      expectCapsuleError(() => compileContinuityCapsuleManifest(input(["note"], { expectedMinutes: value })), "BUDGET_EXCEEDED");
    }
    expectCapsuleError(() => compileContinuityCapsuleManifest(input(["note"], { expectedMinutes: Number.NaN })), "INVALID_INPUT");
    expect(compileContinuityCapsuleManifest(input(Array.from({ length: 16 }, (_, index) => `support-${index.toString()}`))).manifest.supportingEvidence).toHaveLength(16);
    expectCapsuleError(
      () => compileContinuityCapsuleManifest(input(Array.from({ length: 17 }, (_, index) => `support-${index.toString()}`))),
      "BUDGET_EXCEEDED"
    );
  });

  it("accepts exactly 65,536 UTF-8 manifest bytes and rejects one more byte", () => {
    const fixedReferences: readonly ArtifactReference[] = [
      {
        artifactId: `0-${"a".repeat(11_998)}`,
        artifactType: "task",
        providerId: "local",
        role: "context"
      },
      {
        artifactId: `1-${"b".repeat(11_998)}`,
        artifactType: "task",
        providerId: "local",
        role: "context"
      },
      {
        artifactId: `2-${"c".repeat(11_998)}`,
        artifactType: "task",
        providerId: "local",
        role: "context"
      }
    ];
    const makeReferences = (lastId: string): readonly ArtifactReference[] => [
      ...fixedReferences,
      {
        artifactId: lastId,
        artifactType: "task",
        providerId: "local",
        role: "context"
      }
    ];
    const summaries = ["one", "two", "three", "four"] as const;
    const baselineLastId = "3-x";
    const baseline = compileContinuityCapsuleManifest(input(
      summaries,
      { content: "c".repeat(16_000) },
      makeReferences(baselineLastId)
    )).manifest;
    const baselineBytes = utf8Bytes(JSON.stringify(baseline));
    const exactLastIdBytes = utf8Bytes(baselineLastId)
      + CONTINUITY_CAPSULE_MANIFEST_LIMITS.maxManifestBytes
      - baselineBytes;
    const exactLastId = `3-${"x".repeat(exactLastIdBytes - 2)}`;
    const predictedExactBytes = baselineBytes
      - utf8Bytes(baselineLastId)
      + utf8Bytes(exactLastId);
    expect(predictedExactBytes)
      .toBe(CONTINUITY_CAPSULE_MANIFEST_LIMITS.maxManifestBytes);

    const exact = compileContinuityCapsuleManifest(input(
      summaries,
      { content: "c".repeat(16_000) },
      makeReferences(exactLastId)
    )).manifest;
    expect(utf8Bytes(JSON.stringify(exact))).toBe(CONTINUITY_CAPSULE_MANIFEST_LIMITS.maxManifestBytes);
    expect(verifyContinuityCapsuleManifest(JSON.parse(JSON.stringify(exact)))).toEqual(exact);

    const overLastId = `3-é${exactLastId.slice(3)}`;
    const predictedOverBytes = baselineBytes
      - utf8Bytes(baselineLastId)
      + utf8Bytes(overLastId);
    expect(predictedOverBytes)
      .toBe(CONTINUITY_CAPSULE_MANIFEST_LIMITS.maxManifestBytes + 1);
    expectCapsuleError(
      () => compileContinuityCapsuleManifest(input(
        summaries,
        { content: "c".repeat(16_000) },
        makeReferences(overLastId)
      )),
      "BUDGET_EXCEEDED"
    );
  });
});
