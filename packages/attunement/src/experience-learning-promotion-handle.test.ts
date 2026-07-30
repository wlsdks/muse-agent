import { describe, expect, it } from "vitest";

import { fingerprintContinuityPolicy } from "./policy-digest.js";
import {
  createExperienceLearningPromotionHandle,
  parseExperienceLearningPromotionHandle
} from "./experience-learning-promotion-handle.js";

const policyBefore = {
  detail: "standard",
  nextStep: "contextual",
  suppression: "none",
  version: 1
} as const;
const policyAfter = {
  detail: "compact",
  nextStep: "direct",
  suppression: "acknowledge-previous",
  version: 2
} as const;

function input() {
  return {
    activeBehaviorDigestAfter: fingerprintContinuityPolicy(policyAfter),
    activeBehaviorDigestBefore: fingerprintContinuityPolicy(policyBefore),
    appliedAt: "2026-07-30T00:00:01.000Z",
    authority: "owner-explicit" as const,
    candidateId: "experience_candidate_1",
    policyAfter,
    policyBefore,
    promotionAuditId: `learning_policy_audit_${"a".repeat(64)}`,
    promotionId: `learning_promotion_${"b".repeat(64)}`,
    threadId: "thread-1"
  };
}

describe("ExperienceLearningPromotionHandle", () => {
  it("creates a deterministic content-bound immutable handle", () => {
    const first = createExperienceLearningPromotionHandle(input());
    const second = createExperienceLearningPromotionHandle(input());

    expect(first).toEqual(second);
    expect(first?.handleId).toMatch(
      /^learning_promotion_handle_[a-f0-9]{64}$/u
    );
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first?.policyBefore)).toBe(true);
    expect(Object.isFrozen(first?.policyAfter)).toBe(true);
    expect(parseExperienceLearningPromotionHandle(
      JSON.parse(JSON.stringify(first))
    )).toEqual(first);
  });

  it("copies caller-owned policies before freezing", () => {
    const before = { ...policyBefore } as {
      detail: "compact" | "standard";
      nextStep: "contextual" | "direct" | "hidden";
      suppression: "acknowledge-previous" | "none";
      version: number;
    };
    const after = { ...policyAfter } as typeof before;
    const handle = createExperienceLearningPromotionHandle({
      ...input(),
      policyAfter: after,
      policyBefore: before
    });

    before.detail = "compact";
    after.detail = "standard";
    expect(handle?.policyBefore.detail).toBe("standard");
    expect(handle?.policyAfter.detail).toBe("compact");
  });

  it("rejects tampering and non-canonical lineage", () => {
    const handle = createExperienceLearningPromotionHandle(input())!;
    expect(parseExperienceLearningPromotionHandle({
      ...handle,
      promotionId: `learning_promotion_${"c".repeat(64)}`
    })).toBeUndefined();
    expect(createExperienceLearningPromotionHandle({
      ...input(),
      activeBehaviorDigestAfter: "0".repeat(64)
    })).toBeUndefined();
    expect(createExperienceLearningPromotionHandle({
      ...input(),
      policyAfter: { ...policyAfter, version: 1 }
    })).toBeUndefined();
    expect(createExperienceLearningPromotionHandle({
      ...input(),
      appliedAt: "2026-07-30T00:00:01Z"
    })).toBeUndefined();
    expect(createExperienceLearningPromotionHandle({
      ...input(),
      promotionAuditId: "audit"
    })).toBeUndefined();
  });

  it("rejects extra fields and accessors without executing them", () => {
    expect(createExperienceLearningPromotionHandle({
      ...input(),
      extra: true
    })).toBeUndefined();

    let calls = 0;
    const hostile = { ...input() } as Record<string, unknown>;
    Object.defineProperty(hostile, "promotionId", {
      enumerable: true,
      get: () => {
        calls += 1;
        return input().promotionId;
      }
    });
    expect(createExperienceLearningPromotionHandle(hostile)).toBeUndefined();
    expect(calls).toBe(0);
  });
});
