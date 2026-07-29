import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  CONTINUITY_SCOPED_SOURCE_OBSERVATION_LIMITS,
  CONTINUITY_SOURCE_OBSERVATION_LIMITS,
  ContinuityScopedSourceObservationError,
  captureScopedContinuitySourceObservation,
  captureContinuitySourceObservation,
  verifyScopedContinuitySourceObservation,
  type ContinuityScopedSourceObservationReceipt
} from "./continuity-source-observations.js";
import type { ContinuityPack, ResolvedArtifact } from "./types.js";

type Data = Record<string, unknown>;

const OBSERVED_AT = "2026-07-29T09:00:00.000Z";
const HASH_DOMAIN =
  "muse.attunement.continuity-scoped-source-observation.v1\0";
const RECEIPT_ID_PREFIX =
  "muse-continuity-scoped-source-observation:v1:sha256:";

function artifact(
  artifactId: string,
  fields: Partial<ResolvedArtifact> = {}
): ResolvedArtifact {
  return {
    artifactId,
    artifactType: "note",
    providerId: "local",
    role: "context",
    title: "Note",
    ...fields
  };
}

function packFromArtifacts(
  threadId: string,
  artifacts: readonly ResolvedArtifact[]
): ContinuityPack {
  const evidence = artifacts.map((entry) => ({
    artifact: entry,
    reference: {
      artifactId: entry.artifactId,
      artifactType: entry.artifactType,
      providerId: entry.providerId,
      role: entry.role
    },
    status: "available" as const
  }));
  return {
    deliveryPolicyVersion: 1,
    evidence,
    evidenceRefs: evidence.map((entry) => entry.reference),
    policy: {
      detail: "standard",
      nextStep: "direct",
      suppression: "none",
      version: 1
    },
    thread: {
      id: threadId,
      kind: "life",
      title: "Trip planning"
    }
  };
}

function sourceInput(
  sourceId = "default",
  threadId = "thread_trip"
): {
  readonly observedAt: string;
  readonly pack: ContinuityPack;
  readonly scope: { readonly sourceId: string; readonly threadId: string };
} {
  return {
    scope: { sourceId, threadId },
    observedAt: OBSERVED_AT,
    pack: packFromArtifacts(threadId, [artifact("note_1", {
      summary: "Owner-authored source truth",
      title: "Trip note"
    })])
  };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function expectScopedError(
  fn: () => unknown,
  code: ContinuityScopedSourceObservationError["code"]
): void {
  try {
    fn();
    throw new Error("expected scoped source observation to fail");
  } catch (cause) {
    expect(cause).toBeInstanceOf(ContinuityScopedSourceObservationError);
    expect((cause as ContinuityScopedSourceObservationError).code).toBe(code);
  }
}

function rehash(
  receipt: ContinuityScopedSourceObservationReceipt
): ContinuityScopedSourceObservationReceipt {
  const { receiptId: _receiptId, ...body } = receipt;
  const digest = createHash("sha256")
    .update(HASH_DOMAIN, "utf8")
    .update(JSON.stringify(body), "utf8")
    .digest("hex");
  return {
    ...body,
    receiptId: `${RECEIPT_ID_PREFIX}${digest}`
  };
}

function largePack(
  threadId: string,
  payloadBytes: number,
  utf8Bump = false
): ContinuityPack {
  const artifacts: ResolvedArtifact[] = [];
  let remaining = payloadBytes;
  for (let index = 0; index < 128; index += 1) {
    const size = Math.min(16_000, remaining);
    remaining -= size;
    let summary = "x".repeat(size);
    if (utf8Bump && index === 0 && summary.length > 0) {
      summary = `é${summary.slice(1)}`;
    }
    artifacts.push(artifact(`note_${index.toString()}`, { summary, title: "n" }));
  }
  if (remaining !== 0) {
    throw new Error("large Pack payload exceeds fixture capacity");
  }
  return packFromArtifacts(threadId, artifacts);
}

describe("Scoped Continuity Source Observation Receipt", () => {
  it("captures and round-trips a deep-frozen scoped receipt without changing the input", () => {
    const input = sourceInput("personal.local", "thread_trip");
    const before = clone(input);
    const receipt = captureScopedContinuitySourceObservation(input);
    const verified = verifyScopedContinuitySourceObservation(
      JSON.parse(JSON.stringify(receipt))
    );

    expect(input).toEqual(before);
    expect(verified).toEqual(receipt);
    expect(JSON.stringify(verified)).toBe(JSON.stringify(receipt));
    expect(receipt.scope).toEqual({ sourceId: "personal.local", threadId: "thread_trip" });
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(Object.isFrozen(receipt.scope)).toBe(true);
    expect(Object.isFrozen(receipt.observation)).toBe(true);
    expect(Object.isFrozen(receipt.observation.projection)).toBe(true);
  });

  it("binds sourceId and threadId before wrapper integrity", () => {
    const receipt = captureScopedContinuitySourceObservation(sourceInput());
    const changedSource = clone(receipt);
    (changedSource.scope as unknown as Data).sourceId = "other-source";
    expectScopedError(
      () => verifyScopedContinuitySourceObservation(changedSource),
      "INTEGRITY_MISMATCH"
    );

    const mismatchedInput = sourceInput();
    (mismatchedInput.scope as unknown as Data).threadId = "other-thread";
    expectScopedError(
      () => captureScopedContinuitySourceObservation(mismatchedInput),
      "INVALID_INPUT"
    );

    const changedThread = clone(receipt);
    (changedThread.scope as unknown as Data).threadId = "other-thread";
    expectScopedError(
      () => verifyScopedContinuitySourceObservation(changedThread),
      "INVALID_RECEIPT"
    );
  });

  it.each([
    ["empty", ""],
    ["whitespace", "source id"],
    ["path", "source/id"],
    ["control", "source\u0000id"],
    ["punctuation", "source:id"]
  ])("rejects a malformed scoped sourceId on capture and verify: %s", (_label, sourceId) => {
    expectScopedError(
      () => captureScopedContinuitySourceObservation(sourceInput(sourceId)),
      "INVALID_INPUT"
    );

    const receipt = clone(captureScopedContinuitySourceObservation(sourceInput()));
    (receipt.scope as unknown as Data).sourceId = sourceId;
    expectScopedError(
      () => verifyScopedContinuitySourceObservation(receipt),
      "INVALID_RECEIPT"
    );
  });

  it("maps scoped and nested receipt errors in the specified order", () => {
    expectScopedError(
      () => captureScopedContinuitySourceObservation(sourceInput("s".repeat(129))),
      "BUDGET_EXCEEDED"
    );

    const receipt = clone(captureScopedContinuitySourceObservation(sourceInput()));
    (receipt.scope as unknown as Data).sourceId = "s".repeat(129);
    expectScopedError(
      () => verifyScopedContinuitySourceObservation(receipt),
      "BUDGET_EXCEEDED"
    );

    const nestedStale = clone(captureScopedContinuitySourceObservation(sourceInput()));
    (nestedStale.observation.projection.thread as unknown as Data).title = "changed";
    expectScopedError(
      () => verifyScopedContinuitySourceObservation(nestedStale),
      "INVALID_RECEIPT"
    );

    const stale = clone(captureScopedContinuitySourceObservation(sourceInput()));
    (stale.scope as unknown as Data).sourceId = "other-source";
    const rehashed = rehash(stale);
    expect(rehashed.receiptId).not.toBe(stale.receiptId);
    expect(verifyScopedContinuitySourceObservation(rehashed)).toEqual(rehashed);
  });

  it("preserves unknown thrown identities and rejects hostile envelope descriptors", () => {
    const getter = vi.fn(() => sourceInput().pack);
    const accessor = { scope: sourceInput().scope, observedAt: OBSERVED_AT };
    Object.defineProperty(accessor, "pack", { enumerable: true, get: getter });
    expectScopedError(
      () => captureScopedContinuitySourceObservation(accessor),
      "INVALID_INPUT"
    );
    expect(getter).not.toHaveBeenCalled();

    const sentinel = new Error("proxy sentinel");
    const proxy = new Proxy({}, {
      getPrototypeOf() {
        throw sentinel;
      }
    });
    expect(() => captureScopedContinuitySourceObservation(proxy)).toThrow(sentinel);
    expect(() => verifyScopedContinuitySourceObservation(proxy)).toThrow(sentinel);
  });

  it("accepts exactly 1,001,024 scoped UTF-8 bytes and rejects the next byte", () => {
    const sourceId = "s".repeat(128);
    const threadId = "t".repeat(1_300);
    const baselinePayload = 900_000;
    const baseline = captureScopedContinuitySourceObservation({
      scope: { sourceId, threadId },
      observedAt: OBSERVED_AT,
      pack: largePack(threadId, baselinePayload)
    });
    const baselineBytes = utf8Bytes(JSON.stringify(baseline));
    const exactPayload = baselinePayload
      + CONTINUITY_SCOPED_SOURCE_OBSERVATION_LIMITS.maxReceiptBytes
      - baselineBytes;
    const exactInput = {
      scope: { sourceId, threadId },
      observedAt: OBSERVED_AT,
      pack: largePack(threadId, exactPayload)
    };
    const exact = captureScopedContinuitySourceObservation(exactInput);
    const exactInner = captureContinuitySourceObservation({
      observedAt: OBSERVED_AT,
      pack: exactInput.pack
    });
    expect(utf8Bytes(JSON.stringify(exact))).toBe(
      CONTINUITY_SCOPED_SOURCE_OBSERVATION_LIMITS.maxReceiptBytes
    );
    expect(utf8Bytes(JSON.stringify(exactInner))).toBeLessThanOrEqual(
      CONTINUITY_SOURCE_OBSERVATION_LIMITS.maxReceiptBytes
    );
    expect(verifyScopedContinuitySourceObservation(JSON.parse(JSON.stringify(exact)))).toEqual(exact);

    const overflowPack = largePack(threadId, exactPayload, true);
    const overflowInner = captureContinuitySourceObservation({
      observedAt: OBSERVED_AT,
      pack: overflowPack
    });
    const overflow = rehash({
      schemaVersion: 1,
      formatVersion: "muse.continuity-scoped-source-observation.v1",
      authority: "caller-declared-observation",
      scope: { sourceId, threadId },
      observation: overflowInner,
      receiptId: `${RECEIPT_ID_PREFIX}${"0".repeat(64)}`
    });
    expect(utf8Bytes(JSON.stringify(overflow))).toBe(
      CONTINUITY_SCOPED_SOURCE_OBSERVATION_LIMITS.maxReceiptBytes + 1
    );
    expectScopedError(
      () => verifyScopedContinuitySourceObservation(overflow),
      "BUDGET_EXCEEDED"
    );
    expectScopedError(
      () => captureScopedContinuitySourceObservation({
        scope: { sourceId, threadId },
        observedAt: OBSERVED_AT,
        pack: overflowPack
      }),
      "BUDGET_EXCEEDED"
    );
  });
});
