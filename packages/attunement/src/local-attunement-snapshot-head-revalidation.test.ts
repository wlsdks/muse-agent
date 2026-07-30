import { describe, expect, it } from "vitest";

import { baselinePolicy } from "./policy-reducer.js";
import {
  verifyMintedLocalAttunementSnapshotCaptureShellForTesting,
  createLocalAttunementSnapshotProviderForTesting,
  verifyMintedLocalAttunementSnapshotCapture
} from "./local-attunement-snapshot-provider.js";
import {
  LocalAttunementSnapshotHeadRevalidationError,
  bindProviderOwnedHeadRevalidation,
  providerHeadEndpointStatesEqualForTesting,
  verifyMintedLocalAttunementSnapshotHeadRevalidation
} from "./local-attunement-snapshot-head-revalidation.js";

import type { AttunementState } from "./types.js";

const SUBJECT_AT = "2026-07-30T00:00:00.000Z";
const HEAD_AT = "2026-07-30T00:00:00.025Z";
const SCOPE = Object.freeze({ sourceId: "default", threadId: "thread_trip" });

function state(title = "Trip planning"): AttunementState {
  return {
    deliveries: [],
    experienceLearningPolicyAudits: [],
    interactionReceipts: [],
    nextPolicyVersion: 1,
    resetReceipts: [],
    schemaVersion: 12,
    threads: [{
      createdAt: "2026-07-20T09:00:00.000Z",
      id: SCOPE.threadId,
      kind: "life",
      links: [],
      policy: baselinePolicy(),
      title
    }],
    undoResetReceipts: []
  };
}

function provider(input: {
  readonly reads: readonly (
    | Readonly<{ readonly status: "available"; readonly state: AttunementState }>
    | Readonly<{ readonly status: "missing" }>
  )[];
  readonly times?: readonly string[];
}) {
  let readIndex = 0;
  let clockIndex = 0;
  return {
    provider: createLocalAttunementSnapshotProviderForTesting(
      {
        attunementFile: "/configured/attunement.json",
        sourceId: SCOPE.sourceId
      },
      {
        readState: async () =>
          input.reads[readIndex++]
          ?? Object.freeze({ status: "missing" as const }),
        clock: () =>
          new Date((input.times ?? [SUBJECT_AT, HEAD_AT])[clockIndex++]!)
      }
    ),
    reads: () => readIndex
  };
}

function expectBoundedError(
  operation: () => unknown,
  reason: LocalAttunementSnapshotHeadRevalidationError["details"]["reason"],
  path: string
): void {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(LocalAttunementSnapshotHeadRevalidationError);
    const actual = error as LocalAttunementSnapshotHeadRevalidationError;
    expect(actual.message).toBe(
      "local-attunement-snapshot-head-revalidation-failed"
    );
    expect(actual.details).toEqual({ path, reason });
    expect(actual.stack).toBeUndefined();
    expect(JSON.stringify(actual)).not.toContain("/configured");
    return;
  }
  throw new Error("expected bounded revalidation error");
}

describe("provider-owned local snapshot head revalidation", () => {
  it("classifies equal, changed, and span-exceeded endpoint states", async () => {
    const equal = provider({
      reads: [
        { state: state(), status: "available" },
        { state: state(), status: "available" }
      ]
    });
    const fresh = await equal.provider.captureHeadRevalidation(
      SCOPE,
      { maxCaptureSpanMs: 25 }
    );
    expect(fresh.status).toBe("fresh");
    expect(fresh.receipt).toMatchObject({
      canAssertFreshAtAssessment: true,
      captureSpanMs: 25,
      maxCaptureSpanMs: 25,
      mintVerification:
        "provider-owned-two-capture-pair-verified-in-composing-process",
      mintVerificationSurvivesSerialization: false,
      providerScope: SCOPE,
      reason: "head-state-matched-within-bound",
      status: "fresh"
    });
    expect(verifyMintedLocalAttunementSnapshotHeadRevalidation(fresh)).toBe(
      fresh
    );

    const changed = provider({
      reads: [
        { state: state(), status: "available" },
        { state: state("Changed title"), status: "available" }
      ]
    });
    const staleChanged = await changed.provider.captureHeadRevalidation(
      SCOPE,
      { maxCaptureSpanMs: 25 }
    );
    expect(staleChanged.receipt).toMatchObject({
      canAssertFreshAtAssessment: false,
      reason: "head-state-changed",
      status: "stale"
    });

    const exceeded = provider({
      reads: [
        { state: state(), status: "available" },
        { state: state(), status: "available" }
      ],
      times: [SUBJECT_AT, "2026-07-30T00:00:00.026Z"]
    });
    const staleSpan = await exceeded.provider.captureHeadRevalidation(
      SCOPE,
      { maxCaptureSpanMs: 25 }
    );
    expect(staleSpan.receipt).toMatchObject({
      canAssertFreshAtAssessment: false,
      captureSpanMs: 26,
      reason: "capture-span-exceeded",
      status: "stale"
    });
  });

  it("stops after an unavailable subject and preserves head abstention", async () => {
    const subjectUnavailable = provider({
      reads: [{ status: "missing" }, { state: state(), status: "available" }]
    });
    const subject = await subjectUnavailable.provider.captureHeadRevalidation(
      SCOPE,
      { maxCaptureSpanMs: 25 }
    );
    expect(subject.status).toBe("abstained");
    expect(subject.receipt).toMatchObject({
      canAssertFreshAtAssessment: false,
      mintVerification:
        "provider-owned-revalidation-artifact-verified-in-composing-process",
      reason: "requested-scope-unavailable",
      stage: "provider",
      status: "abstained"
    });
    expect(subjectUnavailable.reads()).toBe(1);

    const headUnavailable = provider({
      reads: [{ state: state(), status: "available" }, { status: "missing" }]
    });
    const head = await headUnavailable.provider.captureHeadRevalidation(
      SCOPE,
      { maxCaptureSpanMs: 25 }
    );
    expect(head.receipt).toMatchObject({
      canAssertFreshAtAssessment: false,
      mintVerification:
        "provider-owned-two-capture-pair-verified-in-composing-process",
      reason: "requested-scope-unavailable",
      stage: "revalidation",
      status: "abstained"
    });
    expect(headUnavailable.reads()).toBe(2);
  });

  it("validates and freezes the bound before either source read", async () => {
    for (const value of [0, -1, 1.5, 30_001, Number.MAX_SAFE_INTEGER]) {
      const fixture = provider({
        reads: [
          { state: state(), status: "available" },
          { state: state(), status: "available" }
        ]
      });
      await expect(fixture.provider.captureHeadRevalidation(
        SCOPE,
        { maxCaptureSpanMs: value }
      )).rejects.toSatisfy((error: unknown) => {
        expectBoundedError(
          () => {
            throw error;
          },
          "invalid-max-capture-span-ms",
          "/options/maxCaptureSpanMs"
        );
        return true;
      });
      expect(fixture.reads()).toBe(0);
    }

    let getterCalls = 0;
    const accessor = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(accessor, "maxCaptureSpanMs", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return 25;
      }
    });
    const fixture = provider({
      reads: [
        { state: state(), status: "available" },
        { state: state(), status: "available" }
      ]
    });
    await expect(fixture.provider.captureHeadRevalidation(
      SCOPE,
      accessor
    )).rejects.toBeInstanceOf(
      LocalAttunementSnapshotHeadRevalidationError
    );
    expect(getterCalls).toBe(0);
    expect(fixture.reads()).toBe(0);
  });

  it("rejects serialized reconstruction and keeps hidden state out of receipts", async () => {
    const canary = "PRIVATE_RUNTIME_CANARY";
    const fixture = provider({
      reads: [
        { state: state(canary), status: "available" },
        { state: state(canary), status: "available" }
      ]
    });
    const artifact = await fixture.provider.captureHeadRevalidation(
      SCOPE,
      { maxCaptureSpanMs: 25 }
    );
    expect(JSON.stringify(artifact)).not.toContain(canary);
    expect(JSON.stringify(artifact.receipt)).not.toContain(canary);
    expect(JSON.stringify(artifact.receipt)).not.toContain("/configured");
    expectBoundedError(
      () => verifyMintedLocalAttunementSnapshotHeadRevalidation(
        JSON.parse(JSON.stringify(artifact))
      ),
      "not-minted",
      "/"
    );
  });

  it("allows distinct same-instant captures and is byte-deterministic", async () => {
    const create = () => provider({
      reads: [
        { state: state(), status: "available" },
        { state: state(), status: "available" }
      ],
      times: [SUBJECT_AT, SUBJECT_AT]
    });
    const first = await create().provider.captureHeadRevalidation(
      SCOPE,
      { maxCaptureSpanMs: 25 }
    );
    const second = await create().provider.captureHeadRevalidation(
      SCOPE,
      { maxCaptureSpanMs: 25 }
    );
    expect(first.status).toBe("fresh");
    expect(first.receipt).toEqual(second.receipt);
    expect(JSON.stringify(first.receipt)).toBe(
      JSON.stringify(second.receipt)
    );
    expect(first.subjectCapture).not.toBe(first.headCapture);
  });

  it("rejects same-object reuse even at the same canonical instant", async () => {
    const source = provider({
      reads: [{ state: state(), status: "available" }],
      times: [SUBJECT_AT]
    });
    const capture = await source.provider.capture(SCOPE);
    const hostileReuse = bindProviderOwnedHeadRevalidation(
      async () => capture,
      (input) =>
        verifyMintedLocalAttunementSnapshotCaptureShellForTesting(
          source.provider,
          input
        ),
      verifyMintedLocalAttunementSnapshotCapture
    );
    await expect(hostileReuse(
      SCOPE,
      { maxCaptureSpanMs: 25 }
    )).rejects.toSatisfy((error: unknown) => {
      expectBoundedError(
        () => {
          throw error;
        },
        "same-capture-reused",
        "/headCapture"
      );
      return true;
    });
  });

  it("rejects alternating captures from separately created providers before state access", async () => {
    const subjectOwner = provider({
      reads: [{ state: state(), status: "available" }],
      times: [SUBJECT_AT]
    });
    const headOwner = provider({
      reads: [{ state: state(), status: "available" }],
      times: [HEAD_AT]
    });
    let captures = 0;
    let integrityChecks = 0;
    const alternating = bindProviderOwnedHeadRevalidation(
      async (scope) =>
        captures++ === 0
          ? subjectOwner.provider.capture(scope)
          : headOwner.provider.capture(scope),
      (input) =>
        verifyMintedLocalAttunementSnapshotCaptureShellForTesting(
          subjectOwner.provider,
          input
        ),
      (input) => {
        integrityChecks += 1;
        return verifyMintedLocalAttunementSnapshotCapture(input);
      }
    );
    await expect(alternating(
      SCOPE,
      { maxCaptureSpanMs: 25 }
    )).rejects.toSatisfy((error: unknown) => {
      expectBoundedError(
        () => {
          throw error;
        },
        "capture-not-minted",
        "/headCapture"
      );
      return true;
    });
    expect(integrityChecks).toBe(0);
  });

  it("checks both owner shells before either hidden state at mint and verify time", async () => {
    const source = provider({
      reads: [
        { state: state(), status: "available" },
        { state: state(), status: "available" }
      ]
    });
    const order: string[] = [];
    const capture = bindProviderOwnedHeadRevalidation(
      source.provider.capture,
      (input) => {
        order.push("shell");
        return verifyMintedLocalAttunementSnapshotCaptureShellForTesting(
          source.provider,
          input
        );
      },
      (input) => {
        order.push("hidden-state-integrity");
        return verifyMintedLocalAttunementSnapshotCapture(input);
      }
    );
    const artifact = await capture(
      SCOPE,
      { maxCaptureSpanMs: 25 }
    );
    expect(order).toEqual([
      "shell",
      "shell",
      "hidden-state-integrity",
      "hidden-state-integrity"
    ]);

    order.length = 0;
    expect(verifyMintedLocalAttunementSnapshotHeadRevalidation(artifact))
      .toBe(artifact);
    expect(order).toEqual([
      "shell",
      "shell",
      "hidden-state-integrity",
      "hidden-state-integrity"
    ]);
  });

  it("rejects digest-only collision equality when exact JSON differs", () => {
    const digest = `sha256:${"a".repeat(64)}`;
    expect(providerHeadEndpointStatesEqualForTesting({
      subjectBytes: 7,
      headBytes: 7,
      subjectDigest: digest,
      headDigest: digest,
      subjectStateJson: "{\"a\":1}",
      headStateJson: "{\"b\":1}"
    })).toBe(false);
  });
});
