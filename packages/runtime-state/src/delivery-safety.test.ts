import { describe, expect, it } from "vitest";
import { isDeliverySafetyResult } from "@muse/shared";

import {
  DELIVERY_SAFETY_REASON,
  classifyDeliverySafety,
  createUnverifiedDeliverySafetyResult,
  type DeliverySafetyObservation
} from "./delivery-safety.js";

function safeObservation(
  overrides: Partial<DeliverySafetyObservation> = {}
): DeliverySafetyObservation {
  return {
    baseProviderLocal: true,
    deliveryBrake: "released",
    environmentProbe: "ok",
    followups: { overdue: 0, scheduled: 0, status: "ok" },
    localOnlyEffective: true,
    localOnlyPersisted: true,
    pendingDrafts: { count: 0, status: "ok" },
    providerLock: { localOnly: true, mismatch: false, observation: "verified" },
    reminders: { overdue: 0, scheduled: 0, status: "ok" },
    selfLearnDisabled: true,
    selfLearningHold: "engaged",
    ...overrides
  };
}

describe("classifyDeliverySafety", () => {
  it("creates one exact all-unverified fallback without fabricating an engaged brake", () => {
    const result = createUnverifiedDeliverySafetyResult();

    expect(result.status).toBe("unverified");
    expect(result.reasonCodes).toEqual([
      DELIVERY_SAFETY_REASON.environmentUnverified,
      DELIVERY_SAFETY_REASON.localOnlyUnverified,
      DELIVERY_SAFETY_REASON.providerLockUnverified,
      DELIVERY_SAFETY_REASON.deliveryBrakeUnverified,
      DELIVERY_SAFETY_REASON.selfLearnUnverified,
      DELIVERY_SAFETY_REASON.deliveryRouteUnverified,
      DELIVERY_SAFETY_REASON.selfLearningHoldUnverified,
      DELIVERY_SAFETY_REASON.followupBacklogUnverified,
      DELIVERY_SAFETY_REASON.reminderBacklogUnverified,
      DELIVERY_SAFETY_REASON.pendingDraftsUnverified
    ]);
    expect(Object.keys(result)).toEqual(["evidence", "reasonCodes", "schemaVersion", "status"]);
    expect(Object.keys(result.evidence)).toEqual([
      "baseProviderLocal",
      "deliveryBrake",
      "environmentProbe",
      "localOnlyEffective",
      "localOnlyPersisted",
      "overdueFollowups",
      "overdueReminders",
      "pendingDraftCount",
      "pendingDraftObservation",
      "providerLockLocalOnly",
      "providerLockMismatch",
      "providerLockObservation",
      "scheduledFollowups",
      "scheduledReminders",
      "schemaVersion",
      "selfLearnDisabled",
      "selfLearningHold"
    ]);
    expect(result.evidence.deliveryBrake).toBe("unverified");
    expect(isDeliverySafetyResult(result)).toBe(true);
  });

  it("returns a deterministic privacy-safe passed projection", () => {
    const input = safeObservation({ pendingDrafts: { count: 2, status: "ok" } });
    expect(classifyDeliverySafety(input)).toEqual(classifyDeliverySafety(input));
    expect(classifyDeliverySafety(input)).toMatchObject({
      evidence: {
        pendingDraftCount: 2,
        pendingDraftObservation: "ok",
        schemaVersion: 1
      },
      reasonCodes: [],
      status: "passed"
    });
    expect(isDeliverySafetyResult(classifyDeliverySafety(input))).toBe(true);
  });

  it("orders and deduplicates active delivery failures", () => {
    const result = classifyDeliverySafety(safeObservation({
      baseProviderLocal: false,
      followups: { overdue: 2, scheduled: 2, status: "ok" },
      localOnlyEffective: false,
      localOnlyPersisted: false,
      providerLock: { localOnly: false, mismatch: true, observation: "verified" },
      reminders: { overdue: 1, scheduled: 1, status: "ok" },
      selfLearnDisabled: false,
      selfLearningHold: "released"
    }));
    expect(result.status).toBe("failed");
    expect(result.reasonCodes).toEqual([
      DELIVERY_SAFETY_REASON.providerLockMismatch,
      DELIVERY_SAFETY_REASON.localOnlyMissing,
      DELIVERY_SAFETY_REASON.selfLearnEnabled,
      DELIVERY_SAFETY_REASON.deliveryRouteNotLocal,
      DELIVERY_SAFETY_REASON.providerLockMissing,
      DELIVERY_SAFETY_REASON.selfLearningHoldMissing,
      DELIVERY_SAFETY_REASON.overdueFollowups,
      DELIVERY_SAFETY_REASON.overdueReminders
    ]);
  });

  it("keeps held delivery unverified while retaining an explicit lock mismatch", () => {
    const result = classifyDeliverySafety(safeObservation({
      deliveryBrake: "engaged",
      followups: { overdue: 9, scheduled: 9, status: "ok" },
      providerLock: { localOnly: true, mismatch: true, observation: "verified" }
    }));
    expect(result).toMatchObject({
      reasonCodes: [
        DELIVERY_SAFETY_REASON.providerLockMismatch,
        DELIVERY_SAFETY_REASON.deliveryBrakeEngaged
      ],
      status: "failed"
    });
  });

  it("fails closed for missing and malformed observations", () => {
    const malformed = {
      ...safeObservation(),
      deliveryBrake: "unknown",
      followups: { overdue: 2, scheduled: 1, status: "ok" },
      baseProviderLocal: undefined,
      localOnlyEffective: undefined,
      pendingDrafts: undefined,
      providerLock: { localOnly: true, mismatch: false, observation: "unknown" },
      reminders: { overdue: Number.NaN, scheduled: 1, status: "ok" },
      selfLearnDisabled: undefined,
      selfLearningHold: "unknown"
    } as unknown as DeliverySafetyObservation;
    const result = classifyDeliverySafety(malformed);
    expect(result.status).toBe("unverified");
    expect(result.reasonCodes).toEqual([
      DELIVERY_SAFETY_REASON.localOnlyUnverified,
      DELIVERY_SAFETY_REASON.providerLockUnverified,
      DELIVERY_SAFETY_REASON.deliveryBrakeUnverified,
      DELIVERY_SAFETY_REASON.selfLearnUnverified,
      DELIVERY_SAFETY_REASON.deliveryRouteUnverified,
      DELIVERY_SAFETY_REASON.selfLearningHoldUnverified,
      DELIVERY_SAFETY_REASON.followupBacklogUnverified,
      DELIVERY_SAFETY_REASON.reminderBacklogUnverified,
      DELIVERY_SAFETY_REASON.pendingDraftsUnverified
    ]);
    expect(result.evidence).toMatchObject({
      overdueFollowups: 0,
      overdueReminders: 0,
      pendingDraftCount: 0
    });
  });
});
