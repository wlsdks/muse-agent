import type { MessagingRouteResolution } from "@muse/autoconfigure";

import {
  sanitizeMessagingRouteReceipt,
  unavailableMessagingRouteReceipt
} from "./messaging-route-receipt.js";

export type BriefingRuntimeDecision =
  | "startup"
  | "already-running"
  | "quiet-hours"
  | "route-unavailable"
  | "nothing-to-say"
  | "in-window"
  | "delivered"
  | "error";

export type BriefingRuntimePhase = "startup" | "tick";
export type BriefingRuntimeAvailability =
  | "dormant"
  | "observed"
  | "not-configured"
  | "disabled"
  | "blocked";

export interface BriefingRuntimeStatus {
  readonly availability: BriefingRuntimeAvailability;
  readonly lastDecision: BriefingRuntimeDecision;
  readonly lastObservedAtIso: string;
  readonly lastImminentCount: number;
  readonly lastDeliveredCount: number;
  readonly lastErrorCount: number;
  readonly lastRoute: MessagingRouteResolution;
  readonly phase: BriefingRuntimePhase;
}

export interface BriefingRuntimeStatusUpdate {
  readonly availability: BriefingRuntimeAvailability;
  readonly decision: BriefingRuntimeDecision;
  readonly observedAtIso: string;
  readonly imminentCount?: number;
  readonly deliveredCount?: number;
  readonly errorCount?: number;
  readonly lastRoute?: MessagingRouteResolution;
  readonly phase: BriefingRuntimePhase;
}

export interface BriefingRuntimeStatusStore {
  readonly get: () => BriefingRuntimeStatus | null;
  readonly record: (update: BriefingRuntimeStatusUpdate) => void;
}

const MAX_COUNT = 9_999;

export function createBriefingRuntimeStatusStore(): BriefingRuntimeStatusStore {
  let status: BriefingRuntimeStatus | null = null;
  return {
    get: () => status,
    record: (update) => {
      status = {
        availability: update.availability,
        lastDecision: update.decision,
        lastObservedAtIso: update.observedAtIso,
        lastImminentCount: boundedCount(update.imminentCount ?? 0),
        lastDeliveredCount: boundedCount(update.deliveredCount ?? 0),
        lastErrorCount: boundedCount(update.errorCount ?? 0),
        lastRoute: update.lastRoute
          ? sanitizeMessagingRouteReceipt(update.lastRoute)
          : status?.lastRoute ?? unavailableMessagingRouteReceipt(),
        phase: update.phase
      };
    }
  };
}

export function recordBriefingRuntimeStartup(
  runtimeStatus: BriefingRuntimeStatusStore | undefined,
  availability: Exclude<BriefingRuntimeAvailability, "observed">,
  observedAtIso = new Date().toISOString()
): void {
  try {
    runtimeStatus?.record({
      availability,
      decision: "startup",
      lastRoute: unavailableMessagingRouteReceipt(),
      observedAtIso,
      phase: "startup"
    });
  } catch {
  }
}

function boundedCount(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(MAX_COUNT, Math.max(0, Math.trunc(value)));
}
