import type { JsonObject } from "@muse/shared";

import type {
  ScheduledJobDispatcher,
  ScheduledJobExecutionRecorder,
  ScheduledJobValidator,
  ScheduledMcpToolInvoker,
  SchedulerMessaging
} from "./scheduler-runtime.js";

export { SchedulerExecutionError, SchedulerValidationError } from "./scheduler-errors.js";
export {
  compareJobs,
  computeNextRunAt,
  createScheduledJobExecutionInsert,
  createScheduledJobInsert,
  createScheduledJobUpdate,
  mapScheduledJobExecutionRow,
  mapScheduledJobRow,
  normalizeScheduledJob,
  normalizeScheduledJobExecution,
  renderTemplateVariables,
  requireText,
  resolveJobTimeout
} from "./scheduler-helpers.js";

export type Awaitable<T> = T | Promise<T>;
export type ScheduledJobType = "mcp_tool" | "agent";
export type JobExecutionStatus = "success" | "failed" | "running" | "skipped";

export interface ScheduledJob {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly cronExpression: string;
  readonly timezone: string;
  readonly jobType: ScheduledJobType;
  readonly mcpServerName?: string;
  readonly toolName?: string;
  readonly toolArguments: JsonObject;
  readonly agentPrompt?: string;
  readonly personaId?: string;
  readonly agentSystemPrompt?: string;
  readonly agentModel?: string;
  readonly agentMaxToolCalls?: number;
  readonly tags: readonly string[];
  readonly notificationChannelId?: string;
  readonly webhookUrl?: string;
  readonly retryOnFailure: boolean;
  readonly maxRetryCount: number;
  readonly executionTimeoutMs?: number;
  readonly enabled: boolean;
  readonly lastRunAt?: Date;
  readonly lastStatus?: JobExecutionStatus;
  readonly lastResult?: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface ScheduledJobInput {
  readonly id?: string;
  readonly name: string;
  readonly description?: string | null;
  readonly cronExpression: string;
  readonly timezone?: string;
  readonly jobType?: ScheduledJobType;
  readonly mcpServerName?: string | null;
  readonly toolName?: string | null;
  readonly toolArguments?: JsonObject;
  readonly agentPrompt?: string | null;
  readonly personaId?: string | null;
  readonly agentSystemPrompt?: string | null;
  readonly agentModel?: string | null;
  readonly agentMaxToolCalls?: number | null;
  readonly tags?: readonly string[];
  readonly notificationChannelId?: string | null;
  readonly webhookUrl?: string | null;
  readonly retryOnFailure?: boolean;
  readonly maxRetryCount?: number;
  readonly executionTimeoutMs?: number | null;
  readonly enabled?: boolean;
  readonly lastRunAt?: Date | null;
  readonly lastStatus?: JobExecutionStatus | null;
  readonly lastResult?: string | null;
  readonly createdAt?: Date;
  readonly updatedAt?: Date;
}

export interface ScheduledJobExecution {
  readonly id: string;
  readonly jobId: string;
  readonly jobName: string;
  readonly status: JobExecutionStatus;
  readonly result?: string;
  readonly durationMs: number;
  readonly dryRun: boolean;
  readonly startedAt: Date;
  readonly completedAt?: Date;
}

export interface ScheduledJobExecutionInput {
  readonly id?: string;
  readonly jobId: string;
  readonly jobName: string;
  readonly status: JobExecutionStatus;
  readonly result?: string | null;
  readonly durationMs?: number;
  readonly dryRun?: boolean;
  readonly startedAt?: Date;
  readonly completedAt?: Date | null;
}

export interface ScheduledJobStore {
  list(): Awaitable<readonly ScheduledJob[]>;
  findById(id: string): Awaitable<ScheduledJob | undefined>;
  findByName(name: string): Awaitable<ScheduledJob | undefined>;
  save(job: ScheduledJobInput): Awaitable<ScheduledJob>;
  update(id: string, job: ScheduledJobInput): Awaitable<ScheduledJob | undefined>;
  delete(id: string): Awaitable<void>;
  updateExecutionResult(id: string, status: JobExecutionStatus, result?: string | null): Awaitable<void>;
}

export interface ScheduledJobExecutionStore {
  save(execution: ScheduledJobExecutionInput): Awaitable<ScheduledJobExecution>;
  findByJobId(jobId: string, limit?: number): Awaitable<readonly ScheduledJobExecution[]>;
  findRecent(limit?: number): Awaitable<readonly ScheduledJobExecution[]>;
  deleteOldestExecutions(jobId: string, keepCount: number): Awaitable<void>;
}

export interface InMemoryScheduledJobStoreOptions {
  readonly idFactory?: () => string;
  readonly maxJobs?: number;
  readonly now?: () => Date;
}

export interface InMemoryScheduledJobExecutionStoreOptions {
  readonly idFactory?: () => string;
  readonly maxEntries?: number;
  readonly now?: () => Date;
}

export interface KyselyScheduledJobStoreOptions {
  readonly idFactory?: () => string;
  readonly now?: () => Date;
}

export interface KyselyScheduledJobExecutionStoreOptions {
  readonly idFactory?: () => string;
  readonly now?: () => Date;
}

export interface KyselyDistributedSchedulerLockOptions {
  readonly ownerId?: string;
  readonly now?: () => Date;
}

export interface InMemoryDistributedSchedulerLockOptions {
  readonly ownerId?: string;
  readonly now?: () => Date;
}

export interface ScheduledAgentExecutor {
  execute(job: ScheduledJob): Awaitable<string>;
}

export interface ScheduledJobDispatcherOptions {
  readonly mcpInvoker: ScheduledMcpToolInvoker;
  readonly agentExecutor: ScheduledAgentExecutor;
  readonly defaultExecutionTimeoutMs?: number;
  readonly retryDelayMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface DistributedSchedulerLock {
  tryAcquire(jobId: string, ttlMs: number): Awaitable<boolean>;
  release(jobId: string): Awaitable<void>;
}

export interface MessageSender {
  sendMessage(target: string, text: string, job: ScheduledJob): Awaitable<void>;
}

export interface ScheduledTaskHandle {
  cancel(): void;
}

export interface CronScheduler {
  schedule(job: ScheduledJob, callback: () => void): ScheduledTaskHandle | undefined;
}

export interface NodeCronSchedulerOptions {
  readonly maxDelayMs?: number;
  readonly now?: () => Date;
}

export interface DynamicSchedulerOptions {
  readonly store: ScheduledJobStore;
  readonly dispatcher: ScheduledJobDispatcher;
  readonly validator?: ScheduledJobValidator;
  readonly executionStore?: ScheduledJobExecutionStore;
  readonly executionRecorder?: ScheduledJobExecutionRecorder;
  readonly messagingService?: SchedulerMessaging;
  readonly distributedLock?: DistributedSchedulerLock;
  readonly cronScheduler?: CronScheduler;
  readonly now?: () => Date;
  readonly lockTtlBufferMs?: number;
  /**
   * Optional user kill-switch: when it resolves true, AUTOMATIC firings are
   * skipped (a manual `trigger` still runs). Wire `() =>
   * isSchedulerPaused(pauseFile)`. Unset = never paused.
   */
  readonly isPaused?: () => Promise<boolean>;
}

export {
  InMemoryScheduledJobExecutionStore,
  InMemoryScheduledJobStore,
  KyselyScheduledJobExecutionStore,
  KyselyScheduledJobStore,
  buildScheduledJobListQuery
} from "./scheduler-stores.js";

export {
  defaultExecutionTimeoutMs,
  defaultLockTtlBufferMs,
  minLockTtlMs,
  NodeCronScheduler,
  NoOpScheduledAgentExecutor,
  ScheduledJobDispatcher,
  ScheduledJobExecutionRecorder,
  ScheduledJobValidator,
  ScheduledMcpToolInvoker,
  SchedulerMessaging
} from "./scheduler-runtime.js";

// Distributed scheduler lock primitives live in
// packages/scheduler/src/scheduler-locks.ts.
export {
  createScheduledJobLockInsert,
  InMemoryDistributedSchedulerLock,
  KyselyDistributedSchedulerLock,
  NoOpDistributedSchedulerLock
} from "./scheduler-locks.js";

export { DynamicScheduler, createSchedulerTools } from "./dynamic-scheduler.js";
export { ActiveRunTracker, type DrainOutcome } from "./active-run-tracker.js";

export {
  createNodeOnExitSpawner,
  defaultOnExitKillGraceMs,
  InMemoryOnExitWatchStore,
  maxOnExitPollMs,
  maxOnExitTimeoutMs,
  minOnExitPollMs,
  minOnExitTimeoutMs,
  OnExitScheduler,
  OnExitWatcher,
  validateOnExitTrigger,
  type OnExitArmedRecord,
  type OnExitFireHandler,
  type OnExitSchedulerOptions,
  type OnExitSpawnedChild,
  type OnExitSpawner,
  type OnExitTrigger,
  type OnExitWatcherOptions,
  type OnExitWatchOutcome,
  type OnExitWatchStatus,
  type OnExitWatchStore
} from "./on-exit-schedule.js";
