import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { atomicWriteFile } from "@muse/stores/atomic-file-store";

import type {
  DaemonResourceAdmission,
  DaemonResourceReason,
  DaemonResourceSnapshot,
  DaemonThermalState
} from "./daemon-resource-admission.js";

const LEGACY_SCHEMA = "muse.daemon-resource-admission.v1";
const RECEIPT_SCHEMA = "muse.daemon-workload-receipt/v2";
const MAX_RECEIPT_BYTES = 64 * 1024;
const DAY_MS = 24 * 60 * 60 * 1_000;

export const DAEMON_WORKLOAD_UNIT_IDS = [
  "followup", "pattern", "ambient", "web-watch", "objectives", "home-watch", "briefing",
  "reflection", "email-sync", "self-learn", "self-learn-decay", "playbook-consolidate",
  "memory-consolidate", "recap", "digest-flush", "browsing-sync"
] as const;
export type DaemonWorkloadUnitId = typeof DAEMON_WORKLOAD_UNIT_IDS[number];
export type DaemonWorkloadErrorClass = "timeout" | "io" | "provider" | "model" | "validation" | "unknown";

export interface DaemonResourceAdmissionReceiptV1 {
  readonly at: string;
  readonly reason?: "cpu-load" | "low-free-memory";
  readonly schema: typeof LEGACY_SCHEMA;
  readonly status: "admit" | "defer";
}

export type ObservationAvailability<T extends object> = T | { readonly status: "unavailable" };

export interface DaemonObservationV2 {
  readonly cpu: ObservationAvailability<{ readonly count: number; readonly loadMilli: number; readonly status: "available" }>;
  readonly idle: { readonly milliseconds: number; readonly status: "available" } | { readonly status: "unsupported" | "unavailable" };
  readonly memory: ObservationAvailability<{ readonly freeBytes: number; readonly status: "available" }>;
  readonly power: { readonly status: "ac" | "battery" | "unsupported" | "unavailable" };
  readonly process: { readonly rssBytes: number; readonly systemCpuMicros: number; readonly userCpuMicros: number };
  readonly thermal: { readonly status: DaemonThermalState };
}

export interface DaemonWorkloadDecisionV2 {
  readonly at: string;
  readonly observation: DaemonObservationV2;
  readonly queueDepth: number;
  readonly reason?: DaemonResourceReason | "stop-requested";
  readonly status: "admitted" | "deferred" | "cancelled-before-claim";
}

export interface DaemonWorkloadBoundaryV2 {
  readonly at: string;
  readonly boundaryLatencyMs?: number;
  readonly cpuDeltaMicros: number;
  readonly durationMs: number;
  readonly errorClass?: DaemonWorkloadErrorClass;
  readonly queueDepth: number;
  readonly rssAfterBytes: number;
  readonly rssBeforeBytes: number;
  readonly status: "completed" | "failed";
  readonly stopRequestedDuring: boolean;
  readonly unit: DaemonWorkloadUnitId;
}

export interface DaemonWorkloadReceiptV2 {
  readonly decision: DaemonWorkloadDecisionV2;
  readonly lastBoundary?: DaemonWorkloadBoundaryV2;
  readonly schema: typeof RECEIPT_SCHEMA;
}

export type DaemonResourceReceipt = DaemonResourceAdmissionReceiptV1 | DaemonWorkloadReceiptV2;

export function resolveDaemonResourceReceiptFile(env: NodeJS.ProcessEnv): string {
  const explicit = env.MUSE_DAEMON_RESOURCE_RECEIPT_FILE?.trim();
  if (explicit) return explicit;
  const home = env.HOME?.trim() || homedir();
  const museHome = env.MUSE_HOME?.trim() || join(home, ".muse");
  return join(museHome, "daemon-resource-admission.json");
}

/** Legacy constructor retained only for v1 read/write compatibility tests. */
export function resourceAdmissionReceipt(admission: DaemonResourceAdmission, at = new Date().toISOString()): DaemonResourceAdmissionReceiptV1 {
  if (admission.status === "defer" && admission.reason !== "cpu-load" && admission.reason !== "low-free-memory") {
    throw new Error("legacy resource receipt only supports cpu-load or low-free-memory deferral");
  }
  return {
    at,
    ...(admission.reason === "cpu-load" || admission.reason === "low-free-memory" ? { reason: admission.reason } : {}),
    schema: LEGACY_SCHEMA,
    status: admission.status
  };
}

export function workloadDecisionReceipt(
  admission: DaemonResourceAdmission,
  snapshot: DaemonResourceSnapshot,
  queueDepth: number,
  at = new Date().toISOString()
): DaemonWorkloadReceiptV2 {
  return {
    decision: {
      at,
      observation: observationV2(snapshot),
      queueDepth,
      ...(admission.reason ? { reason: admission.reason } : {}),
      status: admission.status === "admit" ? "admitted" : "deferred"
    },
    schema: RECEIPT_SCHEMA
  };
}

export function cancelledDecisionReceipt(
  snapshot: DaemonResourceSnapshot,
  queueDepth: number,
  at = new Date().toISOString()
): DaemonWorkloadReceiptV2 {
  return {
    decision: { at, observation: observationV2(snapshot), queueDepth, reason: "stop-requested", status: "cancelled-before-claim" },
    schema: RECEIPT_SCHEMA
  };
}

export function withWorkloadBoundary(
  receipt: DaemonWorkloadReceiptV2,
  boundary: DaemonWorkloadBoundaryV2
): DaemonWorkloadReceiptV2 {
  if (receipt.decision.status !== "admitted") throw new Error("workload boundary requires an admitted decision");
  return { ...receipt, lastBoundary: boundary };
}

function observationV2(snapshot: DaemonResourceSnapshot): DaemonObservationV2 {
  const cpuAvailable = finiteInteger(snapshot.cpuCount, 1, 1_024) && finiteNumber(snapshot.load1, 0, 10_000);
  const memoryAvailable = safeInteger(snapshot.freeMemoryBytes);
  const darwin = snapshot.platform === "darwin";
  return {
    cpu: cpuAvailable
      ? { count: snapshot.cpuCount, loadMilli: Math.round(snapshot.load1 * 1_000), status: "available" }
      : { status: "unavailable" },
    idle: darwin
      ? safeInteger(snapshot.idleMs) ? { milliseconds: snapshot.idleMs, status: "available" } : { status: "unavailable" }
      : { status: snapshot.platform === undefined ? "unavailable" : "unsupported" },
    memory: memoryAvailable ? { freeBytes: snapshot.freeMemoryBytes, status: "available" } : { status: "unavailable" },
    power: { status: darwin ? snapshot.onAcPower === true ? "ac" : snapshot.onAcPower === false ? "battery" : "unavailable" : snapshot.platform === undefined ? "unavailable" : "unsupported" },
    process: {
      rssBytes: safeInteger(snapshot.residentMemoryBytes) ? snapshot.residentMemoryBytes : 0,
      systemCpuMicros: safeInteger(snapshot.processCpuSystemMicros) ? snapshot.processCpuSystemMicros : 0,
      userCpuMicros: safeInteger(snapshot.processCpuUserMicros) ? snapshot.processCpuUserMicros : 0
    },
    thermal: { status: isThermal(snapshot.thermalState) ? snapshot.thermalState : "unavailable" }
  };
}

export async function readDaemonResourceAdmissionReceipt(file: string): Promise<DaemonResourceReceipt | undefined> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(file, "r");
    const size = (await handle.stat()).size;
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_RECEIPT_BYTES) return undefined;
    const bytes = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const { bytesRead } = await handle.read(bytes, offset, size - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset !== size) return undefined;
    const raw = bytes.toString("utf8");
    const value: unknown = JSON.parse(raw);
    return isLegacyReceipt(value) || isV2Receipt(value) ? value : undefined;
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function writeDaemonResourceAdmissionReceipt(file: string, receipt: DaemonResourceReceipt): Promise<void> {
  const raw = `${JSON.stringify(receipt)}\n`;
  if (Buffer.byteLength(raw, "utf8") > MAX_RECEIPT_BYTES || (!isLegacyReceipt(receipt) && !isV2Receipt(receipt))) {
    throw new Error("daemon workload receipt is invalid or too large");
  }
  await atomicWriteFile(file, raw);
}

export function describeDaemonResourceAdmissionReceipt(
  receipt: DaemonResourceReceipt | undefined,
  now = new Date()
): string {
  if (!receipt) return "no prior transition evidence";
  if (receipt.schema === LEGACY_SCHEMA) {
    const decision = receipt.status === "defer" ? `deferred (${receipt.reason})` : "admitted";
    return `legacy transition evidence ${decision} at ${receipt.at}${freshnessSuffix(receipt.at, now)}`;
  }
  const decision = receipt.decision.status === "deferred"
    ? `deferred (${receipt.decision.reason})`
    : receipt.decision.status === "cancelled-before-claim" ? "cancelled before claim" : "admitted";
  const boundary = receipt.lastBoundary
    ? `; last unit ${receipt.lastBoundary.unit} ${receipt.lastBoundary.status}`
    : "";
  return `v2 historical decision ${decision} at ${receipt.decision.at}${boundary}${freshnessSuffix(receipt.decision.at, now)}`;
}

function freshnessSuffix(at: string, now: Date): string {
  return now.getTime() - Date.parse(at) > DAY_MS ? " (stale/unverified)" : "";
}

function isLegacyReceipt(value: unknown): value is DaemonResourceAdmissionReceiptV1 {
  if (!exactObject(value, valueRecord(value)?.status === "defer" ? ["at", "reason", "schema", "status"] : ["at", "schema", "status"])) return false;
  const record = value as Record<string, unknown>;
  return record.schema === LEGACY_SCHEMA && canonicalIso(record.at)
    && (record.status === "admit" || (record.status === "defer" && (record.reason === "cpu-load" || record.reason === "low-free-memory")));
}

function isV2Receipt(value: unknown): value is DaemonWorkloadReceiptV2 {
  if (!exactObject(value, valueRecord(value)?.lastBoundary === undefined ? ["decision", "schema"] : ["decision", "lastBoundary", "schema"])) return false;
  const record = value as Record<string, unknown>;
  return record.schema === RECEIPT_SCHEMA && isDecision(record.decision)
    && (record.lastBoundary === undefined || ((record.decision as DaemonWorkloadDecisionV2).status === "admitted" && isBoundary(record.lastBoundary)));
}

function isDecision(value: unknown): value is DaemonWorkloadDecisionV2 {
  const record = valueRecord(value);
  const reasonExpected = record?.status !== "admitted";
  if (!exactObject(value, reasonExpected ? ["at", "observation", "queueDepth", "reason", "status"] : ["at", "observation", "queueDepth", "status"])) return false;
  if (!record || !canonicalIso(record.at) || !finiteInteger(record.queueDepth, 0, DAEMON_WORKLOAD_UNIT_IDS.length) || !isObservation(record.observation)) return false;
  if (record.status === "admitted") return record.reason === undefined;
  if (record.status === "cancelled-before-claim") return record.reason === "stop-requested";
  return record.status === "deferred" && isReason(record.reason);
}

function isObservation(value: unknown): value is DaemonObservationV2 {
  if (!exactObject(value, ["cpu", "idle", "memory", "power", "process", "thermal"])) return false;
  const v = value as Record<string, unknown>;
  const cpu = valueRecord(v.cpu); const memory = valueRecord(v.memory); const idle = valueRecord(v.idle);
  const power = valueRecord(v.power); const proc = valueRecord(v.process); const thermal = valueRecord(v.thermal);
  const cpuOk = cpu?.status === "unavailable" ? exactObject(cpu, ["status"])
    : cpu !== undefined && exactObject(cpu, ["count", "loadMilli", "status"]) && cpu.status === "available" && finiteInteger(cpu.count, 1, 1_024) && finiteInteger(cpu.loadMilli, 0, 10_000_000);
  const memoryOk = memory?.status === "unavailable" ? exactObject(memory, ["status"])
    : memory !== undefined && exactObject(memory, ["freeBytes", "status"]) && memory.status === "available" && safeInteger(memory.freeBytes);
  const idleOk = idle?.status === "available"
    ? exactObject(idle, ["milliseconds", "status"]) && safeInteger(idle.milliseconds)
    : exactObject(idle, ["status"]) && (idle?.status === "unsupported" || idle?.status === "unavailable");
  return cpuOk && memoryOk && idleOk
    && exactObject(power, ["status"]) && ["ac", "battery", "unsupported", "unavailable"].includes(String(power?.status))
    && exactObject(proc, ["rssBytes", "systemCpuMicros", "userCpuMicros"]) && safeInteger(proc?.rssBytes) && safeInteger(proc?.systemCpuMicros) && safeInteger(proc?.userCpuMicros)
    && exactObject(thermal, ["status"]) && isThermal(thermal?.status);
}

function isBoundary(value: unknown): value is DaemonWorkloadBoundaryV2 {
  const record = valueRecord(value);
  if (!record) return false;
  const keys = ["at", "cpuDeltaMicros", "durationMs", "queueDepth", "rssAfterBytes", "rssBeforeBytes", "status", "stopRequestedDuring", "unit"];
  if (record.stopRequestedDuring === true) keys.push("boundaryLatencyMs");
  if (record.status === "failed") keys.push("errorClass");
  if (!exactObject(record, keys)) return false;
  return canonicalIso(record.at) && (record.status === "completed" || record.status === "failed")
    && isUnit(record.unit) && finiteInteger(record.queueDepth, 0, DAEMON_WORKLOAD_UNIT_IDS.length - 1)
    && finiteInteger(record.durationMs, 0, 86_400_000) && safeInteger(record.cpuDeltaMicros)
    && safeInteger(record.rssBeforeBytes) && safeInteger(record.rssAfterBytes)
    && typeof record.stopRequestedDuring === "boolean"
    && (record.stopRequestedDuring ? finiteInteger(record.boundaryLatencyMs, 0, 86_400_000) : record.boundaryLatencyMs === undefined)
    && (record.status === "failed" ? isErrorClass(record.errorClass) : record.errorClass === undefined);
}

function valueRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function exactObject(value: unknown, expected: readonly string[]): boolean {
  const record = valueRecord(value); if (!record) return false;
  const keys = Object.keys(record).sort(); const wanted = [...expected].sort();
  return keys.length === wanted.length && keys.every((key, index) => key === wanted[index]);
}

function canonicalIso(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}
function finiteInteger(value: unknown, min: number, max: number): value is number { return Number.isInteger(value) && Number(value) >= min && Number(value) <= max; }
function finiteNumber(value: unknown, min: number, max: number): value is number { return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max; }
function safeInteger(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 0; }
function isThermal(value: unknown): value is DaemonThermalState { return ["nominal", "fair", "serious", "critical", "unavailable"].includes(String(value)); }
function isReason(value: unknown): value is DaemonResourceReason { return ["owner-paused", "thermal-pressure", "battery-power", "power-unavailable", "active-user", "idle-unavailable", "low-free-memory", "cpu-load"].includes(String(value)); }
function isUnit(value: unknown): value is DaemonWorkloadUnitId { return (DAEMON_WORKLOAD_UNIT_IDS as readonly string[]).includes(String(value)); }
function isErrorClass(value: unknown): value is DaemonWorkloadErrorClass { return ["timeout", "io", "provider", "model", "validation", "unknown"].includes(String(value)); }
