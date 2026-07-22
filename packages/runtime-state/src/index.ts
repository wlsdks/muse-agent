import { createRunId, type JsonObject } from "@muse/shared";

export {
  readLocalCheckpointEvidenceStrict,
  type LocalCheckpointEvidence,
  type LocalCheckpointEvidenceReadResult
} from "./local-checkpoint-evidence.js";
export { createCheckpointContinuityEvidence } from "./checkpoint-v3.js";
export * from "./resident-daemon-status.js";

export type Awaitable<T> = T | Promise<T>;

export interface ExecutionCheckpoint {
  readonly id: string;
  readonly runId: string;
  readonly step: number;
  readonly state: JsonObject;
  readonly createdAt: Date;
}

export interface CheckpointStore {
  save(checkpoint: SaveCheckpointInput): Promise<ExecutionCheckpoint>;
  findByRunId(runId: string): Promise<readonly ExecutionCheckpoint[]>;
  findLatestByRunId(runId: string): Promise<ExecutionCheckpoint | undefined>;
  deleteByRunId(runId: string): Promise<void>;
}

export interface SaveCheckpointInput {
  readonly id?: string;
  readonly runId: string;
  readonly step: number;
  readonly state: JsonObject;
  readonly createdAt?: Date;
  /** Purpose-built, bounded context for future-only exact Continuity evidence. */
  readonly continuityEvidence?: CheckpointContinuityEvidence;
}

export interface CheckpointContinuityEvidence {
  readonly phase: "start" | "act" | "failed" | "complete";
  readonly query: string;
}

export interface InMemoryCheckpointStoreOptions {
  readonly maxCheckpointsPerRun?: number;
  readonly maxRuns?: number;
  readonly idFactory?: () => string;
}

export type HookLifecycle = "beforeStart" | "beforeTool" | "afterTool" | "afterComplete" | "onError";
export type HookTraceStatus = "completed" | "failed";

export interface HookTrace {
  readonly id: string;
  readonly runId: string;
  readonly hookId: string;
  readonly lifecycle: HookLifecycle;
  readonly status: HookTraceStatus;
  readonly durationMs: number;
  readonly error?: string;
  readonly metadata: JsonObject;
  readonly startedAt: Date;
  readonly completedAt: Date;
  readonly createdAt: Date;
}

export interface RecordHookTraceInput {
  readonly id?: string;
  readonly runId: string;
  readonly hookId: string;
  readonly lifecycle: HookLifecycle;
  readonly status: HookTraceStatus;
  readonly durationMs?: number;
  readonly error?: string;
  readonly metadata?: JsonObject;
  readonly startedAt?: Date;
  readonly completedAt?: Date;
  readonly createdAt?: Date;
}

export interface HookTraceStore {
  record(input: RecordHookTraceInput): Awaitable<HookTrace>;
  listByRunId(runId: string): Awaitable<readonly HookTrace[]>;
  listRecent(limit?: number): Awaitable<readonly HookTrace[]>;
}

export interface InMemoryHookTraceStoreOptions {
  readonly maxTraces?: number;
  readonly idFactory?: () => string;
  readonly now?: () => Date;
}

export class InMemoryCheckpointStore implements CheckpointStore {
  static readonly defaultMaxCheckpointsPerRun = 50;
  static readonly defaultMaxRuns = 1_000;

  private readonly maxCheckpointsPerRun: number;
  private readonly maxRuns: number;
  private readonly idFactory: () => string;
  private readonly checkpointsByRunId = new Map<string, ExecutionCheckpoint[]>();

  constructor(options: InMemoryCheckpointStoreOptions = {}) {
    this.maxCheckpointsPerRun = requirePositiveSafeInteger(
      options.maxCheckpointsPerRun,
      InMemoryCheckpointStore.defaultMaxCheckpointsPerRun,
      "maxCheckpointsPerRun"
    );
    this.maxRuns = requirePositiveSafeInteger(
      options.maxRuns,
      InMemoryCheckpointStore.defaultMaxRuns,
      "maxRuns"
    );
    this.idFactory = options.idFactory ?? (() => createRunId("checkpoint"));
  }

  async save(input: SaveCheckpointInput): Promise<ExecutionCheckpoint> {
    this.evictRunsIfNeeded(input.runId);

    const checkpoints = this.checkpointsByRunId.get(input.runId) ?? [];
    const checkpoint: ExecutionCheckpoint = {
      createdAt: input.createdAt ?? new Date(),
      id: input.id ?? this.idFactory(),
      runId: input.runId,
      state: input.state,
      step: input.step
    };
    const existingIndex = checkpoints.findIndex((item) => item.step === checkpoint.step);

    if (existingIndex >= 0) {
      checkpoints[existingIndex] = checkpoint;
    } else {
      checkpoints.push(checkpoint);
    }

    checkpoints.sort(compareCheckpoints);
    this.checkpointsByRunId.set(input.runId, checkpoints.slice(-this.maxCheckpointsPerRun));
    return checkpoint;
  }

  async findByRunId(runId: string): Promise<readonly ExecutionCheckpoint[]> {
    return [...(this.checkpointsByRunId.get(runId) ?? [])].sort(compareCheckpoints);
  }

  async findLatestByRunId(runId: string): Promise<ExecutionCheckpoint | undefined> {
    return (await this.findByRunId(runId)).at(-1);
  }

  async deleteByRunId(runId: string): Promise<void> {
    this.checkpointsByRunId.delete(runId);
  }

  private evictRunsIfNeeded(nextRunId: string): void {
    if (this.checkpointsByRunId.has(nextRunId)) {
      return;
    }

    while (this.checkpointsByRunId.size >= this.maxRuns) {
      const oldestRunId = this.checkpointsByRunId.keys().next().value as string | undefined;

      if (!oldestRunId) {
        return;
      }

      this.checkpointsByRunId.delete(oldestRunId);
    }
  }
}

export class InMemoryHookTraceStore implements HookTraceStore {
  static readonly defaultMaxTraces = 10_000;

  private readonly maxTraces: number;
  private readonly idFactory: () => string;
  private readonly now: () => Date;
  private readonly traces: HookTrace[] = [];

  constructor(options: InMemoryHookTraceStoreOptions = {}) {
    this.maxTraces = requirePositiveSafeInteger(
      options.maxTraces,
      InMemoryHookTraceStore.defaultMaxTraces,
      "maxTraces"
    );
    this.idFactory = options.idFactory ?? (() => createRunId("hook_trace"));
    this.now = options.now ?? (() => new Date());
  }

  record(input: RecordHookTraceInput): HookTrace {
    const startedAt = input.startedAt ?? this.now();
    const completedAt = input.completedAt ?? this.now();
    const trace: HookTrace = {
      completedAt,
      createdAt: input.createdAt ?? this.now(),
      durationMs: input.durationMs ?? Math.max(0, completedAt.getTime() - startedAt.getTime()),
      ...(input.error ? { error: input.error } : {}),
      hookId: input.hookId,
      id: input.id ?? this.idFactory(),
      lifecycle: input.lifecycle,
      metadata: input.metadata ?? {},
      runId: input.runId,
      startedAt,
      status: input.status
    };

    this.traces.push(trace);
    this.traces.splice(0, Math.max(0, this.traces.length - this.maxTraces));
    return trace;
  }

  listByRunId(runId: string): readonly HookTrace[] {
    return this.traces
      .filter((trace) => trace.runId === runId)
      .sort(compareHookTraces);
  }

  listRecent(limit = 100): readonly HookTrace[] {
    return [...this.traces]
      .sort((left, right) => compareHookTraces(right, left))
      .slice(0, Math.max(0, limit));
  }
}

function compareCheckpoints(left: ExecutionCheckpoint, right: ExecutionCheckpoint): number {
  return left.step - right.step || left.createdAt.getTime() - right.createdAt.getTime();
}

function compareHookTraces(left: HookTrace, right: HookTrace): number {
  return left.startedAt.getTime() - right.startedAt.getTime() || left.createdAt.getTime() - right.createdAt.getTime();
}

function requirePositiveSafeInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }

  return resolved;
}

export { KyselyCheckpointStore, KyselyHookTraceStore } from "./kysely-stores.js";
export type {
  KyselyCheckpointStoreOptions,
  KyselyHookTraceStoreOptions
} from "./kysely-stores.js";
export * from "./debug-replay.js";
export * from "./run-history.js";
export * from "./run-history-in-memory.js";
export * from "./run-history-kysely.js";
export * from "./session-tags.js";
export * from "./local-run-evidence.js";
export {
  FileCheckpointStore,
  pruneCheckpointFilesByAge,
  type CheckpointAgePruneResult,
  type FileCheckpointStoreOptions
} from "./file-checkpoint-store.js";
