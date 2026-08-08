export type FollowupRuntimeDecision =
  | "not-configured"
  | "already-running"
  | "quiet-hours"
  | "lock-held"
  | "lock-error"
  | "no-due"
  | "fired"
  | "completed"
  | "error";

export interface FollowupRuntimeStatus {
  readonly lastDecision: FollowupRuntimeDecision;
  readonly lastObservedAtIso: string;
  readonly lastDueCount: number;
  readonly lastDeliveredCount: number;
  readonly lastFiredCount: number;
  readonly lastErrorCount: number;
}

export interface FollowupRuntimeStatusUpdate {
  readonly decision: FollowupRuntimeDecision;
  readonly observedAtIso: string;
  readonly dueCount?: number;
  readonly deliveredCount?: number;
  readonly firedCount?: number;
  readonly errorCount?: number;
}

export interface FollowupRuntimeStatusStore {
  readonly get: () => FollowupRuntimeStatus | null;
  readonly record: (update: FollowupRuntimeStatusUpdate) => void;
}

const MAX_COUNT = 9_999;

export function createFollowupRuntimeStatusStore(): FollowupRuntimeStatusStore {
  let status: FollowupRuntimeStatus | null = null;
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

export function recordFollowupRuntimeNotConfigured(runtimeStatus: FollowupRuntimeStatusStore | undefined): void {
  try {
    const observedAt = new Date();
    runtimeStatus?.record({ decision: "not-configured", observedAtIso: observedAt.toISOString() });
  } catch {
  }
}

function boundedCount(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(MAX_COUNT, Math.max(0, Math.trunc(value)));
}
