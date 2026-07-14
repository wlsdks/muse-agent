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
import { homedir } from "node:os";
import { join } from "node:path";

import { isRecord } from "@muse/shared";
import { atomicWriteFile } from "./atomic-file-store.js";
import { withFileLock } from "./encrypted-file.js";

/** Shared registry-file path so the CLI `bg` commands and the agent's
 *  `background_list` tool read/write the SAME file. Override with
 *  MUSE_BACKGROUND_PROCESSES_FILE. */
export function defaultBackgroundProcessesFile(env: Readonly<Record<string, string | undefined>> = process.env): string {
  return env.MUSE_BACKGROUND_PROCESSES_FILE ?? join(homedir(), ".muse", "background-processes.json");
}

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
  /** OS-level start-time captured at spawn (e.g. `ps -o lstart=`). Re-queried
   *  before a kill/reconcile to detect PID reuse after the original process
   *  exited. Optional so legacy records without it still load. */
  readonly osStartTime?: string;
}

const STATUSES: ReadonlySet<string> = new Set(["running", "exited", "failed", "killed"]);

export function isBackgroundProcessRecord(value: unknown): value is BackgroundProcessRecord {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.pid === "number" &&
    typeof value.command === "string" &&
    typeof value.startedAt === "string" &&
    typeof value.status === "string" &&
    STATUSES.has(value.status)
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
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.processes)) {
    return [];
  }
  return parsed.processes.flatMap((entry): readonly BackgroundProcessRecord[] =>
    isBackgroundProcessRecord(entry) ? [entry] : []
  );
}

export async function writeBackgroundProcesses(file: string, processes: readonly BackgroundProcessRecord[]): Promise<void> {
  await atomicWriteFile(file, `${JSON.stringify({ processes }, null, 2)}\n`);
}

/** Serialized read-modify-write under a cross-process file lock. */
export async function mutateBackgroundProcesses(
  file: string,
  fn: (
    current: readonly BackgroundProcessRecord[]
  ) => readonly BackgroundProcessRecord[] | Promise<readonly BackgroundProcessRecord[]>
): Promise<readonly BackgroundProcessRecord[]> {
  return withFileLock(file, async () => {
    const next = await fn(await readBackgroundProcesses(file));
    await writeBackgroundProcesses(file, next);
    return next;
  });
}

const DEFAULT_MAX_TERMINAL = 50;

/**
 * Self-bound the registry: keep every `running` record but at most
 * `maxTerminal` finished (exited/failed/killed) ones, dropping the OLDEST
 * terminal first (by end time, falling back to start time). Without this the
 * registry grows forever as background processes come and go. Preserves the
 * order of the kept records. Pure.
 */
export function capBackgroundProcesses(
  records: readonly BackgroundProcessRecord[],
  maxTerminal: number = DEFAULT_MAX_TERMINAL
): readonly BackgroundProcessRecord[] {
  const terminal = records.filter((record) => record.status !== "running");
  if (terminal.length <= maxTerminal) {
    return records;
  }
  const keep = new Set(
    [...terminal]
      .sort((a, b) => (b.endedAt ?? b.startedAt).localeCompare(a.endedAt ?? a.startedAt))
      .slice(0, maxTerminal)
  );
  return records.filter((record) => record.status === "running" || keep.has(record));
}

/** Add a record (or replace one with the same id — a re-register is idempotent). Caps terminal records. */
export async function registerBackgroundProcess(file: string, record: BackgroundProcessRecord): Promise<void> {
  await mutateBackgroundProcesses(file, (current) =>
    capBackgroundProcesses([...current.filter((p) => p.id !== record.id), record])
  );
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

/**
 * Remove every TERMINAL (exited/failed/killed) record, keeping only running
 * ones, and return the removed records so the caller can delete their log
 * files (the auto-cap bounds record count but their on-disk logs would
 * otherwise linger). Running processes are never touched.
 */
export async function pruneTerminalBackgroundProcesses(file: string): Promise<readonly BackgroundProcessRecord[]> {
  let removed: readonly BackgroundProcessRecord[] = [];
  await mutateBackgroundProcesses(file, (current) => {
    removed = current.filter((p) => p.status !== "running");
    return current.filter((p) => p.status === "running");
  });
  return removed;
}
