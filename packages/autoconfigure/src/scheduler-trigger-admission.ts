import { randomUUID } from "node:crypto";

import type {
  DynamicSchedulerOptions,
  ScheduledTriggerAdmissionTicket,
  ScheduledTriggerSettlement,
  TriggerControlFileStore
} from "@muse/scheduler";

export interface ScheduledTriggerAdmissionLifecycleOptions {
  readonly leaseToken?: () => string;
  readonly now?: () => Date;
  readonly store: Pick<
    TriggerControlFileStore,
    "admit" | "cancel" | "claim" | "settle"
  >;
}

/**
 * Compose the provider-neutral scheduler lifecycle with durable admission
 * state. The returned settlement capability is scoped to the exact admitted
 * dedup key; a held/duplicate decision cannot settle an older queued entry.
 */
export function createScheduledTriggerAdmissionLifecycle(
  options: ScheduledTriggerAdmissionLifecycleOptions
): NonNullable<DynamicSchedulerOptions["triggerAdmissionLifecycle"]> {
  const leaseToken = options.leaseToken ?? randomUUID;
  const now = options.now ?? (() => new Date());
  return async ({ leaseDurationMs, trigger }) => {
    const admission = await options.store.admit({ envelope: trigger, now: now() });
    const dedupKey = admission.decision.dedupKey;
    if (admission.decision.action === "execute" && dedupKey === null) {
      throw new TypeError("execute trigger admission requires a dedup key");
    }
    let claim: Readonly<{ dedupKey: string; leaseToken: string }> | undefined;
    if (admission.decision.action === "execute" && dedupKey !== null) {
      const claimedLeaseToken = leaseToken();
      await options.store.claim({
        at: now(),
        dedupKey,
        leaseDurationMs,
        leaseToken: claimedLeaseToken,
        maxAttempts: 1
      });
      claim = Object.freeze({ dedupKey, leaseToken: claimedLeaseToken });
    }

    const ticket: ScheduledTriggerAdmissionTicket = Object.freeze({
      decision: admission.decision,
      settle: async (settlement: ScheduledTriggerSettlement) => {
        if (admission.decision.action !== "execute" || claim === undefined) {
          throw new TypeError("only execute trigger admissions can be settled");
        }
        if (settlement.outcome === "completed") {
          await options.store.settle({
            at: settlement.settledAt,
            dedupKey: claim.dedupKey,
            leaseToken: claim.leaseToken,
            outcome: "succeeded"
          });
          return;
        }
        if (settlement.outcome === "dead-lettered") {
          await options.store.settle({
            at: settlement.settledAt,
            dedupKey: claim.dedupKey,
            leaseToken: claim.leaseToken,
            outcome: "failed",
            reason: settlement.reason,
            retryable: false
          });
          return;
        }
        await options.store.cancel({
          at: settlement.settledAt,
          dedupKey: claim.dedupKey,
          leaseToken: claim.leaseToken,
          reason: settlement.reason
        });
      }
    });
    return ticket;
  };
}
