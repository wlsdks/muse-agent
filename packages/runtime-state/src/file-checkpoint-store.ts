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
import { lstat, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, parse, relative, resolve } from "node:path";

import { createRunId, isCanonicalWorkspaceRealpath, withFileLock, withFileMutationQueue, type JsonObject } from "@muse/shared";

import type { CheckpointStore, ExecutionCheckpoint, SaveCheckpointInput } from "./index.js";
import {
  CHECKPOINT_V3_DIRECTORY,
  checkpointV3FileName,
  createCheckpointContinuityEvidence,
  deserializeCheckpointV3,
  parseCheckpointV3Envelope,
  serializeCheckpointV3,
  type CheckpointV3Envelope
} from "./checkpoint-v3.js";

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

function v3CheckpointFilePath(dir: string, workspaceRealpath: string, runId: string): string {
  return join(dir, CHECKPOINT_V3_DIRECTORY, checkpointV3FileName(workspaceRealpath, runId));
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
  /** Explicit workspace authority. Absent stores remain v2-only and never discover v3. */
  readonly continuityWorkspaceDir?: string;
}

interface CheckpointRetentionGroup {
  readonly mtime: number;
  readonly runId: string;
  /** Undefined identifies the shared legacy/v2 logical group. */
  readonly workspaceRealpath?: string;
}

function checkpointRetentionGroupKey(group: Pick<CheckpointRetentionGroup, "runId" | "workspaceRealpath">): string {
  return JSON.stringify(group.workspaceRealpath === undefined
    ? ["unscoped", group.runId]
    : ["scoped", group.workspaceRealpath, group.runId]);
}

function compareCheckpointRetentionGroups(left: CheckpointRetentionGroup, right: CheckpointRetentionGroup): number {
  return right.mtime - left.mtime || checkpointRetentionGroupKey(left).localeCompare(checkpointRetentionGroupKey(right));
}

export class FileCheckpointStore implements CheckpointStore {
  readonly #dir: string;
  readonly #maxPerRun: number;
  readonly #maxRuns: number;
  readonly #pruneInterval: number;
  readonly #idFactory: () => string;
  readonly #continuityWorkspaceDir?: string;
  #workspaceRealpath?: string;
  #savesSincePrune = 0;

  constructor(dir: string, options: FileCheckpointStoreOptions = {}) {
    this.#dir = dir;
    this.#maxPerRun = requirePositiveSafeInteger(options.maxCheckpointsPerRun, DEFAULT_MAX_PER_RUN, "maxCheckpointsPerRun");
    this.#maxRuns = requirePositiveSafeInteger(options.maxRuns, DEFAULT_MAX_RUNS, "maxRuns");
    this.#pruneInterval = requirePositiveSafeInteger(options.pruneIntervalSaves, 25, "pruneIntervalSaves");
    this.#idFactory = options.idFactory ?? (() => createRunId("checkpoint"));
    this.#continuityWorkspaceDir = options.continuityWorkspaceDir;
  }

  async #resolveWorkspaceRealpath(): Promise<string | undefined> {
    if (this.#workspaceRealpath) return this.#workspaceRealpath;
    const configured = this.#continuityWorkspaceDir;
    if (!configured || !isCanonicalWorkspaceRealpath(configured) || configured === "/") return undefined;
    try {
      const resolved = await realpath(configured);
      if (resolved !== configured || !isCanonicalWorkspaceRealpath(resolved) || resolved === "/") return undefined;
      this.#workspaceRealpath = resolved;
      return resolved;
    } catch {
      // Do not cache failures: a workspace may be mounted/created before a later save.
      return undefined;
    }
  }

  async #readFormats(runId: string): Promise<readonly ExecutionCheckpoint[]> {
    const workspaceRealpath = await this.#resolveWorkspaceRealpath();
    const sources: Array<{ readonly checkpoints: readonly ExecutionCheckpoint[]; readonly priority: number }> = [];
    if (workspaceRealpath) {
      const envelope = await readCheckpointV3File(v3CheckpointFilePath(this.#dir, workspaceRealpath, runId));
      if (envelope && envelope.provenance.runId === runId && envelope.provenance.workspaceRealpath === workspaceRealpath) {
        sources.push({ checkpoints: envelope.checkpoints.map(deserializeCheckpointV3), priority: 3 });
      }
    }
    const [v2, legacy] = await Promise.all(checkpointFilePaths(this.#dir, runId).map(readCheckpointFile));
    if (v2 && checkpointRunId(v2) === runId) sources.push({ checkpoints: v2, priority: 2 });
    if (legacy && checkpointRunId(legacy) === runId) sources.push({ checkpoints: legacy, priority: 1 });
    return mergeCheckpointSources(sources);
  }

  /** Bound disk: keep only the most-recently-modified `maxRuns` run files. A
   *  completed run's checkpoints linger for replay (P3) but never grow unbounded.
   *  Amortized — only scans the dir every Nth save (the per-step hot loop calls
   *  save many times). Best-effort — a prune failure never breaks a save. */
  async #checkpointGroups(): Promise<readonly CheckpointRetentionGroup[]> {
    const groups: CheckpointRetentionGroup[] = [];
    const workspaceRealpath = await this.#resolveWorkspaceRealpath();
    for (const runId of await listUnscopedCheckpointRunIds(this.#dir)) {
      let newest = Number.NEGATIVE_INFINITY;
      for (const file of checkpointFilePaths(this.#dir, runId)) {
        try {
          newest = Math.max(newest, (await stat(file)).mtimeMs);
        } catch {
          // Missing/corrupt candidates are ignored by count retention.
        }
      }
      if (!Number.isFinite(newest)) continue;
      groups.push({ mtime: newest, runId });
    }
    if (workspaceRealpath) {
      for (const runId of await listScopedCheckpointRunIds(this.#dir, workspaceRealpath)) {
        try {
          groups.push({
            mtime: (await stat(v3CheckpointFilePath(this.#dir, workspaceRealpath, runId))).mtimeMs,
            runId,
            workspaceRealpath
          });
        } catch {
          // A concurrent delete can make a retention candidate disappear.
        }
      }
    }
    return groups;
  }

  async #pruneOldRuns(protectedRunId: string, protectedWorkspaceRealpath?: string): Promise<void> {
    this.#savesSincePrune += 1;
    if (this.#savesSincePrune < this.#pruneInterval) return;
    this.#savesSincePrune = 0;
    try {
      const groups = [...await this.#checkpointGroups()].sort(compareCheckpointRetentionGroups);
      if (groups.length <= this.#maxRuns) return;
      for (const candidate of groups.slice(this.#maxRuns)) {
        if (sameRetentionGroup(candidate, { runId: protectedRunId, workspaceRealpath: protectedWorkspaceRealpath })) continue;
        await withCheckpointFileLocks(checkpointRetentionGroupFiles(this.#dir, candidate), async () => {
          const current = [...await this.#checkpointGroups()].sort(compareCheckpointRetentionGroups);
          if (current.length <= this.#maxRuns || !current.slice(this.#maxRuns).some((entry) => sameRetentionGroup(entry, candidate))) {
            return;
          }
          await removeCheckpointRetentionGroup(this.#dir, candidate);
        });
      }
    } catch {
      /* retention is best-effort */
    }
  }

  async findByRunId(runId: string): Promise<readonly ExecutionCheckpoint[]> {
    return this.#readFormats(runId);
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
    const workspaceRealpath = await this.#resolveWorkspaceRealpath();
    for (const runId of await listCheckpointRunIds(this.#dir, workspaceRealpath)) {
      const checkpoints = await this.#readFormats(runId);
      if (checkpoints.length === 0) continue;
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
    return [...byRunId.values()].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime() || a.runId.localeCompare(b.runId));
  }

  async save(input: SaveCheckpointInput): Promise<ExecutionCheckpoint> {
    const checkpoint: ExecutionCheckpoint = {
      createdAt: input.createdAt ?? new Date(),
      id: input.id ?? this.#idFactory(),
      runId: input.runId,
      state: input.state,
      step: input.step
    };
    const workspaceRealpath = await this.#resolveWorkspaceRealpath();
    let protectedWorkspaceRealpath: string | undefined;
    let saved: ExecutionCheckpoint;
    if (workspaceRealpath) {
      try {
        saved = await this.#saveV3(checkpoint, input, workspaceRealpath);
        protectedWorkspaceRealpath = workspaceRealpath;
      } catch {
        saved = await this.#saveV2(checkpoint);
      }
    } else {
      saved = await this.#saveV2(checkpoint);
    }
    // Retention may lock a different run. It must run after the committing
    // run's locks are released, otherwise two concurrent saves can each hold
    // one run while pruning the other.
    await this.#pruneOldRuns(checkpoint.runId, protectedWorkspaceRealpath);
    return saved;
  }

  async deleteByRunId(runId: string): Promise<void> {
    const workspaceRealpath = await this.#resolveWorkspaceRealpath();
    await ensureCanonicalDirectory(join(this.#dir, V2_DIRECTORY));
    await withRunFileLocks(this.#dir, runId, workspaceRealpath, async () => removeCheckpointsForRun(this.#dir, runId, workspaceRealpath));
  }

  async #saveV2(checkpoint: ExecutionCheckpoint): Promise<ExecutionCheckpoint> {
    await ensureCanonicalDirectory(join(this.#dir, V2_DIRECTORY));
    const target = checkpointFilePaths(this.#dir, checkpoint.runId)[0]!;
    return withRunFileLocks(this.#dir, checkpoint.runId, undefined, async () => {
      const current = await readCheckpointFile(target);
      const existing = current && checkpointRunId(current) === checkpoint.runId ? [...current] : [];
      upsertCheckpoint(existing, checkpoint, this.#maxPerRun);
      const tmp = `${target}.${fileSafeSegment(checkpoint.id)}.tmp`;
      await writeFile(tmp, JSON.stringify(existing.map(serialize)), "utf8");
      await rename(tmp, target);
      return checkpoint;
    });
  }

  async #saveV3(checkpoint: ExecutionCheckpoint, input: SaveCheckpointInput, workspaceRealpath: string): Promise<ExecutionCheckpoint> {
    await ensureCanonicalDirectory(join(this.#dir, CHECKPOINT_V3_DIRECTORY));
    const target = v3CheckpointFilePath(this.#dir, workspaceRealpath, checkpoint.runId);
    return withRunFileLocks(this.#dir, checkpoint.runId, workspaceRealpath, async () => {
      const current = await readCheckpointV3File(target);
      const existing = current?.provenance.runId === checkpoint.runId && current.provenance.workspaceRealpath === workspaceRealpath
        ? current.checkpoints.map(deserializeCheckpointV3)
        : [];
      upsertCheckpoint(existing, checkpoint, this.#maxPerRun);
      const evidenceByStep = new Map(current?.checkpoints.map((item) => [item.step, item.continuityEvidence] as const) ?? []);
      const evidence = input.continuityEvidence
        ? createCheckpointContinuityEvidence(input.continuityEvidence.query, input.continuityEvidence.phase)
        : undefined;
      evidenceByStep.set(checkpoint.step, evidence);
      const envelope: CheckpointV3Envelope = {
        checkpoints: existing.map((item) => serializeCheckpointV3(item, evidenceByStep.get(item.step))),
        provenance: { runId: checkpoint.runId, workspaceRealpath },
        schemaVersion: 3
      };
      if (!parseCheckpointV3Envelope(envelope)) {
        throw new Error("checkpoint is not valid for the strict v3 persistence contract");
      }
      const tmp = `${target}.${fileSafeSegment(checkpoint.id)}.tmp`;
      await writeFile(tmp, JSON.stringify(envelope), "utf8");
      await rename(tmp, target);
      return checkpoint;
    });
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

async function readCheckpointV3File(file: string): Promise<CheckpointV3Envelope | undefined> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return undefined;
  }
  try {
    return parseCheckpointV3Envelope(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

function mergeCheckpointSources(sources: readonly { readonly checkpoints: readonly ExecutionCheckpoint[]; readonly priority: number }[]): readonly ExecutionCheckpoint[] {
  const byStepMap = new Map<number, { readonly checkpoint: ExecutionCheckpoint; readonly priority: number }>();
  for (const source of sources) {
    for (const checkpoint of source.checkpoints) {
      const existing = byStepMap.get(checkpoint.step);
      if (!existing || source.priority > existing.priority) byStepMap.set(checkpoint.step, { checkpoint, priority: source.priority });
    }
  }
  return [...byStepMap.values()].map((entry) => entry.checkpoint).sort(byStep);
}

function upsertCheckpoint(checkpoints: ExecutionCheckpoint[], checkpoint: ExecutionCheckpoint, maxPerRun: number): void {
  const at = checkpoints.findIndex((candidate) => candidate.step === checkpoint.step);
  if (at >= 0) checkpoints[at] = checkpoint;
  else checkpoints.push(checkpoint);
  checkpoints.sort(byStep);
  if (checkpoints.length > maxPerRun) checkpoints.splice(0, checkpoints.length - maxPerRun);
}

async function ensureCanonicalDirectory(path: string): Promise<void> {
  if (!isCanonicalWorkspaceRealpath(path) || path === "/" || resolve(path) !== path) {
    throw new Error("checkpoint directory must be a non-root canonical absolute path");
  }
  let ancestor = path;
  while (true) {
    try {
      const info = await lstat(ancestor);
      if (!info.isDirectory() || info.isSymbolicLink() || await realpath(ancestor) !== ancestor) {
        throw new Error("checkpoint directory ancestor is not canonical");
      }
      break;
    } catch (cause) {
      if (ioCode(cause) !== "ENOENT") throw cause;
      const parent = dirname(ancestor);
      if (parent === ancestor || ancestor === parse(ancestor).root) throw cause;
      ancestor = parent;
    }
  }
  await mkdir(path, { recursive: true });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== path) {
    throw new Error("checkpoint directory is not canonical");
  }
}

function ioCode(cause: unknown): string | undefined {
  return cause && typeof cause === "object" && "code" in cause && typeof cause.code === "string" ? cause.code : undefined;
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

async function listUnscopedCheckpointRunIds(dir: string): Promise<readonly string[]> {
  const runIds = new Set<string>();
  for (const file of await listCheckpointFiles(dir)) {
    const checkpoints = await readCheckpointFile(file);
    const runId = checkpoints ? checkpointRunId(checkpoints) : undefined;
    if (runId) runIds.add(runId);
  }
  return [...runIds].sort();
}

async function listScopedCheckpointRunIds(dir: string, workspaceRealpath: string): Promise<readonly string[]> {
  const runIds = new Set<string>();
  let names: readonly string[] = [];
  try {
    const v3Dir = join(dir, CHECKPOINT_V3_DIRECTORY);
    const info = await lstat(v3Dir);
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(v3Dir) !== v3Dir) return [];
    names = (await readdir(v3Dir)).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
  for (const name of names) {
    const envelope = await readCheckpointV3File(join(dir, CHECKPOINT_V3_DIRECTORY, name));
    if (envelope?.provenance.workspaceRealpath === workspaceRealpath) runIds.add(envelope.provenance.runId);
  }
  return [...runIds].sort();
}

async function listCheckpointRunIds(dir: string, workspaceRealpath: string | undefined): Promise<readonly string[]> {
  const runIds = new Set(await listUnscopedCheckpointRunIds(dir));
  if (workspaceRealpath) {
    for (const runId of await listScopedCheckpointRunIds(dir, workspaceRealpath)) runIds.add(runId);
  }
  return [...runIds].sort();
}

function sameRetentionGroup(
  left: Pick<CheckpointRetentionGroup, "runId" | "workspaceRealpath">,
  right: Pick<CheckpointRetentionGroup, "runId" | "workspaceRealpath">
): boolean {
  return left.runId === right.runId && left.workspaceRealpath === right.workspaceRealpath;
}

function checkpointRetentionGroupFiles(dir: string, group: Pick<CheckpointRetentionGroup, "runId" | "workspaceRealpath">): readonly string[] {
  return group.workspaceRealpath
    ? [v3CheckpointFilePath(dir, group.workspaceRealpath, group.runId)]
    : checkpointFilePaths(dir, group.runId);
}

async function removeCheckpointRetentionGroup(dir: string, group: CheckpointRetentionGroup): Promise<void> {
  if (group.workspaceRealpath) {
    const file = v3CheckpointFilePath(dir, group.workspaceRealpath, group.runId);
    const envelope = await readCheckpointV3File(file);
    if (envelope?.provenance.runId === group.runId && envelope.provenance.workspaceRealpath === group.workspaceRealpath) {
      await rm(file, { force: true }).catch(() => undefined);
    }
    return;
  }
  for (const file of checkpointFilePaths(dir, group.runId)) {
    const checkpoints = await readCheckpointFile(file);
    if (checkpoints && checkpointRunId(checkpoints) === group.runId) {
      await rm(file, { force: true }).catch(() => undefined);
    }
  }
}

async function removeCheckpointsForRun(dir: string, runId: string, workspaceRealpath?: string): Promise<void> {
  for (const file of checkpointFilePaths(dir, runId)) {
    const checkpoints = await readCheckpointFile(file);
    if (checkpoints && checkpointRunId(checkpoints) === runId) {
      await rm(file, { force: true }).catch(() => undefined);
    }
  }
  if (workspaceRealpath) {
    const file = v3CheckpointFilePath(dir, workspaceRealpath, runId);
    const envelope = await readCheckpointV3File(file);
    if (envelope?.provenance.runId === runId && envelope.provenance.workspaceRealpath === workspaceRealpath) {
      await rm(file, { force: true }).catch(() => undefined);
    }
  }
}

async function withRunFileLocks<T>(dir: string, runId: string, workspaceRealpath: string | undefined, operation: () => Promise<T>): Promise<T> {
  const files = [
    ...checkpointFilePaths(dir, runId),
    ...(workspaceRealpath ? [v3CheckpointFilePath(dir, workspaceRealpath, runId)] : [])
  ];
  return withCheckpointFileLocks(files.sort(), operation);
}

async function withCheckpointFileLocks<T>(files: readonly string[], operation: () => Promise<T>): Promise<T> {
  const [file, ...remaining] = files;
  if (!file) return operation();
  return withFileMutationQueue(file, () => withFileLock(file, () => withCheckpointFileLocks(remaining, operation)));
}

export interface CheckpointAgePruneResult {
  readonly dropped: number;
  readonly droppedFiles: readonly string[];
  readonly kept: number;
}

/** Global owner housekeeping for one configured checkpoint root. */
export async function pruneCheckpointFilesByAge(
  dir: string,
  options: { readonly ageDays: number; readonly now?: number }
): Promise<CheckpointAgePruneResult> {
  const now = options.now ?? Date.now();
  const cutoff = now - options.ageDays * 86_400_000;
  if (!Number.isFinite(options.ageDays) || options.ageDays < 0 || !isCanonicalWorkspaceRealpath(dir) || dir === "/" || resolve(dir) !== dir) {
    throw new RangeError("checkpoint age pruning requires a non-negative age and canonical non-root directory");
  }
  try {
    const root = await lstat(dir);
    if (!root.isDirectory() || root.isSymbolicLink() || await realpath(dir) !== dir) return { dropped: 0, droppedFiles: [], kept: 0 };
  } catch (cause) {
    if (ioCode(cause) === "ENOENT") return { dropped: 0, droppedFiles: [], kept: 0 };
    throw cause;
  }
  const candidates: Array<{ readonly file: string; readonly identity: { dev: number; ino: number; size: number; mtimeMs: number } }> = [];
  for (const parent of [dir, join(dir, V2_DIRECTORY), join(dir, CHECKPOINT_V3_DIRECTORY)]) {
    try {
      const parentInfo = await lstat(parent);
      if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink() || await realpath(parent) !== parent) continue;
      for (const name of await readdir(parent)) {
        if (!name.endsWith(".json")) continue;
        const file = join(parent, name);
        const info = await lstat(file);
        if (!info.isFile() || info.isSymbolicLink()) continue;
        candidates.push({ file, identity: { dev: info.dev, ino: info.ino, mtimeMs: info.mtimeMs, size: info.size } });
      }
    } catch {
      // A missing/racing format directory contributes no candidates.
    }
  }
  let kept = 0;
  const droppedFiles: string[] = [];
  for (const candidate of candidates) {
    const dropped = await withCheckpointFileLocks([candidate.file], async () => {
      try {
        const current = await lstat(candidate.file);
        if (!current.isFile() || current.isSymbolicLink() || !sameFileIdentity(candidate.identity, current) || current.mtimeMs >= cutoff) return false;
        await rm(candidate.file);
        return true;
      } catch {
        return false;
      }
    });
    if (dropped) droppedFiles.push(relative(dir, candidate.file));
    else kept += 1;
  }
  return { dropped: droppedFiles.length, droppedFiles, kept };
}

function sameFileIdentity(
  left: { dev: number; ino: number; size: number; mtimeMs: number },
  right: { dev: number; ino: number; size: number; mtimeMs: number }
): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs;
}

function requirePositiveSafeInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return resolved;
}
