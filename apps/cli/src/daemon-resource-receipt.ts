import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { atomicWriteFile } from "@muse/stores";

import type { DaemonResourceAdmission } from "./daemon-resource-admission.js";

const RECEIPT_SCHEMA = "muse.daemon-resource-admission.v1";

/** A latest-state receipt, deliberately not a sampled performance history. */
export interface DaemonResourceAdmissionReceipt {
  readonly at: string;
  readonly reason?: "cpu-load" | "low-free-memory";
  readonly schema: typeof RECEIPT_SCHEMA;
  readonly status: "admit" | "defer";
}

export function resolveDaemonResourceReceiptFile(env: NodeJS.ProcessEnv): string {
  const explicit = env.MUSE_DAEMON_RESOURCE_RECEIPT_FILE?.trim();
  if (explicit) return explicit;
  const home = env.HOME?.trim() || homedir();
  const museHome = env.MUSE_HOME?.trim() || join(home, ".muse");
  return join(museHome, "daemon-resource-admission.json");
}

export function resourceAdmissionReceipt(admission: DaemonResourceAdmission, at = new Date().toISOString()): DaemonResourceAdmissionReceipt {
  return {
    at,
    ...(admission.reason ? { reason: admission.reason } : {}),
    schema: RECEIPT_SCHEMA,
    status: admission.status
  };
}

function isReceipt(value: unknown): value is DaemonResourceAdmissionReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expected = record.status === "defer" ? ["at", "reason", "schema", "status"] : ["at", "schema", "status"];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) return false;
  if (record.schema !== RECEIPT_SCHEMA || typeof record.at !== "string" || !Number.isFinite(Date.parse(record.at))) return false;
  if (record.status === "admit") return true;
  return record.status === "defer" && (record.reason === "cpu-load" || record.reason === "low-free-memory");
}

/** Invalid or unavailable evidence is absent, never a fabricated transition. */
export async function readDaemonResourceAdmissionReceipt(file: string): Promise<DaemonResourceAdmissionReceipt | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(file, "utf8"));
    return isReceipt(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Atomic owner-only replacement; callers decide whether a failed receipt is fatal. */
export async function writeDaemonResourceAdmissionReceipt(file: string, receipt: DaemonResourceAdmissionReceipt): Promise<void> {
  await atomicWriteFile(file, `${JSON.stringify(receipt)}\n`);
}

export function describeDaemonResourceAdmissionReceipt(receipt: DaemonResourceAdmissionReceipt | undefined): string {
  if (!receipt) return "no prior transition evidence";
  const decision = receipt.status === "defer"
    ? `deferred (${receipt.reason})`
    : "admitted";
  return `last transition ${decision} at ${receipt.at}`;
}
