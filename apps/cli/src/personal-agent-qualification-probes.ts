/** Read-only operational probes for `muse qualify`. Raw/private values stop here. */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import {
  collectDeliverySafetyDiagnostic,
  inspectDeliverySafetyBacklog
} from "@muse/autoconfigure";
import {
  inspectResidentDaemon,
  inspectResidentOrphanApiProcesses,
  type ResidentDaemonInspection
} from "@muse/runtime-state";
import {
  DEFAULT_CAPABILITY_EVIDENCE_MAX_AGE_HOURS,
  type ArtifactEvidenceSnapshot,
  type CapabilityArtifactObservation,
  type DeliveryQualificationObservation,
  type GitEvidenceSnapshot,
  type PersonalAgentQualificationObservations,
  type RuntimeQualificationObservation
} from "./personal-agent-qualification.js";

export interface ReadOnlyCommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ReadOnlyCommandOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
}

export type ReadOnlyCommandRunner = (
  executable: string,
  args: readonly string[],
  options?: ReadOnlyCommandOptions
) => Promise<ReadOnlyCommandResult>;

export interface QualificationProbeDependencies {
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly now?: () => Date;
  readonly run?: ReadOnlyCommandRunner;
  readonly uid?: number;
  readonly daemonTemporaryRoots?: readonly string[];
  readonly residentInspection?: () => Promise<ResidentDaemonInspection>;
  readonly artifactDigest?: (
    workspaceDir: string,
    artifactRoot?: string
  ) => Promise<ArtifactEvidenceSnapshot>;
  readonly capabilityEvidence?: (
    reportFile: string,
    allowedRoot: string,
    workspaceDir: string
  ) => Promise<CapabilityEvidenceInspection>;
}

export interface CapabilityEvidenceInspection {
  readonly artifact: CapabilityArtifactObservation;
  readonly fingerprint?: string;
  readonly state: "missing" | "invalid" | "running" | "completed";
  readonly status?: "passed" | "failed" | "unverified";
}

export interface CollectQualificationOptions {
  readonly workspaceDir: string;
  readonly capabilityReportFile?: string;
  readonly maxEvidenceAgeHours?: number;
}

function defaultRun(executable: string, args: readonly string[], options: ReadOnlyCommandOptions = {}): Promise<ReadOnlyCommandResult> {
  return new Promise((resolveResult) => {
    execFile(executable, [...args], {
      cwd: options.cwd,
      encoding: "utf8",
      env: options.env,
      maxBuffer: 2 * 1024 * 1024,
      timeout: 10_000
    }, (error, stdout, stderr) => {
      const exitCode = error && "code" in error && typeof error.code === "number" ? error.code : error ? 1 : 0;
      resolveResult({ code: exitCode, stderr: stderr ?? "", stdout: stdout ?? "" });
    });
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const readStrictBacklogCounts = inspectDeliverySafetyBacklog;

export async function inspectOrphanApiProcesses(
  platform: NodeJS.Platform,
  run: ReadOnlyCommandRunner
): Promise<Pick<RuntimeQualificationObservation, "orphanProbe" | "orphanRootCount" | "orphanProcessCount">> {
  return inspectResidentOrphanApiProcesses(platform, run);
}

function parseGitRevision(output: string): string | undefined {
  const revision = output.trim();
  return /^[0-9a-f]{7,64}$/u.test(revision) ? revision : undefined;
}

export async function inspectGitSnapshot(workspaceDir: string, run: ReadOnlyCommandRunner): Promise<GitEvidenceSnapshot> {
  const gitEnv = { ...process.env, GIT_OPTIONAL_LOCKS: "0" };
  const [revisionResult, statusResult] = await Promise.all([
    run("git", ["--no-optional-locks", "-C", workspaceDir, "rev-parse", "HEAD"], { env: gitEnv }),
    run("git", ["--no-optional-locks", "-C", workspaceDir, "status", "--porcelain=v1", "--untracked-files=all"], { env: gitEnv })
  ]);
  const revision = revisionResult.code === 0 ? parseGitRevision(revisionResult.stdout) : undefined;
  if (!revision || statusResult.code !== 0) return { tree: "unknown" };
  return { revision, tree: statusResult.stdout.trim().length === 0 ? "clean" : "dirty" };
}

export function parseCapabilityEvidenceInspection(value: unknown): CapabilityEvidenceInspection {
  if (!isRecord(value) || !isRecord(value.artifact)) return { artifact: { state: "invalid" }, state: "invalid" };
  const exactKeys = (record: Record<string, unknown>, keys: readonly string[]): boolean => {
    const actual = Object.keys(record).sort();
    const expected = [...keys].sort();
    return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
  };
  if (value.state !== "missing" && value.state !== "invalid" && value.state !== "running" && value.state !== "completed") {
    return { artifact: { state: "invalid" }, state: "invalid" };
  }
  const artifactState = value.artifact.state;
  if (artifactState !== "missing" && artifactState !== "invalid" && artifactState !== "parsed") {
    return { artifact: { state: "invalid" }, state: "invalid" };
  }
  const artifactKeysValid = artifactState === "parsed"
    ? exactKeys(value.artifact, ["state", "value"])
    : exactKeys(value.artifact, ["state"]);
  if (!artifactKeysValid) return { artifact: { state: "invalid" }, state: "invalid" };
  const fingerprintValid = typeof value.fingerprint === "string" && /^[0-9a-f]{64}$/u.test(value.fingerprint);
  if (value.state === "completed" && (!exactKeys(value, ["artifact", "fingerprint", "state", "status"])
    || !fingerprintValid || artifactState !== "parsed"
    || (value.status !== "passed" && value.status !== "failed" && value.status !== "unverified"))) {
    return { artifact: { state: "invalid" }, state: "invalid" };
  }
  if (value.state === "running" && (!exactKeys(value, ["artifact", "fingerprint", "state"]) || !fingerprintValid)) {
    return { artifact: { state: "invalid" }, state: "invalid" };
  }
  if ((value.state === "missing" || value.state === "invalid") && !exactKeys(value, ["artifact", "state"])) {
    return { artifact: { state: "invalid" }, state: "invalid" };
  }
  return {
    artifact: artifactState === "parsed"
      ? { state: "parsed", value: value.artifact.value }
      : { state: artifactState },
    ...(typeof value.fingerprint === "string" ? { fingerprint: value.fingerprint } : {}),
    state: value.state,
    ...(value.status === "passed" || value.status === "failed" || value.status === "unverified"
      ? { status: value.status }
      : {})
  };
}

async function inspectCapabilityEvidence(
  reportFile: string,
  allowedRoot: string,
  workspaceDir: string,
  run: ReadOnlyCommandRunner
): Promise<CapabilityEvidenceInspection> {
  const helper = join(workspaceDir, "scripts", "eval-agent-evidence.mjs");
  if (!existsSync(helper)) return { artifact: { state: "invalid" }, state: "invalid" };
  const result = await run(process.execPath, [
    helper,
    "--inspect",
    "--report-path",
    reportFile,
    "--allowed-root",
    allowedRoot
  ], { cwd: workspaceDir });
  if (result.code !== 0) return { artifact: { state: "invalid" }, state: "invalid" };
  try {
    return parseCapabilityEvidenceInspection(JSON.parse(result.stdout) as unknown);
  } catch {
    return { artifact: { state: "invalid" }, state: "invalid" };
  }
}

async function defaultArtifactDigest(
  workspaceDir: string,
  artifactRoot: string,
  run: ReadOnlyCommandRunner
): Promise<ArtifactEvidenceSnapshot> {
  const helper = join(workspaceDir, "scripts", "eval-agent-artifacts.mjs");
  if (!existsSync(helper)) return { count: 0, status: "unknown" };
  const result = await run(
    process.execPath,
    [helper, "--json", "--artifact-root", artifactRoot],
    { cwd: workspaceDir }
  );
  if (result.code !== 0) return { count: 0, status: "unknown" };
  try {
    const parsed = JSON.parse(result.stdout) as unknown;
    if (!isRecord(parsed) || parsed.status !== "ok" || typeof parsed.digest !== "string"
      || !/^[0-9a-f]{64}$/u.test(parsed.digest) || typeof parsed.count !== "number"
      || !Number.isSafeInteger(parsed.count) || parsed.count <= 0) return { count: 0, status: "unknown" };
    return { count: parsed.count, digest: parsed.digest, status: "ok" };
  } catch {
    return { count: 0, status: "unknown" };
  }
}

function maxEvidenceAgeMs(value: number | undefined): number {
  const hours = value ?? DEFAULT_CAPABILITY_EVIDENCE_MAX_AGE_HOURS;
  if (!Number.isFinite(hours) || hours <= 0 || hours > DEFAULT_CAPABILITY_EVIDENCE_MAX_AGE_HOURS) {
    throw new Error(`--max-evidence-age-hours must be > 0 and <= ${DEFAULT_CAPABILITY_EVIDENCE_MAX_AGE_HOURS.toString()}`);
  }
  return hours * 60 * 60_000;
}

/**
 * Read the daemon's resident-runtime evidence once, without changing service
 * state. Qualification and `muse doctor` deliberately share this collector so
 * an API summary cannot mask a broken LaunchAgent, stale heartbeat, or orphan
 * development process tree.
 */
async function inspectResidentDaemonRuntime(
  dependencies: QualificationProbeDependencies = {}
): Promise<ResidentDaemonInspection> {
  return dependencies.residentInspection
    ? dependencies.residentInspection()
    : inspectResidentDaemon(dependencies);
}

/** Public, privacy-safe resident daemon observation for local diagnostics. */
export async function collectResidentDaemonRuntime(
  dependencies: QualificationProbeDependencies = {}
): Promise<RuntimeQualificationObservation> {
  const resident = await inspectResidentDaemonRuntime(dependencies);
  return { ...resident.observation, health: resident.health };
}

/**
 * Collect the one canonical, privacy-safe delivery-safety result used by
 * qualification and CLI Doctor. The optional resident inspection prevents
 * qualification from probing the service manager twice.
 */
export async function collectDeliverySafetyObservation(
  dependencies: QualificationProbeDependencies = {},
  options: {
    readonly nowMs?: number;
    readonly resident?: ResidentDaemonInspection;
  } = {}
): Promise<DeliveryQualificationObservation> {
  const residentInspection = options.resident
    ? async () => options.resident!
    : dependencies.residentInspection
      ?? (() => inspectResidentDaemon(dependencies));
  const nowMs = options.nowMs;
  const diagnostic = await collectDeliverySafetyDiagnostic({
    env: dependencies.env,
    now: nowMs === undefined
      ? dependencies.now
      : () => new Date(nowMs),
    residentInspection
  });
  const { runtime: _runtime, ...delivery } = diagnostic;
  return delivery;
}

/** One resident snapshot reduced to the two privacy-safe Doctor projections. */
export async function collectResidentDeliverySafety(
  dependencies: QualificationProbeDependencies = {}
): Promise<{
  readonly delivery: DeliveryQualificationObservation;
  readonly runtime: RuntimeQualificationObservation;
}> {
  const diagnostic = await collectDeliverySafetyDiagnostic({
    env: dependencies.env,
    now: dependencies.now,
    residentInspection: dependencies.residentInspection
      ?? (() => inspectResidentDaemon(dependencies))
  });
  const { runtime, ...delivery } = diagnostic;
  return {
    delivery,
    runtime
  };
}

export async function collectPersonalAgentQualificationObservations(
  options: CollectQualificationOptions,
  dependencies: QualificationProbeDependencies = {}
): Promise<PersonalAgentQualificationObservations> {
  const run = dependencies.run ?? defaultRun;
  const workspaceDir = resolve(options.workspaceDir);
  const reportFile = options.capabilityReportFile
    ? resolve(options.capabilityReportFile)
    : undefined;
  const now = dependencies.now ?? (() => new Date());
  const nowDate = now();
  const nowMs = nowDate.getTime();
  const currentSourceStart = await inspectGitSnapshot(workspaceDir, run);
  const reportDirectory = reportFile ? dirname(reportFile) : undefined;
  const allowedEvidenceRoot = reportDirectory
    ? (basename(reportDirectory) === "agent-capability" ? dirname(reportDirectory) : reportDirectory)
    : undefined;
  const capabilityEvidence = dependencies.capabilityEvidence
    ?? ((file: string, root: string, workspace: string) => inspectCapabilityEvidence(file, root, workspace, run));
  const unconfiguredCapabilityEvidence: CapabilityEvidenceInspection = {
    artifact: { state: "missing" },
    state: "missing"
  };
  const initialCapabilityEvidencePromise = reportFile && allowedEvidenceRoot
    ? capabilityEvidence(reportFile, allowedEvidenceRoot, workspaceDir)
    : Promise.resolve(unconfiguredCapabilityEvidence);
  const artifactDigestPromise = allowedEvidenceRoot
    ? dependencies.artifactDigest
      ? dependencies.artifactDigest(workspaceDir, allowedEvidenceRoot)
      : defaultArtifactDigest(workspaceDir, allowedEvidenceRoot, run)
    : Promise.resolve({ count: 0, status: "unknown" } as const);
  const [residentDelivery, initialCapabilityEvidence, currentArtifacts] = await Promise.all([
    collectResidentDeliverySafety({
      ...dependencies,
      now: () => new Date(nowMs)
    }),
    initialCapabilityEvidencePromise,
    artifactDigestPromise
  ]);
  const currentSourceEnd = await inspectGitSnapshot(workspaceDir, run);
  const finalCapabilityEvidence = reportFile && allowedEvidenceRoot
    ? await capabilityEvidence(reportFile, allowedEvidenceRoot, workspaceDir)
    : unconfiguredCapabilityEvidence;
  const capabilityEvidenceStable = initialCapabilityEvidence.state === finalCapabilityEvidence.state
    && initialCapabilityEvidence.status === finalCapabilityEvidence.status
    && initialCapabilityEvidence.fingerprint === finalCapabilityEvidence.fingerprint;

  return {
    capability: {
      artifact: initialCapabilityEvidence.artifact,
      attempt: {
        stable: capabilityEvidenceStable,
        state: initialCapabilityEvidence.state,
        ...(initialCapabilityEvidence.status ? { status: initialCapabilityEvidence.status } : {})
      },
      currentArtifacts,
      currentSourceEnd,
      currentSourceStart,
      maxAgeMs: maxEvidenceAgeMs(options.maxEvidenceAgeHours)
    },
    delivery: residentDelivery.delivery,
    now: nowDate,
    runtime: residentDelivery.runtime
  };
}
