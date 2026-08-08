export type PatternRuntimeDecision =
  | "not-configured"
  | "already-running"
  | "quiet-hours"
  | "lock-held"
  | "lock-error"
  | "no-fireable"
  | "fired"
  | "completed"
  | "error";

export interface PatternRuntimeStatus {
  readonly lastDecision: PatternRuntimeDecision;
  readonly lastObservedAtIso: string;
  readonly lastFireableCount: number;
  readonly lastDeliveredCount: number;
  readonly lastFiredCount: number;
  readonly lastErrorCount: number;
}

export interface PatternRuntimeStatusUpdate {
  readonly decision: PatternRuntimeDecision;
  readonly observedAtIso: string;
  readonly fireableCount?: number;
  readonly deliveredCount?: number;
  readonly firedCount?: number;
  readonly errorCount?: number;
}

export interface PatternRuntimeStatusStore {
  readonly get: () => PatternRuntimeStatus | null;
  readonly record: (update: PatternRuntimeStatusUpdate) => void;
}

const MAX_COUNT = 9_999;

export function createPatternRuntimeStatusStore(): PatternRuntimeStatusStore {
  let status: PatternRuntimeStatus | null = null;
  return {
    get: () => status,
    record: (update) => {
      status = {
        lastDecision: update.decision,
        lastObservedAtIso: update.observedAtIso,
        lastFireableCount: boundedCount(update.fireableCount ?? 0),
        lastDeliveredCount: boundedCount(update.deliveredCount ?? 0),
        lastFiredCount: boundedCount(update.firedCount ?? 0),
        lastErrorCount: boundedCount(update.errorCount ?? 0)
      };
    }
  };
}

export function recordPatternRuntimeNotConfigured(runtimeStatus: PatternRuntimeStatusStore | undefined): void {
  try {
    runtimeStatus?.record({ decision: "not-configured", observedAtIso: new Date().toISOString() });
  } catch {
  }
}

function boundedCount(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(MAX_COUNT, Math.max(0, Math.trunc(value)));
}
