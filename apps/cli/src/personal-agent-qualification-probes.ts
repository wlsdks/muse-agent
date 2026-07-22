/** Read-only operational probes for `muse qualify`. Raw/private values stop here. */

import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { resolveFollowupsFile, resolveRemindersFile } from "@muse/autoconfigure";
import { isLocalOnlyEnabled } from "@muse/model";
import {
  inspectResidentDaemon,
  inspectResidentOrphanApiProcesses,
  type ResidentDaemonInspection
} from "@muse/runtime-state";
import { readDaemonConfig, resolveDaemonConfigFile } from "./commands-daemon-config.js";
import {
  DEFAULT_CAPABILITY_EVIDENCE_MAX_AGE_HOURS,
  type ArtifactEvidenceSnapshot,
  type BacklogCountObservation,
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
  readonly artifactDigest?: (workspaceDir: string) => Promise<ArtifactEvidenceSnapshot>;
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

interface TextReadResult {
  readonly state: "missing" | "ok" | "unreadable";
  readonly text?: string;
}

const FALSE_VALUES = new Set(["0", "false", "no", "off"]);

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

async function readText(path: string): Promise<TextReadResult> {
  try {
    return { state: "ok", text: await readFile(path, "utf8") };
  } catch (cause) {
    return cause && typeof cause === "object" && "code" in cause && cause.code === "ENOENT"
      ? { state: "missing" }
      : { state: "unreadable" };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function readStrictBacklogCounts(
  file: string,
  kind: "followups" | "reminders",
  nowMs: number
): Promise<BacklogCountObservation> {
  const read = await readText(file);
  if (read.state === "missing") return { overdue: 0, scheduled: 0, status: "ok" };
  if (read.state !== "ok" || read.text === undefined) return { overdue: 0, scheduled: 0, status: "unverified" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(read.text) as unknown;
  } catch {
    return { overdue: 0, scheduled: 0, status: "unverified" };
  }
  if (!isRecord(parsed) || !Array.isArray(parsed[kind])) return { overdue: 0, scheduled: 0, status: "unverified" };

  let scheduled = 0;
  let overdue = 0;
  for (const row of parsed[kind] as unknown[]) {
    if (!isRecord(row)) return { overdue: 0, scheduled: 0, status: "unverified" };
    if (kind === "followups") {
      if (row.status !== "scheduled" && row.status !== "fired" && row.status !== "cancelled") {
        return { overdue: 0, scheduled: 0, status: "unverified" };
      }
      if (row.status !== "scheduled") continue;
      if (typeof row.scheduledFor !== "string") return { overdue: 0, scheduled: 0, status: "unverified" };
      const at = Date.parse(row.scheduledFor);
      if (!Number.isFinite(at)) return { overdue: 0, scheduled: 0, status: "unverified" };
      scheduled += 1;
      if (at <= nowMs) overdue += 1;
      continue;
    }
    if (row.status !== "pending" && row.status !== "fired") return { overdue: 0, scheduled: 0, status: "unverified" };
    if (row.status !== "pending") continue;
    if (typeof row.dueAt !== "string") return { overdue: 0, scheduled: 0, status: "unverified" };
    const at = Date.parse(row.dueAt);
    if (!Number.isFinite(at)) return { overdue: 0, scheduled: 0, status: "unverified" };
    scheduled += 1;
    if (at <= nowMs) overdue += 1;
  }
  return { overdue, scheduled, status: "ok" };
}

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

async function defaultArtifactDigest(workspaceDir: string, run: ReadOnlyCommandRunner): Promise<ArtifactEvidenceSnapshot> {
  const helper = join(workspaceDir, "scripts", "eval-agent-artifacts.mjs");
  if (!existsSync(helper)) return { count: 0, status: "unknown" };
  const result = await run(process.execPath, [helper, "--json"], { cwd: workspaceDir });
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

function parseProviderFlag(args: readonly string[]): string | undefined {
  for (let index = 3; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === "--provider") return args[index + 1]?.trim() || undefined;
    if (arg.startsWith("--provider=")) return arg.slice("--provider=".length).trim() || undefined;
  }
  return undefined;
}

function isExplicitlyDisabled(value: string | undefined): boolean {
  return value !== undefined && FALSE_VALUES.has(value.trim().toLowerCase());
}

function strictDaemonConfigProvider(file: string): { readonly status: "ok" | "unverified"; readonly provider?: string } {
  // `readDaemonConfig` is read-only, but it intentionally collapses malformed
  // input to defaults. The caller performs a raw strict check first.
  try {
    const raw = requireReadFileSync(file);
    if (raw === undefined) return { status: "ok" };
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) return { status: "unverified" };
    if (parsed.provider !== undefined && typeof parsed.provider !== "string") return { status: "unverified" };
    const config = readDaemonConfig(file);
    return { status: "ok", ...(config.provider ? { provider: config.provider } : {}) };
  } catch {
    return { status: "unverified" };
  }
}

// Sync only because the existing daemon config primitive is sync; no mutation,
// quarantine, or path-bearing error leaves this module.
function requireReadFileSync(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8");
  } catch (cause) {
    if (cause && typeof cause === "object" && "code" in cause && cause.code === "ENOENT") return undefined;
    throw cause;
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
  return inspectResidentDaemon(dependencies);
}

/** Public, privacy-safe resident daemon observation for local diagnostics. */
export async function collectResidentDaemonRuntime(
  dependencies: QualificationProbeDependencies = {}
): Promise<RuntimeQualificationObservation> {
  return (await inspectResidentDaemonRuntime(dependencies)).observation;
}

export async function collectPersonalAgentQualificationObservations(
  options: CollectQualificationOptions,
  dependencies: QualificationProbeDependencies = {}
): Promise<PersonalAgentQualificationObservations> {
  const run = dependencies.run ?? defaultRun;
  const workspaceDir = resolve(options.workspaceDir);
  const reportFile = options.capabilityReportFile ?? join(workspaceDir, ".muse-dev", "evals", "agent-capability", "latest.json");
  const now = dependencies.now ?? (() => new Date());
  const nowDate = now();
  const nowMs = nowDate.getTime();
  const currentSourceStart = await inspectGitSnapshot(workspaceDir, run);
  const allowedEvidenceRoot = options.capabilityReportFile === undefined ? workspaceDir : dirname(reportFile);
  const capabilityEvidence = dependencies.capabilityEvidence
    ?? ((file: string, root: string, workspace: string) => inspectCapabilityEvidence(file, root, workspace, run));
  const initialCapabilityEvidencePromise = capabilityEvidence(
    reportFile,
    allowedEvidenceRoot,
    workspaceDir
  );
  const artifactDigestPromise = dependencies.artifactDigest
    ? dependencies.artifactDigest(workspaceDir)
    : defaultArtifactDigest(workspaceDir, run);
  const resident = await inspectResidentDaemonRuntime(dependencies);
  const { effectiveRuntimeEnv, diskArguments, liveArguments, liveEnvironment } = resident;

  const configResult = strictDaemonConfigProvider(resolveDaemonConfigFile(effectiveRuntimeEnv));
  const provider = parseProviderFlag(liveArguments ?? diskArguments ?? [])
    ?? effectiveRuntimeEnv.MUSE_PROACTIVE_PROVIDER?.trim()
    ?? configResult.provider?.trim()
    ?? "log";
  const environmentProbe: DeliveryQualificationObservation["environmentProbe"] = liveEnvironment
    && liveArguments
    && resident.observation.liveDefinitionMatches
    && configResult.status === "ok"
    ? "ok"
    : "unverified";
  const [followups, reminders, initialCapabilityEvidence, currentArtifacts] = await Promise.all([
    readStrictBacklogCounts(resolveFollowupsFile(effectiveRuntimeEnv), "followups", nowMs),
    readStrictBacklogCounts(resolveRemindersFile(effectiveRuntimeEnv), "reminders", nowMs),
    initialCapabilityEvidencePromise,
    artifactDigestPromise
  ]);
  const currentSourceEnd = await inspectGitSnapshot(workspaceDir, run);
  const finalCapabilityEvidence = await capabilityEvidence(reportFile, allowedEvidenceRoot, workspaceDir);
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
    delivery: {
      baseProviderLocalLog: provider === "log",
      brakeEngaged: isExplicitlyDisabled(effectiveRuntimeEnv.MUSE_DAEMON_DELIVERY_ENABLED),
      environmentProbe,
      followups,
      localOnly: isLocalOnlyEnabled(effectiveRuntimeEnv),
      providerLockLog: effectiveRuntimeEnv.MUSE_DAEMON_PROVIDER_LOCK?.trim() === "log",
      reminders,
      selfLearnDisabled: isExplicitlyDisabled(effectiveRuntimeEnv.MUSE_SELFLEARN_ENABLED)
    },
    now: nowDate,
    runtime: resident.observation
  };
}
