import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createLocalAttunementSnapshotProvider
} from "@muse/attunement/testing";
import { parseAttunementState } from "@muse/attunement/state-validation";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  canonicalizeImmutableEnvelope
} from "@attunegraph/core/extension-kit";
import * as graphRoot from "@attunegraph/core";
import {
  ProviderBoundGraphEvidenceError,
  ProviderGraphBindingReceiptError,
  compileProviderBoundGraphEvidence,
  verifyProviderGraphBindingReceipt
} from "./provider-bound-graph-evidence.js";

const AT = "2026-07-30T00:00:00.000Z";
const SOURCE_ID = "provider-graph-test";
const THREAD_ID = "thread_provider_graph";
const CANARY = "PRIVATE_PROVIDER_GRAPH_CANARY_7d7a";
const directories: string[] = [];

function state(
  title = CANARY,
  linkCount = 0,
  deliveryCount = 0
): Record<string, unknown> {
  return {
    deliveries: Array.from({ length: deliveryCount }, (_, index) => ({
      evidenceClass: "organic",
      evidenceRefs: Array.from({ length: 2 }, (_unused, evidenceIndex) => ({
        artifactId:
          `delivery_${index.toString().padStart(3, "0")}`
          + `_evidence_${evidenceIndex.toString()}`,
        artifactType: "task",
        providerId: "local",
        role: "context"
      })),
      id: `delivery_provider_graph_${index.toString().padStart(3, "0")}`,
      openedAt: "2026-07-29T23:20:00.000Z",
      outcome: {
        evidenceClass: "organic",
        outcome: "used",
        ownerNote: CANARY,
        policyVersion: index + 1,
        recordedAt: "2026-07-29T23:30:00.000Z"
      },
      policyVersion: index,
      runId: `run_provider_graph_${index.toString().padStart(3, "0")}`,
      threadId: THREAD_ID
    })),
    interactionReceipts: [],
    nextPolicyVersion: deliveryCount + 1,
    resetReceipts: [],
    schemaVersion: 11,
    threads: [{
      createdAt: "2026-07-29T23:00:00.000Z",
      id: THREAD_ID,
      kind: "work",
      links: Array.from({ length: linkCount }, (_, index) => ({
        artifactId: `task_provider_graph_${index.toString().padStart(3, "0")}`,
        artifactType: "task",
        linkedAt: "2026-07-29T23:10:00.000Z",
        linkedBy: "user",
        providerId: "local",
        role: "context",
        threadId: THREAD_ID
      })),
      policy: {
        detail: "compact",
        nextStep: "direct",
        suppression: "none",
        version: deliveryCount
      },
      title
    }],
    undoResetReceipts: []
  };
}

async function capture(
  threadId = THREAD_ID,
  title = CANARY,
  at = AT,
  pretty = false,
  linkCount = 0,
  deliveryCount = 0,
  factory = createLocalAttunementSnapshotProvider
) {
  const directory = await mkdtemp(join(tmpdir(), "muse-attunegraph-provider-graph-"));
  directories.push(directory);
  const attunementFile = join(directory, "attunement.json");
  const fixture = parseAttunementState(
    state(title, linkCount, deliveryCount)
  );
  await writeFile(
    attunementFile,
    `${
      JSON.stringify(
        fixture,
        null,
        pretty ? 2 : undefined
      )
    }\n`,
    {
    encoding: "utf8",
    mode: 0o600
    }
  );
  const provider = factory({
    attunementFile,
    clock: () => new Date(at),
    sourceId: SOURCE_ID
  });
  return provider.capture({ sourceId: SOURCE_ID, threadId });
}

function resealReceipt(
  receipt: Record<string, unknown>
): Record<string, unknown> {
  const body = JSON.parse(JSON.stringify(receipt)) as Record<string, unknown>;
  delete body.receiptId;
  const envelope = canonicalizeImmutableEnvelope(
    body,
    "external-mutable",
    {
      hashDomain:
        "muse.attunegraph.provider-bound-graph-evidence-receipt.v1",
      idField: "receiptId",
      idPrefix: "muse-attunegraph-provider-bound-graph-evidence:sha256:"
    }
  ).envelope;
  return JSON.parse(JSON.stringify(envelope)) as Record<string, unknown>;
}

async function isolatedCapture() {
  const isolatedTesting = await import(
    "@muse/attunement/testing"
  ) as unknown as {
    createLocalAttunementSnapshotProviderForTesting:
      typeof createLocalAttunementSnapshotProvider;
  };
  return capture(
    THREAD_ID,
    CANARY,
    AT,
    false,
    0,
    0,
    isolatedTesting.createLocalAttunementSnapshotProviderForTesting
  );
}

function assertDeepFrozen(
  value: unknown,
  seen = new Set<object>()
): void {
  if (value === null || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  expect(Object.isFrozen(value)).toBe(true);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    expect(descriptor).toBeDefined();
    expect(descriptor && "value" in descriptor).toBe(true);
    if (descriptor && "value" in descriptor) {
      assertDeepFrozen(descriptor.value, seen);
    }
  }
}

function expectBindingError(
  operation: () => unknown,
  code: ProviderBoundGraphEvidenceError["code"],
  reason: ProviderBoundGraphEvidenceError["details"]["reason"],
  path: string
): void {
  try {
    operation();
  } catch (cause) {
    expect(cause).toBeInstanceOf(ProviderBoundGraphEvidenceError);
    const error = cause as ProviderBoundGraphEvidenceError;
    expect(error.message).toBe("provider-bound-graph-evidence-failed");
    expect(error.code).toBe(code);
    expect(error.details).toEqual({ reason, path });
    expect(error.stack).toBeUndefined();
    expect(Object.keys(error).sort()).toEqual(["code", "details"]);
    expect(Object.isFrozen(error)).toBe(true);
    return;
  }
  throw new Error("expected ProviderBoundGraphEvidenceError");
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true })
    )
  );
});

describe("provider-bound graph evidence", () => {
  it("binds one real local Provider capture to truthful abstained Graph evidence", async () => {
    const source = await capture();
    expect(source.status).toBe("available");
    const first = await compileProviderBoundGraphEvidence(source);
    const second = await compileProviderBoundGraphEvidence(source);

    expect(first.stage).toBe("graph-evidence");
    expect(first.status).toBe("abstained");
    expect(first.receipt.receiptId).toBe(
      "muse-attunegraph-provider-bound-graph-evidence:sha256:"
      + "082bcb49622a36aaa4d11ed8f4b55f665c8baa264d45827eb86b9233ae63dead"
    );
    expect(second.receipt.receiptId).toBe(first.receipt.receiptId);
    if (first.stage !== "graph-evidence" || source.status !== "available") {
      throw new Error("graph-stage evidence was required");
    }
    expect({
      activationEvidenceId: first.graphEvidence.activationEvidence.evidenceId,
      graphEvidenceReceiptId: first.graphEvidence.receipt.receiptId,
      legacyFrontierReceiptId:
        first.graphEvidence.legacyCompilation.frontier?.receipt.receiptId,
      legacyOrderId:
        first.graphEvidence.legacyCompilation.frontier?.order.orderId,
      legacySettlementResultId:
        first.graphEvidence.legacyCompilation.settlement?.resultId,
      legacyWitnessReceiptId:
        first.graphEvidence.legacyCompilation.receipt.receiptId
    }).toEqual({
      activationEvidenceId:
        "muse-attunegraph-receipt-bound-activation-evidence:sha256:"
        + "de90233a1a8f07b44658bb235503f97b5c406224f5f0dfe9fd570e27fc1e873b",
      graphEvidenceReceiptId:
        "muse-attunegraph-receipt-bound-graph-evidence-receipt:sha256:"
        + "9a0eae5b862201367a7af0936f43fa5c423132abad88b6e7fcb0758cb372a4b5",
      legacyFrontierReceiptId:
        "muse-attunegraph-fair-witness-frontier-receipt:sha256:"
        + "fb2363a53bd11ee0146e845396a9088a9cc90bf44b21c4d0f27d3eaa4b94fa56",
      legacyOrderId:
        "muse-attunegraph-fair-frontier-order:sha256:"
        + "fa3f256981b9283ae51b5facc9520bb2e12db3d2aba86215bf878ece282f4cc6",
      legacySettlementResultId:
        "attunegraph-candidate-ledger:sha256:"
        + "b1abcce77a3dd08b074930b0c71c327109b294253c3ba407b378c92618bb1614",
      legacyWitnessReceiptId:
        "muse-attunegraph-thread-rooted-witness-receipt:sha256:"
        + "806e888a66874f84c818037bed13af795e0a2f9c918e1f40e85cb448cbb61f12"
    });
    expect(first.providerReceipt.receiptId).toBe(source.receipt.receiptId);
    expect(first.graphObservationReceipt.observedAt).toBe(AT);
    expect(first.graphEvidence.receipt.status).toBe("abstained");
    expect(first.graphEvidence.legacyCompilation.status).toBe("abstained");
    expect(first.receipt).toMatchObject({
      stage: "graph-evidence",
      providerReceiptId: source.receipt.receiptId,
      providerStateDigest: source.receipt.stateDigest,
      providerNormalizedStateBytes: source.receipt.normalizedStateBytes,
      graphObservationReceiptId:
        first.graphObservationReceipt.receiptId,
      graphEvidenceReceiptId: first.graphEvidence.receipt.receiptId,
      graphActivationEvidenceId:
        first.graphEvidence.activationEvidence.evidenceId,
      graphObservedAtSemantics:
        "provider-capture-completed-by-bound",
      declaredFreshness: {
        status: "unassessed",
        reasonId: "single-read-no-head-revalidation"
      },
      snapshot: {
        authority: "receipt-integrity-only",
        kind: "process-local-provider-capture",
        stateDigest: source.receipt.stateDigest,
        mintVerificationSurvivesSerialization: false
      }
    });
    expect(first.receipt.coverage.reasons).toEqual([
      "single-local-store",
      "point-in-time-read",
      "freshness-unassessed",
      "source-authority-unverified",
      "graph-settlement-abstained"
    ]);
    expect(first.graphEvidence.receipt.actualSeed.id).not.toContain(THREAD_ID);
    expect(
      "commitHash" in (
        first.receipt.stage === "graph-evidence"
          ? first.receipt.snapshot
          : {}
      )
    ).toBe(false);
    expect(JSON.stringify(first)).not.toContain(CANARY);
    expect(
      verifyProviderGraphBindingReceipt(
        JSON.parse(JSON.stringify(first.receipt))
      ).receiptId
    ).toBe(first.receipt.receiptId);
    assertDeepFrozen(first);
  });

  it("returns Provider-stage abstention without constructing Graph evidence", async () => {
    const source = await capture("missing_thread");
    expect(source.status).toBe("abstained");
    const result = await compileProviderBoundGraphEvidence(source);
    expect(result).toMatchObject({
      status: "abstained",
      stage: "provider",
      receipt: {
        stage: "provider",
        coverage: { reasons: ["provider-unavailable"] },
        providerAbstentionReason: "requested-scope-unavailable",
        providerCoverageReasons: ["no-available-provider-snapshot"]
      }
    });
    expect("graphEvidence" in result).toBe(false);
    assertDeepFrozen(result);
  });

  it("rejects reconstructed and accessor captures before state access", async () => {
    const source = await capture();
    expect(source.status).toBe("available");
    if (source.status !== "available") {
      throw new Error("available source was required");
    }
    await expect(
      compileProviderBoundGraphEvidence(
        JSON.parse(JSON.stringify(source))
      )
    ).rejects.toMatchObject({
      code: "INVALID_CAPTURE",
      details: { reason: "capture-not-minted", path: "/capture" }
    });

    let getterCalls = 0;
    const accessor = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(accessor, "status", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "available";
      }
    });
    await expect(
      compileProviderBoundGraphEvidence(accessor)
    ).rejects.toBeInstanceOf(ProviderBoundGraphEvidenceError);
    expect(getterCalls).toBe(0);
  });

  it("uses a frozen bounded stable error and keeps the private root surface closed", () => {
    expectBindingError(
      () => {
        throw new ProviderBoundGraphEvidenceError(
          "INVALID_CAPTURE",
          "capture-not-minted",
          "/capture"
        );
      },
      "INVALID_CAPTURE",
      "capture-not-minted",
      "/capture"
    );
    expect(
      "compileProviderBoundGraphEvidence" in graphRoot
    ).toBe(false);
    expect(
      "verifyProviderGraphBindingReceipt" in graphRoot
    ).toBe(false);
  });

  it("rejects tampered or structurally expanded binding receipts", async () => {
    const source = await capture();
    const result = await compileProviderBoundGraphEvidence(source);
    const wrongId = {
      ...JSON.parse(JSON.stringify(result.receipt)),
      receiptId:
        `muse-attunegraph-provider-bound-graph-evidence:sha256:${"0".repeat(64)}`
    };
    expect(() => verifyProviderGraphBindingReceipt(wrongId))
      .toThrow(ProviderGraphBindingReceiptError);
    try {
      verifyProviderGraphBindingReceipt(wrongId);
    } catch (cause) {
      const error = cause as ProviderGraphBindingReceiptError;
      expect(error.code).toBe("INTEGRITY_MISMATCH");
      expect(error.details).toEqual({
        reason: "receipt-id-mismatch",
        path: "/receiptId"
      });
    }
    const extra = {
      ...JSON.parse(JSON.stringify(result.receipt)),
      surprise: true
    };
    expect(() => verifyProviderGraphBindingReceipt(extra))
      .toThrow(ProviderGraphBindingReceiptError);

    const missingId = JSON.parse(
      JSON.stringify(result.receipt)
    ) as Record<string, unknown>;
    delete missingId.receiptId;
    try {
      verifyProviderGraphBindingReceipt(missingId);
    } catch (cause) {
      const error = cause as ProviderGraphBindingReceiptError;
      expect(error.code).toBe("INVALID_RECEIPT");
      expect(error.details).toEqual({
        reason: "invalid-field-set",
        path: "/receiptId"
      });
    }

    if (result.receipt.stage !== "graph-evidence") {
      throw new Error("graph receipt required");
    }
    const wrongCoverage = JSON.parse(
      JSON.stringify(result.receipt)
    ) as Record<string, unknown>;
    const coverage = wrongCoverage.coverage as {
      reasons: string[];
    };
    coverage.reasons.reverse();
    expect(() =>
      verifyProviderGraphBindingReceipt(resealReceipt(wrongCoverage))
    ).toThrow(ProviderGraphBindingReceiptError);

    const wrongCounts = JSON.parse(
      JSON.stringify(result.receipt)
    ) as Record<string, unknown>;
    const nominations = wrongCounts.nominations as {
      omitted: number;
      omittedAssertionIdsDigest: string | null;
    };
    nominations.omitted = 1;
    nominations.omittedAssertionIdsDigest = null;
    try {
      verifyProviderGraphBindingReceipt(resealReceipt(wrongCounts));
    } catch (cause) {
      const error = cause as ProviderGraphBindingReceiptError;
      expect(error.details.reason).toBe("invalid-count-accounting");
      expect(error.details.path).toBe(
        "/nominations/omittedAssertionIdsDigest"
      );
    }
  });

  it("is deterministic across formatting and changes IDs when source facts or time change", async () => {
    const compact = await capture(THREAD_ID, "Stable title", AT, false);
    const formatted = await capture(THREAD_ID, "Stable title", AT, true);
    const changed = await capture(THREAD_ID, "Changed title", AT, false);
    const later = await capture(
      THREAD_ID,
      "Stable title",
      "2026-07-30T00:01:00.000Z",
      false
    );
    const compactResult = await compileProviderBoundGraphEvidence(compact);
    const formattedResult = await compileProviderBoundGraphEvidence(formatted);
    const changedResult = await compileProviderBoundGraphEvidence(changed);
    const laterResult = await compileProviderBoundGraphEvidence(later);
    expect(formattedResult.receipt.receiptId)
      .toBe(compactResult.receipt.receiptId);
    expect(changedResult.receipt.receiptId)
      .not.toBe(compactResult.receipt.receiptId);
    expect(laterResult.receipt.receiptId)
      .not.toBe(compactResult.receipt.receiptId);
  });

  it("accounts for nomination overflow without silently widening the budget", async () => {
    const source = await capture(
      THREAD_ID,
      "Many exact links",
      AT,
      false,
      0,
      45
    );
    const result = await compileProviderBoundGraphEvidence(source);
    expect(result.stage).toBe("graph-evidence");
    if (
      result.stage !== "graph-evidence"
      || result.receipt.stage !== "graph-evidence"
    ) {
      throw new Error("graph-stage result required");
    }
    expect(result.receipt.nominations).toEqual({
      core: 1,
      change: 85,
      support: 170,
      omitted: 15,
      omittedAssertionIdsDigest:
        "muse-attunegraph-provider-bound-omitted-assertion-ids:sha256:"
        + "9b549e7b5d315b738cdcb3f44af4cc25c57371e9617cf3b7f3a1061f4947bf1e"
    });
    expect(result.receipt.coverage.reasons).toContain(
      "nomination-capacity-bounded"
    );
  });

  it("maps a Graph compiler failure to the stable private boundary", async () => {
    vi.resetModules();
    vi.doMock("./receipt-bound-graph-evidence.js", () => ({
      compileReceiptBoundGraphEvidence: async () => {
        throw new Error(`private-${CANARY}`);
      }
    }));
    try {
      const source = await isolatedCapture();
      const isolated = await import(
        "./provider-bound-graph-evidence.js"
      );
      await expect(
        isolated.compileProviderBoundGraphEvidence(source)
      ).rejects.toMatchObject({
        code: "GRAPH_EVIDENCE_FAILED",
        details: {
          reason: "graph-evidence-failed",
          path: "/graphEvidence"
        }
      });
      try {
        await isolated.compileProviderBoundGraphEvidence(source);
      } catch (cause) {
        expect(JSON.stringify(cause)).not.toContain(CANARY);
      }
    } finally {
      vi.doUnmock("./receipt-bound-graph-evidence.js");
      vi.resetModules();
    }
  });

  it("fails closed when the observed projection has no unique thread core", async () => {
    vi.resetModules();
    vi.doMock("./continuity-observation.js", async (importOriginal) => {
      const actual = await importOriginal<
        typeof import("./continuity-observation.js")
      >();
      return {
        ...actual,
        captureContinuityObservation: (input: {
          scope: Record<string, unknown>;
          sourceObservedAt: string;
        }) => Object.freeze({
          authority: "caller-declared-observation",
          formatVersion: "muse.continuity-observation.v1",
          observedAt: input.sourceObservedAt,
          projection: Object.freeze({
            assertions: Object.freeze([]),
            projectionVersion: "muse.continuity-projection.v1",
            scope: Object.freeze({ ...input.scope })
          }),
          receiptId:
            `muse-continuity-observation:v1:sha256:${"a".repeat(64)}`
        }),
        verifyContinuityObservation: (input: unknown) => input
      };
    });
    try {
      const source = await isolatedCapture();
      const isolated = await import(
        "./provider-bound-graph-evidence.js"
      );
      await expect(
        isolated.compileProviderBoundGraphEvidence(source)
      ).rejects.toMatchObject({
        code: "INTERNAL_POSTCONDITION_FAILED",
        details: {
          reason: "core-nomination-unavailable",
          path: "/graphObservationReceipt/projection/assertions"
        }
      });
    } finally {
      vi.doUnmock("./continuity-observation.js");
      vi.resetModules();
    }
  });

  it("fails closed when Observation boundary fields drift", async () => {
    vi.resetModules();
    vi.doMock("./continuity-observation.js", async (importOriginal) => {
      const actual = await importOriginal<
        typeof import("./continuity-observation.js")
      >();
      return {
        ...actual,
        captureContinuityObservation: (input: {
          scope: Record<string, unknown>;
        }) => Object.freeze({
          authority: "caller-declared-observation",
          formatVersion: "muse.continuity-observation.v1",
          observedAt: "2026-07-30T00:00:01.000Z",
          projection: Object.freeze({
            assertions: Object.freeze([]),
            projectionVersion: "muse.continuity-projection.v1",
            scope: Object.freeze({ ...input.scope })
          }),
          receiptId:
            `muse-continuity-observation:v1:sha256:${"b".repeat(64)}`
        }),
        verifyContinuityObservation: (input: unknown) => input
      };
    });
    try {
      const source = await isolatedCapture();
      const isolated = await import(
        "./provider-bound-graph-evidence.js"
      );
      await expect(
        isolated.compileProviderBoundGraphEvidence(source)
      ).rejects.toMatchObject({
        code: "INTERNAL_POSTCONDITION_FAILED",
        details: {
          reason: "graph-observation-boundary-mismatch",
          path: "/graphObservationReceipt"
        }
      });
    } finally {
      vi.doUnmock("./continuity-observation.js");
      vi.resetModules();
    }
  });
});
