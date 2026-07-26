/** Browser-safe, provider-neutral public contract for delivery-safety projections. */

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

export const DELIVERY_SAFETY_REASON_CODES = Object.freeze(
  Object.values(DELIVERY_SAFETY_REASON)
) as readonly DeliverySafetyReasonCode[];

export const DELIVERY_SAFETY_FAILED_REASON_CODES = Object.freeze([
  DELIVERY_SAFETY_REASON.providerLockMismatch,
  DELIVERY_SAFETY_REASON.localOnlyMissing,
  DELIVERY_SAFETY_REASON.localOnlyMismatch,
  DELIVERY_SAFETY_REASON.selfLearnEnabled,
  DELIVERY_SAFETY_REASON.deliveryRouteNotLocal,
  DELIVERY_SAFETY_REASON.providerLockMissing,
  DELIVERY_SAFETY_REASON.selfLearningHoldMissing,
  DELIVERY_SAFETY_REASON.overdueFollowups,
  DELIVERY_SAFETY_REASON.overdueReminders
] as const);

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

const RESULT_KEYS = ["evidence", "reasonCodes", "schemaVersion", "status"] as const;
const EVIDENCE_KEYS = [
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
] as const;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function safeCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function closedBoolean(value: unknown): value is DeliverySafetyBooleanObservation {
  return typeof value === "boolean" || value === "unverified";
}

function validReasons(value: unknown, status: unknown): value is readonly DeliverySafetyReasonCode[] {
  if (!Array.isArray(value)) return false;
  let previousIndex = -1;
  let hasFailedReason = false;
  for (const reason of value) {
    const index = DELIVERY_SAFETY_REASON_CODES.indexOf(reason as DeliverySafetyReasonCode);
    if (index <= previousIndex) return false;
    previousIndex = index;
    if ((DELIVERY_SAFETY_FAILED_REASON_CODES as readonly string[]).includes(String(reason))) {
      hasFailedReason = true;
    }
  }
  if (status === "passed") return value.length === 0;
  if (status === "failed") return hasFailedReason;
  return status === "unverified" && value.length > 0 && !hasFailedReason;
}

/** Strict admission for browser/API boundaries; rejects every unknown or raw-shaped key. */
export function isDeliverySafetyResult(value: unknown): value is DeliverySafetyResult {
  if (!record(value) || !exactKeys(value, RESULT_KEYS)
    || value.schemaVersion !== DELIVERY_SAFETY_SCHEMA_VERSION
    || !["passed", "failed", "unverified"].includes(String(value.status))
    || !validReasons(value.reasonCodes, value.status)
    || !record(value.evidence)
    || !exactKeys(value.evidence, EVIDENCE_KEYS)) return false;
  const evidence = value.evidence;
  return evidence.schemaVersion === DELIVERY_SAFETY_SCHEMA_VERSION
    && ["ok", "unverified"].includes(String(evidence.environmentProbe))
    && closedBoolean(evidence.localOnlyPersisted)
    && closedBoolean(evidence.localOnlyEffective)
    && closedBoolean(evidence.selfLearnDisabled)
    && closedBoolean(evidence.baseProviderLocal)
    && ["verified", "unverified"].includes(String(evidence.providerLockObservation))
    && typeof evidence.providerLockLocalOnly === "boolean"
    && typeof evidence.providerLockMismatch === "boolean"
    && ["engaged", "released", "unverified"].includes(String(evidence.deliveryBrake))
    && ["engaged", "released", "unverified"].includes(String(evidence.selfLearningHold))
    && safeCount(evidence.scheduledFollowups)
    && safeCount(evidence.overdueFollowups)
    && evidence.overdueFollowups <= evidence.scheduledFollowups
    && safeCount(evidence.scheduledReminders)
    && safeCount(evidence.overdueReminders)
    && evidence.overdueReminders <= evidence.scheduledReminders
    && safeCount(evidence.pendingDraftCount)
    && ["ok", "unverified"].includes(String(evidence.pendingDraftObservation))
    && (evidence.pendingDraftObservation === "ok" || evidence.pendingDraftCount === 0);
}
