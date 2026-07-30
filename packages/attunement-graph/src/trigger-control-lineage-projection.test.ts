import { createHash } from "node:crypto";

import {
  admitTriggerControl,
  cancelTriggerControlWork,
  claimTriggerControlWork,
  createTriggerControlState,
  createTriggerEnvelope,
  settleTriggerControlWork,
  type TriggerControlState
} from "@muse/shared";
import { describe, expect, it } from "vitest";

import {
  TRIGGER_CONTROL_LINEAGE_PROJECTION_RULE_VERSION,
  TRIGGER_CONTROL_LINEAGE_SOURCE_NAMESPACES,
  TriggerControlLineageProjectionError,
  projectTriggerControlLineage,
  type TriggerSchedulerTerminalReceipt
} from "./trigger-control-lineage-projection.js";

const T0 = new Date("2026-07-31T00:00:00.000Z");
const T1 = new Date("2026-07-31T00:00:01.000Z");
const T2 = new Date("2026-07-31T00:00:02.000Z");
const SOURCE_ID = "scheduler-control";

function envelope(
  generation: string,
  payload: { readonly privateValue: string } = {
    privateValue: "private-payload"
  }
) {
  return createTriggerEnvelope({
    generation,
    occurredAt: T0,
    payload,
    receivedAt: T0,
    source: "cron",
    sourceId: "daily-brief"
  });
}

function admitted(
  generation: string,
  options: {
    readonly permission?: "denied" | "granted";
    readonly quietHoursActive?: boolean;
  } = {}
): TriggerControlState {
  return admitTriggerControl(
    createTriggerControlState({ maxEntries: 8, maxPending: 4 }),
    {
      envelope: envelope(generation),
      now: T0,
      ...options
    }
  ).state;
}

function legacyReminderEnvelope(generation: string) {
  const sourceId = "legacy-reminder";
  const current = createTriggerEnvelope({
    generation,
    occurredAt: T0,
    receivedAt: T0,
    source: "reminder",
    sourceId
  });
  return {
    ...current,
    dedupKey: `reminder:${createHash("sha256")
      .update(JSON.stringify([sourceId, generation]))
      .digest("hex")}`
  };
}

function claimed(generation: string): TriggerControlState {
  return claimTriggerControlWork(admitted(generation), {
    at: T1,
    dedupKey: envelope(generation).dedupKey,
    leaseDurationMs: 10_000,
    leaseToken: `lease-${generation}`,
    maxAttempts: 2
  });
}

function completed(generation = "completed"): TriggerControlState {
  return settleTriggerControlWork(claimed(generation), {
    at: T2,
    dedupKey: envelope(generation).dedupKey,
    leaseToken: `lease-${generation}`,
    outcome: "succeeded"
  });
}

function deadLettered(
  generation = "dead",
  reason = "private-terminal-reason"
): TriggerControlState {
  return settleTriggerControlWork(claimed(generation), {
    at: T2,
    dedupKey: envelope(generation).dedupKey,
    leaseToken: `lease-${generation}`,
    outcome: "failed",
    reason,
    retryable: false
  });
}

function cancelled(generation = "cancelled"): TriggerControlState {
  return cancelTriggerControlWork(claimed(generation), {
    at: T2,
    dedupKey: envelope(generation).dedupKey,
    leaseToken: `lease-${generation}`,
    reason: "owner-cancelled-private"
  });
}

function project(
  state: TriggerControlState,
  generation: string,
  execution?: TriggerSchedulerTerminalReceipt
) {
  return projectTriggerControlLineage({
    ...(execution ? { execution } : {}),
    scope: {
      dedupKey: envelope(generation).dedupKey,
      sourceId: SOURCE_ID
    },
    state
  });
}

function executionReceipt(
  generation: string,
  overrides: Partial<TriggerSchedulerTerminalReceipt> = {}
): TriggerSchedulerTerminalReceipt {
  return {
    completedAt: T2.toISOString(),
    dryRun: false,
    executionId: `scheduled_execution_${generation}`,
    jobId: "daily-brief",
    schemaVersion: 1,
    startedAt: T1.toISOString(),
    status: "success",
    triggerDedupKey: envelope(generation).dedupKey,
    ...overrides
  };
}

function assertDeepFrozen(value: unknown, seen = new WeakSet<object>()): void {
  if (value === null || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  expect(Object.isFrozen(value)).toBe(true);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    expect(descriptor && "value" in descriptor).toBe(true);
    if (descriptor && "value" in descriptor) {
      assertDeepFrozen(descriptor.value, seen);
    }
  }
}

function terminalEvidenceId(state: TriggerControlState, generation: string) {
  const projection = project(state, generation);
  return projection.assertions.find((assertion) =>
    assertion.subject.kind === "action"
    && assertion.object.kind === "evidence")?.object.id;
}

describe("trigger control lineage projection", () => {
  it("projects one completed occurrence as bounded exact lifecycle evidence", () => {
    const projection = project(completed(), "completed");

    expect(projection).toMatchObject({
      ruleVersion: TRIGGER_CONTROL_LINEAGE_PROJECTION_RULE_VERSION,
      schemaVersion: 1,
      scope: {
        dedupKey: envelope("completed").dedupKey,
        sourceId: SOURCE_ID
      }
    });
    expect(projection.assertions).toHaveLength(3);
    expect(projection.assertions.map((assertion) => assertion.predicate))
      .toEqual(["PRECEDED", "PRECEDED", "PRECEDED"]);
    expect(projection.assertions.every((assertion) =>
      assertion.epistemicClass === "source-observed"
      && assertion.derivation.kind === "projection"
      && assertion.derivation.version
        === TRIGGER_CONTROL_LINEAGE_PROJECTION_RULE_VERSION
    )).toBe(true);
    expect(projection.assertions.flatMap((assertion) =>
      assertion.sourceRefs.map((sourceRef) => sourceRef.namespace)))
      .toEqual(expect.arrayContaining([
        TRIGGER_CONTROL_LINEAGE_SOURCE_NAMESPACES.admission,
        TRIGGER_CONTROL_LINEAGE_SOURCE_NAMESPACES.work
      ]));
    expect(projection.sourceVersion).toMatch(/^sha256:[0-9a-f]{64}$/u);
    assertDeepFrozen(projection);
  });

  it("correlates one exact scheduler terminal receipt without claiming an agent run or outcome", () => {
    const receipt = executionReceipt("execution");
    const projection = project(completed("execution"), "execution", receipt);
    const correlation = projection.assertions.find((assertion) =>
      assertion.predicate === "CORRELATES_WITH");

    expect(projection.assertions).toHaveLength(4);
    expect(correlation).toMatchObject({
      epistemicClass: "source-observed",
      object: { kind: "evidence" },
      recordedAt: receipt.completedAt,
      subject: { kind: "evidence" }
    });
    expect(correlation?.sourceRefs.map((sourceRef) => sourceRef.namespace))
      .toEqual(expect.arrayContaining([
        TRIGGER_CONTROL_LINEAGE_SOURCE_NAMESPACES.admission,
        TRIGGER_CONTROL_LINEAGE_SOURCE_NAMESPACES.execution
      ]));
    expect(new Set(projection.assertions.map((assertion) => assertion.predicate)))
      .toEqual(new Set(["CORRELATES_WITH", "PRECEDED"]));
    expect(JSON.stringify(projection)).not.toContain(receipt.executionId);
    expect(JSON.stringify(projection)).not.toContain(receipt.jobId);
    assertDeepFrozen(projection);
  });

  it("records skipped rejection evidence without inventing work", () => {
    const projection = project(
      admitted("rejected-record", { permission: "denied" }),
      "rejected-record",
      executionReceipt("rejected-record", { status: "skipped" })
    );

    expect(projection.assertions).toHaveLength(2);
    expect(projection.assertions.some((assertion) =>
      assertion.predicate === "CORRELATES_WITH")).toBe(true);
    expect(projection.assertions.some((assertion) =>
      assertion.subject.kind === "action"
      || assertion.object.kind === "action"
    )).toBe(false);
  });

  it("accepts an exact legacy reminder occurrence key", () => {
    const reminder = legacyReminderEnvelope("legacy");
    const state = admitTriggerControl(
      createTriggerControlState({ maxEntries: 8, maxPending: 4 }),
      { envelope: reminder, now: T0 }
    ).state;
    const projection = projectTriggerControlLineage({
      execution: {
        completedAt: T2.toISOString(),
        dryRun: false,
        executionId: "scheduled_execution_legacy",
        jobId: "legacy-reminder",
        schemaVersion: 1,
        startedAt: T1.toISOString(),
        status: "success",
        triggerDedupKey: reminder.dedupKey
      },
      scope: {
        dedupKey: reminder.dedupKey,
        sourceId: SOURCE_ID
      },
      state
    });

    expect(projection.assertions.some((assertion) =>
      assertion.predicate === "CORRELATES_WITH")).toBe(true);
  });

  it.each([
    ["rejected", { permission: "denied" as const }],
    ["shadowed", { quietHoursActive: true }]
  ])("does not invent work for a %s admission", (generation, options) => {
    const projection = project(admitted(generation, options), generation);

    expect(projection.assertions).toHaveLength(1);
    expect(projection.assertions[0]).toMatchObject({
      subject: { kind: "evidence" },
      predicate: "PRECEDED",
      object: { kind: "decision" }
    });
    expect(projection.assertions.some((assertion) =>
      assertion.subject.kind === "action"
      || assertion.object.kind === "action"
    )).toBe(false);
  });

  it("represents active work without inventing a terminal", () => {
    const projection = project(claimed("leased"), "leased");

    expect(projection.assertions).toHaveLength(2);
    expect(projection.assertions.some((assertion) =>
      assertion.subject.kind === "action"
      && assertion.object.kind === "evidence"
    )).toBe(false);
  });

  it("keeps completed, cancelled, and dead-lettered terminals distinct", () => {
    const completedId = terminalEvidenceId(completed("terminal"), "terminal");
    const cancelledId = terminalEvidenceId(cancelled("terminal"), "terminal");
    const deadLetteredId = terminalEvidenceId(
      deadLettered("terminal"),
      "terminal"
    );

    expect(completedId).toBeDefined();
    expect(new Set([completedId, cancelledId, deadLetteredId]).size).toBe(3);
  });

  it("never upgrades control facts into authority, performance, or outcomes", () => {
    const forbidden = new Set([
      "AUTHORIZED_BY",
      "PERFORMED",
      "PRODUCED_OUTCOME",
      "PROPOSES_POLICY"
    ]);

    expect(project(
      deadLettered(),
      "dead",
      executionReceipt("dead", { status: "failed" })
    ).assertions.some((assertion) =>
      forbidden.has(assertion.predicate))).toBe(false);
  });

  it("hides payload and terminal reason while content-binding exact sources", () => {
    const first = project(deadLettered("private", "first-private-reason"), "private");
    const second = project(deadLettered("private", "second-private-reason"), "private");
    const serialized = JSON.stringify(first);

    expect(serialized).not.toContain("private-payload");
    expect(serialized).not.toContain("first-private-reason");
    expect(first.sourceVersion).not.toBe(second.sourceVersion);
    expect(first.assertions.map((assertion) => assertion.id))
      .not.toEqual(second.assertions.map((assertion) => assertion.id));
  });

  it("replays deterministically with sorted assertions", () => {
    const receipt = executionReceipt("replay", { dryRun: true });
    const first = project(completed("replay"), "replay", receipt);
    const second = project(completed("replay"), "replay", receipt);

    expect(second).toEqual(first);
    expect(first.assertions.map((assertion) => assertion.id)).toEqual(
      [...first.assertions]
        .map((assertion) => assertion.id)
        .sort((left, right) => left.localeCompare(right))
    );
  });

  it("content-binds terminal status while keeping statuses semantically opaque", () => {
    const success = project(
      completed("status"),
      "status",
      executionReceipt("status", { status: "success" })
    );
    const failed = project(
      completed("status"),
      "status",
      executionReceipt("status", { status: "failed" })
    );
    const skipped = project(
      completed("status"),
      "status",
      executionReceipt("status", { dryRun: true, status: "skipped" })
    );
    const dryRunSuccess = project(
      completed("status"),
      "status",
      executionReceipt("status", { dryRun: true, status: "success" })
    );

    expect(new Set([
      success.sourceVersion,
      failed.sourceVersion,
      skipped.sourceVersion,
      dryRunSuccess.sourceVersion
    ]).size).toBe(4);
    expect(new Set([success, failed, skipped, dryRunSuccess].map((projection) =>
      projection.assertions.find((assertion) =>
        assertion.predicate === "CORRELATES_WITH")?.id
    )).size).toBe(4);
  });

  it("fails closed on mismatched, malformed, or expanded scheduler receipts", () => {
    const state = completed("receipt-invalid");
    const base = executionReceipt("receipt-invalid");

    expect(() => project(
      state,
      "receipt-invalid",
      { ...base, triggerDedupKey: envelope("other").dedupKey }
    )).toThrow(expect.objectContaining({ code: "SCOPE_NOT_FOUND" }));
    expect(() => project(
      state,
      "receipt-invalid",
      { ...base, completedAt: "not-an-instant" }
    )).toThrow(expect.objectContaining({ code: "INVALID_SOURCE" }));
    expect(() => project(
      state,
      "receipt-invalid",
      { ...base, completedAt: T0.toISOString() }
    )).toThrow(expect.objectContaining({ code: "INVALID_SOURCE" }));
    expect(() => project(
      state,
      "receipt-invalid",
      {
        ...base,
        payload: "private-payload"
      } as unknown as TriggerSchedulerTerminalReceipt
    )).toThrow(expect.objectContaining({ code: "INVALID_SOURCE" }));
  });

  it("fails closed on tampered state or an unknown occurrence", () => {
    const state = completed("tampered");
    const serialized = JSON.parse(JSON.stringify(state)) as {
      stateId: string;
      workStates: Array<{ terminalReason?: string }>;
    };
    serialized.stateId = "trigger-control:tampered";

    expect(() => projectTriggerControlLineage({
      scope: {
        dedupKey: envelope("tampered").dedupKey,
        sourceId: SOURCE_ID
      },
      state: serialized
    })).toThrow(TriggerControlLineageProjectionError);

    expect(() => projectTriggerControlLineage({
      scope: {
        dedupKey: envelope("missing").dedupKey,
        sourceId: SOURCE_ID
      },
      state
    })).toThrow(expect.objectContaining({ code: "SCOPE_NOT_FOUND" }));
  });
});
