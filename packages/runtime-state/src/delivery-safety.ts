/**
 * Provider-neutral, I/O-free delivery-safety projection.
 *
 * Collectors must reduce owner data and runtime details to this closed
 * observation before classification. No title, recipient, payload, provider
 * identifier, path, or raw process detail belongs in this contract.
 */

export const DELIVERY_SAFETY_SCHEMA_VERSION = 1 as const;

export const DELIVERY_SAFETY_REASON = {
  providerLockMismatch: "delivery-provider-lock-adapter-mismatch",
  localOnlyMissing: "daemon-local-only-not-persisted",
  localOnlyMismatch: "daemon-local-only-state-mismatch",
  selfLearnEnabled: "daemon-self-learn-not-disabled",
  deliveryRouteNotLocal: "delivery-route-not-local-log",
  providerLockMissing: "delivery-provider-lock-not-log",
  selfLearningHoldMissing: "self-learning-hold-not-engaged",
  overdueFollowups: "overdue-followups-detected",
  overdueReminders: "overdue-reminders-detected",
  environmentUnverified: "delivery-environment-unverified",
  localOnlyUnverified: "daemon-local-only-state-unverified",
  providerLockUnverified: "delivery-provider-lock-unverified",
  deliveryBrakeEngaged: "delivery-brake-engaged",
  deliveryBrakeUnverified: "delivery-brake-unverified",
  selfLearnUnverified: "daemon-self-learn-state-unverified",
  deliveryRouteUnverified: "delivery-route-unverified",
  selfLearningHoldUnverified: "self-learning-hold-unverified",
  followupBacklogUnverified: "followup-backlog-unverified",
  reminderBacklogUnverified: "reminder-backlog-unverified",
  pendingDraftsUnverified: "pending-drafts-unverified"
} as const;

export type DeliverySafetyReasonCode =
  (typeof DELIVERY_SAFETY_REASON)[keyof typeof DELIVERY_SAFETY_REASON];
export type DeliverySafetyStatus = "passed" | "failed" | "unverified";
export type DeliverySafetyBooleanObservation = boolean | "unverified";
export type DeliverySafetyBrakeObservation = "engaged" | "released" | "unverified";
export type DeliverySafetyHoldObservation = "engaged" | "released" | "unverified";

export interface DeliverySafetyCountObservation {
  readonly status: "ok" | "unverified";
  readonly scheduled: number;
  readonly overdue: number;
}

export interface PendingDraftCountObservation {
  readonly status: "ok" | "unverified";
  readonly count: number;
}

export interface DeliverySafetyObservation {
  readonly environmentProbe: "ok" | "unverified";
  readonly localOnlyPersisted: DeliverySafetyBooleanObservation;
  readonly localOnlyEffective: DeliverySafetyBooleanObservation;
  readonly selfLearnDisabled: DeliverySafetyBooleanObservation;
  readonly baseProviderLocal: DeliverySafetyBooleanObservation;
  readonly providerLock: {
    readonly observation: "verified" | "unverified";
    readonly localOnly: boolean;
    readonly mismatch: boolean;
  };
  readonly deliveryBrake: DeliverySafetyBrakeObservation;
  readonly selfLearningHold: DeliverySafetyHoldObservation;
  readonly followups: DeliverySafetyCountObservation;
  readonly reminders: DeliverySafetyCountObservation;
  readonly pendingDrafts?: PendingDraftCountObservation;
}

export interface DeliverySafetyEvidence {
  readonly schemaVersion: typeof DELIVERY_SAFETY_SCHEMA_VERSION;
  readonly environmentProbe: "ok" | "unverified";
  readonly localOnlyPersisted: DeliverySafetyBooleanObservation;
  readonly localOnlyEffective: DeliverySafetyBooleanObservation;
  readonly selfLearnDisabled: DeliverySafetyBooleanObservation;
  readonly baseProviderLocal: DeliverySafetyBooleanObservation;
  readonly providerLockObservation: "verified" | "unverified";
  readonly providerLockLocalOnly: boolean;
  readonly providerLockMismatch: boolean;
  readonly deliveryBrake: DeliverySafetyBrakeObservation;
  readonly selfLearningHold: DeliverySafetyHoldObservation;
  readonly scheduledFollowups: number;
  readonly overdueFollowups: number;
  readonly scheduledReminders: number;
  readonly overdueReminders: number;
  readonly pendingDraftCount: number;
  readonly pendingDraftObservation: "ok" | "unverified";
}

export interface DeliverySafetyResult {
  readonly schemaVersion: typeof DELIVERY_SAFETY_SCHEMA_VERSION;
  readonly status: DeliverySafetyStatus;
  readonly reasonCodes: readonly DeliverySafetyReasonCode[];
  readonly evidence: DeliverySafetyEvidence;
}

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
    if (!providerLockLocalOnly) failed.push(DELIVERY_SAFETY_REASON.providerLockMissing);
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
