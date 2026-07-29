import { describe, expect, it } from "vitest";

import {
  GraphSnapshotProvenanceError,
  assertGraphSnapshotFreshnessPair,
  assertGraphSnapshotFreshnessScopePair,
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
const providerScope = {
  sourceId: "default",
  threadId: "thread_trip"
};
const revalidationReceiptId =
  `muse-local-attunement-head-revalidation:sha256:${"d".repeat(64)}`;
const endpoint = {
  providerReceiptId:
    `muse-local-attunement-snapshot:sha256:${"e".repeat(64)}`,
  stateDigest: `sha256:${"f".repeat(64)}`,
  normalizedStateBytes: 12,
  captureCompletedAt: "2026-07-30T00:00:00.000Z"
};
const headSnapshot = {
  authority: "receipt-integrity-only",
  kind: "process-local-provider-head-revalidation",
  revalidationReceiptId,
  providerId: "muse.local-attunement-store",
  providerVersion: "muse.local-attunement-snapshot-provider.v1",
  providerScope,
  subject: endpoint,
  head: {
    ...endpoint,
    providerReceiptId:
      `muse-local-attunement-snapshot:sha256:${"1".repeat(64)}`,
    captureCompletedAt: "2026-07-30T00:00:00.025Z"
  },
  mintVerification:
    "provider-owned-two-capture-pair-verified-in-composing-process",
  mintVerificationSurvivesSerialization: false
};
const headFreshness = {
  basis: "provider-head-revalidation",
  status: "fresh",
  providerScope,
  observedAt: "2026-07-30T00:00:00.000Z",
  assessedAt: "2026-07-30T00:00:00.025Z",
  captureSpanMs: 25,
  maxCaptureSpanMs: 25,
  reasonId: "head-state-matched-within-bound",
  revalidationReceiptId
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

  it("admits only fresh scope-bound provider head revalidation pairs", () => {
    const snapshot = parseGraphSnapshotProvenance(
      headSnapshot,
      "/snapshot"
    );
    const freshness = parseGraphDeclaredFreshness(
      headFreshness,
      "/declaredFreshness"
    );
    assertGraphSnapshotFreshnessScopePair(
      snapshot,
      freshness,
      providerScope,
      {
        snapshot: "/snapshot",
        freshness: "/declaredFreshness",
        expectedScope: "/scope"
      }
    );
    expect(snapshot).toEqual(headSnapshot);
    expect(freshness).toEqual(headFreshness);

    const replay = errorOf(() =>
      assertGraphSnapshotFreshnessScopePair(
        snapshot,
        freshness,
        { ...providerScope, threadId: "thread_other" },
        {
          snapshot: "/snapshot",
          freshness: "/declaredFreshness",
          expectedScope: "/scope"
        }
      )
    );
    expect(replay.details).toEqual({
      reason: "scope-mismatch",
      path: "/scope"
    });
  });

  it("rejects fabricated provider-basis stale grammar", () => {
    const error = errorOf(() => parseGraphDeclaredFreshness({
      ...headFreshness,
      status: "stale",
      reasonId: "head-state-changed"
    }, "/declaredFreshness"));
    expect(error.code).toBe("INVALID_FRESHNESS");
    expect(error.details.reason).toBe("invalid-literal");
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
