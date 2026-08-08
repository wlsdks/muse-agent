import type { RunDigestFlushOutcome } from "@muse/proactivity";
import type { MessagingRouteResolution } from "@muse/autoconfigure";

import {
  sanitizeMessagingRouteReceipt,
  unavailableMessagingRouteReceipt
} from "./messaging-route-receipt.js";

export type DigestRuntimeDecision =
  | "startup"
  | RunDigestFlushOutcome
  | "already-running"
  | "error"
  | "quiet-hours"
  | "route-unavailable";

export type DigestRuntimePhase = "startup" | "tick";
export type DigestRuntimeAvailability =
  | "dormant"
  | "observed"
  | "not-configured"
  | "disabled"
  | "blocked";

export interface DigestRuntimeStatus {
  readonly availability: DigestRuntimeAvailability;
  readonly lastDecision: DigestRuntimeDecision;
  readonly lastErrorCount: number;
  readonly lastItemCount: number;
  readonly lastObservedAtIso: string;
  readonly lastRoute: MessagingRouteResolution;
  readonly phase: DigestRuntimePhase;
}

export interface DigestRuntimeStatusUpdate {
  readonly availability: DigestRuntimeAvailability;
  readonly decision: DigestRuntimeDecision;
  readonly errorCount?: number;
  readonly itemCount?: number;
  readonly observedAtIso: string;
  readonly lastRoute?: MessagingRouteResolution;
  readonly phase: DigestRuntimePhase;
}

export interface DigestRuntimeStatusStore {
  readonly get: () => DigestRuntimeStatus | null;
  readonly record: (update: DigestRuntimeStatusUpdate) => void;
}

const MAX_ERROR_COUNT = 9;
const MAX_ITEM_COUNT = 9_999;

export function createDigestRuntimeStatusStore(): DigestRuntimeStatusStore {
  let status: DigestRuntimeStatus | null = null;
  return {
    get: () => status,
    record: (update) => {
      status = {
        availability: update.availability,
        lastDecision: update.decision,
        lastErrorCount: boundedCount(update.errorCount ?? 0, MAX_ERROR_COUNT),
        lastItemCount: boundedCount(update.itemCount ?? 0, MAX_ITEM_COUNT),
        lastObservedAtIso: update.observedAtIso,
        lastRoute: update.lastRoute
          ? sanitizeMessagingRouteReceipt(update.lastRoute)
          : status?.lastRoute ?? unavailableMessagingRouteReceipt(),
        phase: update.phase
      };
    }
  };
}

export function recordDigestRuntimeStartup(
  runtimeStatus: DigestRuntimeStatusStore | undefined,
  availability: Exclude<DigestRuntimeAvailability, "observed">,
  observedAtIso = new Date().toISOString(),
  lastRoute?: MessagingRouteResolution
): void {
  try {
    runtimeStatus?.record({
      availability,
      decision: "startup",
      lastRoute: lastRoute ?? unavailableMessagingRouteReceipt(),
      observedAtIso,
      phase: "startup"
    });
  } catch {
  }
}

function boundedCount(value: number, maximum: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(maximum, Math.max(0, Math.trunc(value)));
}
