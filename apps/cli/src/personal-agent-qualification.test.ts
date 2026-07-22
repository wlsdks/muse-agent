import { describe, expect, it } from "vitest";
import { baselinePolicy, computeContinuityEvaluation, type AttunementState, type ContinuityEvidenceClass } from "@muse/attunement";

import {
  AGENT_CAPABILITY_MATRIX_ID,
  AGENT_CAPABILITY_REQUIREMENTS,
  parseCapabilityReport,
  qualifyPersonalAgent,
  type ArtifactEvidenceSnapshot,
  type GitEvidenceSnapshot,
  type PersonalAgentQualificationObservations
} from "./personal-agent-qualification.js";

const NOW = new Date("2026-07-21T12:00:00.000Z");
const SOURCE: GitEvidenceSnapshot = { revision: "a".repeat(40), tree: "clean" };
const ARTIFACTS: ArtifactEvidenceSnapshot = { count: 120, digest: "b".repeat(64), status: "ok" };

function rows(): Array<{
  durationMs: number;
  executed: number;
  id: string;
  requested: number;
  required: boolean;
  status: "passed";
}> {
  return AGENT_CAPABILITY_REQUIREMENTS.map((requirement) => ({
    durationMs: 10,
    executed: requirement.repeats,
    id: requirement.id,
    requested: requirement.repeats,
    required: requirement.required,
    status: "passed" as const
  }));
}

function capabilityReport(overrides: Record<string, unknown> = {}) {
  const capabilities = rows();
  return {
    capabilities,
    counts: { failed: 0, passed: 11, total: 11, unverified: 0 },
    generatedAt: "2026-07-21T11:00:00.000Z",
    matrixId: AGENT_CAPABILITY_MATRIX_ID,
    provenance: {
      artifactsAfterBuild: ARTIFACTS,
      artifactsAtEnd: ARTIFACTS,
      sourceAfterBuild: SOURCE,
      sourceAtEnd: SOURCE,
      sourceBeforeBuild: SOURCE
    },
    status: "passed",
    version: 2,
    ...overrides
  };
}

function passingObservations(): PersonalAgentQualificationObservations {
  return {
    capability: {
      artifact: { state: "parsed", value: capabilityReport() },
      attempt: { stable: true, state: "completed", status: "passed" },
      currentArtifacts: ARTIFACTS,
      currentSourceEnd: SOURCE,
      currentSourceStart: SOURCE,
      maxAgeMs: 24 * 60 * 60_000
    },
    delivery: {
      baseProviderLocalLog: true,
      brakeEngaged: false,
      environmentProbe: "ok",
      followups: { overdue: 0, scheduled: 0, status: "ok" },
      localOnly: true,
      providerLockLog: true,
      reminders: { overdue: 0, scheduled: 0, status: "ok" },
      selfLearnDisabled: true
    },
    now: NOW,
    runtime: {
      artifact: "valid",
      autostartProbe: "ok",
      heartbeat: "fresh",
      liveDefinitionMatches: true,
      liveProbe: "ok",
      orphanProbe: "ok",
      orphanProcessCount: 0,
      orphanRootCount: 0,
      pidAgreement: true,
      platform: "darwin",
      runtime: "running",
      stableMuseCommand: true
    }
  };
}

describe("capability report contract", () => {
  it("accepts only the exact canonical matrix and recomputed aggregate", () => {
    expect(parseCapabilityReport(capabilityReport())).toBeDefined();
    const duplicate = rows();
    duplicate[1] = { ...duplicate[0]! };
    expect(parseCapabilityReport(capabilityReport({ capabilities: duplicate }))).toBeUndefined();

    const downgraded = rows();
    downgraded[0] = { ...downgraded[0]!, required: false };
    expect(parseCapabilityReport(capabilityReport({ capabilities: downgraded }))).toBeUndefined();
    expect(parseCapabilityReport(capabilityReport({ counts: { failed: 0, passed: 10, total: 11, unverified: 1 } }))).toBeUndefined();
  });

  it("rejects pass rows that did not execute strict requested repeats", () => {
    const mutated = rows();
    mutated[0] = { ...mutated[0]!, executed: 2 };
    expect(parseCapabilityReport(capabilityReport({ capabilities: mutated }))).toBeUndefined();
  });
});

describe("personal-agent qualification scorer", () => {
  it("qualifies technical gates only and keeps organic effectiveness not-proven", () => {
    const report = qualifyPersonalAgent(passingObservations());
    expect(report.status).toBe("qualified");
    expect(report.counts).toEqual({ failed: 0, passed: 3, total: 3, unverified: 0 });
    expect(report.effectiveness).toEqual({
      reasonCodes: ["organic-personal-effectiveness-not-proven"],
      status: "not-proven"
    });
  });

  it.each(["controlled", "unclassified"] as const)("cannot promote %s-only Attunement evidence into qualification effectiveness", (evidenceClass: ContinuityEvidenceClass) => {
    const state: AttunementState = {
      deliveries: [{ evidenceClass, evidenceRefs: [], id: `delivery_${evidenceClass}`, openedAt: "2026-07-21T09:00:00.000Z", policyVersion: 1, threadId: "thread_work" }],
      interactionReceipts: [],
      nextPolicyVersion: 2,
      resetReceipts: [],
      schemaVersion: 8,
      threads: [{ createdAt: "2026-07-21T08:00:00.000Z", id: "thread_work", kind: "work", links: [], policy: baselinePolicy(), title: "Work" }],
      undoResetReceipts: []
    };
    const evaluation = computeContinuityEvaluation(state, { now: () => NOW.getTime() });
    const report = qualifyPersonalAgent(passingObservations());

    expect(evaluation.measurements.filter((metric) => metric.claim !== "technical-diagnostic")).toEqual([]);
    expect(report.effectiveness).toEqual({ reasonCodes: ["organic-personal-effectiveness-not-proven"], status: "not-proven" });
    expect(JSON.stringify(report.effectiveness)).not.toMatch(/percent|rate|learning|autonomy/iu);
  });

  it("never averages away a runtime failure", () => {
    const input = passingObservations();
    const report = qualifyPersonalAgent({
      ...input,
      runtime: { ...input.runtime, orphanProcessCount: 2, orphanRootCount: 1 }
    });
    expect(report.status).toBe("not-qualified");
    expect(report.gates[1]).toMatchObject({
      reasonCodes: ["orphan-api-processes-detected"],
      status: "failed"
    });
  });

  it("keeps legacy failure evidence without an attempt generation unverified", () => {
    const input = passingObservations();
    const failedRows = rows();
    failedRows[0] = { ...failedRows[0]!, executed: 0, reason: "missing-completion", status: "failed" } as never;
    const report = qualifyPersonalAgent({
      ...input,
      capability: {
        ...input.capability,
        attempt: { stable: true, state: "missing" },
        artifact: {
          state: "parsed",
          value: {
            capabilities: failedRows,
            counts: { failed: 1, passed: 10, total: 11, unverified: 0 },
            status: "failed",
            version: 1
          }
        }
      }
    });
    expect(report.gates[0].status).toBe("unverified");
    expect(report.gates[0].reasonCodes).toContain("capability-attempt-state-missing");
  });

  it("treats only a stable completed generation as authority", () => {
    const base = passingObservations();
    const running = qualifyPersonalAgent({
      ...base,
      capability: { ...base.capability, attempt: { stable: true, state: "running" } }
    });
    expect(running.gates[0]).toMatchObject({
      reasonCodes: ["capability-attempt-in-progress"],
      status: "unverified"
    });

    const changed = qualifyPersonalAgent({
      ...base,
      capability: { ...base.capability, attempt: { stable: false, state: "completed", status: "passed" } }
    });
    expect(changed.gates[0]).toMatchObject({
      reasonCodes: ["capability-attempt-changed-during-qualification"],
      status: "unverified"
    });
  });

  it("fails an exact terminal failed v2 generation", () => {
    const base = passingObservations();
    const failedRows = rows();
    failedRows[0] = { ...failedRows[0]!, executed: 0, reason: "runtime-execution-failed", status: "failed" } as never;
    const report = qualifyPersonalAgent({
      ...base,
      capability: {
        ...base.capability,
        artifact: {
          state: "parsed",
          value: capabilityReport({
            capabilities: failedRows,
            counts: { failed: 1, passed: 10, total: 11, unverified: 0 },
            status: "failed"
          })
        },
        attempt: { stable: true, state: "completed", status: "failed" }
      }
    });
    expect(report.gates[0]).toMatchObject({
      reasonCodes: ["capability-report-failed"],
      status: "failed"
    });
  });

  it("keeps missing, dirty, future, stale, and artifact-mismatched pass evidence unverified", () => {
    const base = passingObservations();
    const variants: PersonalAgentQualificationObservations[] = [
      { ...base, capability: { ...base.capability, artifact: { state: "missing" } } },
      { ...base, capability: { ...base.capability, currentSourceEnd: { ...SOURCE, tree: "dirty" } } },
      { ...base, capability: { ...base.capability, artifact: { state: "parsed", value: capabilityReport({ generatedAt: "2026-07-21T13:00:00.000Z" }) } } },
      { ...base, capability: { ...base.capability, artifact: { state: "parsed", value: capabilityReport({ generatedAt: "2026-07-19T11:00:00.000Z" }) } } },
      { ...base, capability: { ...base.capability, currentArtifacts: { ...ARTIFACTS, digest: "c".repeat(64) } } }
    ];
    for (const input of variants) {
      expect(qualifyPersonalAgent(input).gates[0].status).toBe("unverified");
    }
  });

  it("rejects disk/live identity drift, future/PID-reused heartbeat, and missing probes", () => {
    const base = passingObservations();
    for (const runtime of [
      { ...base.runtime, liveDefinitionMatches: false },
      { ...base.runtime, heartbeat: "future" as const },
      { ...base.runtime, heartbeat: "before-process" as const },
      { ...base.runtime, liveProbe: "unverified" as const }
    ]) {
      expect(qualifyPersonalAgent({ ...base, runtime }).status).not.toBe("qualified");
    }
  });

  it("treats an engaged brake as safe-but-unverified and does not fail on held backlog", () => {
    const base = passingObservations();
    const report = qualifyPersonalAgent({
      ...base,
      delivery: {
        ...base.delivery,
        brakeEngaged: true,
        followups: { overdue: 26, scheduled: 26, status: "ok" }
      }
    });
    expect(report.status).toBe("unverified");
    expect(report.gates[2]).toMatchObject({
      reasonCodes: ["delivery-brake-engaged"],
      status: "unverified"
    });
    expect(report.gates[2].evidence.overdueFollowups).toBe(26);
  });

  it("fails active delivery on every required safety boundary and exposes counts only", () => {
    const base = passingObservations();
    const report = qualifyPersonalAgent({
      ...base,
      delivery: {
        ...base.delivery,
        baseProviderLocalLog: false,
        followups: { overdue: 26, scheduled: 26, status: "ok" },
        localOnly: false,
        providerLockLog: false,
        reminders: { overdue: 2, scheduled: 3, status: "ok" },
        selfLearnDisabled: false
      }
    });
    expect(report.gates[2].status).toBe("failed");
    expect(report.gates[2].reasonCodes).toEqual(expect.arrayContaining([
      "daemon-local-only-not-persisted",
      "daemon-self-learn-not-disabled",
      "delivery-route-not-local-log",
      "delivery-provider-lock-not-log",
      "overdue-followups-detected",
      "overdue-reminders-detected"
    ]));
    const encoded = JSON.stringify(report);
    expect(encoded).not.toMatch(/summary|destination|command|cwd|pid|processStartedAt/iu);
  });
});
