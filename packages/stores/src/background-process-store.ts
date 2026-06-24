/**
 * X-3 (slice 1) — crash-safe registry of BACKGROUND processes.
 *
 * A long-running process the agent starts (a dev server, a `watch` build, a
 * test runner) outlives the turn that launched it. To monitor or stop it on
 * a LATER turn — or after a restart — its identity must survive in durable
 * storage, not just process memory. This is the persisted bookkeeping: an
 * atomic, file-locked JSON registry of records, mirroring the other
 * personal stores (serialized read-modify-write, corrupt-tolerant read).
 *
 * Pure data layer — it never spawns or signals a process (later slices do
 * that and write their state through here). A crash mid-write can't corrupt
 * the file (atomic rename); a corrupt file degrades to empty, never throws.
 */

import { promises as fs } from "node:fs";

import { atomicWriteFile } from "./atomic-file-store.js";
import { withFileLock } from "./encrypted-file.js";

export type BackgroundProcessStatus = "running" | "exited" | "failed" | "killed";

export interface BackgroundProcessRecord {
  readonly id: string;
  readonly pid: number;
  readonly command: string;
  readonly cwd?: string;
  readonly startedAt: string;
  readonly status: BackgroundProcessStatus;
  readonly exitCode?: number | null;
  readonly endedAt?: string;
  readonly logFile?: string;
}

const STATUSES: ReadonlySet<string> = new Set(["running", "exited", "failed", "killed"]);

export function isBackgroundProcessRecord(value: unknown): value is BackgroundProcessRecord {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    typeof record.pid === "number" &&
    typeof record.command === "string" &&
    typeof record.startedAt === "string" &&
    typeof record.status === "string" &&
    STATUSES.has(record.status)
  );
}

export async function readBackgroundProcesses(file: string): Promise<readonly BackgroundProcessRecord[]> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { processes?: unknown }).processes)) {
    return [];
  }
  return (parsed as { processes: unknown[] }).processes.flatMap((entry): readonly BackgroundProcessRecord[] =>
    isBackgroundProcessRecord(entry) ? [entry] : []
  );
}

export async function writeBackgroundProcesses(file: string, processes: readonly BackgroundProcessRecord[]): Promise<void> {
  await atomicWriteFile(file, `${JSON.stringify({ processes }, null, 2)}\n`);
}

/** Serialized read-modify-write under a cross-process file lock. */
export async function mutateBackgroundProcesses(
  file: string,
  fn: (current: readonly BackgroundProcessRecord[]) => readonly BackgroundProcessRecord[]
): Promise<readonly BackgroundProcessRecord[]> {
  return withFileLock(file, async () => {
    const next = fn(await readBackgroundProcesses(file));
    await writeBackgroundProcesses(file, next);
    return next;
  });
}

/** Add a record (or replace one with the same id — a re-register is idempotent). */
export async function registerBackgroundProcess(file: string, record: BackgroundProcessRecord): Promise<void> {
  await mutateBackgroundProcesses(file, (current) => [...current.filter((p) => p.id !== record.id), record]);
}

export async function updateBackgroundProcess(
  file: string,
  id: string,
  patch: Partial<Omit<BackgroundProcessRecord, "id">>
): Promise<void> {
  await mutateBackgroundProcesses(file, (current) =>
    current.map((p) => (p.id === id ? { ...p, ...patch } : p))
  );
}

export async function removeBackgroundProcess(file: string, id: string): Promise<void> {
  await mutateBackgroundProcesses(file, (current) => current.filter((p) => p.id !== id));
}

export async function getBackgroundProcess(file: string, id: string): Promise<BackgroundProcessRecord | undefined> {
  return (await readBackgroundProcesses(file)).find((p) => p.id === id);
}
