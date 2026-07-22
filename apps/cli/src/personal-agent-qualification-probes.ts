/** Read-only operational probes for `muse qualify`. Raw/private values stop here. */

import { execFile } from "node:child_process";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { resolveFollowupsFile, resolveRemindersFile } from "@muse/autoconfigure";
import { isLocalOnlyEnabled } from "@muse/model";

import {
  defaultDaemonTemporaryRoots,
  parseLaunchAgentEnvironmentVariables,
  parseLaunchAgentProgramArguments,
  parseLaunchctlPrintSnapshot,
  validateDaemonCliEntry
} from "./commands-daemon-autostart.js";
import { readDaemonConfig, resolveDaemonConfigFile } from "./commands-daemon-config.js";
import { LAUNCH_AGENT_LABEL, parseLaunchctlListInfo, resolveLaunchAgentFile } from "./commands-daemon-launchagent.js";
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

interface ProcessRow {
  readonly pid: number;
  readonly ppid: number;
  readonly command: string;
}

const DAEMON_HEARTBEAT_STALE_MS = 3 * 60_000;
const FALSE_VALUES = new Set(["0", "false", "no", "off"]);
const API_DEV_ENTRY_PATTERN = /(?:^|[\s/])tsx(?:\/dist\/cli\.mjs)?(?:\s|$)[\s\S]*\bsrc\/index\.ts(?:\s|$)/u;

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

function parseProcessTable(output: string): readonly ProcessRow[] | undefined {
  const rows: ProcessRow[] = [];
  for (const line of output.split(/\r?\n/u)) {
    if (line.trim().length === 0) continue;
    const match = /^\s*(\d+)\s+(\d+)\s+([\s\S]+)$/u.exec(line);
    if (!match) return undefined;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(ppid) || ppid < 0) return undefined;
    rows.push({ command: match[3] ?? "", pid, ppid });
  }
  return rows;
}

function cwdFromLsof(output: string, pid: number): string | undefined {
  const lines = output.split(/\r?\n/u);
  if (!lines.includes(`p${pid.toString()}`)) return undefined;
  const paths = lines.filter((line) => line.startsWith("n")).map((line) => line.slice(1)).filter(Boolean);
  return paths.length === 1 ? paths[0] : undefined;
}

function descendantIds(rows: readonly ProcessRow[], roots: ReadonlySet<number>): Set<number> {
  const found = new Set(roots);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (!found.has(row.pid) && found.has(row.ppid)) {
        found.add(row.pid);
        changed = true;
      }
    }
  }
  return found;
}

export async function inspectOrphanApiProcesses(
  platform: NodeJS.Platform,
  run: ReadOnlyCommandRunner
): Promise<Pick<RuntimeQualificationObservation, "orphanProbe" | "orphanRootCount" | "orphanProcessCount">> {
  if (platform !== "darwin") return { orphanProbe: "unverified", orphanProcessCount: 0, orphanRootCount: 0 };
  const table = await run("ps", ["-axo", "pid=,ppid=,command="]);
  if (table.code !== 0) return { orphanProbe: "unverified", orphanProcessCount: 0, orphanRootCount: 0 };
  const rows = parseProcessTable(table.stdout);
  if (!rows) return { orphanProbe: "unverified", orphanProcessCount: 0, orphanRootCount: 0 };

  const candidateRoots = rows.filter((row) => row.ppid === 1 && API_DEV_ENTRY_PATTERN.test(row.command));
  const roots = new Set<number>();
  for (const candidate of candidateRoots) {
    const cwd = await run("lsof", ["-a", "-p", candidate.pid.toString(), "-d", "cwd", "-Fn"]);
    if (cwd.code !== 0) return { orphanProbe: "unverified", orphanProcessCount: 0, orphanRootCount: 0 };
    const resolvedCwd = cwdFromLsof(cwd.stdout, candidate.pid);
    if (resolvedCwd === undefined) return { orphanProbe: "unverified", orphanProcessCount: 0, orphanRootCount: 0 };
    if (resolvedCwd.replace(/\/+$/u, "").endsWith("/apps/api")) roots.add(candidate.pid);
  }
  const all = descendantIds(rows, roots);
  return { orphanProbe: "ok", orphanProcessCount: all.size, orphanRootCount: roots.size };
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

function isPathInside(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot.length > 0
    && pathFromRoot !== ".."
    && !pathFromRoot.startsWith(`..${sep}`)
    && !isAbsolute(pathFromRoot);
}

function capabilityArtifactPathIsSafe(path: string, allowedRoot?: string): boolean {
  const candidate = resolve(path);
  const root = allowedRoot ? resolve(allowedRoot) : dirname(candidate);
  if (allowedRoot && !isPathInside(root, candidate)) return false;
  try {
    if (allowedRoot) {
      const rootStat = lstatSync(root);
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return false;
      let current = root;
      for (const segment of relative(root, candidate).split(sep)) {
        if (!segment) continue;
        current = join(current, segment);
        if (!existsSync(current)) return true;
        if (lstatSync(current).isSymbolicLink()) return false;
      }
    }
    if (!existsSync(candidate)) return true;
    const stat = lstatSync(candidate);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > 2 * 1024 * 1024) return false;
    return process.platform === "win32" || (stat.mode & 0o777) === 0o600;
  } catch {
    return false;
  }
}

async function readCapabilityArtifact(path: string, allowedRoot?: string): Promise<CapabilityArtifactObservation> {
  if (!capabilityArtifactPathIsSafe(path, allowedRoot)) return { state: "invalid" };
  const read = await readText(path);
  if (read.state === "missing") return { state: "missing" };
  if (read.state !== "ok" || read.text === undefined) return { state: "invalid" };
  try {
    return { state: "parsed", value: JSON.parse(read.text) as unknown };
  } catch {
    return { state: "invalid" };
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

function effectiveHome(env: Readonly<Record<string, string | undefined>>): string | undefined {
  return env.HOME?.trim() || env.USERPROFILE?.trim() || undefined;
}

function heartbeatFileFor(env: Readonly<Record<string, string | undefined>>): string | undefined {
  const sidecar = env.MUSE_PROACTIVE_SIDECAR_FILE?.trim();
  if (sidecar) return join(dirname(sidecar), "proactive-heartbeat-daemon-loop.json");
  const home = effectiveHome(env);
  return home ? join(home, ".muse", "proactive-heartbeat-daemon-loop.json") : undefined;
}

async function readHeartbeat(
  file: string | undefined,
  nowMs: number,
  processStartMs: number | undefined,
  expectedPid: number | undefined
): Promise<{ readonly state: RuntimeQualificationObservation["heartbeat"]; readonly pidMatches: boolean }> {
  if (!file) return { pidMatches: false, state: "unknown" };
  const read = await readText(file);
  if (read.state === "missing") return { pidMatches: false, state: "missing" };
  if (read.state !== "ok" || read.text === undefined) return { pidMatches: false, state: "invalid" };
  try {
    const parsed = JSON.parse(read.text) as unknown;
    if (!isRecord(parsed) || typeof parsed.at !== "string" || typeof parsed.pid !== "number"
      || !Number.isSafeInteger(parsed.pid) || parsed.pid <= 0) return { pidMatches: false, state: "invalid" };
    const at = Date.parse(parsed.at);
    if (!Number.isFinite(at)) return { pidMatches: false, state: "invalid" };
    if (at > nowMs) return { pidMatches: parsed.pid === expectedPid, state: "future" };
    if (processStartMs === undefined) return { pidMatches: parsed.pid === expectedPid, state: "unknown" };
    if (at < processStartMs) return { pidMatches: parsed.pid === expectedPid, state: "before-process" };
    if (nowMs - at > DAEMON_HEARTBEAT_STALE_MS) return { pidMatches: parsed.pid === expectedPid, state: "stale" };
    return { pidMatches: parsed.pid === expectedPid, state: "fresh" };
  } catch {
    return { pidMatches: false, state: "invalid" };
  }
}

async function processStartTime(pid: number | undefined, run: ReadOnlyCommandRunner): Promise<number | undefined> {
  if (pid === undefined) return undefined;
  const result = await run("ps", ["-p", pid.toString(), "-o", "lstart="]);
  if (result.code !== 0) return undefined;
  const parsed = Date.parse(result.stdout.trim());
  return Number.isFinite(parsed) ? parsed : undefined;
}

function runtimeStateFromList(result: ReadOnlyCommandResult): {
  readonly state: RuntimeQualificationObservation["runtime"];
  readonly pid?: number;
} {
  if (result.code !== 0) {
    const safeClassification = `${result.stderr}\n${result.stdout}`;
    return /could not find|not found|no such (?:process|service)/iu.test(safeClassification)
      ? { state: "not-registered" }
      : { state: "unknown" };
  }
  const info = parseLaunchctlListInfo(result.stdout);
  if (info.pid !== undefined) return { pid: info.pid, state: "running" };
  if (info.lastExitStatus !== undefined && info.lastExitStatus !== 0) return { state: "crash-looping" };
  return { state: "not-running" };
}

function sameRelevantEnvironment(
  disk: Readonly<Record<string, string>>,
  live: Readonly<Record<string, string>>
): boolean {
  return Object.entries(disk).every(([key, value]) => {
    // launchctl may omit account-home variables that the child inherits from
    // its user context. Their absence is not evidence that a persisted safety
    // definition drifted; every other disk variable remains strict.
    if ((key === "HOME" || key === "USERPROFILE") && live[key] === undefined) return true;
    return live[key] === value;
  });
}

function stableLiveCommand(
  args: readonly string[],
  temporaryRoots: readonly string[]
): boolean {
  if (args.length !== 3 || args[2] !== "daemon" || !isAbsolute(args[0] ?? "") || !existsSync(args[0] ?? "")) return false;
  return validateDaemonCliEntry(args[1], { temporaryRoots }).ok;
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

interface ResidentDaemonRuntimeInspection {
  readonly effectiveRuntimeEnv: NodeJS.ProcessEnv;
  readonly diskArguments?: readonly string[];
  readonly liveArguments?: readonly string[];
  readonly liveEnvironment?: Readonly<Record<string, string>>;
  readonly observation: RuntimeQualificationObservation;
}

/**
 * Read the daemon's resident-runtime evidence once, without changing service
 * state. Qualification and `muse doctor` deliberately share this collector so
 * an API summary cannot mask a broken LaunchAgent, stale heartbeat, or orphan
 * development process tree.
 */
async function inspectResidentDaemonRuntime(
  dependencies: QualificationProbeDependencies = {}
): Promise<ResidentDaemonRuntimeInspection> {
  const env = dependencies.env ?? process.env;
  const platform = dependencies.platform ?? process.platform;
  const now = dependencies.now ?? (() => new Date());
  const run = dependencies.run ?? defaultRun;
  const nowDate = now();
  const nowMs = nowDate.getTime();

  let artifact: RuntimeQualificationObservation["artifact"];
  let autostartProbe: RuntimeQualificationObservation["autostartProbe"];
  let runtime: RuntimeQualificationObservation["runtime"] = "unknown";
  let liveProbe: RuntimeQualificationObservation["liveProbe"] = "unverified";
  let liveDefinitionMatches = false;
  let stableMuseCommand = false;
  let listPid: number | undefined;
  let livePid: number | undefined;
  let diskEnvironment: Readonly<Record<string, string>> | undefined;
  let liveEnvironment: Readonly<Record<string, string>> | undefined;
  let diskArguments: readonly string[] | undefined;
  let liveArguments: readonly string[] | undefined;
  const plistFile = resolveLaunchAgentFile(env);
  const plist = await readText(plistFile);
  if (plist.state === "missing") {
    artifact = "missing";
    autostartProbe = "ok";
  } else if (plist.state !== "ok" || plist.text === undefined) {
    artifact = "invalid";
    autostartProbe = "ok";
  } else {
    diskArguments = parseLaunchAgentProgramArguments(plist.text);
    diskEnvironment = parseLaunchAgentEnvironmentVariables(plist.text);
    if (!diskArguments || diskArguments.length < 3 || diskEnvironment === undefined) {
      artifact = "invalid";
    } else {
      const entry = validateDaemonCliEntry(diskArguments[1], {
        temporaryRoots: dependencies.daemonTemporaryRoots ?? defaultDaemonTemporaryRoots(env)
      });
      artifact = entry.ok && isAbsolute(diskArguments[0] ?? "") && existsSync(diskArguments[0] ?? "") ? "valid" : "stale";
    }
    autostartProbe = "ok";
  }

  if (platform === "darwin") {
    const list = await run("launchctl", ["list", LAUNCH_AGENT_LABEL]);
    const listed = runtimeStateFromList(list);
    runtime = listed.state;
    listPid = listed.pid;
    const uid = dependencies.uid ?? (typeof process.getuid === "function" ? process.getuid() : undefined);
    if (uid !== undefined && runtime === "running") {
      const printed = await run("launchctl", ["print", `gui/${uid.toString()}/${LAUNCH_AGENT_LABEL}`]);
      const snapshot = printed.code === 0 ? parseLaunchctlPrintSnapshot(printed.stdout) : undefined;
      if (snapshot) {
        liveProbe = "ok";
        livePid = snapshot.pid;
        liveArguments = snapshot.arguments;
        liveEnvironment = snapshot.environment;
        liveDefinitionMatches = diskArguments !== undefined && diskEnvironment !== undefined
          && JSON.stringify(snapshot.arguments) === JSON.stringify(diskArguments)
          && sameRelevantEnvironment(diskEnvironment, snapshot.environment);
        stableMuseCommand = stableLiveCommand(
          snapshot.arguments,
          dependencies.daemonTemporaryRoots ?? defaultDaemonTemporaryRoots(env)
        );
      }
    }
  }

  const processStartMs = await processStartTime(livePid, run);
  // launchctl's effective job environment often omits HOME even though the
  // daemon resolves its default stores from the OS account home. Keep live
  // service variables authoritative, but carry only that host location
  // fallback so heartbeat discovery does not become a false PID mismatch.
  const hostHome = effectiveHome(env);
  const effectiveRuntimeEnv: NodeJS.ProcessEnv = liveEnvironment
    ? {
        ...liveEnvironment,
        ...(liveEnvironment.HOME?.trim() || liveEnvironment.USERPROFILE?.trim() || !hostHome
          ? {}
          : { HOME: hostHome })
      }
    : { ...env, ...(diskEnvironment ?? {}) };
  const heartbeat = await readHeartbeat(heartbeatFileFor(effectiveRuntimeEnv), nowMs, processStartMs, livePid);
  const orphan = await inspectOrphanApiProcesses(platform, run);
  const pidAgreement = listPid !== undefined && livePid !== undefined && listPid === livePid && heartbeat.pidMatches;

  return {
    diskArguments,
    effectiveRuntimeEnv,
    liveArguments,
    liveEnvironment,
    observation: {
      artifact,
      autostartProbe,
      heartbeat: heartbeat.state,
      liveDefinitionMatches,
      liveProbe,
      ...orphan,
      pidAgreement,
      platform,
      runtime,
      stableMuseCommand
    }
  };
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
  const capabilityArtifactPromise = readCapabilityArtifact(
    reportFile,
    options.capabilityReportFile === undefined ? workspaceDir : undefined
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
  const [followups, reminders, capabilityArtifact, currentArtifacts] = await Promise.all([
    readStrictBacklogCounts(resolveFollowupsFile(effectiveRuntimeEnv), "followups", nowMs),
    readStrictBacklogCounts(resolveRemindersFile(effectiveRuntimeEnv), "reminders", nowMs),
    capabilityArtifactPromise,
    artifactDigestPromise
  ]);
  const currentSourceEnd = await inspectGitSnapshot(workspaceDir, run);

  return {
    capability: {
      artifact: capabilityArtifact,
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
