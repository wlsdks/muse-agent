export type ReminderRuntimeDecision =
  | "not-configured"
  | "already-running"
  | "quiet-hours"
  | "lock-held"
  | "lock-error"
  | "no-due"
  | "fired"
  | "completed"
  | "error";

export interface ReminderRuntimeStatus {
  readonly lastDecision: ReminderRuntimeDecision;
  readonly lastObservedAtIso: string;
  readonly lastDueCount: number;
  readonly lastDeliveredCount: number;
  readonly lastFiredCount: number;
  readonly lastErrorCount: number;
}

export interface ReminderRuntimeStatusUpdate {
  readonly decision: ReminderRuntimeDecision;
  readonly observedAtIso: string;
  readonly dueCount?: number;
  readonly deliveredCount?: number;
  readonly firedCount?: number;
  readonly errorCount?: number;
}

export interface ReminderRuntimeStatusStore {
  readonly get: () => ReminderRuntimeStatus | null;
  readonly record: (update: ReminderRuntimeStatusUpdate) => void;
}

const MAX_COUNT = 9_999;

export function createReminderRuntimeStatusStore(): ReminderRuntimeStatusStore {
  let status: ReminderRuntimeStatus | null = null;
  return {
    get: () => status,
    record: (update) => {
      status = {
        lastDecision: update.decision,
        lastObservedAtIso: update.observedAtIso,
        lastDueCount: boundedCount(update.dueCount ?? 0),
        lastDeliveredCount: boundedCount(update.deliveredCount ?? 0),
        lastFiredCount: boundedCount(update.firedCount ?? 0),
        lastErrorCount: boundedCount(update.errorCount ?? 0)
      };
    }
  };
}

function boundedCount(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(MAX_COUNT, Math.max(0, Math.trunc(value)));
}
