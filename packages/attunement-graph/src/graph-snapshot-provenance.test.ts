import { describe, expect, it } from "vitest";

import {
  GraphSnapshotProvenanceError,
  assertGraphSnapshotFreshnessPair,
  parseGraphDeclaredFreshness,
  parseGraphSnapshotProvenance
} from "./graph-snapshot-provenance.js";

const legacySnapshot = {
  authority: "caller-declared-read-snapshot",
  commitHash: `sha256:${"a".repeat(64)}`,
  commitSequence: 7,
  generationId: "main:7"
};
const providerSnapshot = {
  authority: "receipt-integrity-only",
  kind: "process-local-provider-capture",
  providerReceiptId: `muse-local-attunement-snapshot:sha256:${"b".repeat(64)}`,
  providerId: "muse.local-attunement-store",
  providerVersion: "muse.local-attunement-snapshot-provider.v1",
  stateDigest: `sha256:${"c".repeat(64)}`,
  normalizedStateBytes: 12,
  captureCompletedAt: "2026-07-30T00:00:00.000Z",
  mintVerification: "verified-in-composing-process",
  mintVerificationSurvivesSerialization: false
};

function errorOf(operation: () => unknown): GraphSnapshotProvenanceError {
  try { operation(); } catch (cause) {
    expect(cause).toBeInstanceOf(GraphSnapshotProvenanceError);
    return cause as GraphSnapshotProvenanceError;
  }
  throw new Error("expected GraphSnapshotProvenanceError");
}

describe("graph snapshot provenance", () => {
  it("keeps the legacy caller-declared grammar closed and deeply immutable", () => {
    const snapshot = parseGraphSnapshotProvenance(legacySnapshot, "/snapshot");
    const freshness = parseGraphDeclaredFreshness({
      status: "fresh",
      observedAt: "2026-07-30T00:00:00.000Z",
      assessedAt: "2026-07-30T00:01:00.000Z"
    }, "/declaredFreshness");
    assertGraphSnapshotFreshnessPair(snapshot, freshness, "/snapshot", "/declaredFreshness");
    expect(snapshot).toEqual(legacySnapshot);
    expect(Object.getPrototypeOf(snapshot)).toBeNull();
    expect(Object.isFrozen(snapshot)).toBe(true);
  });

  it("accepts only the exact provider provenance paired with unassessed freshness", () => {
    const snapshot = parseGraphSnapshotProvenance(providerSnapshot, "/snapshot");
    const freshness = parseGraphDeclaredFreshness({
      status: "unassessed",
      reasonId: "single-read-no-head-revalidation"
    }, "/declaredFreshness");
    assertGraphSnapshotFreshnessPair(snapshot, freshness, "/snapshot", "/declaredFreshness");
    expect(snapshot.authority).toBe("receipt-integrity-only");
    expect(freshness.status).toBe("unassessed");
  });

  it("rejects cross-pairs and invented provider provenance", () => {
    const legacy = parseGraphSnapshotProvenance(legacySnapshot, "/snapshot");
    const unassessed = parseGraphDeclaredFreshness({
      status: "unassessed",
      reasonId: "single-read-no-head-revalidation"
    }, "/declaredFreshness");
    const pair = errorOf(() =>
      assertGraphSnapshotFreshnessPair(legacy, unassessed, "/snapshot", "/declaredFreshness")
    );
    expect(pair.code).toBe("INVALID_PAIRING");
    expect(pair.details).toEqual({
      reason: "snapshot-freshness-mismatch",
      path: "/declaredFreshness"
    });
    const invalid = errorOf(() => parseGraphSnapshotProvenance({
      ...providerSnapshot,
      providerVersion: "invented"
    }, "/snapshot"));
    expect(invalid.code).toBe("INVALID_SNAPSHOT");
    expect(invalid.details.reason).toBe("invalid-literal");
  });

  it("rejects accessors, sparse shapes, and noncanonical instants without leaking causes", () => {
    const accessor = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(accessor, "authority", { enumerable: true, get: () => "caller-declared-read-snapshot" });
    const error = errorOf(() => parseGraphSnapshotProvenance(accessor, "/snapshot"));
    expect(error.message).toBe("graph-snapshot-provenance-invalid");
    expect(error.details.reason).toBe("invalid-container");
    const freshness = errorOf(() => parseGraphDeclaredFreshness({
      status: "fresh",
      observedAt: "2026-07-30T00:00:00Z",
      assessedAt: "2026-07-30T00:01:00.000Z"
    }, "/declaredFreshness"));
    expect(freshness.code).toBe("INVALID_FRESHNESS");
    expect(freshness.details.reason).toBe("invalid-instant");
  });
});
