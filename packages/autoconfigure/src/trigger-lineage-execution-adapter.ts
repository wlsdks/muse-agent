import type { TriggerSchedulerTerminalReceipt } from "@muse/attunegraph/loop-lineage";
import type { ScheduledJobExecution } from "@muse/scheduler";

/**
 * Reduces an authoritative scheduler execution record to the exact,
 * data-minimized receipt accepted by loop-lineage projection.
 *
 * This adapter does not validate, persist, or project the receipt. The public
 * projector remains the fail-closed validation boundary.
 */
export function toTriggerSchedulerTerminalReceipt(
  execution: ScheduledJobExecution
): TriggerSchedulerTerminalReceipt | undefined {
  if (
    execution.status === "running"
    || execution.triggerDedupKey === undefined
    || execution.completedAt === undefined
  ) {
    return undefined;
  }
  return Object.freeze({
    completedAt: execution.completedAt.toISOString(),
    dryRun: execution.dryRun,
    executionId: execution.id,
    jobId: execution.jobId,
    schemaVersion: 1 as const,
    startedAt: execution.startedAt.toISOString(),
    status: execution.status,
    triggerDedupKey: execution.triggerDedupKey
  });
}
