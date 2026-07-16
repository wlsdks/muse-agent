/**
 * A disk-backed CheckpointStore for the LOCAL-FIRST product. The Kysely store keeps
 * checkpoints in Postgres, and the no-DB default fell back to InMemory — which dies
 * with the process, so a crashed local run could never resume. This persists each
 * run's checkpoints to `<dir>/<runId>.json` so a mid-run crash + restart can replay
 * from the last step (the langgraph "save graph state at each step, resume" gap).
 *
 * Each run file is serialized in-process and across processes. Tolerant: a missing
 * / corrupt file reads as no checkpoints (never throws into the agent loop).
 */

import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createRunId, withFileLock, withFileMutationQueue, type JsonObject } from "@muse/shared";

import type { CheckpointStore, ExecutionCheckpoint, SaveCheckpointInput } from "./index.js";

const DEFAULT_MAX_PER_RUN = 50;
const DEFAULT_MAX_RUNS = 500;
const RUN_FILE_PREFIX_MAX_LENGTH = 180;
const V2_DIRECTORY = "v2";

/**
 * Filesystem-safe, collision-resistant filename for a run id. The readable
 * prefix is bounded for filesystem compatibility; the full digest keeps two
 * IDs that sanitize to the same prefix from sharing resumable state.
 */
function runFileName(runId: string): string {
  const prefix = fileSafeSegment(runId).slice(0, RUN_FILE_PREFIX_MAX_LENGTH) || "run";
  return `${prefix}-${createHash("sha256").update(runId).digest("hex")}.json`;
}

/** Legacy v1 filename retained only to recover checkpoints created before collision-safe names. */
function legacyRunFileName(runId: string): string {
  return `${fileSafeSegment(runId).slice(0, 200)}.json`;
}

function checkpointFilePaths(dir: string, runId: string): readonly string[] {
  return [join(dir, V2_DIRECTORY, runFileName(runId)), join(dir, legacyRunFileName(runId))];
}

function fileSafeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/gu, "_");
}

function serialize(checkpoint: ExecutionCheckpoint): JsonObject {
  return { createdAt: checkpoint.createdAt.toISOString(), id: checkpoint.id, runId: checkpoint.runId, state: checkpoint.state, step: checkpoint.step };
}

function deserialize(raw: unknown): ExecutionCheckpoint | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.runId !== "string" || typeof r.step !== "number" || !Number.isFinite(r.step)) return undefined;
  const createdAt = typeof r.createdAt === "string" ? new Date(r.createdAt) : new Date(0);
  return {
    createdAt: Number.isNaN(createdAt.getTime()) ? new Date(0) : createdAt,
    id: typeof r.id === "string" ? r.id : "unknown",
    runId: r.runId,
    state: (r.state && typeof r.state === "object" ? r.state : {}) as JsonObject,
    step: r.step
  };
}

const byStep = (a: ExecutionCheckpoint, b: ExecutionCheckpoint): number => a.step - b.step;

function checkpointRunId(checkpoints: readonly ExecutionCheckpoint[]): string | undefined {
  const first = checkpoints[0];
  return first && checkpoints.every((checkpoint) => checkpoint.runId === first.runId) ? first.runId : undefined;
}

function checkpointPhase(c: ExecutionCheckpoint): string {
  const p = (c.state as { phase?: unknown }).phase;
  return typeof p === "string" ? p : "unknown";
}

export interface FileCheckpointStoreOptions {
  readonly maxCheckpointsPerRun?: number;
  /** Cap on the number of distinct run files kept; the oldest are pruned. */
  readonly maxRuns?: number;
  /** Amortize retention: scan/prune the dir only every Nth save (default 25). */
  readonly pruneIntervalSaves?: number;
  readonly idFactory?: () => string;
}

export class FileCheckpointStore implements CheckpointStore {
  readonly #dir: string;
  readonly #maxPerRun: number;
  readonly #maxRuns: number;
  readonly #pruneInterval: number;
  readonly #idFactory: () => string;
  #ensuredDir = false;
  #savesSincePrune = 0;

  constructor(dir: string, options: FileCheckpointStoreOptions = {}) {
    this.#dir = dir;
    this.#maxPerRun = requirePositiveSafeInteger(options.maxCheckpointsPerRun, DEFAULT_MAX_PER_RUN, "maxCheckpointsPerRun");
    this.#maxRuns = requirePositiveSafeInteger(options.maxRuns, DEFAULT_MAX_RUNS, "maxRuns");
    this.#pruneInterval = requirePositiveSafeInteger(options.pruneIntervalSaves, 25, "pruneIntervalSaves");
    this.#idFactory = options.idFactory ?? (() => createRunId("checkpoint"));
  }

  /** Bound disk: keep only the most-recently-modified `maxRuns` run files. A
   *  completed run's checkpoints linger for replay (P3) but never grow unbounded.
   *  Amortized — only scans the dir every Nth save (the per-step hot loop calls
   *  save many times). Best-effort — a prune failure never breaks a save. */
  async #checkpointGroups(): Promise<readonly { readonly mtime: number; readonly runId: string }[]> {
    const groups = new Map<string, number>();
    for (const file of await listCheckpointFiles(this.#dir)) {
      const checkpoints = await readCheckpointFile(file);
      const runId = checkpoints ? checkpointRunId(checkpoints) : undefined;
      if (!runId) continue;
      try {
        const mtime = (await stat(file)).mtimeMs;
        groups.set(runId, Math.max(groups.get(runId) ?? Number.NEGATIVE_INFINITY, mtime));
      } catch {
        // A concurrent delete can make a retention candidate disappear.
      }
    }
    return [...groups].map(([runId, mtime]) => ({ mtime, runId }));
  }

  async #pruneOldRuns(protectedRunId: string): Promise<void> {
    this.#savesSincePrune += 1;
    if (this.#savesSincePrune < this.#pruneInterval) return;
    this.#savesSincePrune = 0;
    try {
      const groups = [...await this.#checkpointGroups()].sort((a, b) => b.mtime - a.mtime);
      if (groups.length <= this.#maxRuns) return;
      for (const candidate of groups.slice(this.#maxRuns)) {
        if (candidate.runId === protectedRunId) continue;
        await withRunFileLocks(this.#dir, candidate.runId, async () => {
          const current = [...await this.#checkpointGroups()].sort((a, b) => b.mtime - a.mtime);
          if (current.length <= this.#maxRuns || !current.slice(this.#maxRuns).some((entry) => entry.runId === candidate.runId)) {
            return;
          }
          await removeCheckpointsForRun(this.#dir, candidate.runId);
        });
      }
    } catch {
      /* retention is best-effort */
    }
  }

  async findByRunId(runId: string): Promise<readonly ExecutionCheckpoint[]> {
    for (const file of checkpointFilePaths(this.#dir, runId)) {
      const checkpoints = await readCheckpointFile(file);
      if (checkpoints && checkpointRunId(checkpoints) === runId) return checkpoints;
    }
    return [];
  }

  async findLatestByRunId(runId: string): Promise<ExecutionCheckpoint | undefined> {
    const all = await this.findByRunId(runId);
    return all.length > 0 ? all[all.length - 1] : undefined;
  }

  /**
   * The checkpoint to RESUME a run from: the latest PROGRESS checkpoint (phase
   * `act`/`start`), NOT a terminal sentinel. A graceful failure writes a `failed`
   * checkpoint at a high step holding the ORIGINAL (pre-progress) messages — if
   * resume used the max-step checkpoint it would replay from scratch and re-run
   * every finished tool. Returns undefined for a `complete`d run (nothing to resume).
   */
  async findResumableCheckpoint(runId: string): Promise<ExecutionCheckpoint | undefined> {
    const all = await this.findByRunId(runId);
    const latest = all[all.length - 1];
    if (!latest || checkpointPhase(latest) === "complete") return undefined;
    const progress = all.filter((c) => checkpointPhase(c) === "act" || checkpointPhase(c) === "start");
    return progress[progress.length - 1] ?? latest;
  }

  /**
   * Runs that crashed/were interrupted mid-execution and can be resumed — every run
   * that did NOT reach `complete` and still has a progress checkpoint to resume from.
   * The reported step/phase is the PROGRESS point, not a terminal `failed` sentinel.
   * Most-recently-touched first. (Reads each run file's saved runId, not the
   * sanitized filename, so it round-trips correctly.)
  */
  async listResumable(): Promise<readonly { readonly runId: string; readonly step: number; readonly phase: string; readonly updatedAt: Date }[]> {
    const byRunId = new Map<string, { runId: string; step: number; phase: string; updatedAt: Date }>();
    for (const file of await listCheckpointFiles(this.#dir)) {
      const checkpoints = await readCheckpointFile(file);
      const runId = checkpoints ? checkpointRunId(checkpoints) : undefined;
      if (!checkpoints || !runId) continue;
      const latest = checkpoints[checkpoints.length - 1];
      if (!latest || checkpointPhase(latest) === "complete") continue; // a finished run isn't resumable
      const progress = checkpoints.filter((c) => checkpointPhase(c) === "act" || checkpointPhase(c) === "start");
      const at = progress[progress.length - 1] ?? latest;
      const candidate = { phase: checkpointPhase(at), runId, step: at.step, updatedAt: latest.createdAt };
      const existing = byRunId.get(candidate.runId);
      if (!existing || candidate.updatedAt.getTime() > existing.updatedAt.getTime()) {
        byRunId.set(candidate.runId, candidate);
      }
    }
    return [...byRunId.values()].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  }

  async save(input: SaveCheckpointInput): Promise<ExecutionCheckpoint> {
    const checkpoint: ExecutionCheckpoint = {
      createdAt: input.createdAt ?? new Date(),
      id: input.id ?? this.#idFactory(),
      runId: input.runId,
      state: input.state,
      step: input.step
    };
    if (!this.#ensuredDir) {
      await mkdir(join(this.#dir, V2_DIRECTORY), { recursive: true });
      this.#ensuredDir = true;
    }
    const target = checkpointFilePaths(this.#dir, input.runId)[0]!;
    const saved = await withRunFileLocks(this.#dir, input.runId, async () => {
      const existing = [...await this.findByRunId(input.runId)];
      const at = existing.findIndex((candidate) => candidate.step === checkpoint.step);
      if (at >= 0) existing[at] = checkpoint;
      else existing.push(checkpoint);
      existing.sort(byStep);
      const capped = existing.slice(-this.#maxPerRun);
      const tmp = `${target}.${fileSafeSegment(checkpoint.id)}.tmp`;
      await writeFile(tmp, JSON.stringify(capped.map(serialize)), "utf8");
      await rename(tmp, target);
      return checkpoint;
    });
    // Retention may lock a different run. It must run after the committing
    // run's locks are released, otherwise two concurrent saves can each hold
    // one run while pruning the other.
    await this.#pruneOldRuns(checkpoint.runId);
    return saved;
  }

  async deleteByRunId(runId: string): Promise<void> {
    await mkdir(join(this.#dir, V2_DIRECTORY), { recursive: true });
    await withRunFileLocks(this.#dir, runId, async () => removeCheckpointsForRun(this.#dir, runId));
  }
}

async function readCheckpointFile(file: string): Promise<readonly ExecutionCheckpoint[] | undefined> {
    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch {
      return undefined;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return []; // a half-written / corrupt checkpoint file carries no resumable state
    }
    if (!Array.isArray(parsed)) return [];
    return parsed.map(deserialize).filter((c): c is ExecutionCheckpoint => c !== undefined).sort(byStep);
}

async function listCheckpointFiles(dir: string): Promise<readonly string[]> {
  const roots = await Promise.all([dir, join(dir, V2_DIRECTORY)].map(async (parent) => {
    try {
      return (await readdir(parent)).filter((name) => name.endsWith(".json")).map((name) => join(parent, name));
    } catch {
      return [];
    }
  }));
  return roots.flat();
}

async function removeCheckpointsForRun(dir: string, runId: string): Promise<void> {
  for (const file of checkpointFilePaths(dir, runId)) {
    const checkpoints = await readCheckpointFile(file);
    if (checkpoints && checkpointRunId(checkpoints) === runId) {
      await rm(file, { force: true }).catch(() => undefined);
    }
  }
}

async function withRunFileLocks<T>(dir: string, runId: string, operation: () => Promise<T>): Promise<T> {
  return withCheckpointFileLocks([...checkpointFilePaths(dir, runId)].sort(), operation);
}

async function withCheckpointFileLocks<T>(files: readonly string[], operation: () => Promise<T>): Promise<T> {
  const [file, ...remaining] = files;
  if (!file) return operation();
  return withFileMutationQueue(file, () => withFileLock(file, () => withCheckpointFileLocks(remaining, operation)));
}

function requirePositiveSafeInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return resolved;
}
