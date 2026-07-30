import { isTriggerEnvelope, type TriggerEnvelope } from "./trigger-envelope.js";

export type TriggerAdmissionAction = "execute" | "reject" | "shadow";

export type TriggerAdmissionReason =
  | "budget-exhausted"
  | "cooldown-active"
  | "delivery-brake"
  | "duplicate"
  | "focus-inactive"
  | "focus-unknown"
  | "future"
  | "invalid"
  | "paused"
  | "shadow-only"
  | "stale";

export interface TriggerAdmissionDecision {
  readonly action: TriggerAdmissionAction;
  readonly dedupKey: string | null;
  readonly reasons: readonly TriggerAdmissionReason[];
}

export interface TriggerAdmissionInput {
  readonly envelope: unknown;
  readonly now: Date;
  readonly maxAgeMs?: number;
  readonly maxFutureSkewMs?: number;
  readonly seenDedupKeys?: ReadonlySet<string>;
  readonly paused?: boolean;
  readonly cooldownUntil?: Date;
  readonly focus?: "active" | "inactive" | "not-applicable" | "unknown";
  readonly budgetAvailable?: boolean;
  readonly deliveryBrakeEngaged?: boolean;
  readonly shadowOnly?: boolean;
}

/**
 * Pure event-admission gate. Reject means no reasoning or effect; shadow means
 * the event may be observed/evaluated but cannot deliver an external effect.
 */
export function admitTrigger(input: TriggerAdmissionInput): TriggerAdmissionDecision {
  if (!isTriggerEnvelope(input.envelope)) {
    return { action: "reject", dedupKey: null, reasons: ["invalid"] };
  }
  const envelope: TriggerEnvelope = input.envelope;
  const rejectionReasons: TriggerAdmissionReason[] = [];
  const shadowReasons: TriggerAdmissionReason[] = [];
  const nowMs = input.now.getTime();
  const occurredAtMs = Date.parse(envelope.occurredAt);
  const maxFutureSkewMs = boundedDuration(input.maxFutureSkewMs, 0);

  if (input.seenDedupKeys?.has(envelope.dedupKey)) {
    rejectionReasons.push("duplicate");
  }
  if (occurredAtMs > nowMs + maxFutureSkewMs) {
    rejectionReasons.push("future");
  }
  if (input.maxAgeMs !== undefined
    && nowMs - occurredAtMs > boundedDuration(input.maxAgeMs, 0)) {
    rejectionReasons.push("stale");
  }
  if (input.paused === true) {
    rejectionReasons.push("paused");
  }
  if (input.cooldownUntil && input.cooldownUntil.getTime() > nowMs) {
    rejectionReasons.push("cooldown-active");
  }
  if (rejectionReasons.length > 0) {
    return {
      action: "reject",
      dedupKey: envelope.dedupKey,
      reasons: rejectionReasons
    };
  }

  if (input.focus === "inactive") {
    shadowReasons.push("focus-inactive");
  } else if (input.focus === "unknown") {
    shadowReasons.push("focus-unknown");
  }
  if (input.budgetAvailable === false) {
    shadowReasons.push("budget-exhausted");
  }
  if (input.deliveryBrakeEngaged === true) {
    shadowReasons.push("delivery-brake");
  }
  if (input.shadowOnly === true) {
    shadowReasons.push("shadow-only");
  }
  return shadowReasons.length > 0
    ? { action: "shadow", dedupKey: envelope.dedupKey, reasons: shadowReasons }
    : { action: "execute", dedupKey: envelope.dedupKey, reasons: [] };
}

function boundedDuration(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : fallback;
}
