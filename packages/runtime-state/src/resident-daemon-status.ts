import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
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
  readonly liveArguments?: readonly string[];
  readonly liveEnvironment?: Readonly<Record<string, string>>;
  readonly observation: ResidentDaemonObservation;
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
}

interface ProcessRow {
  readonly pid: number;
  readonly ppid: number;
  readonly command: string;
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

function within(root: string, candidate: string): boolean {
  let canonicalRoot: string;
  try { canonicalRoot = realpathSync(root); } catch { canonicalRoot = resolve(root); }
  const pathFromRoot = relative(canonicalRoot, candidate);
  return pathFromRoot === "" || (!pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot));
}

function stableCliEntry(entry: string | undefined, temporaryRoots: readonly string[]): boolean {
  if (!entry?.trim() || !isAbsolute(entry) || !existsSync(entry)) return false;
  let canonical: string;
  try { canonical = realpathSync(entry); } catch { return false; }
  const normalized = canonical.replaceAll("\\", "/");
  return !normalized.includes("/node_modules/vitest/")
    && !normalized.includes("/node_modules/jest/")
    && !temporaryRoots.some((root) => within(root, canonical));
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
  for (const line of output.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    const match = /^\s*(\d+)\s+(\d+)\s+([\s\S]+)$/u.exec(line);
    if (!match) return undefined;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(ppid) || ppid < 0) return undefined;
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

async function processStart(pid: number | undefined, run: ReadOnlyProcessRunner): Promise<number | undefined> {
  if (pid === undefined) return undefined;
  const result = await run("ps", ["-p", pid.toString(), "-o", "lstart="]);
  const parsed = result.code === 0 ? Date.parse(result.stdout.trim()) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
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
      artifact = isAbsolute(diskArguments[0] ?? "") && existsSync(diskArguments[0] ?? "")
        && stableCliEntry(diskArguments[1], temporaryRoots) ? "valid" : "stale";
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
          && isAbsolute(liveArguments[0] ?? "") && existsSync(liveArguments[0] ?? "")
          && stableCliEntry(liveArguments[1], temporaryRoots);
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
  const orphan = await inspectResidentOrphanApiProcesses(platform, run);
  return {
    diskArguments,
    effectiveRuntimeEnv,
    liveArguments,
    liveEnvironment,
    observation: {
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
    }
  };
}
