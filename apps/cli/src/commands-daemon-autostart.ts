import { existsSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";

import { parseLaunchctlListInfo } from "./commands-daemon-launchagent.js";

export interface CommandProbeResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ScheduledTaskProbeResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type DaemonRuntimeStatus =
  | { readonly state: "not-registered" }
  | { readonly state: "registered-not-running" }
  | { readonly state: "crash-looping"; readonly lastExitStatus: number }
  | { readonly state: "running"; readonly pid: number }
  | { readonly state: "unknown"; readonly reason: string };

export type LaunchAgentArtifactStatus =
  | { readonly state: "missing" }
  | { readonly state: "invalid"; readonly reason: string }
  | { readonly state: "stale-entrypoint"; readonly entrypoint?: string; readonly reason: string }
  | { readonly state: "valid"; readonly entrypoint: string };

export type DaemonAutostartStatus =
  | {
      readonly kind: "darwin";
      readonly plistFile: string;
      readonly artifact: LaunchAgentArtifactStatus;
      readonly runtime: DaemonRuntimeStatus;
    }
  | {
      readonly kind: "win32";
      readonly taskName: string;
      readonly registration: "registered" | "not-registered" | "unknown";
      readonly runtime: { readonly state: "unknown"; readonly reason: string };
    }
  | {
      readonly kind: "unmanaged";
      readonly platform: NodeJS.Platform;
      readonly runtime: { readonly state: "unknown"; readonly reason: string };
    };

export interface InspectDaemonAutostartOptions {
  readonly platform: NodeJS.Platform;
  readonly plistFile: string;
  readonly launchAgentLabel: string;
  readonly scheduledTaskName: string;
  readonly runLaunchctl?: (args: readonly string[]) => Promise<CommandProbeResult>;
  readonly schtasksRun?: (args: readonly string[]) => Promise<ScheduledTaskProbeResult>;
  readonly schtasksQueryArgs: (taskName: string) => readonly string[];
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

/**
 * Parse the narrow EnvironmentVariables dictionary emitted by
 * {@link buildLaunchAgentPlist}. Missing means a valid empty dictionary;
 * malformed XML, duplicate dictionaries/keys, or non-string values are
 * rejected as `undefined` so a qualification probe cannot invent defaults.
 */
export function parseLaunchAgentEnvironmentVariables(plist: string): Readonly<Record<string, string>> | undefined {
  const keyPattern = /<key>\s*EnvironmentVariables\s*<\/key>/gu;
  const keyCount = [...plist.matchAll(keyPattern)].length;
  if (keyCount === 0) return {};
  if (keyCount !== 1) return undefined;

  const dictionaryPattern = /<key>\s*EnvironmentVariables\s*<\/key>\s*(?:<dict\s*\/>|<dict>([\s\S]*?)<\/dict>)/gu;
  const dictionaries = [...plist.matchAll(dictionaryPattern)];
  if (dictionaries.length !== 1) return undefined;
  const body = dictionaries[0]?.[1] ?? "";
  const pairPattern = /<key>([\s\S]*?)<\/key>\s*<string>([\s\S]*?)<\/string>/gu;
  const variables: Record<string, string> = {};
  let cursor = 0;
  for (const match of body.matchAll(pairPattern)) {
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
  if (body.slice(cursor).trim().length > 0) return undefined;
  return variables;
}

export interface LaunchctlPrintSnapshot {
  readonly arguments: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
  readonly pid: number;
}

function launchctlBlock(
  output: string,
  label: string,
  options: { readonly required?: boolean } = {}
): readonly string[] | undefined {
  const lines = output.split(/\r?\n/u);
  const starts = lines.flatMap((line, index) => line.trim() === `${label} = {` ? [index] : []);
  if (starts.length === 0 && options.required === false) {
    return lines.some((line) => line.trim().startsWith(`${label} =`)) ? undefined : [];
  }
  if (starts.length !== 1) return undefined;
  const start = starts[0]!;
  const body: string[] = [];
  for (let index = start + 1; index < lines.length; index += 1) {
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
    if (!match) return undefined;
    const key = match[1]!;
    if (Object.hasOwn(environment, key)) return undefined;
    environment[key] = match[2] ?? "";
  }
  return environment;
}

/**
 * Parse the live, already-loaded job state from `launchctl print`. Every
 * identity-bearing field is mandatory and unique. A service inherits manager
 * environment before its own job dictionary is applied, so all three blocks
 * are parsed conservatively with launchd precedence: inherited, then default,
 * then job-specific. Optional manager blocks may be absent; malformed or
 * duplicate blocks make the whole snapshot unverified.
 */
export function parseLaunchctlPrintSnapshot(output: string): LaunchctlPrintSnapshot | undefined {
  const argumentLines = launchctlBlock(output, "arguments");
  const inheritedEnvironmentLines = launchctlBlock(output, "inherited environment", { required: false });
  const defaultEnvironmentLines = launchctlBlock(output, "default environment", { required: false });
  const environmentLines = launchctlBlock(output, "environment");
  if (!argumentLines || argumentLines.length === 0 || !inheritedEnvironmentLines
    || !defaultEnvironmentLines || !environmentLines) return undefined;

  const inheritedEnvironment = parseLaunchctlEnvironment(inheritedEnvironmentLines);
  const defaultEnvironment = parseLaunchctlEnvironment(defaultEnvironmentLines);
  const jobEnvironment = parseLaunchctlEnvironment(environmentLines);
  if (!inheritedEnvironment || !defaultEnvironment || !jobEnvironment) return undefined;
  const environment = { ...inheritedEnvironment, ...defaultEnvironment, ...jobEnvironment };

  const pidMatches = [...output.matchAll(/^\s*pid\s*=\s*(\d+)\s*$/gmu)];
  if (pidMatches.length !== 1) return undefined;
  const pid = Number(pidMatches[0]?.[1]);
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  return { arguments: argumentLines, environment, pid };
}

/** Parse the ProgramArguments array from the narrow plist shape Muse writes. */
export function parseLaunchAgentProgramArguments(plist: string): readonly string[] | undefined {
  const keyPattern = /<key>\s*ProgramArguments\s*<\/key>/gu;
  if ([...plist.matchAll(keyPattern)].length !== 1) return undefined;
  const arrays = [...plist.matchAll(/<key>\s*ProgramArguments\s*<\/key>\s*<array>([\s\S]*?)<\/array>/gu)];
  if (arrays.length !== 1) return undefined;
  const body = arrays[0]?.[1] ?? "";
  const args: string[] = [];
  let cursor = 0;
  for (const match of body.matchAll(/<string>([\s\S]*?)<\/string>/gu)) {
    const index = match.index ?? 0;
    if (body.slice(cursor, index).trim().length > 0) return undefined;
    const value = xmlText(match[1] ?? "");
    if (value === undefined) return undefined;
    args.push(value);
    cursor = index + match[0].length;
  }
  if (body.slice(cursor).trim().length > 0 || args.length === 0) return undefined;
  return args;
}

function inspectLaunchAgentArtifact(plistFile: string): LaunchAgentArtifactStatus {
  if (!existsSync(plistFile)) return { state: "missing" };

  let programArguments: readonly string[] | undefined;
  try {
    programArguments = parseLaunchAgentProgramArguments(readFileSync(plistFile, "utf8"));
  } catch (cause) {
    return { reason: cause instanceof Error ? cause.message : "could not read plist", state: "invalid" };
  }

  if (!programArguments || programArguments.length < 2) {
    return { reason: "ProgramArguments does not contain node + Muse CLI entry", state: "invalid" };
  }

  const executable = programArguments[0] ?? "";
  const entrypoint = programArguments[1] ?? "";
  if (!isAbsolute(executable) || !existsSync(executable)) {
    return { entrypoint, reason: `runtime executable is missing: ${executable || "<empty>"}`, state: "stale-entrypoint" };
  }
  if (!isAbsolute(entrypoint) || !existsSync(entrypoint)) {
    return { entrypoint, reason: `Muse CLI entry is missing: ${entrypoint || "<empty>"}`, state: "stale-entrypoint" };
  }
  return { entrypoint, state: "valid" };
}

export async function inspectDaemonAutostart(options: InspectDaemonAutostartOptions): Promise<DaemonAutostartStatus> {
  if (options.platform === "win32") {
    if (!options.schtasksRun) {
      return {
        kind: "win32",
        registration: "unknown",
        runtime: { reason: "Task Scheduler probe unavailable", state: "unknown" },
        taskName: options.scheduledTaskName
      };
    }
    const query = await options.schtasksRun(options.schtasksQueryArgs(options.scheduledTaskName));
    return {
      kind: "win32",
      registration: query.exitCode === 0 ? "registered" : "not-registered",
      runtime: { reason: "Task Scheduler registration does not prove a resident process is running", state: "unknown" },
      taskName: options.scheduledTaskName
    };
  }

  if (options.platform !== "darwin") {
    return {
      kind: "unmanaged",
      platform: options.platform,
      runtime: { reason: "Muse does not manage autostart on this platform", state: "unknown" }
    };
  }

  const artifact = inspectLaunchAgentArtifact(options.plistFile);
  if (!options.runLaunchctl) {
    return {
      artifact,
      kind: "darwin",
      plistFile: options.plistFile,
      runtime: { reason: "launchctl probe unavailable", state: "unknown" }
    };
  }

  const query = await options.runLaunchctl(["list", options.launchAgentLabel]);
  if (query.code !== 0) {
    const output = `${query.stderr}\n${query.stdout}`.trim();
    if (/could not find|not found|no such (?:process|service)/iu.test(output)) {
      return { artifact, kind: "darwin", plistFile: options.plistFile, runtime: { state: "not-registered" } };
    }
    return {
      artifact,
      kind: "darwin",
      plistFile: options.plistFile,
      runtime: {
        reason: `launchctl list failed (exit ${query.code.toString()}): ${output || "no diagnostic output"}`,
        state: "unknown"
      }
    };
  }

  const { pid, lastExitStatus } = parseLaunchctlListInfo(query.stdout);
  if (pid !== undefined) {
    return { artifact, kind: "darwin", plistFile: options.plistFile, runtime: { pid, state: "running" } };
  }
  if (lastExitStatus !== undefined && lastExitStatus !== 0) {
    return {
      artifact,
      kind: "darwin",
      plistFile: options.plistFile,
      runtime: { lastExitStatus, state: "crash-looping" }
    };
  }
  return { artifact, kind: "darwin", plistFile: options.plistFile, runtime: { state: "registered-not-running" } };
}

export function isDaemonAutostartHealthy(status: DaemonAutostartStatus): boolean {
  return status.kind === "darwin" && status.artifact.state === "valid" && status.runtime.state === "running";
}

function describeArtifact(artifact: LaunchAgentArtifactStatus): string {
  switch (artifact.state) {
    case "missing": return "missing";
    case "valid": return "valid";
    case "invalid": return `invalid (${artifact.reason})`;
    case "stale-entrypoint": return `stale entrypoint (${artifact.reason})`;
  }
}

function describeRuntime(runtime: DaemonRuntimeStatus): string {
  switch (runtime.state) {
    case "not-registered": return "not registered";
    case "registered-not-running": return "registered but not running";
    case "crash-looping": return `crash-looping (last exit status ${runtime.lastExitStatus.toString()})`;
    case "running": return `running (pid ${runtime.pid.toString()})`;
    case "unknown": return `unknown (${runtime.reason})`;
  }
}

export function formatDaemonAutostartStatus(status: DaemonAutostartStatus): readonly string[] {
  if (status.kind === "darwin") {
    return [
      `autostart:    ${isDaemonAutostartHealthy(status) ? "healthy" : "not ready"} (${status.plistFile})`,
      `  artifact:     ${describeArtifact(status.artifact)}`,
      `  runtime:      ${describeRuntime(status.runtime)}`
    ];
  }
  if (status.kind === "win32") {
    const registration = status.registration === "not-registered" ? "not registered" : status.registration;
    return [
      `autostart:    ${registration} (scheduled task ${status.taskName})`,
      `  runtime:      unknown (${status.runtime.reason})`
    ];
  }
  return [
    `autostart:    unmanaged on ${status.platform}`,
    `  runtime:      unknown (${status.runtime.reason})`
  ];
}

export function describeDaemonAutostartForDoctor(status: DaemonAutostartStatus): string {
  if (status.kind === "darwin") {
    const base = `LaunchAgent artifact ${describeArtifact(status.artifact)}; runtime ${describeRuntime(status.runtime)}`;
    if (isDaemonAutostartHealthy(status)) return base;
    if (status.artifact.state === "missing" || status.runtime.state === "not-registered") {
      return `${base} — run \`muse daemon --install\``;
    }
    return `${base} — inspect \`muse daemon --status\`, then reinstall if needed`;
  }
  if (status.kind === "win32") {
    const registration = status.registration === "not-registered" ? "not registered" : status.registration;
    return `scheduled task ${registration}; runtime unknown — inspect Task Scheduler before trusting idle learning`;
  }
  return `autostart unmanaged on ${status.platform}; runtime unknown — keep \`muse daemon\` resident with your service manager`;
}

export interface ValidateDaemonCliEntryOptions {
  readonly temporaryRoots?: readonly string[];
}

export type DaemonCliEntryValidation =
  | { readonly ok: true; readonly entrypoint: string }
  | { readonly ok: false; readonly reason: string };

function isWithin(root: string, candidate: string): boolean {
  let canonicalRoot: string;
  try {
    canonicalRoot = realpathSync(root);
  } catch {
    canonicalRoot = resolve(root);
  }
  const rel = relative(canonicalRoot, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function defaultDaemonTemporaryRoots(env: NodeJS.ProcessEnv): readonly string[] {
  return [...new Set([
    tmpdir(),
    env.TMPDIR,
    env.TMP,
    env.TEMP,
    ...(process.platform === "darwin" ? ["/tmp", "/private/tmp", "/var/tmp"] : [])
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0).map((value) => resolve(value)))];
}

export function validateDaemonCliEntry(
  rawEntry: string | undefined,
  options: ValidateDaemonCliEntryOptions = {}
): DaemonCliEntryValidation {
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
  // Environment markers such as VITEST_WORKER_ID defend the normal test
  // path, but a subprocess can lose those markers. Persisting a test worker
  // would turn its one-shot process into a KeepAlive crash loop, so reject
  // package entrypoints themselves before any LaunchAgent write/load.
  const normalized = canonical.replaceAll("\\", "/");
  if (normalized.includes("/node_modules/vitest/") || normalized.includes("/node_modules/jest/")) {
    return { ok: false, reason: "the Muse CLI entrypoint is a test-runner worker and cannot be persisted" };
  }
  const temporaryRoots = options.temporaryRoots ?? defaultDaemonTemporaryRoots(process.env);
  const temporaryRoot = temporaryRoots.find((root) => isWithin(root, canonical));
  if (temporaryRoot) {
    return { ok: false, reason: `the Muse CLI entrypoint is inside a temporary directory (${temporaryRoot}): ${canonical}` };
  }
  return { entrypoint: canonical, ok: true };
}
