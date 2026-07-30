import { createHash } from "node:crypto";

import type { AttunementState } from "@muse/attunement";
import { describe, expect, it, vi } from "vitest";

import {
  canonicalizeImmutableEnvelope
} from "./canonical-immutable-envelope.js";
import {
  sealContinuityObservation,
  type ContinuityObservationReceipt
} from "./continuity-observation.js";
import {
  CONTINUITY_PROJECTION_RULE_VERSION,
  projectContinuityState,
  type ContinuityGraphProjection
} from "./continuity-projection.js";
import { InMemoryAttunementGraphStore } from "./in-memory-store.js";
import {
  CapturingAttunementGraphStore,
  ReceiptBoundGraphEvidenceError,
  compileReceiptBoundGraphEvidence
} from "./receipt-bound-graph-evidence.js";
import * as publicGraphApi from "./index.js";
import type { GraphAssertion } from "./types.js";
import { normalizeGraphQueryPlan } from "./validation.js";

const OBSERVED_AT = "2026-07-29T08:00:00.000Z";
const ASSESSED_AT = "2026-07-29T08:05:00.000Z";
const RAW_THREAD_ID = "thread_trip";
const SCOPE = { sourceId: "default", threadId: RAW_THREAD_ID };
const ADMISSION_SPEC = Object.freeze({
  hashDomain: "muse.attunement-graph.receipt-bound-graph-evidence-admission.v1",
  idField: "admissionId",
  idPrefix: "muse-receipt-bound-graph-admission:sha256:"
} as const);

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function sourceFixture(): AttunementState {
  const link = {
    artifactId: "private-provider-artifact-id-sentinel",
    artifactType: "resource" as const,
    linkedAt: "2026-07-29T01:00:00.000Z",
    linkedBy: "user" as const,
    providerId: "mcp:private-provider-sentinel",
    role: "context" as const,
    threadId: RAW_THREAD_ID
  };
  return {
    deliveries: [{
      evidenceClass: "organic",
      evidenceRefs: [{
        artifactId: link.artifactId,
        artifactType: link.artifactType,
        providerId: link.providerId,
        role: link.role
      }],
      id: "delivery_first",
      openedAt: "2026-07-29T02:00:00.000Z",
      outcome: {
        evidenceClass: "organic",
        outcome: "used",
        ownerNote: "private owner note sentinel",
        policyVersion: 1,
        recordedAt: "2026-07-29T03:00:00.000Z"
      },
      policyVersion: 0,
      runId: "continuity_run_first",
      threadId: RAW_THREAD_ID
    }],
    experienceLearningPolicyAudits: [],
    interactionReceipts: [],
    nextPolicyVersion: 2,
    resetReceipts: [],
    schemaVersion: 12,
    threads: [{
      createdAt: "2026-07-29T00:00:00.000Z",
      id: RAW_THREAD_ID,
      kind: "life",
      links: [link],
      policy: {
        detail: "compact",
        nextStep: "direct",
        suppression: "none",
        version: 1
      },
      title: "private trip title sentinel · private artifact summary sentinel"
    }],
    undoResetReceipts: []
  };
}

function projection(): ContinuityGraphProjection {
  return projectContinuityState({
    scope: SCOPE,
    sourceObservedAt: OBSERVED_AT,
    state: sourceFixture()
  });
}

function receipt(value: ContinuityGraphProjection = projection()): ContinuityObservationReceipt {
  return sealContinuityObservation({
    schemaVersion: 1,
    authority: "caller-declared-observation",
    observedAt: OBSERVED_AT,
    projection: value,
    diagnostics: {
      descriptorsInspected: 128,
      projectedAssertions: value.assertions.length,
      sourceRecordsInspected: 4,
      stringBytesInspected: 2_048
    }
  });
}

function assertionByPredicate(
  value: ContinuityObservationReceipt,
  predicate: GraphAssertion["predicate"]
): GraphAssertion {
  const assertion = value.projection.assertions.find((item) =>
    item.predicate === predicate
  );
  if (!assertion) throw new Error(`missing fixture predicate ${predicate}`);
  return assertion;
}

function request(
  receiptValue: ContinuityObservationReceipt = receipt()
): Record<string, unknown> {
  const core = assertionByPredicate(receiptValue, "CONTEXT_FOR");
  const support = assertionByPredicate(receiptValue, "SUPPORTED_BY");
  return clone({
    schemaVersion: 1,
    operatorVersion: "muse.receipt-bound-graph-evidence.v1",
    scope: SCOPE,
    currentGraphObservationReceipt: receiptValue,
    recordedAtOrBefore: OBSERVED_AT,
    snapshot: {
      authority: "caller-declared-read-snapshot",
      commitHash: `sha256:${"a".repeat(64)}`,
      commitSequence: 7,
      generationId: "generation-7"
    },
    declaredFreshness: {
      assessedAt: ASSESSED_AT,
      observedAt: OBSERVED_AT,
      status: "fresh"
    },
    nominations: {
      core: {
        assertionId: core.id,
        nominationId: "core-context",
        role: "core"
      },
      optionals: [{
        assertionId: support.id,
        nominationId: "changed-support",
        role: "change"
      }, {
        assertionId: support.id,
        nominationId: "support-copy",
        role: "support"
      }]
    },
    legacyBudget: {
      maxAssertions: 32,
      maxConsideredAssertions: 256,
      maxDepth: 4,
      maxEstimatedTokens: 16_384,
      maxOutputBytes: 1_000_000,
      maxVisitedRefs: 64
    }
  });
}

function headRevalidatedPair(providerScope = SCOPE) {
  const revalidationReceiptId =
    `muse-local-attunement-head-revalidation:sha256:${"d".repeat(64)}`;
  const endpoint = {
    providerReceiptId:
      `muse-local-attunement-snapshot:sha256:${"e".repeat(64)}`,
    stateDigest: `sha256:${"f".repeat(64)}`,
    normalizedStateBytes: 42,
    captureCompletedAt: OBSERVED_AT
  };
  const assessedAt = new Date(Date.parse(OBSERVED_AT) + 25).toISOString();
  return {
    snapshot: {
      authority: "receipt-integrity-only",
      kind: "process-local-provider-head-revalidation",
      revalidationReceiptId,
      providerId: "muse.local-attunement-store",
      providerVersion: "muse.local-attunement-snapshot-provider.v1",
      providerScope: { ...providerScope },
      subject: endpoint,
      head: {
        ...endpoint,
        providerReceiptId:
          `muse-local-attunement-snapshot:sha256:${"1".repeat(64)}`,
        captureCompletedAt: assessedAt
      },
      mintVerification:
        "provider-owned-two-capture-pair-verified-in-composing-process",
      mintVerificationSurvivesSerialization: false
    },
    freshness: {
      basis: "provider-head-revalidation",
      status: "fresh",
      providerScope: { ...providerScope },
      observedAt: OBSERVED_AT,
      assessedAt,
      captureSpanMs: 25,
      maxCaptureSpanMs: 25,
      reasonId: "head-state-matched-within-bound",
      revalidationReceiptId
    }
  };
}

function expectEvidenceError(
  operation: Promise<unknown>,
  code: ReceiptBoundGraphEvidenceError["code"],
  reason: ReceiptBoundGraphEvidenceError["details"]["reason"],
  path?: string
): Promise<void> {
  return operation.then(
    () => {
      throw new Error("expected ReceiptBoundGraphEvidenceError");
    },
    (cause: unknown) => {
      expect(cause).toBeInstanceOf(ReceiptBoundGraphEvidenceError);
      const error = cause as ReceiptBoundGraphEvidenceError;
      expect(error.code).toBe(code);
      expect(error.details.reason).toBe(reason);
      if (path !== undefined) expect(error.details.path).toBe(path);
    }
  );
}

function expectDeepFrozen(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  expect(Object.isFrozen(value)).toBe(true);
  for (const key of Reflect.ownKeys(value)) {
    if (key === "length") continue;
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    expect(descriptor).toMatchObject({
      configurable: false,
      enumerable: true,
      writable: false
    });
    if (descriptor && "value" in descriptor) expectDeepFrozen(descriptor.value);
  }
}

function canonicalValue(value: unknown): unknown {
  if (
    value === null
    || typeof value === "string"
    || typeof value === "boolean"
    || typeof value === "number"
  ) {
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalValue);
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(value as object).sort()) {
    output[key] = canonicalValue((value as Record<string, unknown>)[key]);
  }
  return output;
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(canonicalValue(value)))
    .digest("hex")}`;
}

function projectionWithModelHypothesis(): ContinuityGraphProjection {
  const original = clone(projection());
  const sourceRef = {
    id: "model-source",
    namespace: "dogfood.model",
    version: "v1"
  };
  const modelAssertion: GraphAssertion = {
    schemaVersion: 1,
    id: "model-proposal",
    subject: { id: "decision-proposal", kind: "decision" },
    predicate: "PROPOSES_POLICY",
    object: { id: "policy-proposal", kind: "policy" },
    epistemicClass: "model-hypothesis",
    sourceRefs: [sourceRef],
    recordedAt: "2026-07-29T04:00:00.000Z",
    derivation: { kind: "model", version: "fixture-v1" }
  };
  const assertions = [...original.assertions, modelAssertion]
    .sort((left, right) => left.id.localeCompare(right.id));
  const timestampBasis = [...original.timestampBasis, {
    basis: "source-observation" as const,
    sourceRef
  }].sort((left, right) =>
    JSON.stringify(left.sourceRef).localeCompare(JSON.stringify(right.sourceRef))
  );
  const body = {
    schemaVersion: 1 as const,
    ruleVersion: CONTINUITY_PROJECTION_RULE_VERSION,
    scope: original.scope,
    sourceVersion: original.sourceVersion,
    assertions,
    timestampBasis
  };
  return {
    ...body,
    projectionVersion: digest({
      assertions,
      ruleVersion: CONTINUITY_PROJECTION_RULE_VERSION,
      scope: original.scope
    })
  };
}

describe("receipt-bound Agent Graph evidence compiler", () => {
  it("rejects cross-scope provider-head replay at direct entry", async () => {
    const input = request();
    const pair = headRevalidatedPair();
    input.snapshot = pair.snapshot;
    input.declaredFreshness = pair.freshness;
    input.scope = { ...SCOPE, threadId: "thread_other" };
    await expectEvidenceError(
      compileReceiptBoundGraphEvidence(input),
      "INVALID_INPUT",
      "invalid-freshness",
      "/scope"
    );
  });

  it("remains package-private rather than expanding the public graph surface", () => {
    expect(publicGraphApi).not.toHaveProperty("compileReceiptBoundGraphEvidence");
    expect(publicGraphApi).not.toHaveProperty("ReceiptBoundGraphEvidenceError");
  });

  it("runs one receipt-bound traversal and conserves duplicate logical nominations", async () => {
    const input = request();
    const originalTraverse = InMemoryAttunementGraphStore.prototype.traverse;
    const traversal = vi.spyOn(
      InMemoryAttunementGraphStore.prototype,
      "traverse"
    ).mockImplementation(function (
      this: InMemoryAttunementGraphStore,
      plan
    ) {
      expect(Object.isFrozen(plan)).toBe(true);
      return originalTraverse.call(this, plan);
    });

    const result = await compileReceiptBoundGraphEvidence(input);

    expect(traversal).toHaveBeenCalledTimes(1);
    traversal.mockRestore();
    expect(result.receipt.status).toBe("partial");
    expect(result.receipt.coverage.status).toBe(result.receipt.status);
    expect(result.receipt.sourceScope).toEqual(SCOPE);
    expect(result.receipt.actualSeed).toMatchObject({
      kind: "thread",
      id: expect.stringMatching(/^muse-continuity-thread:[0-9a-f]{64}$/u)
    });
    expect(result.receipt.actualSeed.id).not.toBe(RAW_THREAD_ID);
    expect(result.receipt.compatibilityScope).toEqual({
      sourceId: SCOPE.sourceId,
      threadId: result.receipt.actualSeed.id
    });
    expect(result.receipt.activationEvidenceId).toBe(
      result.activationEvidence.evidenceId
    );
    expect(result.receipt.legacyWitnessReceiptId).toBe(
      result.legacyCompilation.receipt.receiptId
    );
    expect(result.receipt.coverage.reasons).toEqual([
      "caller-declared-observation",
      "source-authority-unverified",
      "bounded-activation-only",
      "legacy-payload-budget-only",
      "non-authoritative-compatibility-scope",
      "nomination-reused"
    ]);
    expect(result.receipt.dispositions).toEqual([
      expect.objectContaining({
        nominationId: "core-context",
        representativeNominationId: "core-context",
        status: "submitted-admitted"
      }),
      expect.objectContaining({
        nominationId: "changed-support",
        representativeNominationId: "changed-support",
        status: "submitted-admitted"
      }),
      expect.objectContaining({
        nominationId: "support-copy",
        representativeNominationId: "changed-support",
        status: "reused-admitted"
      })
    ]);
    expect(result.activationEvidence.plan).toEqual(
      expect.objectContaining({
        direction: "both",
        seeds: [result.receipt.actualSeed],
        validAt: OBSERVED_AT,
        recordedAtOrBefore: OBSERVED_AT
      })
    );
    expect(result.activationEvidence.activation.assertions).not.toContainEqual(
      expect.objectContaining({ epistemicClass: "model-hypothesis" })
    );
    expect(JSON.stringify(result)).not.toMatch(
      /private trip title sentinel|private owner note sentinel/iu
    );
    expectDeepFrozen(result);

    const replay = await compileReceiptBoundGraphEvidence(clone(input));
    expect(replay.receipt.receiptId).toBe(result.receipt.receiptId);
    expect(replay.activationEvidence.evidenceId).toBe(
      result.activationEvidence.evidenceId
    );
    expect(replay).toStrictEqual(result);
  });

  it("detaches admitted bytes before the first async store operation", async () => {
    const input = request();
    const nominations = (input.nominations as {
      optionals: { nominationId: string }[];
    }).optionals;
    const pending = compileReceiptBoundGraphEvidence(input);
    nominations[0]!.nominationId = "mutated-after-admission";
    const result = await pending;
    expect(result.receipt.dispositions.map((item) => item.nominationId))
      .toContain("changed-support");
    expect(result.receipt.dispositions.map((item) => item.nominationId))
      .not.toContain("mutated-after-admission");
  });

  it("uses core > change > support precedence for duplicate assertion nominations", async () => {
    const input = request();
    const coreAssertionId = ((input.nominations as {
      core: { assertionId: string };
    }).core).assertionId;
    (input.nominations as {
      optionals: Record<string, unknown>[];
    }).optionals.push({
      assertionId: coreAssertionId,
      nominationId: "support-core-copy",
      role: "support"
    });
    const result = await compileReceiptBoundGraphEvidence(input);
    expect(result.receipt.dispositions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          nominationId: "core-context",
          representativeNominationId: "core-context",
          status: "submitted-admitted"
        }),
        expect.objectContaining({
          nominationId: "support-core-copy",
          representativeNominationId: "core-context",
          status: "reused-admitted"
        }),
        expect.objectContaining({
          nominationId: "changed-support",
          representativeNominationId: "changed-support",
          status: "submitted-admitted"
        }),
        expect.objectContaining({
          nominationId: "support-copy",
          representativeNominationId: "changed-support",
          status: "reused-admitted"
        })
      ])
    );
  });

  it("rejects a second traversal at the package-private capture boundary", async () => {
    const wrapper = new CapturingAttunementGraphStore(
      new InMemoryAttunementGraphStore()
    );
    const plan = normalizeGraphQueryPlan({
      seeds: [{ id: "thread-test", kind: "thread" }],
      predicates: ["LINKED_TO"],
      direction: "both",
      maxDepth: 1,
      maxAssertions: 1,
      maxConsideredAssertions: 1,
      maxVisitedRefs: 4
    });
    await wrapper.traverse(plan);
    await expect(wrapper.traverse(plan)).rejects.toMatchObject({
      code: "INVALID_QUERY",
      message: "receipt-bound graph evidence permits exactly one traversal"
    });
    expect(wrapper.traversals).toBe(1);
    expect(wrapper.plan).toBe(plan);
  });

  it("rejects matching and mismatching caller-supplied admission IDs", async () => {
    const baseline = request();
    const matching = clone(
      canonicalizeImmutableEnvelope(
        baseline,
        "external-mutable",
        ADMISSION_SPEC
      ).envelope
    );
    await expectEvidenceError(
      compileReceiptBoundGraphEvidence(matching),
      "INVALID_INPUT",
      "invalid-field-set",
      "/admissionId"
    );

    const mismatching = request();
    mismatching.admissionId =
      `muse-receipt-bound-graph-admission:sha256:${"0".repeat(64)}`;
    await expectEvidenceError(
      compileReceiptBoundGraphEvidence(mismatching),
      "INVALID_INPUT",
      "invalid-request-envelope",
      "/admissionId"
    );
  });

  it.each([
    "seed",
    "query",
    "activation",
    "assertions",
    "evidenceId",
    "resultId"
  ])("rejects caller injection of internal field %s", async (field) => {
    const injected = request();
    injected[field] = { controlled: true };
    await expectEvidenceError(
      compileReceiptBoundGraphEvidence(injected),
      "INVALID_INPUT",
      "invalid-field-set",
      ""
    );
  });

  it("rejects legacy nomination-time injection removed by the receipt-bound contract", async () => {
    const injected = request();
    ((injected.nominations as {
      optionals: Record<string, unknown>[];
    }).optionals[0]!).observedAt = OBSERVED_AT;
    await expectEvidenceError(
      compileReceiptBoundGraphEvidence(injected),
      "INVALID_INPUT",
      "invalid-nominations",
      "/nominations/optionals/0"
    );
  });

  it("fails closed on receipt, scope, nomination, and epistemic mismatches", async () => {
    const wrongScope = request();
    (wrongScope.scope as { threadId: string }).threadId = "thread_other";
    await expectEvidenceError(
      compileReceiptBoundGraphEvidence(wrongScope),
      "DEPENDENCY_MISMATCH",
      "scope-receipt-mismatch",
      "/scope"
    );

    const changedReceipt = request();
    const embedded = changedReceipt.currentGraphObservationReceipt as {
      observedAt: string;
    };
    embedded.observedAt = "2026-07-29T07:59:59.000Z";
    await expectEvidenceError(
      compileReceiptBoundGraphEvidence(changedReceipt),
      "DEPENDENCY_MISMATCH",
      "observation-receipt-integrity-mismatch",
      "/currentGraphObservationReceipt"
    );

    const offReceipt = request();
    ((offReceipt.nominations as {
      optionals: { assertionId: string }[];
    }).optionals[0]!).assertionId = "missing-assertion";
    await expectEvidenceError(
      compileReceiptBoundGraphEvidence(offReceipt),
      "DEPENDENCY_MISMATCH",
      "nomination-off-receipt",
      "/nominations/optionals/0/assertionId"
    );

    const modelReceipt = receipt(projectionWithModelHypothesis());
    const modelRequest = request(modelReceipt);
    ((modelRequest.nominations as {
      optionals: { assertionId: string }[];
    }).optionals[0]!).assertionId = "model-proposal";
    await expectEvidenceError(
      compileReceiptBoundGraphEvidence(modelRequest),
      "DEPENDENCY_MISMATCH",
      "nomination-not-admissible",
      "/nominations/optionals/0/assertionId"
    );
  });

  it("keeps unavailable freshness and capacity failure as explicit abstention", async () => {
    const unavailable = request();
    unavailable.declaredFreshness = {
      reasonId: "caller-unavailable",
      status: "unavailable"
    };
    const unavailableResult = await compileReceiptBoundGraphEvidence(unavailable);
    expect(unavailableResult.receipt.status).toBe("abstained");
    expect(unavailableResult.receipt.coverage.reasons).toContain(
      "legacy-settlement-abstained"
    );
    expect(unavailableResult.receipt.dispositions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          legacyAdmissionStatus: "core-not-admitted",
          nominationId: "core-context",
          status: "submitted-not-admitted"
        }),
        expect.objectContaining({
          nominationId: "support-copy",
          status: "reused-not-admitted"
        })
      ])
    );

    const zeroOutput = request();
    (zeroOutput.legacyBudget as { maxOutputBytes: number }).maxOutputBytes = 0;
    const capacity = await compileReceiptBoundGraphEvidence(zeroOutput);
    expect(capacity.receipt.status).toBe("abstained");
    expect(capacity.receipt.dispositions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          legacyAdmissionStatus: "capacity-invalid",
          nominationId: "core-context",
          status: "submitted-not-admitted"
        }),
        expect.objectContaining({
          legacyAdmissionStatus: "capacity-invalid",
          nominationId: "changed-support",
          status: "submitted-not-admitted"
        })
      ])
    );
  });

  it("binds semantic output independently of key order and rejects invalid budget edges", async () => {
    const baseline = request();
    const first = await compileReceiptBoundGraphEvidence(baseline);
    const permuted = Object.fromEntries(
      Object.entries(clone(baseline)).reverse()
    );
    const nominationsValue = permuted.nominations as Record<string, unknown>;
    permuted.nominations = Object.fromEntries(
      Object.entries(nominationsValue).reverse()
    );
    const second = await compileReceiptBoundGraphEvidence(permuted);
    expect(second.receipt.receiptId).toBe(first.receipt.receiptId);
    expect(second.activationEvidence.evidenceId).toBe(
      first.activationEvidence.evidenceId
    );

    const excessiveDepth = request();
    (excessiveDepth.legacyBudget as { maxDepth: number }).maxDepth = 5;
    await expectEvidenceError(
      compileReceiptBoundGraphEvidence(excessiveDepth),
      "INVALID_INPUT",
      "invalid-legacy-budget",
      "/legacyBudget/maxDepth"
    );

    const futureCutoff = request();
    futureCutoff.recordedAtOrBefore = "2026-07-29T08:00:00.001Z";
    await expectEvidenceError(
      compileReceiptBoundGraphEvidence(futureCutoff),
      "DEPENDENCY_MISMATCH",
      "cutoff-after-observation",
      "/recordedAtOrBefore"
    );
  });

  it.each([
    ["maxAssertions", 0],
    ["maxAssertions", 257],
    ["maxConsideredAssertions", 31],
    ["maxConsideredAssertions", 1_025],
    ["maxDepth", -1],
    ["maxDepth", 5],
    ["maxEstimatedTokens", 63],
    ["maxEstimatedTokens", 32_769],
    ["maxOutputBytes", -1],
    ["maxVisitedRefs", 0],
    ["maxVisitedRefs", 1_025]
  ] as const)("rejects legacy budget boundary %s=%s", async (field, value) => {
    const invalidBudget = request();
    (invalidBudget.legacyBudget as Record<string, number>)[field] = value;
    await expectEvidenceError(
      compileReceiptBoundGraphEvidence(invalidBudget),
      "INVALID_INPUT",
      "invalid-legacy-budget",
      `/legacyBudget/${field}`
    );
  });

  it("lets hostile admission reject an unsafe-integer output budget first", async () => {
    const unsafe = request();
    (unsafe.legacyBudget as { maxOutputBytes: number }).maxOutputBytes =
      Number.MAX_SAFE_INTEGER + 1;
    await expectEvidenceError(
      compileReceiptBoundGraphEvidence(unsafe),
      "INVALID_INPUT",
      "invalid-request-envelope",
      "/legacyBudget/maxOutputBytes"
    );
  });

  it("turns activation selection exclusion into explicit graph-path abstention", async () => {
    const bounded = request();
    Object.assign(bounded.legacyBudget as Record<string, number>, {
      maxAssertions: 1,
      maxConsideredAssertions: 256
    });
    const result = await compileReceiptBoundGraphEvidence(bounded);
    expect(result.receipt.status).toBe("abstained");
    expect(result.receipt.coverage.reasons).toContain("nomination-excluded");
    expect(result.receipt.dispositions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          nominationId: "core-context",
          status: "submitted-excluded"
        })
      ])
    );
  });

  it("detects a trusted-store traversal result tamper seam", async () => {
    const originalTraverse = InMemoryAttunementGraphStore.prototype.traverse;
    const tampered = vi.spyOn(
      InMemoryAttunementGraphStore.prototype,
      "traverse"
    ).mockImplementation(async function (
      this: InMemoryAttunementGraphStore,
      plan
    ) {
      const result = await originalTraverse.call(this, plan);
      const assertions = clone(result.assertions) as GraphAssertion[];
      assertions[0] = { ...assertions[0]!, id: "tampered-assertion-id" };
      return {
        ...clone(result),
        assertions
      };
    });
    await expectEvidenceError(
      compileReceiptBoundGraphEvidence(request()),
      "INTERNAL_POSTCONDITION_FAILED",
      "receipt-assertion-mismatch",
      "/activationEvidence/traversal/assertions"
    );
    tampered.mockRestore();
  });

  it("rejects hostile object graphs without invoking accessors", async () => {
    let getterCalls = 0;
    const accessor = request();
    Object.defineProperty(accessor, "scope", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return SCOPE;
      }
    });
    await expectEvidenceError(
      compileReceiptBoundGraphEvidence(accessor),
      "INVALID_INPUT",
      "invalid-request-envelope"
    );
    expect(getterCalls).toBe(0);

    const proxied = new Proxy(request(), {});
    await expectEvidenceError(
      compileReceiptBoundGraphEvidence(proxied),
      "INVALID_INPUT",
      "invalid-request-envelope"
    );

    const cyclic = request();
    cyclic.loop = cyclic;
    await expectEvidenceError(
      compileReceiptBoundGraphEvidence(cyclic),
      "INVALID_INPUT",
      "invalid-request-envelope"
    );

    const aliased = request();
    aliased.alias = aliased.scope;
    await expectEvidenceError(
      compileReceiptBoundGraphEvidence(aliased),
      "INVALID_INPUT",
      "invalid-request-envelope"
    );

    const sparse = request();
    (sparse.nominations as { optionals: unknown[] }).optionals = new Array(1);
    await expectEvidenceError(
      compileReceiptBoundGraphEvidence(sparse),
      "INVALID_INPUT",
      "invalid-request-envelope"
    );

    const mixed = request();
    Object.freeze(mixed.scope);
    await expectEvidenceError(
      compileReceiptBoundGraphEvidence(mixed),
      "INVALID_INPUT",
      "invalid-request-envelope"
    );
  });

  it("keeps the public error surface frozen, bounded, and cause-free", async () => {
    const invalid = request();
    invalid.schemaVersion = 2;
    try {
      await compileReceiptBoundGraphEvidence(invalid);
      throw new Error("expected failure");
    } catch (cause) {
      expect(cause).toBeInstanceOf(ReceiptBoundGraphEvidenceError);
      const error = cause as ReceiptBoundGraphEvidenceError;
      expect(error).toMatchObject({
        code: "INVALID_INPUT",
        details: {
          path: "/schemaVersion",
          reason: "invalid-schema-version"
        },
        message: "receipt-bound-graph-evidence-failed",
        name: "ReceiptBoundGraphEvidenceError"
      });
      expect(error).not.toHaveProperty("stack");
      expect(error).not.toHaveProperty("cause");
      expect(Object.keys(error)).toEqual(["code", "details"]);
      for (const key of ["message", "name", "code", "details"]) {
        expect(Object.getOwnPropertyDescriptor(error, key)).toMatchObject({
          configurable: false,
          enumerable: key === "code" || key === "details",
          writable: false
        });
      }
      expect(Object.isFrozen(error.details)).toBe(true);
    }
  });

  it("rejects a surplus frontier entry without a witnessed nomination", async () => {
    vi.resetModules();
    vi.doMock("./thread-rooted-witness-documents.js", async () => {
      const actual = await vi.importActual<
        typeof import("./thread-rooted-witness-documents.js")
      >("./thread-rooted-witness-documents.js");
      return {
        ...actual,
        compileThreadRootedWitnessDocuments(input: unknown) {
          const result = clone(actual.compileThreadRootedWitnessDocuments(input));
          const dispositions = result.frontier?.receipt.dispositions;
          if (!dispositions || dispositions.length === 0) {
            throw new Error("fixture requires one frontier disposition");
          }
          (dispositions as unknown as Record<string, unknown>[]).push({
            ...dispositions[0],
            nominationId: "surplus-frontier"
          });
          return result;
        }
      };
    });
    const isolated = await import("./receipt-bound-graph-evidence.js");
    try {
      await isolated.compileReceiptBoundGraphEvidence(request());
      throw new Error("expected frontier conservation failure");
    } catch (cause) {
      expect(cause).toMatchObject({
        code: "INTERNAL_POSTCONDITION_FAILED",
        details: {
          path: "/legacyCompilation/frontier/receipt/dispositions",
          reason: "admission-disposition-mismatch"
        }
      });
    }
    vi.doUnmock("./thread-rooted-witness-documents.js");
    vi.resetModules();
  });

  it("maps canonical 1 MiB artifact overflow at both output stages", async () => {
    vi.resetModules();
    let overflowDomain =
      "muse.attunement-graph.receipt-bound-activation-evidence.v1";
    vi.doMock("./canonical-immutable-envelope.js", async () => {
      const actual = await vi.importActual<
        typeof import("./canonical-immutable-envelope.js")
      >("./canonical-immutable-envelope.js");
      return {
        ...actual,
        canonicalizeImmutableEnvelope(
          input: unknown,
          profile: Parameters<typeof actual.canonicalizeImmutableEnvelope>[1],
          spec: Parameters<typeof actual.canonicalizeImmutableEnvelope>[2]
        ) {
          if (spec.hashDomain === overflowDomain) {
            throw new actual.CanonicalImmutableEnvelopeError(
              "BUDGET_EXCEEDED",
              "encode: full-envelope-bytes",
              {
                phase: "encode",
                reason: "full-envelope-bytes",
                path: "",
                axis: "full-envelope-bytes",
                actual: 1_048_577,
                limit: 1_048_576
              }
            );
          }
          return actual.canonicalizeImmutableEnvelope(input, profile, spec);
        }
      };
    });
    const isolated = await import("./receipt-bound-graph-evidence.js");
    const expectIsolatedCapacity = async (
      operation: Promise<unknown>,
      path: string
    ): Promise<void> => {
      try {
        await operation;
        throw new Error("expected isolated capacity failure");
      } catch (cause) {
        expect(cause).toMatchObject({
          code: "CAPACITY_EXCEEDED",
          details: {
            path,
            reason: "result-envelope-capacity-exceeded"
          },
          message: "receipt-bound-graph-evidence-failed",
          name: "ReceiptBoundGraphEvidenceError"
        });
      }
    };
    await expectIsolatedCapacity(
      isolated.compileReceiptBoundGraphEvidence(request()),
      "/activationEvidence"
    );
    overflowDomain =
      "muse.attunement-graph.receipt-bound-graph-evidence-receipt.v1";
    await expectIsolatedCapacity(
      isolated.compileReceiptBoundGraphEvidence(request()),
      "/receipt"
    );
    vi.doUnmock("./canonical-immutable-envelope.js");
    vi.resetModules();
  });
});
