import { createHash } from "node:crypto";

import type {
  ArtifactReference,
  AttunementState,
  ContinuityPack,
  ContinuityPolicy,
  ResolvedArtifact
} from "@muse/attunement";
import { fingerprintContinuityTaskState } from "@muse/attunement";
import {
  captureScopedContinuitySourceObservation
} from "@muse/attunement/continuity-source-observations";
import { describe, expect, it } from "vitest";

import {
  BOUNDARY_ID_PREFIX,
  CONTINUITY_RESUME_BOUNDARY_LIMITS,
  ContinuityResumeBoundaryError,
  captureContinuityResumeBoundary,
  verifyContinuityResumeBoundary,
  verifyContinuityResumeBoundaryWithDependencies,
  type ContinuityResumeBoundary
} from "./continuity-resume-boundary.js";
import { captureContinuityObservation } from "./continuity-observation.js";

const OBSERVED_AT = "2026-07-30T08:00:00.000Z";
const POLICY: ContinuityPolicy = Object.freeze({
  detail: "compact",
  nextStep: "direct",
  suppression: "none",
  version: 0
});

function reference(artifactId = "task_resume"): ArtifactReference {
  return {
    artifactId,
    artifactType: "task",
    providerId: "local",
    role: "next-step"
  };
}

function state(
  sourceId = "default",
  threadId = "thread_resume",
  task = reference()
): AttunementState {
  void sourceId;
  return {
    deliveries: [],
    interactionReceipts: [],
    nextPolicyVersion: 1,
    resetReceipts: [],
    schemaVersion: 11,
    threads: [{
      createdAt: "2026-07-30T00:00:00.000Z",
      id: threadId,
      kind: "work",
      links: [{
        ...task,
        linkedAt: "2026-07-30T01:00:00.000Z",
        linkedBy: "user",
        threadId
      }],
      policy: POLICY,
      title: "Resume boundary thread"
    }],
    undoResetReceipts: []
  };
}

function artifact(task: ArtifactReference): ResolvedArtifact {
  return {
    ...task,
    taskStatus: "open",
    title: "Exact next task"
  };
}

function pair(options: {
  readonly artifactId?: string;
  readonly sourceId?: string;
  readonly threadId?: string;
} = {}) {
  const sourceId = options.sourceId ?? "default";
  const threadId = options.threadId ?? "thread_resume";
  const task = reference(options.artifactId);
  const sourceState = state(sourceId, threadId, task);
  const pack: ContinuityPack = {
    deliveryPolicyVersion: POLICY.version,
    evidence: [{
      artifact: artifact(task),
      reference: task,
      status: "available"
    }],
    evidenceRefs: [task],
    interactionAnchor: {
      artifactId: task.artifactId,
      linkedAt: "2026-07-30T01:00:00.000Z",
      observedStatus: "open",
      openStateFingerprint: fingerprintContinuityTaskState({
        artifactId: task.artifactId,
        status: "open",
        updatedAt: ""
      }),
      providerId: "local",
      role: "next-step"
    },
    nextStep: artifact(task),
    policy: POLICY,
    thread: {
      id: threadId,
      kind: "work",
      title: "Resume boundary thread"
    }
  };
  return {
    graph: captureContinuityObservation({
      scope: { sourceId, threadId },
      sourceObservedAt: OBSERVED_AT,
      state: sourceState
    }),
    source: captureScopedContinuitySourceObservation({
      observedAt: OBSERVED_AT,
      pack,
      scope: { sourceId, threadId }
    })
  };
}

function independentBoundary(
  value: Omit<ContinuityResumeBoundary, "boundaryId">
): ContinuityResumeBoundary {
  const body = {
    schemaVersion: value.schemaVersion,
    boundaryVersion: value.boundaryVersion,
    authority: value.authority,
    scope: {
      sourceId: value.scope.sourceId,
      threadId: value.scope.threadId
    },
    observedAt: value.observedAt,
    sourceObservationReceiptId: value.sourceObservationReceiptId,
    graphObservationReceiptId: value.graphObservationReceiptId,
    graphSourceVersion: value.graphSourceVersion,
    graphProjectionVersion: value.graphProjectionVersion,
    previousNextStep: {
      artifactId: value.previousNextStep.artifactId,
      artifactType: value.previousNextStep.artifactType,
      providerId: value.previousNextStep.providerId,
      role: value.previousNextStep.role
    }
  };
  const digest = createHash("sha256")
    .update("muse.attunement.continuity-resume-boundary.v1\0", "utf8")
    .update(JSON.stringify(body), "utf8")
    .digest("hex");
  return { ...body, boundaryId: `${BOUNDARY_ID_PREFIX}${digest}` };
}

function withBoundary(
  boundary: ContinuityResumeBoundary,
  changes: {
    readonly scope?: { readonly sourceId: string; readonly threadId: string };
    readonly graphSourceVersion?: string;
    readonly graphProjectionVersion?: string;
    readonly previousNextStep?: ContinuityResumeBoundary["previousNextStep"];
  }
): ContinuityResumeBoundary {
  const { boundaryId: _boundaryId, ...body } = boundary;
  return independentBoundary({
    ...body,
    ...changes,
    scope: changes.scope ?? body.scope,
    previousNextStep: changes.previousNextStep ?? body.previousNextStep
  });
}

function expectBoundaryError(
  operation: () => unknown,
  code: ContinuityResumeBoundaryError["code"]
): ContinuityResumeBoundaryError {
  try {
    operation();
  } catch (cause) {
    expect(cause).toBeInstanceOf(ContinuityResumeBoundaryError);
    const error = cause as ContinuityResumeBoundaryError;
    expect(error.code).toBe(code);
    expect(Object.keys(error.details)).toEqual(["path", "reason"]);
    expect(Object.isFrozen(error)).toBe(true);
    expect(Object.isFrozen(error.details)).toBe(true);
    expect(JSON.stringify(error.details).length).toBeLessThan(600);
    return error;
  }
  throw new Error(`expected ${code}`);
}

function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

describe("Continuity resume boundary", () => {
  it("captures the exact caller-designated previous observation boundary", () => {
    const { source, graph } = pair();
    const boundary = captureContinuityResumeBoundary({
      previousSourceObservationReceipt: source,
      previousGraphObservationReceipt: graph
    });

    expect(Object.keys(boundary)).toEqual([
      "schemaVersion",
      "boundaryVersion",
      "authority",
      "scope",
      "observedAt",
      "sourceObservationReceiptId",
      "graphObservationReceiptId",
      "graphSourceVersion",
      "graphProjectionVersion",
      "previousNextStep",
      "boundaryId"
    ]);
    expect(Object.keys(boundary.scope)).toEqual(["sourceId", "threadId"]);
    expect(Object.keys(boundary.previousNextStep)).toEqual([
      "artifactId",
      "artifactType",
      "providerId",
      "role"
    ]);
    expect(boundary).toMatchObject({
      schemaVersion: 1,
      boundaryVersion: "muse.continuity-resume-boundary.v1",
      authority: "caller-declared-resume-boundary",
      scope: { sourceId: "default", threadId: "thread_resume" },
      observedAt: OBSERVED_AT,
      sourceObservationReceiptId: source.receiptId,
      graphObservationReceiptId: graph.receiptId,
      graphSourceVersion: graph.projection.sourceVersion,
      graphProjectionVersion: graph.projection.projectionVersion,
      previousNextStep: reference()
    });

    const { boundaryId: _boundaryId, ...body } = boundary;
    const expected = createHash("sha256")
      .update("muse.attunement.continuity-resume-boundary.v1\0", "utf8")
      .update(JSON.stringify(body), "utf8")
      .digest("hex");
    expect(boundary.boundaryId).toBe(`${BOUNDARY_ID_PREFIX}${expected}`);
  });

  it("round-trips portably and dependency verification returns frozen verified dependencies", () => {
    const { source, graph } = pair();
    const boundary = captureContinuityResumeBoundary({
      previousSourceObservationReceipt: source,
      previousGraphObservationReceipt: graph
    });
    const portable = verifyContinuityResumeBoundary(
      JSON.parse(JSON.stringify(boundary))
    );
    const verified = verifyContinuityResumeBoundaryWithDependencies({
      boundary: portable,
      previousSourceObservationReceipt: jsonClone(source),
      previousGraphObservationReceipt: jsonClone(graph)
    });

    expect(JSON.stringify(portable)).toBe(JSON.stringify(boundary));
    expect(verified.boundary).toEqual(boundary);
    expect(verified.previousSourceObservationReceipt.receiptId).toBe(source.receiptId);
    expect(verified.previousGraphObservationReceipt.receiptId).toBe(graph.receiptId);
    expect(Object.isFrozen(verified)).toBe(true);
    expect(Object.isFrozen(verified.boundary.scope)).toBe(true);
    expect(Object.isFrozen(
      verified.previousSourceObservationReceipt.observation.projection.evidence
    )).toBe(true);
    expect(Object.isFrozen(
      verified.previousGraphObservationReceipt.projection.assertions
    )).toBe(true);
  });

  it("binds every field and rejects sorted-key or self-inclusive hash alternatives", () => {
    const { source, graph } = pair();
    const boundary = captureContinuityResumeBoundary({
      previousSourceObservationReceipt: source,
      previousGraphObservationReceipt: graph
    });
    const { boundaryId: _boundaryId, ...body } = boundary;
    const mutations: readonly ContinuityResumeBoundary[] = [
      withBoundary(boundary, {
        scope: { ...boundary.scope, sourceId: "substituted" }
      }),
      withBoundary(boundary, {
        scope: { ...boundary.scope, threadId: "substituted" }
      }),
      withBoundary(boundary, {
        graphSourceVersion: `sha256:${"1".repeat(64)}`
      }),
      withBoundary(boundary, {
        graphProjectionVersion: `sha256:${"2".repeat(64)}`
      }),
      withBoundary(boundary, {
        previousNextStep: {
          ...boundary.previousNextStep,
          artifactId: "task_substituted"
        }
      })
    ];
    expect(new Set(mutations.map((entry) => entry.boundaryId)).size).toBe(mutations.length);
    expect(mutations.every((entry) => entry.boundaryId !== boundary.boundaryId)).toBe(true);

    const sorted = Object.fromEntries(
      Object.entries(body).sort(([left], [right]) => left < right ? -1 : 1)
    );
    const sortedId = `${BOUNDARY_ID_PREFIX}${createHash("sha256")
      .update("muse.attunement.continuity-resume-boundary.v1\0", "utf8")
      .update(JSON.stringify(sorted), "utf8")
      .digest("hex")}`;
    const selfInclusiveId = `${BOUNDARY_ID_PREFIX}${createHash("sha256")
      .update("muse.attunement.continuity-resume-boundary.v1\0", "utf8")
      .update(JSON.stringify(boundary), "utf8")
      .digest("hex")}`;
    expect(sortedId).not.toBe(boundary.boundaryId);
    expect(selfInclusiveId).not.toBe(boundary.boundaryId);
  });

  it("rejects portable tampering and dependency cross-pairs without fallback", () => {
    const first = pair();
    const second = pair({ artifactId: "task_other" });
    const boundary = captureContinuityResumeBoundary({
      previousSourceObservationReceipt: first.source,
      previousGraphObservationReceipt: first.graph
    });
    expectBoundaryError(
      () => verifyContinuityResumeBoundary({
        ...jsonClone(boundary),
        observedAt: "2026-07-30T09:00:00.000Z"
      }),
      "INTEGRITY_MISMATCH"
    );
    expectBoundaryError(
      () => verifyContinuityResumeBoundaryWithDependencies({
        boundary,
        previousSourceObservationReceipt: first.source,
        previousGraphObservationReceipt: second.graph
      }),
      "DEPENDENCY_MISMATCH"
    );
    expectBoundaryError(
      () => captureContinuityResumeBoundary({
        previousSourceObservationReceipt: first.source,
        previousGraphObservationReceipt: second.graph
      }),
      "DEPENDENCY_MISMATCH"
    );
  });

  it("preserves inputs, rejects portable aliases/cycles, and permits dependency aliases", () => {
    const { source, graph } = pair();
    const rawSource = jsonClone(source);
    const rawGraph = jsonClone(graph);
    const before = JSON.stringify({ rawSource, rawGraph });
    const evidenceArtifact =
      rawSource.observation.projection.evidence[0]!.artifact!;
    (rawSource.observation.projection as unknown as {
      nextStep: ResolvedArtifact;
    }).nextStep = evidenceArtifact;
    const boundary = captureContinuityResumeBoundary({
      previousSourceObservationReceipt: rawSource,
      previousGraphObservationReceipt: rawGraph
    });
    expect(JSON.stringify({ rawSource, rawGraph })).toBe(before);
    expect(boundary.previousNextStep.artifactId).toBe("task_resume");

    const shared = {
      sourceId: "default",
      threadId: "thread_resume",
      artifactId: "task_resume",
      artifactType: "task",
      providerId: "local",
      role: "next-step"
    };
    expectBoundaryError(
      () => verifyContinuityResumeBoundary({
        ...jsonClone(boundary),
        scope: shared,
        previousNextStep: shared
      }),
      "INVALID_RECEIPT"
    );
    const cyclic = jsonClone(boundary) as ContinuityResumeBoundary & {
      loop?: unknown;
    };
    (cyclic as unknown as { scope: { loop?: unknown } }).scope.loop =
      cyclic.scope;
    expectBoundaryError(
      () => verifyContinuityResumeBoundary(cyclic),
      "INVALID_RECEIPT"
    );
  });

  it("maps hostile proxy traps and preserves dependency-aware precedence", () => {
    const { source, graph } = pair();
    const boundary = captureContinuityResumeBoundary({
      previousSourceObservationReceipt: source,
      previousGraphObservationReceipt: graph
    });
    const hostile = new Proxy({}, {
      ownKeys() {
        throw new Error("secret dependency body");
      }
    });
    const inputError = expectBoundaryError(
      () => captureContinuityResumeBoundary(hostile),
      "INVALID_INPUT"
    );
    expect(JSON.stringify(inputError)).not.toContain("secret");
    expectBoundaryError(
      () => verifyContinuityResumeBoundary(hostile),
      "INVALID_RECEIPT"
    );
    expectBoundaryError(
      () => verifyContinuityResumeBoundaryWithDependencies({
        boundary: { ...boundary, boundaryId: `${BOUNDARY_ID_PREFIX}${"f".repeat(64)}` },
        previousSourceObservationReceipt: hostile,
        previousGraphObservationReceipt: graph
      }),
      "INTEGRITY_MISMATCH"
    );
  });

  it("enforces character, UTF-8, graph-version, artifact, and lone-surrogate limits", () => {
    const { source, graph } = pair();
    const boundary = captureContinuityResumeBoundary({
      previousSourceObservationReceipt: source,
      previousGraphObservationReceipt: graph
    });
    expect(verifyContinuityResumeBoundary(withBoundary(boundary, {
      scope: {
        sourceId: "s".repeat(128),
        threadId: "é".repeat(256)
      },
      previousNextStep: {
        ...boundary.previousNextStep,
        artifactId: "😀".repeat(4_096)
      }
    }))).toBeDefined();
    expectBoundaryError(
      () => verifyContinuityResumeBoundary(withBoundary(boundary, {
        scope: { ...boundary.scope, sourceId: "s".repeat(129) }
      })),
      "BUDGET_EXCEEDED"
    );
    expectBoundaryError(
      () => verifyContinuityResumeBoundary(withBoundary(boundary, {
        scope: {
          ...boundary.scope,
          threadId: `${"é".repeat(256)}a`
        }
      })),
      "BUDGET_EXCEEDED"
    );
    expectBoundaryError(
      () => verifyContinuityResumeBoundary(withBoundary(boundary, {
        previousNextStep: {
          ...boundary.previousNextStep,
          artifactId: "😀".repeat(4_097)
        }
      })),
      "BUDGET_EXCEEDED"
    );
    expectBoundaryError(
      () => verifyContinuityResumeBoundary(withBoundary(boundary, {
        graphSourceVersion: `sha256:${"A".repeat(64)}`
      })),
      "INVALID_RECEIPT"
    );
    expectBoundaryError(
      () => verifyContinuityResumeBoundary(withBoundary(boundary, {
        graphProjectionVersion: `sha256:${"a".repeat(65)}`
      })),
      "INVALID_RECEIPT"
    );
    expectBoundaryError(
      () => verifyContinuityResumeBoundary(withBoundary(boundary, {
        scope: { ...boundary.scope, threadId: "\uD800" }
      })),
      "INVALID_RECEIPT"
    );
    expectBoundaryError(
      () => captureContinuityResumeBoundary({
        previousSourceObservationReceipt: source,
        previousGraphObservationReceipt: {
          ...jsonClone(graph),
          receiptId: `bad\uD800`
        }
      }),
      "INVALID_INPUT"
    );
  });

  it("pins the exact reachable 100,000/100,001-byte receipt boundary", () => {
    const exactPair = pair({
      artifactId: "\0".repeat(16_384),
      sourceId: "s".repeat(128),
      threadId: `${"\"".repeat(162)}${"t".repeat(350)}`
    });
    const exact = captureContinuityResumeBoundary({
      previousSourceObservationReceipt: exactPair.source,
      previousGraphObservationReceipt: exactPair.graph
    });
    expect(new TextEncoder().encode(JSON.stringify(exact)).byteLength).toBe(
      CONTINUITY_RESUME_BOUNDARY_LIMITS.maxReceiptBytes
    );

    const tooLargePair = pair({
      artifactId: "\0".repeat(16_384),
      sourceId: "s".repeat(128),
      threadId: `${"\"".repeat(163)}${"t".repeat(349)}`
    });
    expectBoundaryError(
      () => captureContinuityResumeBoundary({
        previousSourceObservationReceipt: tooLargePair.source,
        previousGraphObservationReceipt: tooLargePair.graph
      }),
      "BUDGET_EXCEEDED"
    );
    const portableTooLarge = withBoundary(exact, {
      scope: {
        ...exact.scope,
        threadId: `${"\"".repeat(163)}${"t".repeat(349)}`
      }
    });
    expect(new TextEncoder().encode(JSON.stringify(portableTooLarge)).byteLength)
      .toBe(CONTINUITY_RESUME_BOUNDARY_LIMITS.maxReceiptBytes + 1);
    expectBoundaryError(
      () => verifyContinuityResumeBoundary(portableTooLarge),
      "BUDGET_EXCEEDED"
    );
  });

  it("fails malformed structure before field budgets and keeps captured output immutable", () => {
    const dependencyPair = pair();
    const input = {
      previousSourceObservationReceipt: jsonClone(dependencyPair.source),
      previousGraphObservationReceipt: jsonClone(dependencyPair.graph)
    };
    const boundary = captureContinuityResumeBoundary(input);
    (input.previousSourceObservationReceipt.scope as {
      sourceId: string;
    }).sourceId = "mutated";
    expect(boundary.scope.sourceId).toBe("default");
    expect(Object.isFrozen(boundary)).toBe(true);
    expect(Object.isFrozen(boundary.previousNextStep)).toBe(true);

    expectBoundaryError(
      () => captureContinuityResumeBoundary({
        ...input,
        unexpected: true
      }),
      "INVALID_INPUT"
    );
    expectBoundaryError(
      () => verifyContinuityResumeBoundary({
        ...withBoundary(boundary, {
          previousNextStep: {
            ...boundary.previousNextStep,
            artifactId: "x".repeat(16_385)
          }
        }),
        boundaryId: "bad"
      }),
      "INVALID_RECEIPT"
    );
  });
});
