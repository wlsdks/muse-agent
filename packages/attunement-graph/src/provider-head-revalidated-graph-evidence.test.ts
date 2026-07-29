import {
  createLocalAttunementSnapshotProviderForTesting
} from "../../attunement/src/local-attunement-snapshot-provider.js";
import { parseAttunementState } from "@muse/attunement/state-validation";
import { describe, expect, it, vi } from "vitest";

import { canonicalizeImmutableEnvelope } from "./canonical-immutable-envelope.js";
import {
  ProviderHeadRevalidatedGraphEvidenceError,
  compileHeadRevalidatedProviderBoundGraphEvidence,
  verifyProviderHeadRevalidatedGraphBindingReceipt
} from "./provider-head-revalidated-graph-evidence.js";

vi.mock("@muse/attunement/continuity-snapshots", async () =>
  import("../../attunement/src/continuity-snapshots.js")
);

const SOURCE_ID = "provider-head-graph-test";
const THREAD_ID = "thread_provider_head_graph";
const SUBJECT_AT = "2026-07-30T00:00:00.000Z";
const RECEIPT_SPEC = Object.freeze({
  hashDomain:
    "muse.attunement-graph.provider-head-revalidated-graph-evidence-receipt.v1",
  idField: "receiptId",
  idPrefix: "muse-provider-head-revalidated-graph-evidence:sha256:"
} as const);

function state(title = "Private head graph canary") {
  return parseAttunementState({
    deliveries: [],
    interactionReceipts: [],
    nextPolicyVersion: 1,
    resetReceipts: [],
    schemaVersion: 11,
    threads: [{
      createdAt: "2026-07-29T23:00:00.000Z",
      id: THREAD_ID,
      kind: "work",
      links: [],
      policy: {
        detail: "compact",
        nextStep: "direct",
        suppression: "none",
        version: 0
      },
      title
    }],
    undoResetReceipts: []
  });
}

async function fixture(options: {
  readonly changed?: boolean;
  readonly spanMs?: number;
  readonly subjectUnavailable?: boolean;
}) {
  let clocks = 0;
  let reads = 0;
  const provider = createLocalAttunementSnapshotProviderForTesting(
    {
      attunementFile: "/configured/attunement.json",
      sourceId: SOURCE_ID
    },
    {
      readState: async () => options.subjectUnavailable
        ? { status: "missing" as const }
        : ({
            state: state(options.changed && reads++ > 0
              ? "Changed title"
              : "Private head graph canary"),
            status: "available" as const
          }),
      clock: () => {
        const at = clocks++ === 0
          ? SUBJECT_AT
          : new Date(
            Date.parse(SUBJECT_AT) + (options.spanMs ?? 25)
          ).toISOString();
        return new Date(at);
      }
    }
  );
  return {
    provider,
    scope: { sourceId: SOURCE_ID, threadId: THREAD_ID }
  };
}

describe("provider head-revalidated Graph evidence", () => {
  it("settles equal endpoints as partial with exact narrow semantics", async () => {
    const source = await fixture({});
    const artifact = await source.provider.captureHeadRevalidation(
      source.scope,
      { maxCaptureSpanMs: 25 }
    );
    const result =
      await compileHeadRevalidatedProviderBoundGraphEvidence(artifact);
    expect(result.status).toBe("partial");
    expect(result.stage).toBe("graph-evidence");
    if (result.status !== "partial") throw new Error("partial required");
    expect(result.graphEvidence.receipt.status).toBe("partial");
    expect(result.graphEvidence.receipt.coverage.reasons.slice(0, 6)).toEqual([
      "provider-head-revalidated-observation-integrity-only",
      "fresh-at-assessment-only",
      "source-authority-unverified",
      "bounded-activation-only",
      "legacy-payload-budget-only",
      "non-authoritative-compatibility-scope"
    ]);
    expect(result.graphEvidence.legacyCompilation.receipt.coverage.reasons)
      .toEqual([
        "provider-head-revalidation-snapshot-integrity-only",
        "fresh-at-assessment-only",
        "bounded-result-only"
      ]);
    const legacy = result.graphEvidence.legacyCompilation;
    expect(legacy.frontier?.order.coverage.reasons).toEqual([
      "candidate-pool-only",
      "lane-semantics-caller-declared",
      "not-budget-settled"
    ]);
    expect(legacy.frontier?.receipt.coverage.reasons).toEqual([
      "bounded-witness-pool-only",
      "provider-head-revalidation-snapshot-integrity-only",
      "fresh-at-assessment-only",
      "source-authority-not-independently-verified",
      "focus-predicate-lane-mapping-v1"
    ]);
    expect(legacy.settlement?.status).toBe("partial");
    if (legacy.settlement?.status !== "partial") {
      throw new Error("fresh settlement must be partial");
    }
    expect(legacy.settlement.completeness).toMatchObject({
      canAssertAbsenceWithinSnapshot: false,
      canAssertCurrentWorldAbsence: false
    });
    expect(legacy.settlement.documents[0]?.authority.freshness).toBe(
      "provider-head-revalidation-receipt-integrity-only"
    );
    expect(result.receipt.providerFreshness).toEqual({
      status: "fresh-at-assessment",
      reason: "head-state-matched-within-bound"
    });
    expect(result.receipt.coverage.reasons).toEqual([
      "single-local-store",
      "two-endpoint-provider-revalidation",
      "fresh-at-assessment-only",
      "source-authority-unverified",
      "graph-settlement-partial"
    ]);
    expect(result.receipt).toMatchObject({
      canAssertFreshAtAssessment: true,
      canAssertAbsenceWithinSnapshot: false,
      canAssertCurrentWorldAbsence: false,
      canAssertDurableProviderAuthority: false
    });
    expect(verifyProviderHeadRevalidatedGraphBindingReceipt(
      JSON.parse(JSON.stringify(result.receipt))
    )).toEqual(result.receipt);
  });

  it("does not compile changed or span-exceeded endpoints into Graph fields", async () => {
    const changedSource = await fixture({ changed: true });
    const changedArtifact =
      await changedSource.provider.captureHeadRevalidation(
        changedSource.scope,
        { maxCaptureSpanMs: 25 }
      );
    const changed =
      await compileHeadRevalidatedProviderBoundGraphEvidence(changedArtifact);
    expect(changed.status).toBe("stale");
    expect(changed.receipt.providerFreshness).toEqual({
      status: "not-fresh",
      reason: "head-state-changed"
    });
    expect(changed).not.toHaveProperty("graphEvidence");
    expect(changed.receipt).not.toHaveProperty("snapshot");
    expect(changed.receipt).not.toHaveProperty("declaredFreshness");
    expect(verifyProviderHeadRevalidatedGraphBindingReceipt(
      JSON.parse(JSON.stringify(changed.receipt))
    )).toEqual(changed.receipt);

    const spanSource = await fixture({ spanMs: 26 });
    const spanArtifact = await spanSource.provider.captureHeadRevalidation(
      spanSource.scope,
      { maxCaptureSpanMs: 25 }
    );
    const span =
      await compileHeadRevalidatedProviderBoundGraphEvidence(spanArtifact);
    expect(span.status).toBe("stale");
    expect(span.receipt.providerFreshness.reason).toBe(
      "capture-span-exceeded"
    );
    expect(span).not.toHaveProperty("graphEvidence");
    expect(verifyProviderHeadRevalidatedGraphBindingReceipt(
      JSON.parse(JSON.stringify(span.receipt))
    )).toEqual(span.receipt);
  });

  it("rejects serialized revalidation reconstruction", async () => {
    const source = await fixture({});
    const artifact = await source.provider.captureHeadRevalidation(
      source.scope,
      { maxCaptureSpanMs: 25 }
    );
    await expect(
      compileHeadRevalidatedProviderBoundGraphEvidence(
        JSON.parse(JSON.stringify(artifact))
      )
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(
        ProviderHeadRevalidatedGraphEvidenceError
      );
      expect((error as ProviderHeadRevalidatedGraphEvidenceError).code)
        .toBe("INVALID_REVALIDATION");
      return true;
    });
  });

  it("keeps one-read provider abstention mint wording truthful", async () => {
    const source = await fixture({ subjectUnavailable: true });
    const artifact = await source.provider.captureHeadRevalidation(
      source.scope,
      { maxCaptureSpanMs: 25 }
    );
    const result =
      await compileHeadRevalidatedProviderBoundGraphEvidence(artifact);
    expect(artifact.receipt.mintVerification).toBe(
      "provider-owned-revalidation-artifact-verified-in-composing-process"
    );
    expect(result.status).toBe("abstained");
    expect(result.stage).toBe("provider");
    expect(result.receipt.mintVerification).toBe(
      "provider-owned-revalidation-artifact-verified-in-composing-process"
    );
    expect(verifyProviderHeadRevalidatedGraphBindingReceipt(
      JSON.parse(JSON.stringify(result.receipt))
    ).mintVerification).toBe(
      "provider-owned-revalidation-artifact-verified-in-composing-process"
    );
  });

  it("rejects the hash-valid invented provider authority and reason fixture", async () => {
    const source = await fixture({ changed: true });
    const artifact = await source.provider.captureHeadRevalidation(
      source.scope,
      { maxCaptureSpanMs: 25 }
    );
    const result =
      await compileHeadRevalidatedProviderBoundGraphEvidence(artifact);
    const attacker = JSON.parse(
      JSON.stringify(result.receipt)
    ) as Record<string, unknown>;
    delete attacker.receiptId;
    attacker.providerId = "attacker.provider";
    attacker.providerFreshness = {
      status: "not-fresh",
      reason: "invented-reason"
    };
    attacker.coverage = {
      status: "stale",
      reasons: ["invented-authority"]
    };
    const hashValid = JSON.parse(JSON.stringify(
      canonicalizeImmutableEnvelope(
        attacker,
        "external-mutable",
        RECEIPT_SPEC
      ).envelope
    ));

    expect(() =>
      verifyProviderHeadRevalidatedGraphBindingReceipt(hashValid)
    ).toThrowError(ProviderHeadRevalidatedGraphEvidenceError);
  });

  it("rejects a hash-valid thread seed that was not derived from the provider scope", async () => {
    const source = await fixture({});
    const artifact = await source.provider.captureHeadRevalidation(
      source.scope,
      { maxCaptureSpanMs: 25 }
    );
    const result =
      await compileHeadRevalidatedProviderBoundGraphEvidence(artifact);
    expect(result.status).toBe("partial");

    const attacker = JSON.parse(
      JSON.stringify(result.receipt)
    ) as Record<string, unknown>;
    delete attacker.receiptId;
    const originalSeed = attacker.graphActualSeed as {
      readonly id: string;
      readonly kind: "thread";
    };
    const replacementSuffix = originalSeed.id.endsWith("0") ? "1" : "0";
    attacker.graphActualSeed = {
      id: `${originalSeed.id.slice(0, -1)}${replacementSuffix}`,
      kind: "thread"
    };
    const hashValid = JSON.parse(JSON.stringify(
      canonicalizeImmutableEnvelope(
        attacker,
        "external-mutable",
        RECEIPT_SPEC
      ).envelope
    ));

    expect(() =>
      verifyProviderHeadRevalidatedGraphBindingReceipt(hashValid)
    ).toThrowError(ProviderHeadRevalidatedGraphEvidenceError);
  });
});
