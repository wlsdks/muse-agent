import {
  createLocalAttunementSnapshotProviderForTesting
} from "@muse/attunement/testing";
import { readFileSync } from "node:fs";
import {
  fingerprintContinuityTaskState,
  type ArtifactReference,
  type ContinuityPack,
  type ContinuityPolicy
} from "@muse/attunement";
import {
  captureScopedContinuitySourceObservation
} from "@muse/attunement/continuity-source-observations";
import { parseAttunementState } from "@muse/attunement/state-validation";
import { describe, expect, it, vi } from "vitest";

import {
  ContinuityResumeContextOrchestratorError,
  compileContinuityResumeContext,
  getContinuityResumeContextAudit
} from "./continuity-resume-context-orchestrator.js";
import {
  captureContinuityResumeBoundary
} from "./continuity-resume-boundary.js";
import {
  captureContinuityObservation
} from "./continuity-observation.js";
import {
  compileHeadRevalidatedProviderBoundGraphEvidence
} from "./provider-head-revalidated-graph-evidence.js";
import {
  getThreadRootedRetainedWitnessInventory
} from "./thread-rooted-witness-documents.js";

vi.mock("@muse/attunement/continuity-snapshots", async () =>
  import("@muse/attunement/continuity-snapshots")
);

const BUDGET = Object.freeze({
  maxAssertions: 32,
  maxConsideredAssertions: 256,
  maxDepth: 4,
  maxEstimatedTokens: 4096,
  maxOutputBytes: 262_144,
  maxVisitedRefs: 128
});
const SOURCE_ID = "resume-orchestrator-test";
const THREAD_ID = "thread_resume_orchestrator";
const PREVIOUS_AT = "2026-07-30T00:00:00.000Z";
const CURRENT_AT = "2026-07-30T01:00:00.000Z";
const POLICY: ContinuityPolicy = Object.freeze({
  detail: "compact",
  nextStep: "direct",
  suppression: "none",
  version: 0
});
const NEXT_STEP: ArtifactReference = Object.freeze({
  artifactId: "task_resume_orchestrator",
  artifactType: "task",
  providerId: "local",
  role: "next-step"
});
const CURRENT_SUPPORT: ArtifactReference = Object.freeze({
  artifactId: "task_resume_orchestrator_support",
  artifactType: "task",
  providerId: "local",
  role: "context"
});
const CURRENT_OUTSIDE_SUPPORT: ArtifactReference = Object.freeze({
  ...CURRENT_SUPPORT,
  artifactId: "task_resume_orchestrator_outside"
});

function state(
  title = "Resume orchestrator thread",
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
      id: THREAD_ID,
      kind: "work",
      links: [{
        ...NEXT_STEP,
        linkedAt: "2026-07-29T23:30:00.000Z",
        linkedBy: "user",
        threadId: THREAD_ID
      }, ...extraReferences.map((reference, index) => ({
        ...reference,
        linkedAt: index === 0
          ? "2026-07-30T00:30:00.000Z"
          : PREVIOUS_AT,
        linkedBy: "user" as const,
        threadId: THREAD_ID
      }))],
      policy,
      title
    }],
    undoResetReceipts: []
  });
}

function pack(
  title = "Resume orchestrator thread",
  policy: ContinuityPolicy = POLICY,
  extraReferences: readonly ArtifactReference[] = []
): ContinuityPack {
  const resolved = {
    ...NEXT_STEP,
    taskStatus: "open" as const,
    title: "Resume exact task"
  };
  const extras = extraReferences.map((reference) => ({
    ...reference,
    taskStatus: "open" as const,
    title: "Resume support task"
  }));
  return {
    deliveryPolicyVersion: policy.version,
    evidence: [{
      artifact: resolved,
      reference: NEXT_STEP,
      status: "available"
    }, ...extras.map((extra, index) => ({
      artifact: extra,
      reference: extraReferences[index]!,
      status: "available" as const
    }))],
    evidenceRefs: [NEXT_STEP, ...extraReferences],
    interactionAnchor: {
      artifactId: NEXT_STEP.artifactId,
      linkedAt: "2026-07-29T23:30:00.000Z",
      observedStatus: "open",
      openStateFingerprint: fingerprintContinuityTaskState({
        artifactId: NEXT_STEP.artifactId,
        status: "open",
        updatedAt: ""
      }),
      providerId: "local",
      role: "next-step"
    },
    nextStep: resolved,
    policy,
    thread: {
      id: THREAD_ID,
      kind: "work",
      title
    }
  };
}

function previousDependencies(sourceId = SOURCE_ID) {
  const scope = { sourceId, threadId: THREAD_ID };
  const previousSourceObservationReceipt =
    captureScopedContinuitySourceObservation({
      observedAt: PREVIOUS_AT,
      pack: pack(),
      scope
    });
  const previousGraphObservationReceipt = captureContinuityObservation({
    scope,
    sourceObservedAt: PREVIOUS_AT,
    state: state()
  });
  const boundary = captureContinuityResumeBoundary({
    previousSourceObservationReceipt,
    previousGraphObservationReceipt
  });
  return {
    boundary,
    previousSourceObservationReceipt,
    previousGraphObservationReceipt
  };
}

async function currentProvider(
  mode: "same" | "stale" | "semantic-change" = "same"
) {
  let reads = 0;
  let clocks = 0;
  const semanticState = mode === "semantic-change"
    ? state("Resume orchestrator thread", POLICY, [
      CURRENT_SUPPORT,
      CURRENT_OUTSIDE_SUPPORT
    ])
    : undefined;
  const provider = createLocalAttunementSnapshotProviderForTesting(
    {
      attunementFile: "/configured/attunement.json",
      sourceId: SOURCE_ID
    },
    {
      readState: async () => ({
        state: mode === "semantic-change"
          ? semanticState!
          : state(mode === "stale" && reads++ > 0
            ? "Changed at head"
            : undefined),
        status: "available" as const
      }),
      clock: () => new Date(
        Date.parse(CURRENT_AT) + (clocks++ === 0 ? 0 : 25)
      )
    }
  );
  const artifact = await provider.captureHeadRevalidation(
    { sourceId: SOURCE_ID, threadId: THREAD_ID },
    { maxCaptureSpanMs: 25 }
  );
  return compileHeadRevalidatedProviderBoundGraphEvidence(artifact);
}

describe("continuity resume-context orchestrator", () => {
  it("rejects hostile and revoked Provider values before reflection", () => {
    const traps = {
      get: 0,
      getOwnPropertyDescriptor: 0,
      getPrototypeOf: 0,
      ownKeys: 0
    };
    const target = Object.freeze({});
    const hostile = new Proxy(target, {
      get() {
        traps.get++;
        throw new Error("provider get trap must not run");
      },
      getOwnPropertyDescriptor() {
        traps.getOwnPropertyDescriptor++;
        throw new Error("provider descriptor trap must not run");
      },
      getPrototypeOf() {
        traps.getPrototypeOf++;
        throw new Error("provider prototype trap must not run");
      },
      ownKeys() {
        traps.ownKeys++;
        throw new Error("provider ownKeys trap must not run");
      }
    });
    const revoked = Proxy.revocable(target, {});
    revoked.revoke();

    for (const currentProviderResult of [hostile, revoked.proxy]) {
      expect(() => compileContinuityResumeContext({
        schemaVersion: 1,
        boundary: {},
        previousSourceObservationReceipt: {},
        previousGraphObservationReceipt: {},
        currentProviderResult,
        budget: BUDGET
      })).toThrowError(ContinuityResumeContextOrchestratorError);
      try {
        compileContinuityResumeContext({
          schemaVersion: 1,
          boundary: {},
          previousSourceObservationReceipt: {},
          previousGraphObservationReceipt: {},
          currentProviderResult,
          budget: BUDGET
        });
      } catch (error) {
        expect(error).toMatchObject({
          code: "INVALID_DEPENDENCY",
          details: {
            path: "/currentProviderResult",
            reason: "provider-result-not-process-minted"
          }
        });
      }
    }
    expect(traps).toEqual({
      get: 0,
      getOwnPropertyDescriptor: 0,
      getPrototypeOf: 0,
      ownKeys: 0
    });
  });

  it("rejects stale Provider input when the current Source key is present as undefined", async () => {
    const currentProviderResult = await currentProvider("stale");
    expect(currentProviderResult.status).toBe("stale");

    expect(() => compileContinuityResumeContext({
      schemaVersion: 1,
      ...previousDependencies(),
      currentProviderResult,
      currentSourceObservationReceipt: undefined,
      budget: BUDGET
    })).toThrowError(ContinuityResumeContextOrchestratorError);
    try {
      compileContinuityResumeContext({
        schemaVersion: 1,
        ...previousDependencies(),
        currentProviderResult,
        currentSourceObservationReceipt: undefined,
        budget: BUDGET
      });
    } catch (error) {
      expect(error).toMatchObject({
        code: "INVALID_INPUT",
        details: {
          path: "/currentSourceObservationReceipt",
          reason: "current-source-must-be-absent"
        }
      });
    }
  });

  it("returns a typed stale abstention when the current Source key is absent", async () => {
    const currentProviderResult = await currentProvider("stale");
    const result = compileContinuityResumeContext({
      schemaVersion: 1,
      ...previousDependencies(),
      currentProviderResult,
      budget: BUDGET
    });

    expect(result).toEqual({
      schemaVersion: 1,
      status: "abstained",
      reason: "current-provider-stale",
      providerStatus: "stale",
      providerStage: "revalidation",
      agentContext: null
    });
    expect(Object.hasOwn(result, "orchestrationEvidence")).toBe(false);
    expect(Object.hasOwn(result, "currentGraphObservationReceipt")).toBe(false);
    expect(getContinuityResumeContextAudit(result)).toBeUndefined();
  });

  it("rejects copied minted Provider results before previous dependency work", async () => {
    const exact = await currentProvider();
    for (const currentProviderResult of [
      { ...exact },
      JSON.parse(JSON.stringify(exact)),
      structuredClone(exact),
      new Proxy(exact, {})
    ]) {
      expect(() => compileContinuityResumeContext({
        schemaVersion: 1,
        boundary: {},
        previousSourceObservationReceipt: {},
        previousGraphObservationReceipt: {},
        currentProviderResult,
        budget: BUDGET
      })).toThrowError(expect.objectContaining({
        code: "INVALID_DEPENDENCY",
        details: expect.objectContaining({
          reason: "provider-result-not-process-minted"
        })
      }));
    }
  });

  it("gives Provider scope mismatch precedence over current Source presence", async () => {
    const currentProviderResult = await currentProvider("stale");
    expect(() => compileContinuityResumeContext({
      schemaVersion: 1,
      ...previousDependencies("other-source"),
      currentProviderResult,
      currentSourceObservationReceipt: undefined,
      budget: BUDGET
    })).toThrowError(expect.objectContaining({
      code: "DEPENDENCY_MISMATCH",
      details: expect.objectContaining({ reason: "provider-scope-mismatch" })
    }));
  });

  it("requires an exact current Source and rejects a mismatched Source pair", async () => {
    const currentProviderResult = await currentProvider();
    expect(() => compileContinuityResumeContext({
      schemaVersion: 1,
      ...previousDependencies(),
      currentProviderResult,
      budget: BUDGET
    })).toThrowError(expect.objectContaining({
      code: "INVALID_INPUT",
      details: expect.objectContaining({ reason: "current-source-required" })
    }));

    const mismatchedSource = captureScopedContinuitySourceObservation({
      observedAt: CURRENT_AT,
      pack: pack(),
      scope: { sourceId: "other-source", threadId: THREAD_ID }
    });
    expect(() => compileContinuityResumeContext({
      schemaVersion: 1,
      ...previousDependencies(),
      currentProviderResult,
      currentSourceObservationReceipt: mismatchedSource,
      budget: BUDGET
    })).toThrowError(expect.objectContaining({
      code: "DEPENDENCY_MISMATCH",
      details: expect.objectContaining({
        reason: "current-source-graph-mismatch"
      })
    }));
  });

  it("settles an exact current no-change pair once into minimal agent context", async () => {
    const currentProviderResult = await currentProvider();
    expect(currentProviderResult.status).toBe("partial");
    if (currentProviderResult.status !== "partial") {
      throw new Error("partial Provider required");
    }
    const currentSourceObservationReceipt =
      captureScopedContinuitySourceObservation({
        observedAt: CURRENT_AT,
        pack: pack(),
        scope: { sourceId: SOURCE_ID, threadId: THREAD_ID }
      });

    const dependencies = previousDependencies();
    const result = compileContinuityResumeContext({
      schemaVersion: 1,
      ...dependencies,
      currentProviderResult,
      currentSourceObservationReceipt,
      budget: BUDGET
    });

    expect(result).toMatchObject({
      status: "partial",
      comparisonStatus: "no-change",
      witnessStatus: "partial",
      agentContext: {
        resumeContextFacts: { status: "no-change", changes: [] }
      }
    });
    if (result.status !== "partial") throw new Error("partial required");
    const audit = getContinuityResumeContextAudit(result);
    if (audit === undefined) throw new Error("exact result audit required");
    expect(Object.keys(result.agentContext)).toEqual([
      "resumeContextFacts",
      "supportingFacts",
      "contextStream"
    ]);
    expect(
      audit.frontier.receipt.metrics.settlementInvocations
    ).toBeGreaterThanOrEqual(1);
    expect(audit.previous.boundary).toEqual(dependencies.boundary);
    expect(audit.currentSourceObservationReceipt).toEqual(currentSourceObservationReceipt);
    expect(audit.currentProviderResult).toBe(currentProviderResult);
    expect(audit.currentGraphObservationReceipt)
      .toEqual(currentProviderResult.graphObservationReceipt);
    expect(audit.reservation).toBe(result.reservation);
    expect(audit.combinedCost).toBe(result.combinedCost);
    expect(Object.isFrozen(audit)).toBe(true);
    expect(result.combinedCost?.settlementCost).toEqual({
      depth:
        audit.frontier.settlement.status === "partial"
          ? audit.frontier.settlement.settlement.ledger
            .counters.maxDepth
          : -1,
      consideredAssertions:
        audit.frontier.settlement.status === "partial"
          ? audit.frontier.settlement.settlement.ledger
            .counters.consideredAssertions
          : -1,
      visitedRefs:
        audit.frontier.settlement.status === "partial"
          ? audit.frontier.settlement.settlement.ledger
            .counters.visitedRefs
          : -1,
      assertions:
        audit.frontier.settlement.status === "partial"
          ? audit.frontier.settlement.settlement.ledger
            .counters.selectedAssertions
          : -1,
      estimatedTokensV1:
        audit.frontier.settlement.status === "partial"
          ? audit.frontier.settlement.settlement
            .estimatedTokens
          : -1,
      outputBytes:
        audit.frontier.settlement.status === "partial"
          ? audit.frontier.settlement.settlement
            .totalOutputBytes
          : -1
    });
    expect(Object.getPrototypeOf(result)).toBeNull();
    expect(Object.getPrototypeOf(result.agentContext)).toBeNull();
    expect(Object.getPrototypeOf(result.agentContext.supportingFacts))
      .toBe(Array.prototype);
    expect(Object.isFrozen(result.agentContext.supportingFacts)).toBe(true);
    expect(result.agentContext.contextStream.endsWith("\n")).toBe(true);
    expect(JSON.stringify(result.agentContext)).not.toMatch(
      /receiptId|sourceRefs|derivation|manifestId|nominationId|entryId/
    );
  });

  it("compiles a stable changed-current Provider into semantic partial changes", async () => {
    const currentProviderResult = await currentProvider("semantic-change");
    expect(currentProviderResult.status).toBe("partial");
    const currentSourceObservationReceipt =
      captureScopedContinuitySourceObservation({
        observedAt: CURRENT_AT,
        pack: pack("Resume orchestrator thread", POLICY, [
          CURRENT_SUPPORT,
          CURRENT_OUTSIDE_SUPPORT
        ]),
        scope: { sourceId: SOURCE_ID, threadId: THREAD_ID }
      });
    const result = compileContinuityResumeContext({
      schemaVersion: 1,
      ...previousDependencies(),
      currentProviderResult,
      currentSourceObservationReceipt,
      budget: BUDGET
    });
    if (result.status !== "partial") throw new Error("partial required");
    expect(result.comparisonStatus).toBe("partial");
    expect(result.agentContext.resumeContextFacts.status).toBe("partial");
    expect(result.agentContext.resumeContextFacts.changes.length)
      .toBeGreaterThan(0);
    expect(
      result.agentContext.resumeContextFacts.changes.every(
        (change) => !("sourceRefs" in change.after)
      )
    ).toBe(true);
  });

  it("pins exact and N-1 mandatory admission on all six cost axes", async () => {
    const currentProviderResult = await currentProvider("semantic-change");
    const currentSourceObservationReceipt =
      captureScopedContinuitySourceObservation({
        observedAt: CURRENT_AT,
        pack: pack("Resume orchestrator thread", POLICY, [
          CURRENT_SUPPORT,
          CURRENT_OUTSIDE_SUPPORT
        ]),
        scope: { sourceId: SOURCE_ID, threadId: THREAD_ID }
      });
    const dependencies = previousDependencies();
    const baseline = compileContinuityResumeContext({
      schemaVersion: 1,
      ...dependencies,
      currentProviderResult,
      currentSourceObservationReceipt,
      budget: BUDGET
    });
    expect(baseline.status).toBe("partial");
    if (baseline.status !== "partial") throw new Error("partial required");
    const mandatory = baseline.reservation.mandatoryCost;
    const exact = {
      maxDepth: mandatory.depth,
      maxConsideredAssertions: mandatory.consideredAssertions,
      maxVisitedRefs: mandatory.visitedRefs,
      maxAssertions: mandatory.assertions,
      maxEstimatedTokens: mandatory.estimatedTokensV1,
      maxOutputBytes: mandatory.outputBytes
    };
    const axes = [
      ["depth", "maxDepth"],
      ["consideredAssertions", "maxConsideredAssertions"],
      ["visitedRefs", "maxVisitedRefs"],
      ["assertions", "maxAssertions"],
      ["estimatedTokensV1", "maxEstimatedTokens"],
      ["outputBytes", "maxOutputBytes"]
    ] as const;

    expect(Object.values(exact).every((value) => value > 0)).toBe(true);
    expect(compileContinuityResumeContext({
      schemaVersion: 1,
      ...dependencies,
      currentProviderResult,
      currentSourceObservationReceipt,
      budget: exact
    }).status).toBe("partial");
    for (const [costAxis, requestAxis] of axes) {
      const result = compileContinuityResumeContext({
        schemaVersion: 1,
        ...dependencies,
        currentProviderResult,
        currentSourceObservationReceipt,
        budget: { ...exact, [requestAxis]: exact[requestAxis] - 1 }
      });
      expect(result).toMatchObject({
        status: "abstained",
        reason: "mandatory-resume-context-does-not-fit",
        firstViolatedAxis: costAxis,
        mandatoryCost: mandatory
      });
      expect(getContinuityResumeContextAudit(result)).toBeUndefined();
    }
  });

  it("retains mandatory facts as a facts-only capacity-invalid usable result", async () => {
    const currentProviderResult = await currentProvider();
    const currentSourceObservationReceipt =
      captureScopedContinuitySourceObservation({
        observedAt: CURRENT_AT,
        pack: pack(),
        scope: { sourceId: SOURCE_ID, threadId: THREAD_ID }
      });
    const dependencies = previousDependencies();
    const baseline = compileContinuityResumeContext({
      schemaVersion: 1,
      ...dependencies,
      currentProviderResult,
      currentSourceObservationReceipt,
      budget: BUDGET
    });
    if (baseline.status !== "partial") throw new Error("partial required");
    const mandatory = baseline.reservation.mandatoryCost;
    const result = compileContinuityResumeContext({
      schemaVersion: 1,
      ...dependencies,
      currentProviderResult,
      currentSourceObservationReceipt,
      budget: {
        maxDepth: mandatory.depth,
        maxConsideredAssertions: mandatory.consideredAssertions,
        maxVisitedRefs: mandatory.visitedRefs,
        maxAssertions: mandatory.assertions,
        maxEstimatedTokens: mandatory.estimatedTokensV1,
        maxOutputBytes: mandatory.outputBytes
      }
    });

    expect(result).toMatchObject({
      status: "partial",
      witnessStatus: "capacity-invalid",
      agentContext: { supportingFacts: [] }
    });
    if (result.status !== "partial") throw new Error("partial required");
    const audit = getContinuityResumeContextAudit(result);
    if (audit === undefined) throw new Error("exact result audit required");
    expect(Object.hasOwn(result, "combinedCost")).toBe(false);
    expect(Object.hasOwn(
      audit.frontier.settlement,
      "settlement"
    )).toBe(false);
    expect(result.agentContext.contextStream).toBe(
      `${JSON.stringify(result.agentContext.resumeContextFacts)}\n`
    );
  });

  it("keeps audit capability exact, frozen, and outside enumerable results", async () => {
    const currentProviderResult = await currentProvider();
    if (currentProviderResult.status !== "partial") {
      throw new Error("partial Provider required");
    }
    const currentSourceObservationReceipt =
      captureScopedContinuitySourceObservation({
        observedAt: CURRENT_AT,
        pack: pack(),
        scope: { sourceId: SOURCE_ID, threadId: THREAD_ID }
      });
    const result = compileContinuityResumeContext({
      schemaVersion: 1,
      ...previousDependencies(),
      currentProviderResult,
      currentSourceObservationReceipt,
      budget: BUDGET
    });
    if (result.status !== "partial") throw new Error("partial required");
    const audit = getContinuityResumeContextAudit(result);
    if (audit === undefined) throw new Error("exact result audit required");

    expect(Object.hasOwn(result, "orchestrationEvidence")).toBe(false);
    const forbidden = new Set([
      "previous",
      "currentSourceObservationReceipt",
      "currentProviderResult",
      "currentGraphObservationReceipt",
      "changeResult",
      "inventory",
      "frontier",
      "receipt",
      "ledger",
      "manifest",
      "proof",
      "settlement",
      "documents",
      "dispositions",
      "sourceRefs",
      "derivation",
      "assertionId"
    ]);
    const pending: unknown[] = [result];
    const seen = new Set<object>();
    while (pending.length > 0) {
      const value = pending.pop();
      if (value === null || typeof value !== "object" || seen.has(value)) {
        continue;
      }
      seen.add(value);
      for (const [key, nested] of Object.entries(value)) {
        expect(forbidden.has(key)).toBe(false);
        pending.push(nested);
      }
    }

    for (const copy of [
      { ...result },
      JSON.parse(JSON.stringify(result)),
      structuredClone(result),
      { result },
      new Proxy(result, {})
    ]) {
      expect(getContinuityResumeContextAudit(copy)).toBeUndefined();
    }
    const traps = { get: 0, getOwnPropertyDescriptor: 0, ownKeys: 0 };
    const hostile = new Proxy({}, {
      get() {
        traps.get++;
        throw new Error("audit get trap must not run");
      },
      getOwnPropertyDescriptor() {
        traps.getOwnPropertyDescriptor++;
        throw new Error("audit descriptor trap must not run");
      },
      ownKeys() {
        traps.ownKeys++;
        throw new Error("audit keys trap must not run");
      }
    });
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    for (const value of [null, undefined, hostile, revoked.proxy]) {
      expect(getContinuityResumeContextAudit(value)).toBeUndefined();
    }
    expect(traps).toEqual({ get: 0, getOwnPropertyDescriptor: 0, ownKeys: 0 });
    expect(audit.inventory).toBe(
      getThreadRootedRetainedWitnessInventory(
        currentProviderResult.graphEvidence.legacyCompilation
      )
    );

    const auditPending: unknown[] = [audit];
    const auditSeen = new Set<object>();
    while (auditPending.length > 0) {
      const value = auditPending.pop();
      if (value === null || typeof value !== "object" || auditSeen.has(value)) {
        continue;
      }
      auditSeen.add(value);
      expect(Object.isFrozen(value)).toBe(true);
      auditPending.push(...Object.values(value));
    }
  });

  it("deep-freezes provenance-free agent context with canonical prototypes", async () => {
    const currentProviderResult = await currentProvider();
    const result = compileContinuityResumeContext({
      schemaVersion: 1,
      ...previousDependencies(),
      currentProviderResult,
      currentSourceObservationReceipt:
        captureScopedContinuitySourceObservation({
          observedAt: CURRENT_AT,
          pack: pack(),
          scope: { sourceId: SOURCE_ID, threadId: THREAD_ID }
        }),
      budget: BUDGET
    });
    if (result.status !== "partial") throw new Error("partial required");
    const forbidden = new Set([
      "assertionId",
      "source",
      "receipt",
      "boundary",
      "document",
      "entry",
      "nomination",
      "order",
      "settlement",
      "result",
      "manifestId",
      "sourceRefs",
      "derivation",
      "proof",
      "ledger"
    ]);
    const pending: unknown[] = [result.agentContext];
    const seen = new Set<object>();
    while (pending.length > 0) {
      const value = pending.pop();
      if (value === null || typeof value !== "object" || seen.has(value)) {
        continue;
      }
      seen.add(value);
      expect(Object.isFrozen(value)).toBe(true);
      if (Array.isArray(value)) {
        expect(Object.getPrototypeOf(value)).toBe(Array.prototype);
        pending.push(...value);
        continue;
      }
      expect(Object.getPrototypeOf(value)).toBeNull();
      for (const [key, nested] of Object.entries(value)) {
        expect(forbidden.has(key)).toBe(false);
        pending.push(nested);
      }
    }
  });

  it("contains one audit map/set, one top-level settlement, and no root export", () => {
    const source = readFileSync(
      new URL("./continuity-resume-context-orchestrator.ts", import.meta.url),
      "utf8"
    );
    const packageJson = JSON.parse(readFileSync(
      new URL("../package.json", import.meta.url),
      "utf8"
    )) as { readonly exports: Record<string, unknown> };
    expect(source.match(/new WeakMap<object, ContinuityResumeContextAuditV1>/gu))
      .toHaveLength(1);
    expect(source.match(/CONTINUITY_RESUME_CONTEXT_AUDITS\.set\(result, audit\)/gu))
      .toHaveLength(1);
    expect(source.match(/settleFairWitnessFrontier\(\{/gu)).toHaveLength(1);
    expect(Object.hasOwn(packageJson.exports, ".")).toBe(false);
    const supportingBody = source.slice(
      source.indexOf("function supportingFacts("),
      source.indexOf("function settlementCost(")
    );
    expect(supportingBody).not.toMatch(
      /item\.entry\.frontierDisposition\.(?:status|rank)/u
    );
    expect(supportingBody).toMatch(
      /frontier\.receipt\.dispositions/u
    );
  });
});
