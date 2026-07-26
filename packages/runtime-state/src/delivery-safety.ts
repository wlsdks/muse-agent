/**
 * Provider-neutral, I/O-free delivery-safety projection.
 *
 * Collectors must reduce owner data and runtime details to this closed
 * observation before classification. No title, recipient, payload, provider
 * identifier, path, or raw process detail belongs in this contract.
 */

import {
  DELIVERY_SAFETY_REASON,
  DELIVERY_SAFETY_SCHEMA_VERSION,
  type DeliverySafetyBooleanObservation,
  type DeliverySafetyCountObservation,
  type DeliverySafetyObservation,
  type DeliverySafetyReasonCode,
  type DeliverySafetyResult
} from "@muse/shared";

export {
  DELIVERY_SAFETY_FAILED_REASON_CODES,
  DELIVERY_SAFETY_REASON,
  DELIVERY_SAFETY_REASON_CODES,
  DELIVERY_SAFETY_SCHEMA_VERSION,
  isDeliverySafetyResult,
  type DeliverySafetyBooleanObservation,
  type DeliverySafetyBrakeObservation,
  type DeliverySafetyCountObservation,
  type DeliverySafetyEvidence,
  type DeliverySafetyHoldObservation,
  type DeliverySafetyObservation,
  type DeliverySafetyReasonCode,
  type DeliverySafetyResult,
  type DeliverySafetyStatus,
  type PendingDraftCountObservation
} from "@muse/shared";

function validCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validCountObservation(
  value: DeliverySafetyCountObservation | undefined
): value is DeliverySafetyCountObservation {
  return value?.status === "ok"
    && validCount(value.scheduled)
    && validCount(value.overdue)
    && value.overdue <= value.scheduled;
}

function normalizeBoolean(value: unknown): DeliverySafetyBooleanObservation {
  return typeof value === "boolean" ? value : "unverified";
}

/**
 * Classify one privacy-safe delivery observation with stable reason ordering.
 *
 * The delivery brake suppresses failures that require active delivery, but an
 * explicit provider-lock mismatch remains a failure. Missing or malformed
 * evidence always closes as unverified.
 */
export function classifyDeliverySafety(
  observation: DeliverySafetyObservation
): DeliverySafetyResult {
  const failed: DeliverySafetyReasonCode[] = [];
  const unverified: DeliverySafetyReasonCode[] = [];
  const localOnlyPersisted = normalizeBoolean(observation.localOnlyPersisted);
  const localOnlyEffective = normalizeBoolean(observation.localOnlyEffective);
  const selfLearnDisabled = normalizeBoolean(observation.selfLearnDisabled);
  const baseProviderLocal = normalizeBoolean(observation.baseProviderLocal);
  const providerLockObservation = observation.providerLock?.observation === "verified"
    ? "verified"
    : "unverified";
  const providerLockLocalOnly = observation.providerLock?.localOnly === true;
  const providerLockMismatch = observation.providerLock?.mismatch === true;
  const deliveryBrake = observation.deliveryBrake === "engaged"
    || observation.deliveryBrake === "released"
    ? observation.deliveryBrake
    : "unverified";
  const selfLearningHold = observation.selfLearningHold === "engaged"
    || observation.selfLearningHold === "released"
    ? observation.selfLearningHold
    : "unverified";
  const followupsValid = validCountObservation(observation.followups);
  const remindersValid = validCountObservation(observation.reminders);
  const pendingDraftsValid = observation.pendingDrafts?.status === "ok"
    && validCount(observation.pendingDrafts.count);

  if (providerLockMismatch) failed.push(DELIVERY_SAFETY_REASON.providerLockMismatch);

  if (deliveryBrake !== "engaged") {
    if (localOnlyPersisted === false) failed.push(DELIVERY_SAFETY_REASON.localOnlyMissing);
    if (
      typeof localOnlyPersisted === "boolean"
      && typeof localOnlyEffective === "boolean"
      && localOnlyPersisted !== localOnlyEffective
    ) {
      failed.push(DELIVERY_SAFETY_REASON.localOnlyMismatch);
    }
    if (selfLearnDisabled === false) failed.push(DELIVERY_SAFETY_REASON.selfLearnEnabled);
    if (baseProviderLocal === false) failed.push(DELIVERY_SAFETY_REASON.deliveryRouteNotLocal);
    if (providerLockObservation === "verified" && !providerLockLocalOnly) {
      failed.push(DELIVERY_SAFETY_REASON.providerLockMissing);
    }
    if (selfLearningHold === "released") {
      failed.push(DELIVERY_SAFETY_REASON.selfLearningHoldMissing);
    }
    if (followupsValid && observation.followups.overdue > 0) {
      failed.push(DELIVERY_SAFETY_REASON.overdueFollowups);
    }
    if (remindersValid && observation.reminders.overdue > 0) {
      failed.push(DELIVERY_SAFETY_REASON.overdueReminders);
    }
  }

  if (observation.environmentProbe !== "ok") {
    unverified.push(DELIVERY_SAFETY_REASON.environmentUnverified);
  }
  if (localOnlyPersisted === "unverified" || localOnlyEffective === "unverified") {
    unverified.push(DELIVERY_SAFETY_REASON.localOnlyUnverified);
  }
  if (providerLockObservation !== "verified") {
    unverified.push(DELIVERY_SAFETY_REASON.providerLockUnverified);
  }
  if (deliveryBrake === "engaged") {
    unverified.push(DELIVERY_SAFETY_REASON.deliveryBrakeEngaged);
  } else if (deliveryBrake === "unverified") {
    unverified.push(DELIVERY_SAFETY_REASON.deliveryBrakeUnverified);
  }
  if (selfLearnDisabled === "unverified") {
    unverified.push(DELIVERY_SAFETY_REASON.selfLearnUnverified);
  }
  if (baseProviderLocal === "unverified") {
    unverified.push(DELIVERY_SAFETY_REASON.deliveryRouteUnverified);
  }
  if (selfLearningHold === "unverified") {
    unverified.push(DELIVERY_SAFETY_REASON.selfLearningHoldUnverified);
  }
  if (!followupsValid) unverified.push(DELIVERY_SAFETY_REASON.followupBacklogUnverified);
  if (!remindersValid) unverified.push(DELIVERY_SAFETY_REASON.reminderBacklogUnverified);
  if (!pendingDraftsValid) unverified.push(DELIVERY_SAFETY_REASON.pendingDraftsUnverified);

  const reasonCodes = [...new Set([...failed, ...unverified])];
  return {
    evidence: {
      baseProviderLocal,
      deliveryBrake,
      environmentProbe: observation.environmentProbe === "ok" ? "ok" : "unverified",
      localOnlyEffective,
      localOnlyPersisted,
      overdueFollowups: followupsValid ? observation.followups.overdue : 0,
      overdueReminders: remindersValid ? observation.reminders.overdue : 0,
      pendingDraftCount: pendingDraftsValid ? observation.pendingDrafts!.count : 0,
      pendingDraftObservation: pendingDraftsValid ? "ok" : "unverified",
      providerLockLocalOnly,
      providerLockMismatch,
      providerLockObservation,
      scheduledFollowups: followupsValid ? observation.followups.scheduled : 0,
      scheduledReminders: remindersValid ? observation.reminders.scheduled : 0,
      schemaVersion: DELIVERY_SAFETY_SCHEMA_VERSION,
      selfLearnDisabled,
      selfLearningHold
    },
    reasonCodes,
    schemaVersion: DELIVERY_SAFETY_SCHEMA_VERSION,
    status: failed.length > 0 ? "failed" : unverified.length > 0 ? "unverified" : "passed"
  };
}

/**
 * Canonical fail-closed projection for an unavailable delivery-safety
 * supplier. It asserts no operational fact: every observable fact remains
 * unverified, including the delivery brake.
 */
export function createUnverifiedDeliverySafetyResult(): DeliverySafetyResult {
  return classifyDeliverySafety({
    baseProviderLocal: "unverified",
    deliveryBrake: "unverified",
    environmentProbe: "unverified",
    followups: { overdue: 0, scheduled: 0, status: "unverified" },
    localOnlyEffective: "unverified",
    localOnlyPersisted: "unverified",
    pendingDrafts: { count: 0, status: "unverified" },
    providerLock: { localOnly: false, mismatch: false, observation: "unverified" },
    reminders: { overdue: 0, scheduled: 0, status: "unverified" },
    selfLearnDisabled: "unverified",
    selfLearningHold: "unverified"
  });
}
