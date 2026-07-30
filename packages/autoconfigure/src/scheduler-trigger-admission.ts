import type {
  DynamicSchedulerOptions,
  ScheduledTriggerAdmissionTicket,
  ScheduledTriggerSettlement
} from "@muse/scheduler";
import type { FileTriggerAdmissionJournalStore } from "@muse/stores";

export interface ScheduledTriggerAdmissionLifecycleOptions {
  readonly now?: () => Date;
  readonly store: Pick<FileTriggerAdmissionJournalStore, "admit" | "settle">;
}

/**
 * Compose the provider-neutral scheduler lifecycle with durable admission
 * state. The returned settlement capability is scoped to the exact admitted
 * dedup key; a held/duplicate decision cannot settle an older queued entry.
 */
export function createScheduledTriggerAdmissionLifecycle(
  options: ScheduledTriggerAdmissionLifecycleOptions
): NonNullable<DynamicSchedulerOptions["triggerAdmissionLifecycle"]> {
  const now = options.now ?? (() => new Date());
  return async ({ trigger }) => {
    const admission = await options.store.admit({ envelope: trigger, now: now() });
    const dedupKey = admission.decision.dedupKey;
    if (admission.decision.action === "execute" && dedupKey === null) {
      throw new TypeError("execute trigger admission requires a dedup key");
    }

    const ticket: ScheduledTriggerAdmissionTicket = Object.freeze({
      decision: admission.decision,
      settle: async (settlement: ScheduledTriggerSettlement) => {
        if (admission.decision.action !== "execute" || dedupKey === null) {
          throw new TypeError("only execute trigger admissions can be settled");
        }
        await options.store.settle({
          at: settlement.settledAt,
          dedupKey,
          outcome: settlement.outcome,
          ...("reason" in settlement ? { reason: settlement.reason } : {})
        });
      }
    });
    return ticket;
  };
}
