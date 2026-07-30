import { describe, expect, it } from "vitest";

import {
  admitTriggerToJournal,
  cancelTriggerWork,
  claimTriggerWork,
  createLoopSupervisorHealthSnapshot,
  createTriggerAdmissionJournal,
  createTriggerEnvelope,
  settleTriggerAdmission,
  settleTriggerWork
} from "../src/index.js";

const NOW = new Date("2026-07-30T12:00:00.000Z");

function agent(overrides: Record<string, unknown> = {}) {
  return {
    endedAt: NOW.toISOString(),
    terminalReason: "goal-verified",
    terminalStatus: "completed" as const,
    verificationEvidenceId: "eval:1",
    verificationStatus: "passed" as const,
    ...overrides
  };
}

function journal(generation = "g1") {
  const envelope = createTriggerEnvelope({
    generation,
    occurredAt: NOW,
    receivedAt: NOW,
    source: "cron",
    sourceId: "daily-brief"
  });
  return admitTriggerToJournal(createTriggerAdmissionJournal({ maxPending: 2 }), {
    envelope,
    now: NOW
  }).journal;
}

describe("createLoopSupervisorHealthSnapshot", () => {
  it("reports healthy only when every loop has current valid evidence", () => {
    const snapshot = createLoopSupervisorHealthSnapshot({
      adaptation: { evidenceId: "promotion:1", evidenceVerified: true, status: "promoted" },
      agent: agent(),
      event: { journal: createTriggerAdmissionJournal({ maxPending: 1 }), workStates: [] },
      generatedAt: NOW
    });
    expect(snapshot).toMatchObject({
      adaptation: { level: "healthy" },
      agent: { level: "healthy" },
      event: { level: "healthy" },
      level: "healthy",
      reasons: []
    });
  });

  it("never treats pending or failed verification as healthy", () => {
    expect(createLoopSupervisorHealthSnapshot({
      agent: agent({
        terminalReason: "verification-pending",
        terminalStatus: "held",
        verificationEvidenceId: undefined,
        verificationStatus: "pending"
      }),
      generatedAt: NOW
    })).toMatchObject({
      agent: { level: "degraded", reasons: ["agent-verification-pending"] },
      level: "degraded"
    });
    expect(createLoopSupervisorHealthSnapshot({
      agent: agent({
        terminalReason: "verification-failed",
        terminalStatus: "failed",
        verificationStatus: "failed"
      }),
      generatedAt: NOW
    })).toMatchObject({
      agent: { level: "blocked", reasons: ["agent-verification-failed"] },
      level: "blocked"
    });
  });

  it("blocks an impossible unverified completion", () => {
    expect(createLoopSupervisorHealthSnapshot({
      agent: agent({
        terminalReason: "goal-verified",
        terminalStatus: "completed",
        verificationEvidenceId: undefined,
        verificationStatus: "pending"
      }),
      generatedAt: NOW
    })).toMatchObject({
      agent: { level: "blocked", reasons: ["agent-completion-unverified"] },
      level: "blocked"
    });
  });

  it("does not call a not-required verification healthy", () => {
    expect(createLoopSupervisorHealthSnapshot({
      agent: agent({
        verificationEvidenceId: undefined,
        verificationStatus: "not-required"
      }),
      generatedAt: NOW
    })).toMatchObject({
      agent: {
        level: "degraded",
        reasons: ["agent-verification-not-required"]
      },
      level: "degraded"
    });
  });

  it("degrades queued admissions that have no recoverable work state", () => {
    expect(createLoopSupervisorHealthSnapshot({
      event: { journal: journal(), workStates: [] },
      generatedAt: NOW
    })).toMatchObject({
      event: {
        counts: { queued: 1 },
        level: "degraded",
        reasons: ["event-work-state-missing"]
      },
      level: "degraded"
    });
  });

  it("surfaces dead letters, expired leases, and backpressure", () => {
    const admitted = journal();
    const leased = claimTriggerWork(admitted, {
      at: NOW,
      dedupKey: admitted.entries[0]!.envelope.dedupKey,
      leaseDurationMs: 1_000,
      leaseToken: "worker-a:1",
      maxAttempts: 1
    });
    const deadWork = settleTriggerWork(leased, {
      at: new Date("2026-07-30T12:00:00.500Z"),
      leaseToken: "worker-a:1",
      outcome: "failed",
      reason: "invalid",
      retryable: false
    });
    const deadJournal = settleTriggerAdmission(admitted, {
      at: new Date("2026-07-30T12:00:00.500Z"),
      dedupKey: deadWork.dedupKey,
      outcome: "dead-lettered",
      reason: "invalid"
    });
    expect(createLoopSupervisorHealthSnapshot({
      event: { journal: deadJournal, workStates: [deadWork] },
      generatedAt: new Date("2026-07-30T12:00:00.500Z")
    })).toMatchObject({
      event: {
        counts: { deadLettered: 1 },
        level: "blocked",
        reasons: ["event-dead-lettered"]
      },
      level: "blocked"
    });

    expect(createLoopSupervisorHealthSnapshot({
      event: { journal: admitted, workStates: [leased] },
      generatedAt: new Date("2026-07-30T12:00:01.000Z")
    })).toMatchObject({
      event: { level: "degraded", reasons: ["event-lease-expired"] }
    });

    const completedButUnsettled = settleTriggerWork(leased, {
      at: new Date("2026-07-30T12:00:00.500Z"),
      leaseToken: "worker-a:1",
      outcome: "succeeded"
    });
    expect(createLoopSupervisorHealthSnapshot({
      event: { journal: admitted, workStates: [completedButUnsettled] },
      generatedAt: new Date("2026-07-30T12:00:00.500Z")
    })).toMatchObject({
      event: {
        level: "degraded",
        reasons: ["event-settlement-pending"]
      }
    });

    const first = admitTriggerToJournal(
      createTriggerAdmissionJournal({ maxEntries: 2, maxPending: 1 }),
      {
        envelope: createTriggerEnvelope({
          generation: "g1",
          occurredAt: NOW,
          receivedAt: NOW,
          source: "cron",
          sourceId: "capacity"
        }),
        now: NOW
      }
    ).journal;
    const pressured = admitTriggerToJournal(first, {
      envelope: createTriggerEnvelope({
        generation: "g2",
        occurredAt: NOW,
        receivedAt: NOW,
        source: "cron",
        sourceId: "capacity"
      }),
      now: NOW
    }).journal;
    expect(createLoopSupervisorHealthSnapshot({
      event: { journal: pressured, workStates: [] },
      generatedAt: NOW
    })).toMatchObject({
      event: {
        level: "degraded",
        reasons: ["event-backpressure", "event-work-state-missing"]
      }
    });
  });

  it("requires evidence before adaptation promotion can be green", () => {
    expect(createLoopSupervisorHealthSnapshot({
      adaptation: { status: "promoted" },
      generatedAt: NOW
    })).toMatchObject({
      adaptation: {
        level: "blocked",
        reasons: ["adaptation-promotion-unverified"]
      },
      level: "blocked"
    });
    expect(createLoopSupervisorHealthSnapshot({
      adaptation: {
        evidenceId: "promotion:unverified",
        evidenceVerified: false,
        status: "promoted"
      },
      generatedAt: NOW
    })).toMatchObject({
      adaptation: {
        level: "blocked",
        reasons: ["adaptation-promotion-unverified"]
      }
    });
  });

  it("counts one cancellation identity once across journal and worker state", () => {
    const admitted = journal("cancelled");
    const leased = claimTriggerWork(admitted, {
      at: NOW,
      dedupKey: admitted.entries[0]!.envelope.dedupKey,
      leaseDurationMs: 1_000,
      leaseToken: "worker-a:1",
      maxAttempts: 1
    });
    const cancelledWork = cancelTriggerWork(leased, {
      at: new Date("2026-07-30T12:00:00.250Z"),
      reason: "owner-stop"
    });
    const cancelledJournal = settleTriggerAdmission(admitted, {
      at: new Date("2026-07-30T12:00:00.250Z"),
      dedupKey: admitted.entries[0]!.envelope.dedupKey,
      outcome: "cancelled",
      reason: "owner-stop"
    });
    expect(createLoopSupervisorHealthSnapshot({
      event: {
        journal: cancelledJournal,
        workStates: [cancelledWork]
      },
      generatedAt: new Date("2026-07-30T12:00:00.250Z")
    })).toMatchObject({
      event: {
        counts: { cancelled: 1 },
        level: "degraded",
        reasons: ["event-cancelled"]
      }
    });
  });

  it("uses unknown rather than invented health when no evidence exists", () => {
    expect(createLoopSupervisorHealthSnapshot({ generatedAt: NOW })).toMatchObject({
      adaptation: { level: "unknown" },
      agent: { level: "unknown" },
      event: { level: "unknown" },
      level: "unknown"
    });
  });

  it("degrades partial observability and stale agent evidence", () => {
    expect(createLoopSupervisorHealthSnapshot({
      agent: agent({ endedAt: "2026-07-30T11:00:00.000Z" }),
      generatedAt: NOW,
      staleAfterMs: 1_000
    })).toMatchObject({
      agent: { level: "degraded", reasons: ["agent-evidence-stale"] },
      level: "degraded",
      reasons: expect.arrayContaining(["agent-evidence-stale", "partial-observability"])
    });
  });

  it("blocks future-dated evidence instead of treating it as fresh", () => {
    expect(createLoopSupervisorHealthSnapshot({
      agent: agent({ endedAt: "2026-07-30T12:00:00.001Z" }),
      generatedAt: NOW
    })).toMatchObject({
      agent: { level: "blocked", reasons: ["agent-evidence-future"] },
      level: "blocked"
    });

    const admitted = journal("future-settlement");
    const completed = settleTriggerAdmission(admitted, {
      at: new Date("2026-07-30T12:00:01.000Z"),
      dedupKey: admitted.entries[0]!.envelope.dedupKey,
      outcome: "completed"
    });
    expect(createLoopSupervisorHealthSnapshot({
      event: { journal: completed, workStates: [] },
      generatedAt: NOW
    })).toMatchObject({
      event: { level: "blocked", reasons: ["event-state-future"] },
      level: "blocked"
    });
  });

  it("is content-bound and deeply immutable", () => {
    const first = createLoopSupervisorHealthSnapshot({
      adaptation: { status: "idle" },
      agent: agent(),
      event: { journal: createTriggerAdmissionJournal({ maxPending: 1 }), workStates: [] },
      generatedAt: NOW
    });
    const second = createLoopSupervisorHealthSnapshot({
      adaptation: { status: "idle" },
      agent: agent(),
      event: { journal: createTriggerAdmissionJournal({ maxPending: 1 }), workStates: [] },
      generatedAt: NOW
    });
    expect(first.snapshotId).toBe(second.snapshotId);
    expect(first.snapshotId).toMatch(/^loop-health:[a-f0-9]{64}$/u);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.event.counts)).toBe(true);
    expect(Object.isFrozen(first.reasons)).toBe(true);
  });
});
