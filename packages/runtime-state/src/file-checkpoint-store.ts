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

import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createRunId, withFileLock, withFileMutationQueue, type JsonObject } from "@muse/shared";

import type { CheckpointStore, ExecutionCheckpoint, SaveCheckpointInput } from "./index.js";

const DEFAULT_MAX_PER_RUN = 50;
const DEFAULT_MAX_RUNS = 500;

/** Filesystem-safe filename for a runId (no path traversal, no separators). */
function runFileName(runId: string): string {
  return `${fileSafeSegment(runId)}.json`;
}

function fileSafeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/gu, "_").slice(0, 200);
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
  async #pruneOldRuns(protectedTarget: string): Promise<void> {
    this.#savesSincePrune += 1;
    if (this.#savesSincePrune < this.#pruneInterval) return;
    this.#savesSincePrune = 0;
    try {
      const names = (await readdir(this.#dir)).filter((n) => n.endsWith(".json"));
      if (names.length <= this.#maxRuns) return;
      const withMtime = await Promise.all(names.map(async (n) => ({ mtime: (await stat(join(this.#dir, n))).mtimeMs, name: n })));
      withMtime.sort((a, b) => b.mtime - a.mtime); // newest first
      for (const candidate of withMtime.slice(this.#maxRuns)) {
        const target = join(this.#dir, candidate.name);
        // `save` already owns this target's queue + lock. Never queue behind
        // ourselves: retention can wait until a later save instead of deleting
        // the checkpoint currently being committed.
        if (target === protectedTarget) continue;
        await withFileMutationQueue(target, () => withFileLock(target, async () => {
          // Re-evaluate after acquiring the candidate's lock. A concurrent save
          // may have made it recent while prune waited, and deleting it would
          // discard a just-committed resumable checkpoint.
          const currentNames = (await readdir(this.#dir)).filter((name) => name.endsWith(".json"));
          if (currentNames.length <= this.#maxRuns) return;
          const currentByAge = await Promise.all(currentNames.map(async (name) => ({
            mtime: (await stat(join(this.#dir, name))).mtimeMs,
            name
          })));
          currentByAge.sort((a, b) => b.mtime - a.mtime);
          if (!currentByAge.slice(this.#maxRuns).some((entry) => entry.name === candidate.name)) return;
          await rm(target, { force: true });
        }));
      }
    } catch {
      /* retention is best-effort */
    }
  }

  async findByRunId(runId: string): Promise<readonly ExecutionCheckpoint[]> {
    let raw: string;
    try {
      raw = await readFile(join(this.#dir, runFileName(runId)), "utf8");
    } catch {
      return [];
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
    let names: string[];
    try {
      names = (await readdir(this.#dir)).filter((n) => n.endsWith(".json"));
    } catch {
      return [];
    }
    const out: { runId: string; step: number; phase: string; updatedAt: Date }[] = [];
    for (const name of names) {
      let checkpoints: readonly ExecutionCheckpoint[];
      try {
        const raw = await readFile(join(this.#dir, name), "utf8");
        const parsed: unknown = JSON.parse(raw);
        if (!Array.isArray(parsed)) continue;
        checkpoints = parsed.map(deserialize).filter((c): c is ExecutionCheckpoint => c !== undefined).sort(byStep);
      } catch {
        continue;
      }
      const latest = checkpoints[checkpoints.length - 1];
      if (!latest || checkpointPhase(latest) === "complete") continue; // a finished run isn't resumable
      const progress = checkpoints.filter((c) => checkpointPhase(c) === "act" || checkpointPhase(c) === "start");
      const at = progress[progress.length - 1] ?? latest;
      out.push({ phase: checkpointPhase(at), runId: at.runId, step: at.step, updatedAt: latest.createdAt });
    }
    return out.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  }

  async save(input: SaveCheckpointInput): Promise<ExecutionCheckpoint> {
    const checkpoint: ExecutionCheckpoint = {
      createdAt: input.createdAt ?? new Date(),
      id: input.id ?? this.#idFactory(),
      runId: input.runId,
      state: input.state,
      step: input.step
    };
    const target = join(this.#dir, runFileName(input.runId));
    return withFileMutationQueue(target, () => withFileLock(target, async () => {
      const existing = [...await this.findByRunId(input.runId)];
      const at = existing.findIndex((candidate) => candidate.step === checkpoint.step);
      if (at >= 0) existing[at] = checkpoint;
      else existing.push(checkpoint);
      existing.sort(byStep);
      const capped = existing.slice(-this.#maxPerRun);
      if (!this.#ensuredDir) {
        await mkdir(this.#dir, { recursive: true });
        this.#ensuredDir = true;
      }
      const tmp = `${target}.${fileSafeSegment(checkpoint.id)}.tmp`;
      await writeFile(tmp, JSON.stringify(capped.map(serialize)), "utf8");
      await rename(tmp, target);
      await this.#pruneOldRuns(target);
      return checkpoint;
    }));
  }

  async deleteByRunId(runId: string): Promise<void> {
    const target = join(this.#dir, runFileName(runId));
    await withFileMutationQueue(target, () => withFileLock(target, async () => {
      await rm(target, { force: true }).catch(() => undefined);
    }));
  }
}

function requirePositiveSafeInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return resolved;
}
