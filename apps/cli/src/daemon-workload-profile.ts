import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { atomicWriteFile } from "@muse/stores/atomic-file-store";

import { DAEMON_WORKLOAD_UNIT_IDS, type DaemonResourceReceipt, type DaemonWorkloadBoundaryV2, type DaemonWorkloadUnitId } from "./daemon-resource-receipt.js";

const SCHEMA = "muse.daemon-workload-profile/v1";
const MAX_BYTES = 64 * 1024;
const MAX_COUNTER = Number.MAX_SAFE_INTEGER;
const PROFILE_WINDOW_MS = 7 * 24 * 60 * 60 * 1_000;

export interface DaemonWorkloadUnitProfile {
  readonly completed: number;
  readonly failed: number;
  readonly maxDurationMs: number;
  readonly maxRssGrowthBytes: number;
  readonly totalCpuMicros: number;
  readonly totalDurationMs: number;
}

export interface DaemonWorkloadProfile {
  readonly admitted: number;
  readonly boundaries: number;
  readonly cancelled: number;
  readonly deferred: number;
  readonly schema: typeof SCHEMA;
  readonly since: string;
  readonly units: Partial<Record<DaemonWorkloadUnitId, DaemonWorkloadUnitProfile>>;
  readonly updatedAt: string;
}

export function resolveDaemonWorkloadProfileFile(env: NodeJS.ProcessEnv): string {
  const explicit = env.MUSE_DAEMON_WORKLOAD_PROFILE_FILE?.trim();
  if (explicit) return explicit;
  const home = env.HOME?.trim() || homedir();
  const museHome = env.MUSE_HOME?.trim() || join(home, ".muse");
  return join(museHome, "daemon-workload-profile.json");
}

export function emptyDaemonWorkloadProfile(at = new Date().toISOString()): DaemonWorkloadProfile {
  return { admitted: 0, boundaries: 0, cancelled: 0, deferred: 0, schema: SCHEMA, since: at, units: {}, updatedAt: at };
}

export function recordDaemonWorkloadReceipt(
  profile: DaemonWorkloadProfile,
  receipt: DaemonResourceReceipt
): DaemonWorkloadProfile {
  if (receipt.schema === "muse.daemon-resource-admission.v1") return profile;
  const eventAt = receipt.lastBoundary?.at ?? receipt.decision.at;
  const base = Date.parse(eventAt) - Date.parse(profile.since) >= PROFILE_WINDOW_MS
    ? emptyDaemonWorkloadProfile(eventAt)
    : profile;
  const status = receipt.decision.status;
  const next = {
    ...base,
    // An admitted decision is also embedded in the later boundary receipt;
    // count only claimed boundaries so the transition write is not double-counted.
    admitted: add(base.admitted, status === "admitted" && receipt.lastBoundary !== undefined ? 1 : 0),
    cancelled: add(base.cancelled, status === "cancelled-before-claim" ? 1 : 0),
    deferred: add(base.deferred, status === "deferred" ? 1 : 0),
    updatedAt: eventAt
  };
  return receipt.lastBoundary ? recordBoundary(next, receipt.lastBoundary) : next;
}

function recordBoundary(profile: DaemonWorkloadProfile, boundary: DaemonWorkloadBoundaryV2): DaemonWorkloadProfile {
  const current = profile.units[boundary.unit] ?? {
    completed: 0, failed: 0, maxDurationMs: 0, maxRssGrowthBytes: 0, totalCpuMicros: 0, totalDurationMs: 0
  };
  const rssGrowth = Math.max(0, boundary.rssAfterBytes - boundary.rssBeforeBytes);
  return {
    ...profile,
    boundaries: add(profile.boundaries, 1),
    units: {
      ...profile.units,
      [boundary.unit]: {
        completed: add(current.completed, boundary.status === "completed" ? 1 : 0),
        failed: add(current.failed, boundary.status === "failed" ? 1 : 0),
        maxDurationMs: Math.max(current.maxDurationMs, boundary.durationMs),
        maxRssGrowthBytes: Math.max(current.maxRssGrowthBytes, rssGrowth),
        totalCpuMicros: add(current.totalCpuMicros, boundary.cpuDeltaMicros),
        totalDurationMs: add(current.totalDurationMs, boundary.durationMs)
      }
    }
  };
}

export function describeDaemonWorkloadProfile(profile: DaemonWorkloadProfile | undefined): string {
  if (!profile || profile.boundaries === 0) return "no cumulative workload profile";
  const ranked = Object.entries(profile.units)
    .map(([unit, value]) => ({ unit, value: value! }))
    .sort((a, b) => b.value.totalDurationMs - a.value.totalDurationMs);
  if (ranked.length === 0) return "no cumulative workload profile";
  const slowest = ranked[0]!;
  const failures = ranked.reduce((sum, entry) => sum + entry.value.failed, 0);
  const averageMs = Math.round(slowest.value.totalDurationMs / Math.max(1, slowest.value.completed + slowest.value.failed));
  return `profile ${profile.boundaries.toString()} boundaries since ${profile.since}; slowest-total ${slowest.unit} avg ${averageMs.toString()} ms max ${slowest.value.maxDurationMs.toString()} ms; failures ${failures.toString()}`;
}

export async function readDaemonWorkloadProfile(file: string): Promise<DaemonWorkloadProfile | undefined> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(file, "r");
    const size = (await handle.stat()).size;
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_BYTES) return undefined;
    const bytes = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const { bytesRead } = await handle.read(bytes, offset, size - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset !== size) return undefined;
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    return isProfile(value) ? value : undefined;
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function writeDaemonWorkloadProfile(file: string, profile: DaemonWorkloadProfile): Promise<void> {
  if (!isProfile(profile)) throw new Error("daemon workload profile is invalid");
  const raw = `${JSON.stringify(profile)}\n`;
  if (Buffer.byteLength(raw, "utf8") > MAX_BYTES) throw new Error("daemon workload profile is too large");
  await atomicWriteFile(file, raw);
}

function add(left: number, right: number): number { return Math.min(MAX_COUNTER, left + right); }
function integer(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 0; }
function iso(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}
function isUnitProfile(value: unknown): value is DaemonWorkloadUnitProfile {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return keys.join("|") === "completed|failed|maxDurationMs|maxRssGrowthBytes|totalCpuMicros|totalDurationMs"
    && keys.every((key) => integer(record[key]));
}
function isProfile(value: unknown): value is DaemonWorkloadProfile {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join("|") !== "admitted|boundaries|cancelled|deferred|schema|since|units|updatedAt") return false;
  if (record.schema !== SCHEMA || !iso(record.since) || !iso(record.updatedAt)
    || !integer(record.admitted) || !integer(record.boundaries) || !integer(record.cancelled) || !integer(record.deferred)
    || !record.units || typeof record.units !== "object" || Array.isArray(record.units)) return false;
  const units = record.units as Record<string, unknown>;
  const allowed = new Set<string>(DAEMON_WORKLOAD_UNIT_IDS);
  if (!Object.entries(units).every(([key, unit]) => allowed.has(key) && isUnitProfile(unit))) return false;
  const observedBoundaries = (Object.values(units) as DaemonWorkloadUnitProfile[]).reduce(
    (sum, unit) => sum + unit.completed + unit.failed,
    0
  );
  return record.boundaries === observedBoundaries && record.admitted === observedBoundaries;
}
