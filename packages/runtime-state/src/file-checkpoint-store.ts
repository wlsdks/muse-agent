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

import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createRunId, type JsonObject } from "@muse/shared";

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

export interface FileCheckpointStoreOptions {
  readonly maxCheckpointsPerRun?: number;
  /** Cap on the number of distinct run files kept; the oldest are pruned. */
  readonly maxRuns?: number;
  readonly idFactory?: () => string;
}

export class FileCheckpointStore implements CheckpointStore {
  readonly #dir: string;
  readonly #maxPerRun: number;
  readonly #maxRuns: number;
  readonly #idFactory: () => string;
  #ensuredDir = false;

  constructor(dir: string, options: FileCheckpointStoreOptions = {}) {
    this.#dir = dir;
    this.#maxPerRun = options.maxCheckpointsPerRun ?? DEFAULT_MAX_PER_RUN;
    this.#maxRuns = options.maxRuns ?? DEFAULT_MAX_RUNS;
    this.#idFactory = options.idFactory ?? (() => createRunId("checkpoint"));
  }

  /** Bound disk: keep only the most-recently-modified `maxRuns` run files. A
   *  completed run's checkpoints linger for replay (P3) but never grow unbounded.
   *  Best-effort — a prune failure never breaks a save. */
  async #pruneOldRuns(): Promise<void> {
    try {
      const names = (await readdir(this.#dir)).filter((n) => n.endsWith(".json"));
      if (names.length <= this.#maxRuns) return;
      const withMtime = await Promise.all(names.map(async (n) => ({ mtime: (await stat(join(this.#dir, n))).mtimeMs, name: n })));
      withMtime.sort((a, b) => b.mtime - a.mtime); // newest first
      await Promise.all(withMtime.slice(this.#maxRuns).map((e) => rm(join(this.#dir, e.name), { force: true }).catch(() => undefined)));
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
   * Runs that crashed/were interrupted mid-execution — every run whose LATEST
   * checkpoint isn't a terminal `complete` phase. The resume command replays these.
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
      if (!latest) continue;
      const phase = typeof (latest.state as { phase?: unknown }).phase === "string" ? (latest.state as { phase: string }).phase : "unknown";
      if (phase === "complete") continue; // a finished run isn't resumable
      out.push({ phase, runId: latest.runId, step: latest.step, updatedAt: latest.createdAt });
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
    await writeFile(join(this.#dir, runFileName(input.runId)), JSON.stringify(capped.map(serialize)), "utf8");
    await this.#pruneOldRuns();
    return checkpoint;
  }

  async deleteByRunId(runId: string): Promise<void> {
    await rm(join(this.#dir, runFileName(runId)), { force: true }).catch(() => undefined);
  }
}
