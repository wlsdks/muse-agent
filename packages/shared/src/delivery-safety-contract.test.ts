import { describe, expect, it } from "vitest";

import {
  DELIVERY_SAFETY_REASON,
  DELIVERY_SAFETY_SCHEMA_VERSION,
  isDeliverySafetyResult,
  type DeliverySafetyResult
} from "./delivery-safety-contract.js";

function result(overrides: Partial<DeliverySafetyResult> = {}): DeliverySafetyResult {
  return {
    evidence: {
      baseProviderLocal: true,
      deliveryBrake: "released",
      environmentProbe: "ok",
      localOnlyEffective: true,
      localOnlyPersisted: true,
      overdueFollowups: 0,
      overdueReminders: 0,
      pendingDraftCount: 2,
      pendingDraftObservation: "ok",
      providerLockLocalOnly: true,
      providerLockMismatch: false,
      providerLockObservation: "verified",
      scheduledFollowups: 0,
      scheduledReminders: 0,
      schemaVersion: DELIVERY_SAFETY_SCHEMA_VERSION,
      selfLearnDisabled: true,
      selfLearningHold: "engaged"
    },
    reasonCodes: [],
    schemaVersion: DELIVERY_SAFETY_SCHEMA_VERSION,
    status: "passed",
    ...overrides
  };
}

describe("delivery-safety public contract", () => {
  it("admits exact closed results and canonical ordered reasons", () => {
    expect(isDeliverySafetyResult(result())).toBe(true);
    expect(isDeliverySafetyResult(result({
      reasonCodes: [
        DELIVERY_SAFETY_REASON.providerLockMismatch,
        DELIVERY_SAFETY_REASON.environmentUnverified
      ],
      status: "failed"
    }))).toBe(true);
  });

  it.each([
    ["extra result key", { ...result(), draft: "PRIVATE" }],
    ["extra evidence key", { ...result(), evidence: { ...result().evidence, recipient: "PRIVATE" } }],
    ["unknown reason", { ...result(), reasonCodes: ["raw-private-reason"], status: "unverified" }],
    ["reordered reasons", {
      ...result(),
      reasonCodes: [
        DELIVERY_SAFETY_REASON.environmentUnverified,
        DELIVERY_SAFETY_REASON.providerLockMismatch
      ],
      status: "failed"
    }],
    ["duplicate reason", {
      ...result(),
      reasonCodes: [
        DELIVERY_SAFETY_REASON.environmentUnverified,
        DELIVERY_SAFETY_REASON.environmentUnverified
      ],
      status: "unverified"
    }],
    ["negative count", {
      ...result(),
      evidence: { ...result().evidence, pendingDraftCount: -1 }
    }],
    ["raw brake enum", {
      ...result(),
      evidence: { ...result().evidence, deliveryBrake: "PRIVATE" }
    }],
    ["passed with reason", {
      ...result(),
      reasonCodes: [DELIVERY_SAFETY_REASON.environmentUnverified]
    }]
  ])("rejects %s", (_name, malformed) => {
    expect(isDeliverySafetyResult(malformed)).toBe(false);
  });
});
