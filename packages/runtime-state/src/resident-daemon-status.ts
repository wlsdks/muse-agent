import { execFile } from "node:child_process";
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export const MUSE_LAUNCH_AGENT_LABEL = "com.muse.daemon";
export const RESIDENT_DAEMON_HEARTBEAT_MAX_AGE_MS = 3 * 60_000;

export interface ResidentDaemonObservation {
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

export interface ResidentDaemonInspection {
  readonly effectiveRuntimeEnv: NodeJS.ProcessEnv;
  readonly diskArguments?: readonly string[];
  readonly health: ResidentDaemonHealthResult;
  readonly liveArguments?: readonly string[];
  readonly liveEnvironment?: Readonly<Record<string, string>>;
  readonly processInventory: ResidentMuseProcessInventory;
  readonly observation: ResidentDaemonObservation;
}

export type ResidentMuseProcessRole = "resident" | "orphan-api" | "orphan-api-descendant";

export interface ResidentMuseProcess {
  readonly pid: number;
  readonly ppid: number;
  readonly cwd: string;
  readonly executableRealpath: string;
  readonly startedAt: string;
  readonly role: ResidentMuseProcessRole;
  readonly matchesLaunchdPid: boolean;
}

export type ResidentInventoryCondition =
  | "artifact-only"
  | "process-only"
  | "duplicate"
  | "orphan"
  | "healthy"
  | "degraded"
  | "unverified";

export interface ResidentMuseProcessInventory {
  readonly probe: "ok" | "unverified";
  readonly processes: readonly ResidentMuseProcess[];
  readonly museProcessCount: number;
  readonly residentProcessCount: number;
  readonly duplicateResidentProcessCount: number;
  readonly conditions: readonly ResidentInventoryCondition[];
}

export const RESIDENT_DAEMON_HEALTH_REASON = {
  artifactInvalid: "daemon-artifact-invalid",
  artifactMissing: "daemon-artifact-missing",
  artifactStale: "daemon-artifact-stale",
  autostartProbeUnverified: "daemon-probe-unverified",
  commandUnstable: "daemon-command-not-stable-muse-entry",
  crashLooping: "daemon-crash-looping",
  definitionMismatch: "daemon-live-definition-mismatch",
  duplicateResidents: "duplicate-resident-processes-detected",
  heartbeatBeforeProcess: "daemon-heartbeat-before-process-start",
  heartbeatFuture: "daemon-heartbeat-future-dated",
  heartbeatInvalid: "daemon-heartbeat-invalid",
  heartbeatMissing: "daemon-heartbeat-missing",
  heartbeatStale: "daemon-heartbeat-stale",
  liveProbeUnverified: "daemon-live-probe-unverified",
  notRegistered: "daemon-not-registered",
  notRunning: "daemon-not-running",
  orphanProcesses: "orphan-api-processes-detected",
  pidMismatch: "daemon-pid-mismatch",
  platformUnverified: "background-runtime-platform-unverified",
  processProbeUnverified: "orphan-process-probe-unverified",
  residentProcessMissing: "resident-process-missing"
} as const;

export type ResidentDaemonHealthReasonCode =
  (typeof RESIDENT_DAEMON_HEALTH_REASON)[keyof typeof RESIDENT_DAEMON_HEALTH_REASON];

export interface ResidentDaemonHealthResult {
  readonly status: "healthy" | "failed" | "unverified";
  readonly reasonCodes: readonly ResidentDaemonHealthReasonCode[];
}

/** One fail-close resident truth shared by CLI status, Doctor, and qualification. */
export function classifyResidentDaemonHealth(
  observation: ResidentDaemonObservation,
  inventory: ResidentMuseProcessInventory
): ResidentDaemonHealthResult {
  const failed: ResidentDaemonHealthReasonCode[] = [];
  const unverified: ResidentDaemonHealthReasonCode[] = [];
  if (observation.platform !== "darwin") unverified.push(RESIDENT_DAEMON_HEALTH_REASON.platformUnverified);
  if (observation.autostartProbe !== "ok") unverified.push(RESIDENT_DAEMON_HEALTH_REASON.autostartProbeUnverified);
  if (observation.artifact === "missing") failed.push(RESIDENT_DAEMON_HEALTH_REASON.artifactMissing);
  else if (observation.artifact === "invalid") failed.push(RESIDENT_DAEMON_HEALTH_REASON.artifactInvalid);
  else if (observation.artifact === "stale") failed.push(RESIDENT_DAEMON_HEALTH_REASON.artifactStale);
  else if (observation.artifact === "unknown") unverified.push(RESIDENT_DAEMON_HEALTH_REASON.autostartProbeUnverified);

  if (observation.runtime === "not-registered") failed.push(RESIDENT_DAEMON_HEALTH_REASON.notRegistered);
  else if (observation.runtime === "not-running") failed.push(RESIDENT_DAEMON_HEALTH_REASON.notRunning);
  else if (observation.runtime === "crash-looping") failed.push(RESIDENT_DAEMON_HEALTH_REASON.crashLooping);
  else if (observation.runtime === "unknown") unverified.push(RESIDENT_DAEMON_HEALTH_REASON.autostartProbeUnverified);

  if (observation.liveProbe !== "ok") {
    unverified.push(RESIDENT_DAEMON_HEALTH_REASON.liveProbeUnverified);
  } else {
    if (!observation.liveDefinitionMatches) failed.push(RESIDENT_DAEMON_HEALTH_REASON.definitionMismatch);
    if (!observation.stableMuseCommand) failed.push(RESIDENT_DAEMON_HEALTH_REASON.commandUnstable);
    if (!observation.pidAgreement) failed.push(RESIDENT_DAEMON_HEALTH_REASON.pidMismatch);
  }

  if (observation.heartbeat === "missing") failed.push(RESIDENT_DAEMON_HEALTH_REASON.heartbeatMissing);
  else if (observation.heartbeat === "invalid" || observation.heartbeat === "unknown") {
    unverified.push(RESIDENT_DAEMON_HEALTH_REASON.heartbeatInvalid);
  } else if (observation.heartbeat === "stale") failed.push(RESIDENT_DAEMON_HEALTH_REASON.heartbeatStale);
  else if (observation.heartbeat === "future") unverified.push(RESIDENT_DAEMON_HEALTH_REASON.heartbeatFuture);
  else if (observation.heartbeat === "before-process") {
    unverified.push(RESIDENT_DAEMON_HEALTH_REASON.heartbeatBeforeProcess);
  }

  if (observation.orphanProbe !== "ok" || inventory.probe !== "ok") {
    unverified.push(RESIDENT_DAEMON_HEALTH_REASON.processProbeUnverified);
  } else {
    if (inventory.residentProcessCount === 0) failed.push(RESIDENT_DAEMON_HEALTH_REASON.residentProcessMissing);
    if (inventory.duplicateResidentProcessCount > 0 || inventory.residentProcessCount > 1) {
      failed.push(RESIDENT_DAEMON_HEALTH_REASON.duplicateResidents);
    }
    const matchingResidents = inventory.processes.filter((process_) =>
      process_.role === "resident" && process_.matchesLaunchdPid).length;
    if (inventory.residentProcessCount === 1 && matchingResidents !== 1) {
      failed.push(RESIDENT_DAEMON_HEALTH_REASON.pidMismatch);
    }
  }
  if (observation.orphanRootCount > 0 || observation.orphanProcessCount > 0) {
    failed.push(RESIDENT_DAEMON_HEALTH_REASON.orphanProcesses);
  }

  const reasonCodes = [...new Set([...failed, ...unverified])];
  return {
    reasonCodes,
    status: failed.length > 0 ? "failed" : unverified.length > 0 ? "unverified" : "healthy"
  };
}

export interface ReadOnlyProcessResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ReadOnlyProcessOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
}

export type ReadOnlyProcessRunner = (
  executable: string,
  args: readonly string[],
  options?: ReadOnlyProcessOptions
) => Promise<ReadOnlyProcessResult>;

export interface ResidentDaemonInspectionOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly now?: () => Date;
  readonly run?: ReadOnlyProcessRunner;
  readonly uid?: number;
  readonly daemonTemporaryRoots?: readonly string[];
  /** API status reads disable the broader orphan scan to keep their process probe allowlist narrow. */
  readonly inspectOrphans?: boolean;
}

interface ProcessRow {
  readonly pid: number;
  readonly ppid: number;
  readonly command: string;
}

interface ProcessInventoryProbe {
  readonly probe: "ok" | "unverified";
  readonly processes: readonly ResidentMuseProcess[];
  readonly orphanRootCount: number;
  readonly orphanProcessCount: number;
}

interface LaunchctlSnapshot {
  readonly arguments: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
  readonly pid: number;
}

async function defaultRun(
  executable: string,
  args: readonly string[],
  options: ReadOnlyProcessOptions = {}
): Promise<ReadOnlyProcessResult> {
  return new Promise((resolveResult) => {
    execFile(executable, [...args], {
      cwd: options.cwd,
      encoding: "utf8",
      env: options.env,
      maxBuffer: 2 * 1024 * 1024,
      timeout: 10_000
    }, (error, stdout, stderr) => {
      const code = error && "code" in error && typeof error.code === "number" ? error.code : error ? 1 : 0;
      resolveResult({ code, stderr: stderr ?? "", stdout: stdout ?? "" });
    });
  });
}

async function readText(file: string): Promise<{ readonly state: "missing" | "ok" | "unreadable"; readonly text?: string }> {
  try {
    return { state: "ok", text: await readFile(file, "utf8") };
  } catch (cause) {
    return cause && typeof cause === "object" && "code" in cause && cause.code === "ENOENT"
      ? { state: "missing" }
      : { state: "unreadable" };
  }
}

function xmlText(value: string): string | undefined {
  if (value.includes("<")) return undefined;
  if (value.replace(/&(amp|lt|gt|quot|apos);/gu, "").includes("&")) return undefined;
  return value.replace(/&(amp|lt|gt|quot|apos);/gu, (_entity, name: string) => {
    switch (name) {
      case "amp": return "&";
      case "lt": return "<";
      case "gt": return ">";
      case "quot": return "\"";
      case "apos": return "'";
      default: return "";
    }
  });
}

export function parseResidentLaunchAgentEnvironment(plist: string): Readonly<Record<string, string>> | undefined {
  const keys = [...plist.matchAll(/<key>\s*EnvironmentVariables\s*<\/key>/gu)];
  if (keys.length === 0) return {};
  if (keys.length !== 1) return undefined;
  const dictionaries = [...plist.matchAll(/<key>\s*EnvironmentVariables\s*<\/key>\s*(?:<dict\s*\/>|<dict>([\s\S]*?)<\/dict>)/gu)];
  if (dictionaries.length !== 1) return undefined;
  const body = dictionaries[0]?.[1] ?? "";
  const variables: Record<string, string> = {};
  let cursor = 0;
  for (const match of body.matchAll(/<key>([\s\S]*?)<\/key>\s*<string>([\s\S]*?)<\/string>/gu)) {
    const index = match.index ?? 0;
    if (body.slice(cursor, index).trim().length > 0) return undefined;
    const key = xmlText(match[1] ?? "");
    const value = xmlText(match[2] ?? "");
    if (key === undefined || key.length === 0 || key.trim() !== key || value === undefined || Object.hasOwn(variables, key)) {
      return undefined;
    }
    variables[key] = value;
    cursor = index + match[0].length;
  }
  return body.slice(cursor).trim().length === 0 ? variables : undefined;
}

export function parseResidentLaunchAgentArguments(plist: string): readonly string[] | undefined {
  if ([...plist.matchAll(/<key>\s*ProgramArguments\s*<\/key>/gu)].length !== 1) return undefined;
  const arrays = [...plist.matchAll(/<key>\s*ProgramArguments\s*<\/key>\s*<array>([\s\S]*?)<\/array>/gu)];
  if (arrays.length !== 1) return undefined;
  const body = arrays[0]?.[1] ?? "";
  const arguments_: string[] = [];
  let cursor = 0;
  for (const match of body.matchAll(/<string>([\s\S]*?)<\/string>/gu)) {
    const index = match.index ?? 0;
    if (body.slice(cursor, index).trim().length > 0) return undefined;
    const value = xmlText(match[1] ?? "");
    if (value === undefined) return undefined;
    arguments_.push(value);
    cursor = index + match[0].length;
  }
  return body.slice(cursor).trim().length === 0 && arguments_.length > 0 ? arguments_ : undefined;
}

function launchctlBlock(output: string, label: string, required = true): readonly string[] | undefined {
  const lines = output.split(/\r?\n/u);
  const starts = lines.flatMap((line, index) => line.trim() === `${label} = {` ? [index] : []);
  if (starts.length === 0 && !required) {
    return lines.some((line) => line.trim().startsWith(`${label} =`)) ? undefined : [];
  }
  if (starts.length !== 1) return undefined;
  const body: string[] = [];
  for (let index = starts[0]! + 1; index < lines.length; index += 1) {
    const line = lines[index]!.trim();
    if (line === "}") return body;
    if (line.endsWith("= {") || line.includes("{")) return undefined;
    if (line.length > 0) body.push(line);
  }
  return undefined;
}

function parseLaunchctlEnvironment(lines: readonly string[]): Readonly<Record<string, string>> | undefined {
  const environment: Record<string, string> = {};
  for (const line of lines) {
    const match = /^([A-Za-z_][A-Za-z\d_]*)\s*=>\s*(.*)$/u.exec(line);
    if (!match || Object.hasOwn(environment, match[1]!)) return undefined;
    environment[match[1]!] = match[2] ?? "";
  }
  return environment;
}

export function parseResidentLaunchctlSnapshot(output: string): LaunchctlSnapshot | undefined {
  const arguments_ = launchctlBlock(output, "arguments");
  const inherited = launchctlBlock(output, "inherited environment", false);
  const defaults = launchctlBlock(output, "default environment", false);
  const job = launchctlBlock(output, "environment");
  if (!arguments_?.length || !inherited || !defaults || !job) return undefined;
  const inheritedEnvironment = parseLaunchctlEnvironment(inherited);
  const defaultEnvironment = parseLaunchctlEnvironment(defaults);
  const jobEnvironment = parseLaunchctlEnvironment(job);
  if (!inheritedEnvironment || !defaultEnvironment || !jobEnvironment) return undefined;
  const pids = [...output.matchAll(/^\s*pid\s*=\s*(\d+)\s*$/gmu)];
  if (pids.length !== 1) return undefined;
  const pid = Number(pids[0]?.[1]);
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  return { arguments: arguments_, environment: { ...inheritedEnvironment, ...defaultEnvironment, ...jobEnvironment }, pid };
}

function resolveLaunchAgentFile(env: NodeJS.ProcessEnv): string {
  const explicit = env.MUSE_DAEMON_PLIST_FILE?.trim();
  if (explicit) return explicit;
  return join(env.HOME?.trim() || homedir(), "Library", "LaunchAgents", `${MUSE_LAUNCH_AGENT_LABEL}.plist`);
}

function defaultTemporaryRoots(env: NodeJS.ProcessEnv): readonly string[] {
  return [...new Set([
    tmpdir(), env.TMPDIR, env.TMP, env.TEMP,
    ...(process.platform === "darwin" ? ["/tmp", "/private/tmp", "/var/tmp"] : [])
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0).map((value) => resolve(value)))];
}

export interface ValidateStableMuseCliEntryOptions {
  readonly temporaryRoots?: readonly string[];
}

export type StableMuseCliEntryValidation =
  | { readonly ok: true; readonly entrypoint: string; readonly packageRoot: string }
  | { readonly ok: false; readonly reason: string };

export type StableMuseRuntimeExecutableValidation =
  | { readonly ok: true; readonly executable: string }
  | { readonly ok: false; readonly reason: string };

function within(root: string, candidate: string): boolean {
  let canonicalRoot: string;
  try { canonicalRoot = realpathSync(root); } catch { canonicalRoot = resolve(root); }
  const pathFromRoot = relative(canonicalRoot, candidate);
  return pathFromRoot === "" || (!pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot));
}

function withinLexically(root: string, candidate: string): boolean {
  const pathFromRoot = relative(resolve(root), resolve(candidate));
  return pathFromRoot === "" || (!pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot));
}

function containsSymlink(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  let current = root;
  try {
    if (lstatSync(current).isSymbolicLink()) return true;
    for (const part of pathFromRoot.split(/[\\/]/u).filter(Boolean)) {
      current = join(current, part);
      if (lstatSync(current).isSymbolicLink()) return true;
    }
    return false;
  } catch {
    return true;
  }
}

function declaredMuseCliBin(entry: string, canonicalEntry: string): string | undefined {
  let directory = dirname(entry);
  for (let depth = 0; depth < 16; depth += 1) {
    const manifestFile = join(directory, "package.json");
    if (existsSync(manifestFile)) {
      try {
        if (containsSymlink(directory, entry)) return undefined;
        const parsed = JSON.parse(readFileSync(manifestFile, "utf8")) as unknown;
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
        const manifest = parsed as Record<string, unknown>;
        if (manifest.name !== "@muse/cli") return undefined;
        const bin = typeof manifest.bin === "object" && manifest.bin !== null && !Array.isArray(manifest.bin)
          ? (manifest.bin as Record<string, unknown>).muse
          : undefined;
        if (typeof bin !== "string" || !bin.trim() || bin.includes("\0") || isAbsolute(bin)) return undefined;
        const declared = resolve(directory, bin);
        if (!withinLexically(directory, declared) || !existsSync(declared) || containsSymlink(directory, declared)) return undefined;
        return realpathSync(declared) === canonicalEntry ? realpathSync(directory) : undefined;
      } catch {
        return undefined;
      }
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return undefined;
}

function isTestOutput(packageRoot: string, canonicalEntry: string): boolean {
  const packageRelative = relative(packageRoot, canonicalEntry).replaceAll("\\", "/").toLowerCase();
  const parts = packageRelative.split("/");
  const fileName = parts.pop() ?? "";
  return parts.some((part) =>
    part === "__specs__"
    || part === "__tests__"
    || part === "spec"
    || part === "specs"
    || part === "test"
    || part === "tests"
  )
    || /(?:^|[._-])(?:runner|spec|test)(?:[._-]|$)/u.test(fileName);
}

export function validateStableMuseRuntimeExecutable(
  rawExecutable: string | undefined
): StableMuseRuntimeExecutableValidation {
  const executable = rawExecutable?.trim();
  if (!executable) return { ok: false, reason: "the runtime executable is missing" };
  if (!isAbsolute(executable)) {
    return { ok: false, reason: `the runtime executable is not absolute: ${executable}` };
  }
  if (!existsSync(executable)) {
    return { ok: false, reason: `the runtime executable does not exist: ${executable}` };
  }
  try {
    const canonical = realpathSync(executable);
    const expected = realpathSync(process.execPath);
    if (!statSync(canonical).isFile()) {
      return { ok: false, reason: `the runtime executable is not a regular file: ${canonical}` };
    }
    if (canonical !== expected) {
      return { ok: false, reason: `the runtime executable does not match the current Node runtime: ${canonical}` };
    }
    return { executable: canonical, ok: true };
  } catch {
    return { ok: false, reason: `the runtime executable cannot be resolved: ${executable}` };
  }
}

export function validateStableMuseCliEntry(
  rawEntry: string | undefined,
  options: ValidateStableMuseCliEntryOptions = {}
): StableMuseCliEntryValidation {
  const entry = rawEntry?.trim();
  if (!entry) return { ok: false, reason: "the Muse CLI entrypoint is missing" };
  if (!isAbsolute(entry)) return { ok: false, reason: `the Muse CLI entrypoint is not absolute: ${entry}` };
  if (!existsSync(entry)) return { ok: false, reason: `the Muse CLI entrypoint does not exist: ${entry}` };
  let canonical: string;
  try {
    canonical = realpathSync(entry);
  } catch {
    return { ok: false, reason: `the Muse CLI entrypoint cannot be resolved: ${entry}` };
  }
  try {
    if (!statSync(canonical).isFile()) {
      return { ok: false, reason: `the Muse CLI entrypoint is not a regular file: ${canonical}` };
    }
  } catch {
    return { ok: false, reason: `the Muse CLI entrypoint cannot be inspected: ${canonical}` };
  }
  const normalized = canonical.replaceAll("\\", "/");
  if (normalized.includes("/node_modules/vitest/") || normalized.includes("/node_modules/jest/")) {
    return { ok: false, reason: "the Muse CLI entrypoint is a test-runner worker and cannot be persisted" };
  }
  const temporaryRoots = options.temporaryRoots ?? defaultTemporaryRoots(process.env);
  const temporaryRoot = temporaryRoots.find((root) => within(root, canonical));
  if (temporaryRoot) {
    return { ok: false, reason: `the Muse CLI entrypoint is inside a temporary directory (${temporaryRoot}): ${canonical}` };
  }
  const packageRoot = declaredMuseCliBin(entry, canonical);
  if (!packageRoot) {
    return { ok: false, reason: "the Muse CLI entrypoint is not the declared muse bin of an @muse/cli package" };
  }
  if (isTestOutput(packageRoot, canonical)) {
    return { ok: false, reason: `the Muse CLI entrypoint is test output and cannot be persisted: ${canonical}` };
  }
  return { entrypoint: canonical, ok: true, packageRoot };
}

function parseList(result: ReadOnlyProcessResult): { readonly state: ResidentDaemonObservation["runtime"]; readonly pid?: number } {
  if (result.code !== 0) {
    return /could not find|not found|no such (?:process|service)/iu.test(`${result.stderr}\n${result.stdout}`)
      ? { state: "not-registered" }
      : { state: "unknown" };
  }
  const pidMatch = /"PID"\s*=\s*(\d+);/.exec(result.stdout);
  const statusMatch = /"LastExitStatus"\s*=\s*(-?\d+);/.exec(result.stdout);
  const pid = pidMatch ? Number(pidMatch[1]) : undefined;
  const status = statusMatch ? Number(statusMatch[1]) : undefined;
  if (pid !== undefined && Number.isFinite(pid) && pid > 0) return { pid, state: "running" };
  return status !== undefined && Number.isFinite(status) && status !== 0
    ? { state: "crash-looping" }
    : { state: "not-running" };
}

function parseProcessTable(output: string): readonly ProcessRow[] | undefined {
  const rows: ProcessRow[] = [];
  const pids = new Set<number>();
  for (const line of output.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    const match = /^\s*(\d+)\s+(\d+)\s+([\s\S]+)$/u.exec(line);
    if (!match) return undefined;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    if (!Number.isSafeInteger(pid) || pid <= 0 || pids.has(pid)
      || !Number.isSafeInteger(ppid) || ppid < 0) return undefined;
    pids.add(pid);
    rows.push({ command: match[3] ?? "", pid, ppid });
  }
  return rows;
}

function descendants(rows: readonly ProcessRow[], roots: ReadonlySet<number>): Set<number> {
  const found = new Set(roots);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (!found.has(row.pid) && found.has(row.ppid)) { found.add(row.pid); changed = true; }
    }
  }
  return found;
}

const MAX_RESIDENT_INVENTORY_PROCESSES = 32;

function residentCommand(command: string, definitions: readonly (readonly string[])[]): boolean {
  const normalized = command.trim();
  if (definitions.some((definition) => definition.length === 3
    && definition[2] === "daemon"
    && normalized === definition.join(" "))) return true;
  return /^(?:(?:\S*\/)?muse\s+daemon|(?:\S*\/)?node\s+\S*\/(?:apps|packages)\/cli\/\S+\s+daemon)(?:\s|$)/u.test(normalized);
}

function orphanApiCommand(row: ProcessRow): boolean {
  return row.ppid === 1
    && /(?:^|[\s/])tsx(?:\/dist\/cli\.mjs)?(?:\s|$)[\s\S]*\bsrc\/index\.ts(?:\s|$)/u.test(row.command);
}

async function inspectProcessPath(
  pid: number,
  descriptor: "cwd" | "txt",
  run: ReadOnlyProcessRunner
): Promise<string | undefined> {
  const result = await run("lsof", ["-a", "-p", pid.toString(), "-d", descriptor, "-Fn"]);
  const lines = result.stdout.split(/\r?\n/u);
  const paths = lines.filter((line) => line.startsWith("n")).map((line) => line.slice(1)).filter(Boolean);
  if (result.code !== 0 || !lines.includes(`p${pid.toString()}`) || paths.length !== 1) return undefined;
  try {
    return realpathSync(paths[0]!);
  } catch {
    return undefined;
  }
}

async function inspectResidentMuseProcesses(
  platform: NodeJS.Platform,
  run: ReadOnlyProcessRunner,
  definitions: readonly (readonly string[])[],
  launchdPid: number | undefined
): Promise<ProcessInventoryProbe> {
  const unverified = (): ProcessInventoryProbe => ({
    orphanProcessCount: 0,
    orphanRootCount: 0,
    probe: "unverified",
    processes: []
  });
  if (platform !== "darwin") return unverified();
  const table = await run("ps", ["-axo", "pid=,ppid=,command="]);
  const rows = table.code === 0 ? parseProcessTable(table.stdout) : undefined;
  if (!rows) return unverified();

  const residentPids = new Set(rows.filter((row) => residentCommand(row.command, definitions)).map((row) => row.pid));
  const orphanCandidates = rows.filter(orphanApiCommand);
  const potentialOrphanPids = descendants(rows, new Set(orphanCandidates.map((row) => row.pid)));
  if (new Set([...residentPids, ...potentialOrphanPids]).size > MAX_RESIDENT_INVENTORY_PROCESSES) {
    return unverified();
  }
  const orphanRoots = new Set<number>();
  for (const row of orphanCandidates) {
    const cwd = await inspectProcessPath(row.pid, "cwd", run);
    if (cwd === undefined) return unverified();
    if (cwd.replace(/\/+$/u, "").endsWith("/apps/api")) orphanRoots.add(row.pid);
  }
  const orphanPids = descendants(rows, orphanRoots);
  const candidatePids = new Set([...residentPids, ...orphanPids]);
  if (candidatePids.size > MAX_RESIDENT_INVENTORY_PROCESSES) return unverified();

  const processes: ResidentMuseProcess[] = [];
  for (const row of rows.filter((candidate) => candidatePids.has(candidate.pid))) {
    const [cwd, executableRealpath, startedAtMs] = await Promise.all([
      inspectProcessPath(row.pid, "cwd", run),
      inspectProcessPath(row.pid, "txt", run),
      processStart(row.pid, run)
    ]);
    if (cwd === undefined || executableRealpath === undefined || startedAtMs === undefined) {
      return unverified();
    }
    const role: ResidentMuseProcessRole = residentPids.has(row.pid)
      ? "resident"
      : orphanRoots.has(row.pid) ? "orphan-api" : "orphan-api-descendant";
    processes.push({
      cwd,
      executableRealpath,
      matchesLaunchdPid: row.pid === launchdPid,
      pid: row.pid,
      ppid: row.ppid,
      role,
      startedAt: new Date(startedAtMs).toISOString()
    });
  }
  return {
    orphanProcessCount: orphanPids.size,
    orphanRootCount: orphanRoots.size,
    probe: "ok",
    processes
  };
}

export async function inspectResidentOrphanApiProcesses(
  platform: NodeJS.Platform,
  run: ReadOnlyProcessRunner
): Promise<Pick<ResidentDaemonObservation, "orphanProbe" | "orphanRootCount" | "orphanProcessCount">> {
  if (platform !== "darwin") return { orphanProbe: "unverified", orphanProcessCount: 0, orphanRootCount: 0 };
  const table = await run("ps", ["-axo", "pid=,ppid=,command="]);
  const rows = table.code === 0 ? parseProcessTable(table.stdout) : undefined;
  if (!rows) return { orphanProbe: "unverified", orphanProcessCount: 0, orphanRootCount: 0 };
  const candidates = rows.filter((row) => row.ppid === 1
    && /(?:^|[\s/])tsx(?:\/dist\/cli\.mjs)?(?:\s|$)[\s\S]*\bsrc\/index\.ts(?:\s|$)/u.test(row.command));
  if (candidates.length > MAX_RESIDENT_INVENTORY_PROCESSES) {
    return { orphanProbe: "unverified", orphanProcessCount: 0, orphanRootCount: 0 };
  }
  const roots = new Set<number>();
  for (const candidate of candidates) {
    const cwd = await run("lsof", ["-a", "-p", candidate.pid.toString(), "-d", "cwd", "-Fn"]);
    const lines = cwd.stdout.split(/\r?\n/u);
    const paths = lines.filter((line) => line.startsWith("n")).map((line) => line.slice(1)).filter(Boolean);
    if (cwd.code !== 0 || !lines.includes(`p${candidate.pid.toString()}`) || paths.length !== 1) {
      return { orphanProbe: "unverified", orphanProcessCount: 0, orphanRootCount: 0 };
    }
    if (paths[0]!.replace(/\/+$/u, "").endsWith("/apps/api")) roots.add(candidate.pid);
  }
  return { orphanProbe: "ok", orphanProcessCount: descendants(rows, roots).size, orphanRootCount: roots.size };
}

function relevantEnvironmentMatches(disk: Readonly<Record<string, string>>, live: Readonly<Record<string, string>>): boolean {
  return Object.entries(disk).every(([key, value]) =>
    ((key === "HOME" || key === "USERPROFILE") && live[key] === undefined) || live[key] === value);
}

function heartbeatFile(env: Readonly<Record<string, string | undefined>>): string | undefined {
  const sidecar = env.MUSE_PROACTIVE_SIDECAR_FILE?.trim();
  if (sidecar) return join(dirname(sidecar), "proactive-heartbeat-daemon-loop.json");
  const home = env.HOME?.trim() || env.USERPROFILE?.trim();
  return home ? join(home, ".muse", "proactive-heartbeat-daemon-loop.json") : undefined;
}

async function inspectHeartbeat(
  file: string | undefined,
  nowMs: number,
  processStartMs: number | undefined,
  expectedPid: number | undefined
): Promise<{ readonly state: ResidentDaemonObservation["heartbeat"]; readonly pidMatches: boolean }> {
  if (!file) return { pidMatches: false, state: "unknown" };
  const read = await readText(file);
  if (read.state === "missing") return { pidMatches: false, state: "missing" };
  if (read.state !== "ok" || read.text === undefined) return { pidMatches: false, state: "invalid" };
  try {
    const parsed = JSON.parse(read.text) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new TypeError("invalid heartbeat");
    const row = parsed as Record<string, unknown>;
    if (typeof row.at !== "string" || typeof row.pid !== "number" || !Number.isSafeInteger(row.pid) || row.pid <= 0) {
      throw new TypeError("invalid heartbeat");
    }
    const at = Date.parse(row.at);
    if (!Number.isFinite(at)) throw new TypeError("invalid heartbeat");
    const pidMatches = row.pid === expectedPid;
    if (at > nowMs) return { pidMatches, state: "future" };
    if (processStartMs === undefined) return { pidMatches, state: "unknown" };
    if (at < processStartMs) return { pidMatches, state: "before-process" };
    return { pidMatches, state: nowMs - at > RESIDENT_DAEMON_HEARTBEAT_MAX_AGE_MS ? "stale" : "fresh" };
  } catch {
    return { pidMatches: false, state: "invalid" };
  }
}

const PROCESS_START_WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const PROCESS_START_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

function parseProcessStart(value: string): number | undefined {
  const match = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat)\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})$/u.exec(value.trim());
  if (!match) return undefined;
  const month = PROCESS_START_MONTHS.indexOf(match[2] as (typeof PROCESS_START_MONTHS)[number]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const year = Number(match[7]);
  if (month < 0 || year < 1970 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return undefined;
  const parsed = new Date(year, month, day, hour, minute, second, 0);
  if (parsed.getFullYear() !== year || parsed.getMonth() !== month || parsed.getDate() !== day
    || parsed.getHours() !== hour || parsed.getMinutes() !== minute || parsed.getSeconds() !== second
    || PROCESS_START_WEEKDAYS[parsed.getDay()] !== match[1]) return undefined;
  return parsed.getTime();
}

async function processStart(pid: number | undefined, run: ReadOnlyProcessRunner): Promise<number | undefined> {
  if (pid === undefined) return undefined;
  const result = await run("ps", ["-p", pid.toString(), "-o", "lstart="]);
  return result.code === 0 ? parseProcessStart(result.stdout) : undefined;
}

/** Inspect resident runtime authority without writing service or owner state. */
export async function inspectResidentDaemon(
  options: ResidentDaemonInspectionOptions = {}
): Promise<ResidentDaemonInspection> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const run = options.run ?? defaultRun;
  const nowMs = (options.now ?? (() => new Date()))().getTime();
  const temporaryRoots = options.daemonTemporaryRoots ?? defaultTemporaryRoots(env);
  let artifact: ResidentDaemonObservation["artifact"];
  let diskArguments: readonly string[] | undefined;
  let diskEnvironment: Readonly<Record<string, string>> | undefined;
  const plist = await readText(resolveLaunchAgentFile(env));
  if (plist.state === "missing") artifact = "missing";
  else if (plist.state !== "ok" || plist.text === undefined) artifact = "invalid";
  else {
    diskArguments = parseResidentLaunchAgentArguments(plist.text);
    diskEnvironment = parseResidentLaunchAgentEnvironment(plist.text);
    if (!diskArguments || diskArguments.length < 3 || diskEnvironment === undefined) {
      artifact = "invalid";
    } else {
      artifact = validateStableMuseRuntimeExecutable(diskArguments[0]).ok
        && validateStableMuseCliEntry(diskArguments[1], { temporaryRoots }).ok ? "valid" : "stale";
    }
  }

  let runtime: ResidentDaemonObservation["runtime"] = "unknown";
  let liveProbe: ResidentDaemonObservation["liveProbe"] = "unverified";
  let listPid: number | undefined;
  let livePid: number | undefined;
  let liveArguments: readonly string[] | undefined;
  let liveEnvironment: Readonly<Record<string, string>> | undefined;
  let liveDefinitionMatches = false;
  let stableMuseCommand = false;
  if (platform === "darwin") {
    const listed = parseList(await run("launchctl", ["list", MUSE_LAUNCH_AGENT_LABEL]));
    runtime = listed.state;
    listPid = listed.pid;
    const uid = options.uid ?? (typeof process.getuid === "function" ? process.getuid() : undefined);
    if (uid !== undefined && runtime === "running") {
      const printed = await run("launchctl", ["print", `gui/${uid.toString()}/${MUSE_LAUNCH_AGENT_LABEL}`]);
      const snapshot = printed.code === 0 ? parseResidentLaunchctlSnapshot(printed.stdout) : undefined;
      if (snapshot) {
        liveProbe = "ok";
        livePid = snapshot.pid;
        liveArguments = snapshot.arguments;
        liveEnvironment = snapshot.environment;
        liveDefinitionMatches = diskArguments !== undefined && diskEnvironment !== undefined
          && JSON.stringify(liveArguments) === JSON.stringify(diskArguments)
          && relevantEnvironmentMatches(diskEnvironment, liveEnvironment);
        stableMuseCommand = liveArguments.length === 3 && liveArguments[2] === "daemon"
          && validateStableMuseRuntimeExecutable(liveArguments[0]).ok
          && validateStableMuseCliEntry(liveArguments[1], { temporaryRoots }).ok;
      }
    }
  }
  const hostHome = env.HOME?.trim() || env.USERPROFILE?.trim();
  const effectiveRuntimeEnv: NodeJS.ProcessEnv = liveEnvironment
    ? {
        ...liveEnvironment,
        ...(liveEnvironment.HOME?.trim() || liveEnvironment.USERPROFILE?.trim() || !hostHome ? {} : { HOME: hostHome })
      }
    : { ...env, ...(diskEnvironment ?? {}) };
  const heartbeat = await inspectHeartbeat(heartbeatFile(effectiveRuntimeEnv), nowMs, await processStart(livePid, run), livePid);
  const processProbe = options.inspectOrphans === false
    ? { orphanProcessCount: 0, orphanRootCount: 0, probe: "unverified" as const, processes: [] }
    : await inspectResidentMuseProcesses(
        platform,
        run,
        [diskArguments, liveArguments].filter((definition): definition is readonly string[] => definition !== undefined),
        livePid
      );
  const orphan = {
    orphanProbe: processProbe.probe,
    orphanProcessCount: processProbe.orphanProcessCount,
    orphanRootCount: processProbe.orphanRootCount
  };
  const residentProcessCount = processProbe.processes.filter((process_) => process_.role === "resident").length;
  const duplicateResidentProcessCount = Math.max(0, residentProcessCount - 1);
  const launchdResidentMatches = processProbe.processes.filter((process_) =>
    process_.role === "resident" && process_.matchesLaunchdPid).length;
  const conditions: ResidentInventoryCondition[] = [];
  if (processProbe.probe !== "ok" || orphan.orphanProbe !== "ok") {
    conditions.push("unverified");
  } else {
    if (orphan.orphanRootCount > 0) conditions.push("orphan");
    if (duplicateResidentProcessCount > 0) conditions.push("duplicate");
    if (artifact === "valid" && residentProcessCount === 0) conditions.push("artifact-only");
    if (artifact === "missing" && residentProcessCount > 0) conditions.push("process-only");
    if (artifact === "valid"
      && runtime === "running"
      && liveProbe === "ok"
      && liveDefinitionMatches
      && stableMuseCommand
      && listPid !== undefined
      && livePid !== undefined
      && listPid === livePid
      && heartbeat.pidMatches
      && heartbeat.state === "fresh"
      && orphan.orphanRootCount === 0
      && residentProcessCount === 1
      && launchdResidentMatches === 1) {
      conditions.push("healthy");
    }
    if (conditions.length === 0) conditions.push("degraded");
  }
  const processInventory: ResidentMuseProcessInventory = {
    conditions,
    duplicateResidentProcessCount,
    museProcessCount: processProbe.processes.length,
    probe: processProbe.probe,
    processes: processProbe.processes,
    residentProcessCount
  };
  const observation: ResidentDaemonObservation = {
    artifact,
    autostartProbe: "ok",
    heartbeat: heartbeat.state,
    liveDefinitionMatches,
    liveProbe,
    ...orphan,
    pidAgreement: listPid !== undefined && livePid !== undefined && listPid === livePid && heartbeat.pidMatches,
    platform,
    runtime,
    stableMuseCommand
  };
  return {
    diskArguments,
    effectiveRuntimeEnv,
    health: classifyResidentDaemonHealth(observation, processInventory),
    liveArguments,
    liveEnvironment,
    processInventory,
    observation
  };
}
