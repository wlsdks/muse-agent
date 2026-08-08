import type { RunDigestFlushOutcome } from "@muse/proactivity";
import type { MessagingRouteResolution } from "@muse/autoconfigure";

import {
  sanitizeMessagingRouteReceipt,
  unavailableMessagingRouteReceipt
} from "./messaging-route-receipt.js";

export type DigestRuntimeDecision =
  | RunDigestFlushOutcome
  | "already-running"
  | "error"
  | "quiet-hours"
  | "route-unavailable";

export interface DigestRuntimeStatus {
  readonly lastDecision: DigestRuntimeDecision;
  readonly lastErrorCount: number;
  readonly lastItemCount: number;
  readonly lastObservedAtIso: string;
  readonly lastRoute: MessagingRouteResolution;
}

export interface DigestRuntimeStatusUpdate {
  readonly decision: DigestRuntimeDecision;
  readonly errorCount?: number;
  readonly itemCount?: number;
  readonly observedAtIso: string;
  readonly lastRoute?: MessagingRouteResolution;
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
        lastDecision: update.decision,
        lastErrorCount: boundedCount(update.errorCount ?? 0, MAX_ERROR_COUNT),
        lastItemCount: boundedCount(update.itemCount ?? 0, MAX_ITEM_COUNT),
        lastObservedAtIso: update.observedAtIso,
        lastRoute: update.lastRoute
          ? sanitizeMessagingRouteReceipt(update.lastRoute)
          : status?.lastRoute ?? unavailableMessagingRouteReceipt()
      };
    }
  };
}

function boundedCount(value: number, maximum: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(maximum, Math.max(0, Math.trunc(value)));
}
