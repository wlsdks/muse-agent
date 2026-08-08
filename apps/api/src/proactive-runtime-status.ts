export type ProactiveRuntimeDecision =
  | "already-running"
  | "quiet-hours"
  | "route-unavailable"
  | "session-locked"
  | "lock-held"
  | "lock-error"
  | "no-imminent"
  | "suppressed"
  | "fired"
  | "completed"
  | "error";

export interface ProactiveRuntimeStatus {
  readonly lastDecision: ProactiveRuntimeDecision;
  readonly lastObservedAtIso: string;
  readonly lastImminentCount: number;
  readonly lastFiredCount: number;
  readonly lastSuppressedCount: number;
  readonly lastErrorCount: number;
  readonly sessionLockedUntilIso?: string;
}

export interface ProactiveRuntimeStatusUpdate {
  readonly decision: ProactiveRuntimeDecision;
  readonly observedAtIso: string;
  readonly imminentCount?: number;
  readonly firedCount?: number;
  readonly suppressedCount?: number;
  readonly errorCount?: number;
  readonly sessionLockedUntilIso?: string;
}

export interface ProactiveRuntimeStatusStore {
  readonly get: () => ProactiveRuntimeStatus | null;
  readonly record: (update: ProactiveRuntimeStatusUpdate) => void;
}

const MAX_COUNT = 9_999;

export function createProactiveRuntimeStatusStore(): ProactiveRuntimeStatusStore {
  let status: ProactiveRuntimeStatus | null = null;
  return {
    get: () => status,
    record: (update) => {
      status = {
        lastDecision: update.decision,
        lastObservedAtIso: update.observedAtIso,
        lastImminentCount: boundedCount(update.imminentCount ?? 0),
        lastFiredCount: boundedCount(update.firedCount ?? 0),
        lastSuppressedCount: boundedCount(update.suppressedCount ?? 0),
        lastErrorCount: boundedCount(update.errorCount ?? 0),
        ...(update.sessionLockedUntilIso ? { sessionLockedUntilIso: update.sessionLockedUntilIso } : {})
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
