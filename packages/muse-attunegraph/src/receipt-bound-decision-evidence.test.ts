import { describe, expect, it } from "vitest";

import {
  compileReceiptBoundDecisionEvidence,
  decisionEvidenceCoversAssertionIds
} from "./receipt-bound-decision-evidence.js";

const OBSERVED_AT = "2026-08-01T00:00:00.000Z";
const SCOPE = Object.freeze({ sourceId: "source", threadId: "thread" });
const SEED = Object.freeze({ id: "thread-root", kind: "thread" as const });
const ASSERTION = Object.freeze({
  schemaVersion: 1 as const,
  id: "core",
  subject: { id: "artifact", kind: "artifact" as const },
  predicate: "CONTEXT_FOR" as const,
  object: SEED,
  epistemicClass: "source-observed" as const,
  sourceRefs: [{ namespace: "test", id: "source" }],
  recordedAt: OBSERVED_AT,
  derivation: { kind: "projection" as const, version: "test@1" }
});

function request(maxEstimatedTokens: number) {
  return {
    scope: SCOPE,
    actualSeed: SEED,
    observedAt: OBSERVED_AT,
    sourceObservationReceiptId: "observation",
    graphEvidenceReceiptId: "graph",
    coreAssertionId: ASSERTION.id,
    maxEstimatedTokens,
    assertions: [ASSERTION]
  };
}

describe("receipt-bound Decision Query evidence", () => {
  it("binds the exact fresh query receipt and replays deterministically", async () => {
    const first = await compileReceiptBoundDecisionEvidence(request(128));
    const second = await compileReceiptBoundDecisionEvidence(request(128));

    expect(first.receipt).toMatchObject({
      status: "bound",
      use: "evidence-only",
      graphEvidenceReceiptId: "graph",
      sourceObservationReceiptId: "observation",
      decisionQueryReceiptId: first.decisionQuery.receipt.receiptId,
      coverage: {
        coreAssertionWitnessed: true,
        canAssertAbsenceWithinSnapshot: false,
        canAssertCurrentWorldAbsence: false,
        canGrantActionAuthority: false,
        authorityEvaluation: "not-performed",
        conflictClosure: "not-performed"
      }
    });
    expect(first.decisionQuery.receipt.query.head).toEqual({
      mode: "exact",
      generation: first.decisionQuery.snapshot?.generation,
      commitId: first.decisionQuery.snapshot?.commitId
    });
    expect(first.decisionQuery.receipt.witness.assertionIds).toEqual(["core"]);
    expect(decisionEvidenceCoversAssertionIds(first, ["core"])).toBe(true);
    expect(decisionEvidenceCoversAssertionIds(first, ["core", "missing"]))
      .toBe(false);
    expect(second).toStrictEqual(first);
  });

  it("records an honest abstention when the fixed token budget cannot witness core", async () => {
    const result = await compileReceiptBoundDecisionEvidence(request(64));

    expect(result.receipt).toMatchObject({
      status: "abstained",
      decisionQueryStatus: "partial",
      coverage: { coreAssertionWitnessed: false }
    });
    expect(result.decisionQuery.receipt.witness.assertionIds).toEqual([]);
    expect(result.decisionQuery.receipt.diagnostics.truncationReasons)
      .toEqual(["token-budget"]);
    expect(decisionEvidenceCoversAssertionIds(result, [])).toBe(false);
    expect(decisionEvidenceCoversAssertionIds(result, ["core"])).toBe(false);
  });
});
