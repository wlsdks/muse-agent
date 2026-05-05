import { createRunId, type JsonObject } from "@muse/shared";

export type Awaitable<T> = T | Promise<T>;
export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired" | "cancelled";
export type Reversibility = "reversible" | "partially_reversible" | "irreversible" | "unknown";

export interface ApprovalContext {
  readonly reason?: string;
  readonly action?: string;
  readonly impactScope?: string;
  readonly reversibility?: Reversibility;
}

export interface ToolApprovalRequest {
  readonly id: string;
  readonly runId: string;
  readonly userId: string;
  readonly toolName: string;
  readonly arguments: JsonObject;
  readonly context: ApprovalContext;
  readonly timeoutMs: number;
  readonly requestedAt: Date;
}

export interface ToolApprovalResponse {
  readonly approved: boolean;
  readonly reason?: string;
  readonly modifiedArguments?: JsonObject;
}

export interface ApprovalSummary extends ToolApprovalRequest {
  readonly status: ApprovalStatus;
}

export interface PendingApprovalStore {
  requestApproval(input: RequestApprovalInput): Promise<ToolApprovalResponse>;
  listPending(): Awaitable<readonly ApprovalSummary[]>;
  listPendingByUser(userId: string): Awaitable<readonly ApprovalSummary[]>;
  countPending(): Awaitable<number>;
  countPendingByUser(userId: string): Awaitable<number>;
  approve(approvalId: string, modifiedArguments?: JsonObject): Awaitable<boolean>;
  reject(approvalId: string, reason?: string): Awaitable<boolean>;
}

export interface RequestApprovalInput {
  readonly runId: string;
  readonly userId: string;
  readonly toolName: string;
  readonly arguments: JsonObject;
  readonly timeoutMs?: number;
  readonly context?: ApprovalContext;
}

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
}

export interface InMemoryPendingApprovalStoreOptions {
  readonly defaultTimeoutMs?: number;
  readonly maxPending?: number;
  readonly idFactory?: () => string;
}

export interface InMemoryCheckpointStoreOptions {
  readonly maxCheckpointsPerRun?: number;
  readonly maxRuns?: number;
  readonly idFactory?: () => string;
}

export type HookLifecycle = "beforeStart" | "afterComplete" | "onError";
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

export class InMemoryPendingApprovalStore implements PendingApprovalStore {
  static readonly defaultMaxPending = 10_000;
  static readonly defaultTimeoutMs = 300_000;

  private readonly defaultTimeoutMs: number;
  private readonly maxPending: number;
  private readonly idFactory: () => string;
  private readonly pending = new Map<string, PendingApprovalEntry>();

  constructor(options: InMemoryPendingApprovalStoreOptions = {}) {
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? InMemoryPendingApprovalStore.defaultTimeoutMs;
    this.maxPending = options.maxPending ?? InMemoryPendingApprovalStore.defaultMaxPending;
    this.idFactory = options.idFactory ?? (() => createRunId("approval"));
  }

  requestApproval(input: RequestApprovalInput): Promise<ToolApprovalResponse> {
    const request = this.createRequest(input);
    const promise = new Promise<ToolApprovalResponse>((resolve) => {
      const entry: PendingApprovalEntry = { request, resolve };

      this.pending.set(request.id, entry);
      this.evictOverflow();

      const timeout = setTimeout(() => {
        if (this.pending.delete(request.id)) {
          resolve({
            approved: false,
            reason: `Approval timed out after ${request.timeoutMs}ms`
          });
        }
      }, request.timeoutMs);

      entry.timeout = timeout;
    });

    return promise.finally(() => {
      this.clear(request.id);
    });
  }

  listPending(): readonly ApprovalSummary[] {
    return [...this.pending.values()].map((entry) => toApprovalSummary(entry.request));
  }

  listPendingByUser(userId: string): readonly ApprovalSummary[] {
    return this.listPending().filter((approval) => approval.userId === userId);
  }

  countPending(): number {
    return this.pending.size;
  }

  countPendingByUser(userId: string): number {
    return this.listPendingByUser(userId).length;
  }

  approve(approvalId: string, modifiedArguments?: JsonObject): boolean {
    const entry = this.pending.get(approvalId);

    if (!entry) {
      return false;
    }

    entry.resolve({ approved: true, modifiedArguments });
    this.clear(approvalId);
    return true;
  }

  reject(approvalId: string, reason = "Rejected by human"): boolean {
    const entry = this.pending.get(approvalId);

    if (!entry) {
      return false;
    }

    entry.resolve({ approved: false, reason });
    this.clear(approvalId);
    return true;
  }

  private createRequest(input: RequestApprovalInput): ToolApprovalRequest {
    const timeoutMs = input.timeoutMs && input.timeoutMs > 0 ? input.timeoutMs : this.defaultTimeoutMs;

    return {
      arguments: input.arguments,
      context: input.context ?? {},
      id: this.idFactory(),
      requestedAt: new Date(),
      runId: input.runId,
      timeoutMs,
      toolName: input.toolName,
      userId: input.userId
    };
  }

  private evictOverflow(): void {
    while (this.pending.size > this.maxPending) {
      const oldestId = this.pending.keys().next().value as string | undefined;

      if (!oldestId) {
        return;
      }

      const entry = this.pending.get(oldestId);
      this.clear(oldestId);
      entry?.resolve({
        approved: false,
        reason: "Approval store overflow: request dropped because maxPending was exceeded"
      });
    }
  }

  private clear(approvalId: string): void {
    const entry = this.pending.get(approvalId);

    if (entry?.timeout) {
      clearTimeout(entry.timeout);
    }

    this.pending.delete(approvalId);
  }
}

export class InMemoryCheckpointStore implements CheckpointStore {
  static readonly defaultMaxCheckpointsPerRun = 50;
  static readonly defaultMaxRuns = 1_000;

  private readonly maxCheckpointsPerRun: number;
  private readonly maxRuns: number;
  private readonly idFactory: () => string;
  private readonly checkpointsByRunId = new Map<string, ExecutionCheckpoint[]>();

  constructor(options: InMemoryCheckpointStoreOptions = {}) {
    this.maxCheckpointsPerRun =
      options.maxCheckpointsPerRun ?? InMemoryCheckpointStore.defaultMaxCheckpointsPerRun;
    this.maxRuns = options.maxRuns ?? InMemoryCheckpointStore.defaultMaxRuns;
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
    this.maxTraces = options.maxTraces ?? InMemoryHookTraceStore.defaultMaxTraces;
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

interface PendingApprovalEntry {
  readonly request: ToolApprovalRequest;
  readonly resolve: (response: ToolApprovalResponse) => void;
  timeout?: NodeJS.Timeout;
}

function toApprovalSummary(request: ToolApprovalRequest): ApprovalSummary {
  return {
    ...request,
    status: "pending"
  };
}

function compareCheckpoints(left: ExecutionCheckpoint, right: ExecutionCheckpoint): number {
  return left.step - right.step || left.createdAt.getTime() - right.createdAt.getTime();
}

function compareHookTraces(left: HookTrace, right: HookTrace): number {
  return left.startedAt.getTime() - right.startedAt.getTime() || left.createdAt.getTime() - right.createdAt.getTime();
}

export { KyselyCheckpointStore, KyselyHookTraceStore, KyselyPendingApprovalStore } from "./kysely-stores.js";
export type {
  KyselyCheckpointStoreOptions,
  KyselyHookTraceStoreOptions,
  KyselyPendingApprovalStoreOptions
} from "./kysely-stores.js";
export * from "./run-history.js";
