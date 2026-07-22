import { availableParallelism, freemem, loadavg } from "node:os";

import { readMacAcPower, readMacIdleMs } from "@muse/macos/system-resource-observation";

export type DaemonThermalState = "nominal" | "fair" | "serious" | "critical" | "unavailable";
export type DaemonResourceReason =
  | "owner-paused"
  | "thermal-pressure"
  | "battery-power"
  | "power-unavailable"
  | "active-user"
  | "idle-unavailable"
  | "low-free-memory"
  | "cpu-load";

export interface DaemonResourceSnapshot {
  readonly cpuCount: number;
  readonly freeMemoryBytes: number;
  readonly load1: number;
  readonly idleMs?: number;
  readonly onAcPower?: boolean;
  readonly platform?: NodeJS.Platform;
  readonly processCpuSystemMicros?: number;
  readonly processCpuUserMicros?: number;
  readonly residentMemoryBytes?: number;
  readonly thermalState?: DaemonThermalState;
}

export interface DaemonResourceAdmission {
  readonly status: "admit" | "defer";
  readonly reason?: DaemonResourceReason;
}

export interface DaemonResourceAdmissionOptions {
  /** Explicit owner escape hatch, read live from daemon config once per tick. */
  readonly ownerPaused?: boolean;
}

/** The resolved limits a daemon applies before it starts deferrable work. */
export interface DaemonResourcePolicy {
  readonly backgroundMode: "auto" | "paused";
  readonly backgroundModeMalformed: boolean;
  readonly guardEnabled: boolean;
  readonly maxLoadPerCore: number;
  readonly minIdleMs: number;
  readonly minFreeMemoryMb: number;
}

const MEBIBYTE = 1024 * 1024;
const DEFAULT_MIN_FREE_MEMORY_MB = 1024;
const DEFAULT_MAX_LOAD_PER_CORE = 0.75;
const DEFAULT_MIN_IDLE_SECONDS = 300;

export function readDaemonResourceSnapshot(): DaemonResourceSnapshot {
  const cpu = process.cpuUsage();
  return {
    cpuCount: availableParallelism(),
    freeMemoryBytes: freemem(),
    load1: loadavg()[0] ?? Number.NaN,
    ...(process.platform === "darwin" ? {
      idleMs: readMacIdleMs(),
      onAcPower: readMacAcPower()
    } : {}),
    platform: process.platform,
    processCpuSystemMicros: cpu.system,
    processCpuUserMicros: cpu.user,
    residentMemoryBytes: process.memoryUsage().rss,
    thermalState: "unavailable"
  };
}

function boundedNumber(raw: string | undefined, fallback: number, min: number, max: number): number {
  const value = Number(raw);
  return Number.isFinite(value) && value >= min && value <= max ? value : fallback;
}

function explicitBoundedNumber(raw: string | undefined, min: number, max: number): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value >= min && value <= max ? value : undefined;
}

function explicitBoolean(raw: string | undefined): boolean | undefined {
  if (raw === undefined) return undefined;
  const value = raw.trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(value)) return true;
  if (["false", "0", "no", "off"].includes(value)) return false;
  return undefined;
}

/**
 * Resolve the daemon's resource policy once, so the tick, LaunchAgent writer,
 * and doctor cannot drift on defaults or valid ranges. Invalid input falls
 * back to the conservative shipped value; it never disables the guard.
 */
export function resolveDaemonResourcePolicy(env: NodeJS.ProcessEnv): DaemonResourcePolicy {
  const rawMode = env.MUSE_DAEMON_BACKGROUND_MODE?.trim().toLowerCase();
  const backgroundModeMalformed = rawMode !== undefined && rawMode !== "auto" && rawMode !== "paused";
  return {
    backgroundMode: backgroundModeMalformed ? "paused" : rawMode === "paused" ? "paused" : "auto",
    backgroundModeMalformed,
    guardEnabled: explicitBoolean(env.MUSE_DAEMON_RESOURCE_GUARD) ?? true,
    maxLoadPerCore: boundedNumber(env.MUSE_DAEMON_MAX_LOAD_PER_CORE, DEFAULT_MAX_LOAD_PER_CORE, 0.1, 4),
    minIdleMs: boundedNumber(env.MUSE_DAEMON_MIN_IDLE_SECONDS, DEFAULT_MIN_IDLE_SECONDS, 60, 86_400) * 1_000,
    minFreeMemoryMb: boundedNumber(env.MUSE_DAEMON_MIN_FREE_MEMORY_MB, DEFAULT_MIN_FREE_MEMORY_MB, 128, 65_536)
  };
}

/**
 * The narrowly allowlisted policy overrides that may cross the launchd
 * boundary. Defaults and malformed ambient values deliberately stay out of
 * the plist: the daemon resolves the same safe defaults at boot, while no
 * arbitrary MUSE_* value, credential, or path becomes resident configuration.
 */
export function daemonResourcePolicyEnvironment(env: NodeJS.ProcessEnv): Readonly<Record<string, string>> {
  const variables: Record<string, string> = {};
  if (env.MUSE_DAEMON_BACKGROUND_MODE !== undefined) {
    variables.MUSE_DAEMON_BACKGROUND_MODE = resolveDaemonResourcePolicy(env).backgroundMode;
  }
  const guard = explicitBoolean(env.MUSE_DAEMON_RESOURCE_GUARD);
  if (guard !== undefined) variables.MUSE_DAEMON_RESOURCE_GUARD = String(guard);
  const minFreeMemoryMb = explicitBoundedNumber(env.MUSE_DAEMON_MIN_FREE_MEMORY_MB, 128, 65_536);
  if (minFreeMemoryMb !== undefined) variables.MUSE_DAEMON_MIN_FREE_MEMORY_MB = String(minFreeMemoryMb);
  const maxLoadPerCore = explicitBoundedNumber(env.MUSE_DAEMON_MAX_LOAD_PER_CORE, 0.1, 4);
  if (maxLoadPerCore !== undefined) variables.MUSE_DAEMON_MAX_LOAD_PER_CORE = String(maxLoadPerCore);
  const minIdleSeconds = explicitBoundedNumber(env.MUSE_DAEMON_MIN_IDLE_SECONDS, 60, 86_400);
  if (minIdleSeconds !== undefined) variables.MUSE_DAEMON_MIN_IDLE_SECONDS = String(minIdleSeconds);
  return variables;
}

/** A privacy-safe one-line description for read-only status surfaces. */
export function describeDaemonResourceAdmission(
  policy: DaemonResourcePolicy,
  snapshot: DaemonResourceSnapshot,
  admission: DaemonResourceAdmission,
  source: "LaunchAgent" | "shell/default"
): string {
  const limits = policy.guardEnabled
    ? `mode ${policy.backgroundMode}${policy.backgroundModeMalformed ? " (invalid explicit value; held)" : ""}; guard on; min idle ${(policy.minIdleMs / 1_000).toString()}s; min free ${policy.minFreeMemoryMb.toString()} MiB; max load ${policy.maxLoadPerCore.toString()}/core`
    : "guard off";
  const observed = Number.isFinite(snapshot.cpuCount) && Number.isFinite(snapshot.freeMemoryBytes) && Number.isFinite(snapshot.load1)
    ? `observed ${(snapshot.freeMemoryBytes / MEBIBYTE).toFixed(0)} MiB free, load ${snapshot.load1.toFixed(2)}/${snapshot.cpuCount.toString()} cores`
    : "OS resource observation unavailable";
  const processObserved = Number.isSafeInteger(snapshot.residentMemoryBytes) && Number.isSafeInteger(snapshot.processCpuUserMicros) && Number.isSafeInteger(snapshot.processCpuSystemMicros)
    ? `, Muse RSS ${(snapshot.residentMemoryBytes! / MEBIBYTE).toFixed(0)} MiB, process CPU ${((snapshot.processCpuUserMicros! + snapshot.processCpuSystemMicros!) / 1_000).toFixed(0)} ms`
    : "";
  const platformObserved = snapshot.platform === "darwin"
    ? `, idle ${snapshot.idleMs === undefined ? "unavailable" : `${(snapshot.idleMs / 1_000).toFixed(0)}s`}, power ${snapshot.onAcPower === true ? "AC" : snapshot.onAcPower === false ? "battery" : "unavailable"}`
    : "";
  const verdict = admission.status === "defer"
    ? `heavy background work deferred (${admission.reason})`
    : "heavy background work admitted";
  return `${source}; ${limits}; ${observed}${processObserved}${platformObserved}; ${verdict}`;
}

/**
 * A small, local admission gate for work that is explicitly non-urgent: model
 * calls, browsing sync, and consolidation. Invalid OS observations fail open
 * because a platform counter must never make a daemon permanently inert.
 */
export function assessDaemonResourceAdmission(
  env: NodeJS.ProcessEnv,
  snapshot: DaemonResourceSnapshot,
  options: DaemonResourceAdmissionOptions = {}
): DaemonResourceAdmission {
  if (options.ownerPaused) return { reason: "owner-paused", status: "defer" };
  const policy = resolveDaemonResourcePolicy(env);
  if (policy.backgroundMode === "paused") return { reason: "owner-paused", status: "defer" };
  if (snapshot.thermalState === "serious" || snapshot.thermalState === "critical") {
    return { reason: "thermal-pressure", status: "defer" };
  }
  if (snapshot.platform === "darwin") {
    if (snapshot.onAcPower === false) return { reason: "battery-power", status: "defer" };
    if (snapshot.onAcPower === undefined) return { reason: "power-unavailable", status: "defer" };
    if (snapshot.idleMs === undefined) return { reason: "idle-unavailable", status: "defer" };
    if (snapshot.idleMs < policy.minIdleMs) return { reason: "active-user", status: "defer" };
  }
  if (!policy.guardEnabled) return { status: "admit" };
  if (!Number.isFinite(snapshot.cpuCount) || snapshot.cpuCount < 1
    || !Number.isFinite(snapshot.freeMemoryBytes) || snapshot.freeMemoryBytes < 0
    || !Number.isFinite(snapshot.load1) || snapshot.load1 < 0) {
    return { status: "admit" };
  }
  const minFreeBytes = policy.minFreeMemoryMb * MEBIBYTE;
  if (snapshot.freeMemoryBytes < minFreeBytes) return { reason: "low-free-memory", status: "defer" };
  if (snapshot.load1 >= snapshot.cpuCount * policy.maxLoadPerCore) return { reason: "cpu-load", status: "defer" };
  return { status: "admit" };
}
