/**
 * A disk-backed CheckpointStore for the LOCAL-FIRST product. The Kysely store keeps
 * checkpoints in Postgres, and the no-DB default fell back to InMemory — which dies
 * with the process, so a crashed local run could never resume. This persists each
 * run's checkpoints to `<dir>/<runId>.json` so a mid-run crash + restart can replay
 * from the last step (the langgraph "save graph state at each step, resume" gap).
 *
 * Single-user + sequential, so a plain read-modify-write per save is safe. Tolerant:
 * a missing / corrupt file reads as no checkpoints (never throws into the agent loop).
 */

import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createRunId, isRecord, type JsonObject, withBestEffort } from "@muse/shared";

import type { CheckpointStore, ExecutionCheckpoint, SaveCheckpointInput } from "./index.js";

const DEFAULT_MAX_PER_RUN = 50;
const DEFAULT_MAX_RUNS = 500;

/** Filesystem-safe filename for a runId (no path traversal, no separators). */
function runFileName(runId: string): string {
  return `${runId.replace(/[^A-Za-z0-9._-]/gu, "_").slice(0, 200)}.json`;
}

function serialize(checkpoint: ExecutionCheckpoint): JsonObject {
  return { createdAt: checkpoint.createdAt.toISOString(), id: checkpoint.id, runId: checkpoint.runId, state: checkpoint.state, step: checkpoint.step };
}

function deserialize(raw: unknown): ExecutionCheckpoint | undefined {
  if (!isRecord(raw)) return undefined;
  const r = raw;
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
  const p = isRecord(c.state) ? c.state.phase : undefined;
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
    this.#maxPerRun = options.maxCheckpointsPerRun ?? DEFAULT_MAX_PER_RUN;
    this.#maxRuns = options.maxRuns ?? DEFAULT_MAX_RUNS;
    this.#pruneInterval = Math.max(1, options.pruneIntervalSaves ?? 25);
    this.#idFactory = options.idFactory ?? (() => createRunId("checkpoint"));
  }

  /** Bound disk: keep only the most-recently-modified `maxRuns` run files. A
   *  completed run's checkpoints linger for replay (P3) but never grow unbounded.
   *  Amortized — only scans the dir every Nth save (the per-step hot loop calls
   *  save many times). Best-effort — a prune failure never breaks a save. */
  async #pruneOldRuns(): Promise<void> {
    this.#savesSincePrune += 1;
    if (this.#savesSincePrune < this.#pruneInterval) return;
    this.#savesSincePrune = 0;
    try {
      const names = (await readdir(this.#dir)).filter((n) => n.endsWith(".json"));
      if (names.length <= this.#maxRuns) return;
      const withMtime = await Promise.all(names.map(async (n) => ({ mtime: (await stat(join(this.#dir, n))).mtimeMs, name: n })));
      withMtime.sort((a, b) => b.mtime - a.mtime); // newest first
    await Promise.all(withMtime.slice(this.#maxRuns).map((e) => withBestEffort(rm(join(this.#dir, e.name), { force: true }), undefined)));
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
    const existing = [...await this.findByRunId(input.runId)];
    const at = existing.findIndex((c) => c.step === checkpoint.step);
    if (at >= 0) existing[at] = checkpoint;
    else existing.push(checkpoint);
    existing.sort(byStep);
    const capped = existing.slice(-this.#maxPerRun);
    if (!this.#ensuredDir) {
      await mkdir(this.#dir, { recursive: true });
      this.#ensuredDir = true;
    }
    // Atomic write: a crash mid-write must not corrupt the file and lose ALL prior
    // good checkpoints for this run — exactly when fault-tolerance matters. Write a
    // temp file then rename (atomic on POSIX); the reader never sees a partial file.
    const target = join(this.#dir, runFileName(input.runId));
    const tmp = `${target}.${checkpoint.id}.tmp`;
    await writeFile(tmp, JSON.stringify(capped.map(serialize)), "utf8");
    await rename(tmp, target);
    await this.#pruneOldRuns();
    return checkpoint;
  }

  async deleteByRunId(runId: string): Promise<void> {
  await withBestEffort(rm(join(this.#dir, runFileName(runId)), { force: true }), undefined);
}
}
