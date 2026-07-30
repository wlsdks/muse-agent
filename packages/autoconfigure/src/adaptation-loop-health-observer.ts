import {
  projectVerifiedExperienceLearningPromotionHealth,
  type ExperienceLearningPromotionReceipt
} from "@muse/attunement";
import type { AdaptationLoopHealthInput } from "@muse/shared";

export interface LatestAdaptationLoopHealthObserver {
  observe(receipt: unknown): void;
  snapshot(): AdaptationLoopHealthInput | undefined;
}

/**
 * Keeps only the latest fully recomputed adaptation promotion projection.
 * It grants no mutation authority and equal timestamps settle independently
 * of callback arrival order.
 */
export function createLatestAdaptationLoopHealthObserver(): LatestAdaptationLoopHealthObserver {
  let latest: {
    readonly appliedAtMs: number;
    readonly evidenceId: string;
    readonly health: AdaptationLoopHealthInput;
  } | undefined;

  return Object.freeze({
    observe(value: unknown): void {
      const health = projectVerifiedExperienceLearningPromotionHealth(value);
      if (!health) return;
      const receipt = value as ExperienceLearningPromotionReceipt;
      const appliedAtMs = Date.parse(receipt.appliedAt);
      const evidenceId = health.evidenceId ?? "";
      if (!latest
        || appliedAtMs > latest.appliedAtMs
        || (appliedAtMs === latest.appliedAtMs && evidenceId > latest.evidenceId)) {
        latest = Object.freeze({ appliedAtMs, evidenceId, health });
      }
    },
    snapshot(): AdaptationLoopHealthInput | undefined {
      return latest?.health;
    }
  });
}
