import { describe, expect, it } from "vitest";
import { baselinePolicy, computeContinuityEvaluation, type AttunementState, type ContinuityEvidenceClass } from "@muse/attunement";
import {
  classifyResidentDaemonHealth,
  type ResidentDaemonObservation,
  type ResidentDaemonHealthResult,
  type ResidentMuseProcessInventory
} from "@muse/runtime-state";
import { formatResidentDaemonHealthStatus } from "./commands-daemon.js";
import { residentDaemonRuntimeCheck } from "./commands-doctor.js";

import {
  AGENT_CAPABILITY_MATRIX_ID,
  AGENT_CAPABILITY_REQUIREMENTS,
  parseCapabilityReport,
  qualifyPersonalAgent,
  type ArtifactEvidenceSnapshot,
  type GitEvidenceSnapshot,
  type PersonalAgentQualificationObservations,
  type RuntimeQualificationObservation
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

function runtimeObservation(
  overrides: Partial<RuntimeQualificationObservation> = {}
): RuntimeQualificationObservation {
  const { health: suppliedHealth, ...observationOverrides } = overrides;
  const observation: ResidentDaemonObservation = {
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
    restart: { failureCount: 0, state: "closed", updatedAt: NOW.toISOString() },
    runtime: "running",
    stableMuseCommand: true,
    ...observationOverrides
  };
  const inventory: ResidentMuseProcessInventory = {
    conditions: [],
    duplicateResidentProcessCount: 0,
    museProcessCount: 1,
    probe: observation.orphanProbe,
    processes: [{
      cwd: "/private/runtime",
      executableRealpath: process.execPath,
      matchesLaunchdPid: observation.pidAgreement,
      pid: 1,
      ppid: 0,
      role: "resident",
      startedAt: "2026-07-21T00:00:00.000Z"
    }],
    residentProcessCount: 1
  };
  return { ...observation, health: suppliedHealth ?? classifyResidentDaemonHealth(observation, inventory) };
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
    runtime: runtimeObservation()
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
  it.each([
    {
      health: { reasonCodes: [], status: "healthy" },
      name: "healthy"
    },
    {
      health: {
        reasonCodes: [
          "daemon-not-registered",
          "resident-process-missing",
          "daemon-live-probe-unverified",
          "daemon-heartbeat-invalid"
        ],
        status: "failed"
      },
      name: "artifact-only"
    },
    {
      health: {
        reasonCodes: [
          "daemon-artifact-missing",
          "daemon-not-registered",
          "daemon-pid-mismatch",
          "daemon-live-probe-unverified",
          "daemon-heartbeat-invalid"
        ],
        status: "failed"
      },
      name: "process-only"
    },
    {
      health: { reasonCodes: ["duplicate-resident-processes-detected"], status: "failed" },
      name: "duplicate"
    },
    {
      health: { reasonCodes: ["orphan-api-processes-detected"], status: "failed" },
      name: "orphan"
    },
    {
      health: { reasonCodes: ["daemon-heartbeat-stale"], status: "failed" },
      name: "stale"
    },
    {
      health: {
        reasonCodes: ["background-runtime-platform-unverified", "daemon-probe-unverified"],
        status: "unverified"
      },
      name: "unmanaged"
    }
  ] satisfies readonly { readonly health: ResidentDaemonHealthResult; readonly name: string }[])(
    "keeps $name status and reasons byte-equivalent across daemon, doctor, and qualification",
    ({ health }) => {
      const runtime = runtimeObservation({ health });
      const doctor = residentDaemonRuntimeCheck(runtime);
      const qualification = qualifyPersonalAgent({ ...passingObservations(), runtime });
      const daemonBytes = formatResidentDaemonHealthStatus(health);

      expect(JSON.stringify(doctor.health)).toBe(daemonBytes);
      expect(JSON.stringify(qualification.gates[1].evidence.health)).toBe(daemonBytes);
      expect(JSON.stringify({
        reasonCodes: qualification.gates[1].reasonCodes,
        status: qualification.gates[1].status === "passed"
          ? "healthy"
          : qualification.gates[1].status === "failed" ? "failed" : "unverified"
      })).toBe(daemonBytes);
    }
  );

  it("qualifies technical gates only and keeps organic effectiveness not-proven", () => {
    const report = qualifyPersonalAgent(passingObservations());
    expect(report.status).toBe("qualified");
    expect(report.counts).toEqual({ failed: 0, passed: 3, total: 3, unverified: 0 });
    expect(report.effectiveness).toEqual({
      reasonCodes: ["organic-personal-effectiveness-not-proven"],
      status: "not-proven"
    });
  });

  it("binds the report to privacy-safe source, build, runtime, input, and expiry provenance", () => {
    const report = qualifyPersonalAgent(passingObservations());

    expect(report).toMatchObject({
      provenance: {
        build: ARTIFACTS,
        expiresAt: "2026-07-22T12:00:00.000Z",
        generatedAt: NOW.toISOString(),
        runtimeIdentity: {
          artifactState: "valid",
          heartbeatState: "fresh",
          liveDefinitionMatch: true,
          liveProbe: "ok",
          orphanProcessCount: 0,
          orphanProbe: "ok",
          orphanRootCount: 0,
          platform: "darwin",
          processIdentityMatch: true,
          runtimeState: "running"
        },
        source: { end: SOURCE, start: SOURCE }
      },
      schemaVersion: 2
    });
    expect(report.provenance.inputHash).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("keeps the input hash stable across generation time and changes it for technical evidence drift", () => {
    const base = passingObservations();
    const baselineHash = qualifyPersonalAgent(base).provenance.inputHash;
    const afterFreshnessBoundary = qualifyPersonalAgent({
      ...base,
      now: new Date(base.now.getTime() + 25 * 60 * 60_000)
    });

    expect(afterFreshnessBoundary.gates[0].status).toBe("unverified");
    expect(afterFreshnessBoundary.provenance.inputHash).toBe(baselineHash);
    expect(afterFreshnessBoundary.generatedAt).not.toBe(base.now.toISOString());

    const changedInputs: PersonalAgentQualificationObservations[] = [
      {
        ...base,
        capability: {
          ...base.capability,
          currentSourceEnd: { revision: "c".repeat(40), tree: "clean" }
        }
      },
      {
        ...base,
        capability: {
          ...base.capability,
          currentArtifacts: { ...ARTIFACTS, digest: "c".repeat(64) }
        }
      },
      { ...base, runtime: runtimeObservation({ pidAgreement: false }) },
      { ...base, delivery: { ...base.delivery, localOnly: false } },
      { ...base, capability: { ...base.capability, maxAgeMs: 60 * 60_000 } }
    ];

    for (const input of changedInputs) {
      expect(qualifyPersonalAgent(input).provenance.inputHash).not.toBe(baselineHash);
    }
  });

  it("keeps unavailable source and build identities explicit without inventing values", () => {
    const base = passingObservations();
    const report = qualifyPersonalAgent({
      ...base,
      capability: {
        ...base.capability,
        currentArtifacts: { count: 0, status: "unknown" },
        currentSourceEnd: { tree: "unknown" },
        currentSourceStart: { tree: "unknown" },
        maxAgeMs: 48 * 60 * 60_000
      }
    });

    expect(report.provenance).toMatchObject({
      build: { count: 0, digest: null, status: "unknown" },
      expiresAt: "2026-07-22T12:00:00.000Z",
      source: {
        end: { revision: null, tree: "unknown" },
        start: { revision: null, tree: "unknown" }
      }
    });
  });

  it("represents unobserved live runtime identity as null instead of a concrete mismatch", () => {
    const base = passingObservations();
    const report = qualifyPersonalAgent({
      ...base,
      runtime: runtimeObservation({
        liveDefinitionMatches: false,
        liveProbe: "unverified",
        pidAgreement: false,
        stableMuseCommand: false
      })
    });

    expect(report.provenance.runtimeIdentity).toMatchObject({
      liveDefinitionMatch: null,
      liveProbe: "unverified",
      processIdentityMatch: null
    });
    expect(report.gates[1].reasonCodes).toContain("daemon-live-probe-unverified");
  });

  it.each(["controlled", "unclassified"] as const)("cannot promote %s-only Attunement evidence into qualification effectiveness", (evidenceClass: ContinuityEvidenceClass) => {
    const state: AttunementState = {
      deliveries: [{ evidenceClass, evidenceRefs: [], id: `delivery_${evidenceClass}`, openedAt: "2026-07-21T09:00:00.000Z", policyVersion: 1, threadId: "thread_work" }],
      interactionReceipts: [],
      nextPolicyVersion: 2,
      resetReceipts: [],
      schemaVersion: 11,
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
      runtime: runtimeObservation({ orphanProcessCount: 2, orphanRootCount: 1 })
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
      runtimeObservation({ liveDefinitionMatches: false }),
      runtimeObservation({ pidAgreement: false }),
      runtimeObservation({ heartbeat: "future" }),
      runtimeObservation({ heartbeat: "before-process" }),
      runtimeObservation({ liveProbe: "unverified" })
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
