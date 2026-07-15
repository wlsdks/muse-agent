/**
 * Cross-tick reject ledger for the curator skill-merge cooldown. A cluster the
 * held-out gate keeps rejecting would otherwise be re-proposed (a local-LLM merge
 * + nomic embeds) every idle tick forever — pure wasted compute. This persists a
 * fingerprint→{rejectCount,lastRejectedAt} map so `consolidate` can skip a
 * cluster after it has been rejected `threshold` times, until a member's content
 * changes (which yields a new fingerprint, re-opening it).
 *
 * The fingerprint is over name/description/body of every member (sorted), so the
 * cluster's IDENTITY is stable across ticks while ANY edit to a member re-opens
 * it. File-backed here (apps/api) so `@muse/skills` stays IO-free — it only gets
 * the injected callbacks.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isRecord } from "@muse/shared";

export interface ClusterMember {
  readonly name: string;
  readonly description: string;
  readonly body: string;
}

interface RejectEntry {
  readonly rejectCount: number;
  readonly lastRejectedAt: string;
}
type RejectLedger = Record<string, RejectEntry>;

/** Default consecutive rejects before a cluster is cooled down — > 1 so feedbackRetry gets a couple of ticks. */
export const DEFAULT_COOLDOWN_THRESHOLD = 2;

/**
 * Stable over ticks, sensitive to any member edit: sha1 of the JSON of each
 * member's [name, description, body], sorted by name. JSON escaping makes the
 * encoding collision-safe and free of raw control bytes.
 */
export function fingerprintCluster(cluster: readonly ClusterMember[]): string {
  const canonical = JSON.stringify(
    cluster
      .map((s) => [s.name, s.description, s.body])
      .sort((a, b) => (a[0]! < b[0]! ? -1 : a[0]! > b[0]! ? 1 : 0))
  );
  return createHash("sha1").update(canonical).digest("hex");
}

async function readLedger(file: string): Promise<RejectLedger> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8"));
    if (!isRejectLedger(parsed)) {
      return {};
    }
    return parsed;
  } catch {
    return {}; // missing or corrupt → empty (fail-soft)
  }
}

function isRejectLedger(value: unknown): value is RejectLedger {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  for (const rawEntry of Object.values(value)) {
    if (!isRejectLedgerEntry(rawEntry)) {
      return false;
    }
    if (!Number.isFinite(rawEntry.rejectCount) || rawEntry.rejectCount < 0) {
      return false;
    }
  }

  return true;
}

function isRejectLedgerEntry(value: unknown): value is { readonly rejectCount: number; readonly lastRejectedAt: string } {
  if (!isRecord(value)) {
    return false;
  }
  const entry = value;
  return typeof entry.rejectCount === "number" && Number.isFinite(entry.rejectCount)
    && typeof entry.lastRejectedAt === "string";
}

async function writeLedger(file: string, ledger: RejectLedger): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = join(dirname(file), `.${createHash("sha1").update(file).digest("hex").slice(0, 8)}.tmp`);
  await writeFile(tmp, JSON.stringify(ledger), { mode: 0o600 });
  await rename(tmp, file);
}

/** True when this cluster has been rejected at least `threshold` times (cooldown active). */
export async function shouldSkipCluster(
  file: string,
  cluster: readonly ClusterMember[],
  threshold: number = DEFAULT_COOLDOWN_THRESHOLD
): Promise<boolean> {
  const entry = (await readLedger(file))[fingerprintCluster(cluster)];
  return entry !== undefined && entry.rejectCount >= Math.max(1, threshold);
}

/** Bump the cluster's consecutive-reject count (atomic read-modify-write). */
export async function recordClusterReject(file: string, cluster: readonly ClusterMember[], nowIso: string): Promise<void> {
  const fp = fingerprintCluster(cluster);
  const ledger = await readLedger(file);
  const prev = ledger[fp]?.rejectCount ?? 0;
  ledger[fp] = { lastRejectedAt: nowIso, rejectCount: prev + 1 };
  await writeLedger(file, ledger);
}

/** Clear the cluster's entry — called when it finally merges (or to reset). */
export async function clearCluster(file: string, cluster: readonly ClusterMember[]): Promise<void> {
  const fp = fingerprintCluster(cluster);
  const ledger = await readLedger(file);
  if (ledger[fp] === undefined) return;
  delete ledger[fp];
  await writeLedger(file, ledger);
}
