import { availableParallelism, freemem, loadavg } from "node:os";

import { parseBoolean } from "@muse/autoconfigure";

export interface DaemonResourceSnapshot {
  readonly cpuCount: number;
  readonly freeMemoryBytes: number;
  readonly load1: number;
}

export interface DaemonResourceAdmission {
  readonly status: "admit" | "defer";
  readonly reason?: "cpu-load" | "low-free-memory";
}

const MEBIBYTE = 1024 * 1024;
const DEFAULT_MIN_FREE_MEMORY_MB = 1024;
const DEFAULT_MAX_LOAD_PER_CORE = 0.75;

export function readDaemonResourceSnapshot(): DaemonResourceSnapshot {
  return {
    cpuCount: availableParallelism(),
    freeMemoryBytes: freemem(),
    load1: loadavg()[0] ?? Number.NaN
  };
}

function boundedNumber(raw: string | undefined, fallback: number, min: number, max: number): number {
  const value = Number(raw);
  return Number.isFinite(value) && value >= min && value <= max ? value : fallback;
}

/**
 * A small, local admission gate for work that is explicitly non-urgent: model
 * calls, browsing sync, and consolidation. Invalid OS observations fail open
 * because a platform counter must never make a daemon permanently inert.
 */
export function assessDaemonResourceAdmission(
  env: NodeJS.ProcessEnv,
  snapshot: DaemonResourceSnapshot
): DaemonResourceAdmission {
  if (!parseBoolean(env.MUSE_DAEMON_RESOURCE_GUARD, true)) return { status: "admit" };
  if (!Number.isFinite(snapshot.cpuCount) || snapshot.cpuCount < 1
    || !Number.isFinite(snapshot.freeMemoryBytes) || snapshot.freeMemoryBytes < 0
    || !Number.isFinite(snapshot.load1) || snapshot.load1 < 0) {
    return { status: "admit" };
  }
  const minFreeBytes = boundedNumber(env.MUSE_DAEMON_MIN_FREE_MEMORY_MB, DEFAULT_MIN_FREE_MEMORY_MB, 128, 65_536) * MEBIBYTE;
  if (snapshot.freeMemoryBytes < minFreeBytes) return { reason: "low-free-memory", status: "defer" };
  const maxLoadPerCore = boundedNumber(env.MUSE_DAEMON_MAX_LOAD_PER_CORE, DEFAULT_MAX_LOAD_PER_CORE, 0.1, 4);
  if (snapshot.load1 >= snapshot.cpuCount * maxLoadPerCore) return { reason: "cpu-load", status: "defer" };
  return { status: "admit" };
}
