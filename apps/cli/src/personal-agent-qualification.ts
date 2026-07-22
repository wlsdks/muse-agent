/**
 * Deterministic, privacy-safe qualification for the single-user Muse agent.
 *
 * This module is deliberately pure. I/O collectors reduce paths, process
 * details, personal rows, and raw subprocess output into the observations
 * below; only closed reason codes and aggregate counts cross into the report.
 */

export const PERSONAL_AGENT_QUALIFICATION_SCHEMA_VERSION = 1 as const;
export const AGENT_CAPABILITY_MATRIX_ID = "muse-agent-capability-v1" as const;
export const DEFAULT_CAPABILITY_EVIDENCE_MAX_AGE_HOURS = 24;

export const AGENT_CAPABILITY_REQUIREMENTS = [
  { id: "tool-selection-arguments", required: true, repeats: 3 },
  { id: "plan-quality", required: true, repeats: 3 },
  { id: "tool-argument-grounding", required: true, repeats: 3 },
  { id: "computer-task-terminal-edit", required: true, repeats: 3 },
  { id: "adversarial-containment-no-op", required: true, repeats: 3 },
  { id: "cosine-recall-abstention", required: true, repeats: 1 },
  { id: "multihop-retrieval-lift", required: true, repeats: 1 },
  { id: "orchestration-failure-bounds", required: true, repeats: 3 },
  { id: "channel-conversation-rhythm", required: true, repeats: 3 },
  { id: "edit-run-verify", required: false, repeats: 3 },
  { id: "browser-terminal-task", required: false, repeats: 3 }
] as const;

export const QUALIFICATION_REASON = {
  artifactDigestMismatch: "capability-artifact-digest-mismatch",
  artifactEvidenceMissing: "capability-artifact-evidence-missing",
  capabilityFailed: "capability-report-failed",
  capabilityFutureDated: "capability-report-future-dated",
  capabilityAttemptChanged: "capability-attempt-changed-during-qualification",
  capabilityAttemptInProgress: "capability-attempt-in-progress",
  capabilityAttemptInvalid: "capability-attempt-state-invalid",
  capabilityAttemptMissing: "capability-attempt-state-missing",
  capabilityInvalid: "capability-report-invalid",
  capabilityMissing: "capability-report-missing",
  capabilityProvenanceMissing: "capability-provenance-missing",
  capabilityStale: "capability-report-stale",
  capabilityUnverified: "capability-report-unverified",
  currentSourceDirty: "current-source-tree-dirty",
  currentSourceDrift: "current-source-drift",
  currentSourceUnverified: "current-source-unverified",
  daemonArtifactInvalid: "daemon-artifact-invalid",
  daemonArtifactMissing: "daemon-artifact-missing",
  daemonArtifactStale: "daemon-artifact-stale",
  daemonCommandUnstable: "daemon-command-not-stable-muse-entry",
  daemonCrashLooping: "daemon-crash-looping",
  daemonDefinitionMismatch: "daemon-live-definition-mismatch",
  daemonLiveProbeUnverified: "daemon-live-probe-unverified",
  daemonNotRegistered: "daemon-not-registered",
  daemonNotRunning: "daemon-not-running",
  daemonPidMismatch: "daemon-pid-mismatch",
  daemonProbeUnverified: "daemon-probe-unverified",
  deliveryBrakeEngaged: "delivery-brake-engaged",
  deliveryEnvironmentUnverified: "delivery-environment-unverified",
  deliveryProviderLockMissing: "delivery-provider-lock-not-log",
  deliveryRouteNotLocalLog: "delivery-route-not-local-log",
  followupBacklogUnverified: "followup-backlog-unverified",
  heartbeatBeforeProcess: "daemon-heartbeat-before-process-start",
  heartbeatFuture: "daemon-heartbeat-future-dated",
  heartbeatInvalid: "daemon-heartbeat-invalid",
  heartbeatMissing: "daemon-heartbeat-missing",
  heartbeatStale: "daemon-heartbeat-stale",
  localOnlyMissing: "daemon-local-only-not-persisted",
  organicEvidenceNotProven: "organic-personal-effectiveness-not-proven",
  orphanApiProcesses: "orphan-api-processes-detected",
  orphanProcessProbeUnverified: "orphan-process-probe-unverified",
  overdueFollowups: "overdue-followups-detected",
  overdueReminders: "overdue-reminders-detected",
  platformUnsupported: "background-runtime-platform-unverified",
  reminderBacklogUnverified: "reminder-backlog-unverified",
  selfLearnEnabled: "daemon-self-learn-not-disabled",
  sourceProvenanceInvalid: "capability-source-provenance-invalid"
} as const;

export type QualificationReasonCode = (typeof QUALIFICATION_REASON)[keyof typeof QUALIFICATION_REASON];
export type QualificationGateStatus = "passed" | "failed" | "unverified";
export type PersonalAgentQualificationStatus = "qualified" | "not-qualified" | "unverified";

export interface GitEvidenceSnapshot {
  readonly revision?: string;
  readonly tree: "clean" | "dirty" | "unknown";
}

export interface ArtifactEvidenceSnapshot {
  readonly status: "ok" | "unknown";
  readonly digest?: string;
  readonly count: number;
}

export interface CapabilityArtifactObservation {
  readonly state: "missing" | "invalid" | "parsed";
  readonly value?: unknown;
}

export interface CapabilityQualificationObservation {
  readonly artifact: CapabilityArtifactObservation;
  readonly attempt: {
    readonly stable: boolean;
    readonly state: "missing" | "invalid" | "running" | "completed";
    readonly status?: "passed" | "failed" | "unverified";
  };
  readonly currentSourceStart: GitEvidenceSnapshot;
  readonly currentSourceEnd: GitEvidenceSnapshot;
  readonly currentArtifacts: ArtifactEvidenceSnapshot;
  readonly maxAgeMs: number;
}

export interface RuntimeQualificationObservation {
  readonly platform: NodeJS.Platform;
  readonly autostartProbe: "ok" | "unverified";
  readonly artifact: "valid" | "missing" | "invalid" | "stale" | "unknown";
  readonly runtime: "running" | "not-registered" | "not-running" | "crash-looping" | "unknown";
  readonly liveProbe: "ok" | "unverified";
  readonly liveDefinitionMatches: boolean;
  readonly stableMuseCommand: boolean;
  readonly pidAgreement: boolean;
  readonly heartbeat: "fresh" | "missing" | "invalid" | "stale" | "future" | "before-process" | "unknown";
  readonly orphanProbe: "ok" | "unverified";
  readonly orphanRootCount: number;
  readonly orphanProcessCount: number;
}

export interface BacklogCountObservation {
  readonly status: "ok" | "unverified";
  readonly scheduled: number;
  readonly overdue: number;
}

export interface DeliveryQualificationObservation {
  readonly environmentProbe: "ok" | "unverified";
  readonly localOnly: boolean;
  readonly selfLearnDisabled: boolean;
  readonly baseProviderLocalLog: boolean;
  readonly providerLockLog: boolean;
  readonly brakeEngaged: boolean;
  readonly followups: BacklogCountObservation;
  readonly reminders: BacklogCountObservation;
}

export interface PersonalAgentQualificationObservations {
  readonly now: Date;
  readonly capability: CapabilityQualificationObservation;
  readonly runtime: RuntimeQualificationObservation;
  readonly delivery: DeliveryQualificationObservation;
}

export interface CapabilityGateEvidence {
  readonly reportVersion?: number;
  readonly passed?: number;
  readonly failed?: number;
  readonly unverified?: number;
  readonly total?: number;
  readonly sourceRevisionMatch: boolean;
  readonly artifactDigestMatch: boolean;
}

export interface RuntimeGateEvidence {
  readonly artifactState: RuntimeQualificationObservation["artifact"];
  readonly runtimeState: RuntimeQualificationObservation["runtime"];
  readonly liveDefinitionMatch: boolean;
  readonly heartbeatState: RuntimeQualificationObservation["heartbeat"];
  readonly processIdentityMatch: boolean;
  readonly orphanRootCount: number;
  readonly orphanProcessCount: number;
}

export interface DeliveryGateEvidence {
  readonly localOnlyPersisted: boolean;
  readonly selfLearnDisabled: boolean;
  readonly baseProviderLocalLog: boolean;
  readonly providerLockLog: boolean;
  readonly deliveryBrakeEngaged: boolean;
  readonly scheduledFollowups: number;
  readonly overdueFollowups: number;
  readonly scheduledReminders: number;
  readonly overdueReminders: number;
}

export interface QualificationGate<Id extends string, Evidence> {
  readonly id: Id;
  readonly required: true;
  readonly status: QualificationGateStatus;
  readonly reasonCodes: readonly QualificationReasonCode[];
  readonly evidence: Evidence;
}

export interface PersonalAgentQualificationReport {
  readonly schemaVersion: typeof PERSONAL_AGENT_QUALIFICATION_SCHEMA_VERSION;
  readonly profile: "personal-agent-v1";
  readonly generatedAt: string;
  readonly readOnly: true;
  readonly status: PersonalAgentQualificationStatus;
  readonly counts: {
    readonly passed: number;
    readonly failed: number;
    readonly unverified: number;
    readonly total: 3;
  };
  readonly gates: readonly [
    QualificationGate<"capability", CapabilityGateEvidence>,
    QualificationGate<"background-runtime", RuntimeGateEvidence>,
    QualificationGate<"delivery-safety", DeliveryGateEvidence>
  ];
  readonly effectiveness: {
    readonly status: "not-proven";
    readonly reasonCodes: readonly [typeof QUALIFICATION_REASON.organicEvidenceNotProven];
  };
}

interface ParsedCapabilityRow {
  readonly id: string;
  readonly required: boolean;
  readonly status: "passed" | "failed" | "unverified";
  readonly requested: number;
  readonly executed: number;
  readonly durationMs: number;
  readonly reason?: string;
}

interface ParsedCapabilityReport {
  readonly version: 1 | 2;
  readonly status: "passed" | "failed" | "unverified";
  readonly counts: { readonly passed: number; readonly failed: number; readonly unverified: number; readonly total: number };
  readonly capabilities: readonly ParsedCapabilityRow[];
  readonly generatedAt?: string;
  readonly matrixId?: string;
  readonly provenance?: {
    readonly sourceBeforeBuild: GitEvidenceSnapshot;
    readonly sourceAfterBuild: GitEvidenceSnapshot;
    readonly sourceAtEnd: GitEvidenceSnapshot;
    readonly artifactsAfterBuild: ArtifactEvidenceSnapshot;
    readonly artifactsAtEnd: ArtifactEvidenceSnapshot;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => allowed.has(key));
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function parseSourceSnapshot(value: unknown): GitEvidenceSnapshot | undefined {
  if (!isRecord(value) || !hasExactKeys(value, ["tree"], ["revision"])) return undefined;
  if (value.tree !== "clean" && value.tree !== "dirty" && value.tree !== "unknown") return undefined;
  if (value.revision !== undefined && (typeof value.revision !== "string" || !/^[0-9a-f]{7,64}$/u.test(value.revision))) return undefined;
  return { tree: value.tree, ...(typeof value.revision === "string" ? { revision: value.revision } : {}) };
}

function parseArtifactSnapshot(value: unknown): ArtifactEvidenceSnapshot | undefined {
  if (!isRecord(value) || !hasExactKeys(value, ["count", "status"], ["digest"])) return undefined;
  if (value.status !== "ok" && value.status !== "unknown") return undefined;
  if (!isNonNegativeInteger(value.count)) return undefined;
  if (value.digest !== undefined && (typeof value.digest !== "string" || !/^[0-9a-f]{64}$/u.test(value.digest))) return undefined;
  if (value.status === "ok" && (typeof value.digest !== "string" || value.count === 0)) return undefined;
  return {
    count: value.count,
    status: value.status,
    ...(typeof value.digest === "string" ? { digest: value.digest } : {})
  };
}

function parseCapabilityRow(value: unknown): ParsedCapabilityRow | undefined {
  if (!isRecord(value) || !hasExactKeys(
    value,
    ["durationMs", "executed", "id", "requested", "required", "status"],
    ["reason"]
  )) return undefined;
  if (typeof value.id !== "string" || typeof value.required !== "boolean") return undefined;
  if (value.status !== "passed" && value.status !== "failed" && value.status !== "unverified") return undefined;
  if (!isNonNegativeInteger(value.requested) || !isNonNegativeInteger(value.executed)) return undefined;
  if (typeof value.durationMs !== "number" || !Number.isFinite(value.durationMs) || value.durationMs < 0) return undefined;
  if (value.reason !== undefined && typeof value.reason !== "string") return undefined;
  if (value.status === "passed" && value.reason !== undefined) return undefined;
  if (value.status !== "passed" && (typeof value.reason !== "string" || value.reason.length === 0)) return undefined;
  return {
    durationMs: value.durationMs,
    executed: value.executed,
    id: value.id,
    requested: value.requested,
    required: value.required,
    status: value.status,
    ...(typeof value.reason === "string" ? { reason: value.reason } : {})
  };
}

function parseCounts(value: unknown): ParsedCapabilityReport["counts"] | undefined {
  if (!isRecord(value) || !hasExactKeys(value, ["failed", "passed", "total", "unverified"])) return undefined;
  if (![value.failed, value.passed, value.total, value.unverified].every(isNonNegativeInteger)) return undefined;
  return {
    failed: value.failed as number,
    passed: value.passed as number,
    total: value.total as number,
    unverified: value.unverified as number
  };
}

function recomputeCapabilityStatus(rows: readonly ParsedCapabilityRow[]): ParsedCapabilityReport["status"] {
  if (rows.some((row) => row.status === "failed")) return "failed";
  return rows.some((row) => row.required && row.status !== "passed") ? "unverified" : "passed";
}

/** Strict parse + canonical matrix validation. Invalid aggregates never become evidence. */
export function parseCapabilityReport(value: unknown): ParsedCapabilityReport | undefined {
  if (!isRecord(value) || (value.version !== 1 && value.version !== 2)) return undefined;
  const v2 = value.version === 2;
  const requiredKeys = v2
    ? ["capabilities", "counts", "generatedAt", "matrixId", "provenance", "status", "version"]
    : ["capabilities", "counts", "status", "version"];
  if (!hasExactKeys(value, requiredKeys)) return undefined;
  if (value.status !== "passed" && value.status !== "failed" && value.status !== "unverified") return undefined;
  if (!Array.isArray(value.capabilities) || value.capabilities.length !== AGENT_CAPABILITY_REQUIREMENTS.length) return undefined;
  const rows = value.capabilities.map(parseCapabilityRow);
  if (rows.some((row) => row === undefined)) return undefined;
  const capabilities = rows as ParsedCapabilityRow[];
  for (let index = 0; index < AGENT_CAPABILITY_REQUIREMENTS.length; index += 1) {
    const expected = AGENT_CAPABILITY_REQUIREMENTS[index];
    const actual = capabilities[index];
    if (!expected || !actual || actual.id !== expected.id || actual.required !== expected.required || actual.requested !== expected.repeats) return undefined;
    if (actual.status === "passed" && actual.executed !== expected.repeats) return undefined;
    if (actual.executed > actual.requested) return undefined;
  }
  if (new Set(capabilities.map((row) => row.id)).size !== capabilities.length) return undefined;
  const counts = parseCounts(value.counts);
  if (!counts) return undefined;
  const expectedCounts = {
    failed: capabilities.filter((row) => row.status === "failed").length,
    passed: capabilities.filter((row) => row.status === "passed").length,
    total: capabilities.length,
    unverified: capabilities.filter((row) => row.status === "unverified").length
  };
  if (counts.failed !== expectedCounts.failed || counts.passed !== expectedCounts.passed
    || counts.total !== expectedCounts.total || counts.unverified !== expectedCounts.unverified) return undefined;
  if (value.status !== recomputeCapabilityStatus(capabilities)) return undefined;

  if (!v2) return { capabilities, counts, status: value.status, version: 1 };
  if (value.matrixId !== AGENT_CAPABILITY_MATRIX_ID || typeof value.generatedAt !== "string") return undefined;
  if (!isRecord(value.provenance) || !hasExactKeys(value.provenance, [
    "artifactsAfterBuild", "artifactsAtEnd", "sourceAfterBuild", "sourceAtEnd", "sourceBeforeBuild"
  ])) return undefined;
  const sourceBeforeBuild = parseSourceSnapshot(value.provenance.sourceBeforeBuild);
  const sourceAfterBuild = parseSourceSnapshot(value.provenance.sourceAfterBuild);
  const sourceAtEnd = parseSourceSnapshot(value.provenance.sourceAtEnd);
  const artifactsAfterBuild = parseArtifactSnapshot(value.provenance.artifactsAfterBuild);
  const artifactsAtEnd = parseArtifactSnapshot(value.provenance.artifactsAtEnd);
  if (!sourceBeforeBuild || !sourceAfterBuild || !sourceAtEnd || !artifactsAfterBuild || !artifactsAtEnd) return undefined;
  return {
    capabilities,
    counts,
    generatedAt: value.generatedAt,
    matrixId: value.matrixId,
    provenance: { artifactsAfterBuild, artifactsAtEnd, sourceAfterBuild, sourceAtEnd, sourceBeforeBuild },
    status: value.status,
    version: 2
  };
}

function sameCleanSource(left: GitEvidenceSnapshot, right: GitEvidenceSnapshot): boolean {
  return left.tree === "clean" && right.tree === "clean"
    && typeof left.revision === "string" && left.revision === right.revision;
}

function sameArtifact(left: ArtifactEvidenceSnapshot, right: ArtifactEvidenceSnapshot): boolean {
  return left.status === "ok" && right.status === "ok" && left.count > 0 && left.count === right.count
    && typeof left.digest === "string" && left.digest === right.digest;
}

function gateStatus(failed: readonly QualificationReasonCode[], unverified: readonly QualificationReasonCode[]): QualificationGateStatus {
  if (failed.length > 0) return "failed";
  return unverified.length > 0 ? "unverified" : "passed";
}

function assessCapability(
  observation: CapabilityQualificationObservation,
  nowMs: number
): QualificationGate<"capability", CapabilityGateEvidence> {
  const failed: QualificationReasonCode[] = [];
  const unverified: QualificationReasonCode[] = [];
  let report: ParsedCapabilityReport | undefined;
  if (!observation.attempt.stable) {
    unverified.push(QUALIFICATION_REASON.capabilityAttemptChanged);
  } else if (observation.attempt.state === "missing") {
    unverified.push(QUALIFICATION_REASON.capabilityAttemptMissing);
  } else if (observation.attempt.state === "invalid") {
    unverified.push(QUALIFICATION_REASON.capabilityAttemptInvalid);
  } else if (observation.attempt.state === "running") {
    unverified.push(QUALIFICATION_REASON.capabilityAttemptInProgress);
  } else if (observation.artifact.state === "missing") {
    unverified.push(QUALIFICATION_REASON.capabilityMissing);
  } else if (observation.artifact.state === "invalid") {
    unverified.push(QUALIFICATION_REASON.capabilityInvalid);
  } else {
    report = parseCapabilityReport(observation.artifact.value);
    if (!report || report.status !== observation.attempt.status) {
      report = undefined;
      unverified.push(QUALIFICATION_REASON.capabilityInvalid);
    }
  }

  let sourceRevisionMatch = false;
  let artifactDigestMatch = false;
  if (report?.status === "failed") {
    failed.push(QUALIFICATION_REASON.capabilityFailed);
  } else if (report?.status === "unverified") {
    unverified.push(QUALIFICATION_REASON.capabilityUnverified);
  } else if (report?.status === "passed") {
    if (report.version !== 2 || !report.provenance || !report.generatedAt) {
      unverified.push(QUALIFICATION_REASON.capabilityProvenanceMissing);
    } else {
      const generatedAtMs = Date.parse(report.generatedAt);
      if (!Number.isFinite(generatedAtMs)) {
        unverified.push(QUALIFICATION_REASON.capabilityInvalid);
      } else if (generatedAtMs > nowMs) {
        unverified.push(QUALIFICATION_REASON.capabilityFutureDated);
      } else if (nowMs - generatedAtMs > observation.maxAgeMs) {
        unverified.push(QUALIFICATION_REASON.capabilityStale);
      }

      const { sourceBeforeBuild, sourceAfterBuild, sourceAtEnd, artifactsAfterBuild, artifactsAtEnd } = report.provenance;
      const sourceProvenanceValid = sameCleanSource(sourceBeforeBuild, sourceAfterBuild)
        && sameCleanSource(sourceAfterBuild, sourceAtEnd);
      if (!sourceProvenanceValid) unverified.push(QUALIFICATION_REASON.sourceProvenanceInvalid);

      if (observation.currentSourceStart.tree === "dirty" || observation.currentSourceEnd.tree === "dirty") {
        unverified.push(QUALIFICATION_REASON.currentSourceDirty);
      } else if (!sameCleanSource(observation.currentSourceStart, observation.currentSourceEnd)) {
        unverified.push(
          observation.currentSourceStart.tree === "unknown" || observation.currentSourceEnd.tree === "unknown"
            ? QUALIFICATION_REASON.currentSourceUnverified
            : QUALIFICATION_REASON.currentSourceDrift
        );
      }
      sourceRevisionMatch = sourceProvenanceValid
        && sameCleanSource(observation.currentSourceStart, observation.currentSourceEnd)
        && sourceAtEnd.revision === observation.currentSourceEnd.revision;
      if (!sourceRevisionMatch && !unverified.includes(QUALIFICATION_REASON.currentSourceDirty)
        && !unverified.includes(QUALIFICATION_REASON.currentSourceUnverified)
        && !unverified.includes(QUALIFICATION_REASON.currentSourceDrift)) {
        unverified.push(QUALIFICATION_REASON.currentSourceDrift);
      }

      const reportArtifactsValid = sameArtifact(artifactsAfterBuild, artifactsAtEnd);
      if (!reportArtifactsValid || observation.currentArtifacts.status !== "ok") {
        unverified.push(QUALIFICATION_REASON.artifactEvidenceMissing);
      } else {
        artifactDigestMatch = sameArtifact(artifactsAtEnd, observation.currentArtifacts);
        if (!artifactDigestMatch) unverified.push(QUALIFICATION_REASON.artifactDigestMismatch);
      }
    }
  }

  return {
    evidence: {
      artifactDigestMatch,
      sourceRevisionMatch,
      ...(report ? {
        failed: report.counts.failed,
        passed: report.counts.passed,
        reportVersion: report.version,
        total: report.counts.total,
        unverified: report.counts.unverified
      } : {})
    },
    id: "capability",
    reasonCodes: [...failed, ...unverified],
    required: true,
    status: gateStatus(failed, unverified)
  };
}

function assessRuntime(observation: RuntimeQualificationObservation): QualificationGate<"background-runtime", RuntimeGateEvidence> {
  const failed: QualificationReasonCode[] = [];
  const unverified: QualificationReasonCode[] = [];
  if (observation.platform !== "darwin") unverified.push(QUALIFICATION_REASON.platformUnsupported);
  if (observation.autostartProbe !== "ok") unverified.push(QUALIFICATION_REASON.daemonProbeUnverified);
  if (observation.artifact === "missing") failed.push(QUALIFICATION_REASON.daemonArtifactMissing);
  else if (observation.artifact === "invalid") failed.push(QUALIFICATION_REASON.daemonArtifactInvalid);
  else if (observation.artifact === "stale") failed.push(QUALIFICATION_REASON.daemonArtifactStale);
  else if (observation.artifact === "unknown") unverified.push(QUALIFICATION_REASON.daemonProbeUnverified);

  if (observation.runtime === "not-registered") failed.push(QUALIFICATION_REASON.daemonNotRegistered);
  else if (observation.runtime === "not-running") failed.push(QUALIFICATION_REASON.daemonNotRunning);
  else if (observation.runtime === "crash-looping") failed.push(QUALIFICATION_REASON.daemonCrashLooping);
  else if (observation.runtime === "unknown") unverified.push(QUALIFICATION_REASON.daemonProbeUnverified);

  if (observation.liveProbe !== "ok") unverified.push(QUALIFICATION_REASON.daemonLiveProbeUnverified);
  else {
    if (!observation.liveDefinitionMatches) failed.push(QUALIFICATION_REASON.daemonDefinitionMismatch);
    if (!observation.stableMuseCommand) failed.push(QUALIFICATION_REASON.daemonCommandUnstable);
    if (!observation.pidAgreement) failed.push(QUALIFICATION_REASON.daemonPidMismatch);
  }

  if (observation.heartbeat === "missing") failed.push(QUALIFICATION_REASON.heartbeatMissing);
  else if (observation.heartbeat === "invalid") unverified.push(QUALIFICATION_REASON.heartbeatInvalid);
  else if (observation.heartbeat === "stale") failed.push(QUALIFICATION_REASON.heartbeatStale);
  else if (observation.heartbeat === "future") unverified.push(QUALIFICATION_REASON.heartbeatFuture);
  else if (observation.heartbeat === "before-process") unverified.push(QUALIFICATION_REASON.heartbeatBeforeProcess);
  else if (observation.heartbeat === "unknown") unverified.push(QUALIFICATION_REASON.heartbeatInvalid);

  if (observation.orphanProbe !== "ok") unverified.push(QUALIFICATION_REASON.orphanProcessProbeUnverified);
  if (observation.orphanRootCount > 0 || observation.orphanProcessCount > 0) failed.push(QUALIFICATION_REASON.orphanApiProcesses);

  return {
    evidence: {
      artifactState: observation.artifact,
      heartbeatState: observation.heartbeat,
      liveDefinitionMatch: observation.liveDefinitionMatches,
      orphanProcessCount: observation.orphanProcessCount,
      orphanRootCount: observation.orphanRootCount,
      processIdentityMatch: observation.pidAgreement,
      runtimeState: observation.runtime
    },
    id: "background-runtime",
    reasonCodes: [...new Set([...failed, ...unverified])],
    required: true,
    status: gateStatus(failed, unverified)
  };
}

function assessDelivery(observation: DeliveryQualificationObservation): QualificationGate<"delivery-safety", DeliveryGateEvidence> {
  const failed: QualificationReasonCode[] = [];
  const unverified: QualificationReasonCode[] = [];
  if (observation.environmentProbe !== "ok") unverified.push(QUALIFICATION_REASON.deliveryEnvironmentUnverified);
  if (observation.followups.status !== "ok") unverified.push(QUALIFICATION_REASON.followupBacklogUnverified);
  if (observation.reminders.status !== "ok") unverified.push(QUALIFICATION_REASON.reminderBacklogUnverified);

  if (observation.brakeEngaged) {
    unverified.push(QUALIFICATION_REASON.deliveryBrakeEngaged);
  } else {
    if (!observation.localOnly) failed.push(QUALIFICATION_REASON.localOnlyMissing);
    if (!observation.selfLearnDisabled) failed.push(QUALIFICATION_REASON.selfLearnEnabled);
    if (!observation.baseProviderLocalLog) failed.push(QUALIFICATION_REASON.deliveryRouteNotLocalLog);
    if (!observation.providerLockLog) failed.push(QUALIFICATION_REASON.deliveryProviderLockMissing);
    if (observation.followups.overdue > 0) failed.push(QUALIFICATION_REASON.overdueFollowups);
    if (observation.reminders.overdue > 0) failed.push(QUALIFICATION_REASON.overdueReminders);
  }

  return {
    evidence: {
      baseProviderLocalLog: observation.baseProviderLocalLog,
      deliveryBrakeEngaged: observation.brakeEngaged,
      localOnlyPersisted: observation.localOnly,
      overdueFollowups: observation.followups.overdue,
      overdueReminders: observation.reminders.overdue,
      providerLockLog: observation.providerLockLog,
      scheduledFollowups: observation.followups.scheduled,
      scheduledReminders: observation.reminders.scheduled,
      selfLearnDisabled: observation.selfLearnDisabled
    },
    id: "delivery-safety",
    reasonCodes: [...new Set([...failed, ...unverified])],
    required: true,
    status: gateStatus(failed, unverified)
  };
}

export function qualifyPersonalAgent(observations: PersonalAgentQualificationObservations): PersonalAgentQualificationReport {
  const nowMs = observations.now.getTime();
  const gates = [
    assessCapability(observations.capability, nowMs),
    assessRuntime(observations.runtime),
    assessDelivery(observations.delivery)
  ] as const;
  const counts = {
    failed: gates.filter((gate) => gate.status === "failed").length,
    passed: gates.filter((gate) => gate.status === "passed").length,
    total: 3 as const,
    unverified: gates.filter((gate) => gate.status === "unverified").length
  };
  const status: PersonalAgentQualificationStatus = counts.failed > 0
    ? "not-qualified"
    : counts.unverified > 0
      ? "unverified"
      : "qualified";
  return {
    counts,
    effectiveness: {
      reasonCodes: [QUALIFICATION_REASON.organicEvidenceNotProven],
      status: "not-proven"
    },
    gates,
    generatedAt: observations.now.toISOString(),
    profile: "personal-agent-v1",
    readOnly: true,
    schemaVersion: PERSONAL_AGENT_QUALIFICATION_SCHEMA_VERSION,
    status
  };
}
