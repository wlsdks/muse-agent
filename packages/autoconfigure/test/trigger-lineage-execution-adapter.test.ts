import {
  projectTriggerControlLineage,
  TriggerControlLineageProjectionError
} from "@muse/attunement-graph/loop-lineage";
import type { ScheduledJobExecution } from "@muse/scheduler";
import {
  admitTriggerControl,
  createTriggerControlState,
  createTriggerEnvelope
} from "@muse/shared";
import { describe, expect, it } from "vitest";

import { toTriggerSchedulerTerminalReceipt } from "../src/trigger-lineage-execution-adapter.js";

const STARTED_AT = new Date("2026-07-31T00:00:00.000Z");
const COMPLETED_AT = new Date("2026-07-31T00:00:01.000Z");
const trigger = createTriggerEnvelope({
  generation: "adapter-test",
  occurredAt: STARTED_AT,
  receivedAt: STARTED_AT,
  source: "cron",
  sourceId: "daily-brief"
});

function execution(
  overrides: Partial<ScheduledJobExecution> = {}
): ScheduledJobExecution {
  return {
    completedAt: COMPLETED_AT,
    dryRun: false,
    durationMs: 1_000,
    id: "scheduled_execution_adapter",
    jobId: "daily-brief",
    jobName: "Private daily brief title",
    payloadPreview: "private payload preview",
    result: "private result",
    startedAt: STARTED_AT,
    status: "success",
    triggerDedupKey: trigger.dedupKey,
    triggeredBy: "webhook",
    ...overrides
  };
}

describe("trigger lineage execution adapter", () => {
  it.each([
    ["success", false],
    ["failed", false],
    ["skipped", true]
  ] as const)("copies one complete %s terminal record exactly", (status, dryRun) => {
    const receipt = toTriggerSchedulerTerminalReceipt(execution({ dryRun, status }));

    expect(receipt).toEqual({
      completedAt: COMPLETED_AT.toISOString(),
      dryRun,
      executionId: "scheduled_execution_adapter",
      jobId: "daily-brief",
      schemaVersion: 1,
      startedAt: STARTED_AT.toISOString(),
      status,
      triggerDedupKey: trigger.dedupKey
    });
    expect(Object.isFrozen(receipt)).toBe(true);
  });

  it.each([
    { status: "running" as const },
    { completedAt: undefined },
    { triggerDedupKey: undefined }
  ])("does not mint terminal evidence from an incomplete record", (overrides) => {
    expect(toTriggerSchedulerTerminalReceipt(execution(overrides))).toBeUndefined();
  });

  it("strips every non-lineage scheduler field", () => {
    const serialized = JSON.stringify(toTriggerSchedulerTerminalReceipt(execution()));

    expect(serialized).not.toContain("Private daily brief title");
    expect(serialized).not.toContain("private payload preview");
    expect(serialized).not.toContain("private result");
    expect(serialized).not.toContain("webhook");
    expect(serialized).not.toContain("durationMs");
  });

  it("is accepted by exact loop-lineage projection without repairing source data", () => {
    const state = admitTriggerControl(
      createTriggerControlState({ maxPending: 4 }),
      { envelope: trigger, now: STARTED_AT }
    ).state;
    const receipt = toTriggerSchedulerTerminalReceipt(execution());

    expect(projectTriggerControlLineage({
      execution: receipt,
      scope: {
        dedupKey: trigger.dedupKey,
        sourceId: "scheduler-control"
      },
      state
    }).assertions.some((assertion) =>
      assertion.predicate === "CORRELATES_WITH")).toBe(true);

    const malformed = toTriggerSchedulerTerminalReceipt(execution({
      triggerDedupKey: "trigger:invalid"
    }));
    expect(() => projectTriggerControlLineage({
      execution: malformed,
      scope: {
        dedupKey: trigger.dedupKey,
        sourceId: "scheduler-control"
      },
      state
    })).toThrow(TriggerControlLineageProjectionError);
  });
});
