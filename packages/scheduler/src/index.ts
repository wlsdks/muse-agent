import type { McpManager } from "@muse/mcp";
import { TimeoutError, withTimeout } from "@muse/resilience";
import type { JsonObject } from "@muse/shared";
import type { MuseTool } from "@muse/tools";

import { SchedulerExecutionError } from "./scheduler-errors.js";
import {
  computeNextRunAt,
  defaultRetryCount,
  defaultTimezone,
  delay,
  requireText,
  resolveJobTimeout,
  resolveTemplateJson,
  validateCronExpression,
  validateExecutionTimeout,
  validateJobName,
  validateJobTypeFields,
  validateRetryConfig,
  validateTimezone
} from "./scheduler-helpers.js";

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
}

export const defaultExecutionTimeoutMs = 300_000;
const defaultRetryDelayMs = 2_000;
export const minLockTtlMs = 5_000;
export const defaultLockTtlBufferMs = 10_000;

export {
  InMemoryScheduledJobExecutionStore,
  InMemoryScheduledJobStore,
  KyselyScheduledJobExecutionStore,
  KyselyScheduledJobStore
} from "./scheduler-stores.js";

export class ScheduledJobValidator {
  validate(job: ScheduledJobInput | ScheduledJob): void {
    validateTimezone(job.timezone ?? defaultTimezone);
    validateCronExpression(job.cronExpression);
    validateJobName(job.name);
    validateExecutionTimeout(job.executionTimeoutMs ?? undefined);
    validateRetryConfig(job.retryOnFailure ?? false, job.maxRetryCount ?? defaultRetryCount);
    validateJobTypeFields(job.jobType ?? "mcp_tool", job);
  }
}

export class ScheduledMcpToolInvoker {
  constructor(private readonly mcpManager: McpManager) {}

  async invoke(job: ScheduledJob): Promise<string> {
    if (job.jobType !== "mcp_tool") {
      throw new SchedulerExecutionError(`Job '${job.name}' is not an MCP tool job`);
    }

    const serverName = requireText(job.mcpServerName, `MCP job '${job.name}' requires mcpServerName`);
    const toolName = requireText(job.toolName, `MCP job '${job.name}' requires toolName`);

    if (this.mcpManager.getStatus(serverName) !== "connected") {
      const connected = await this.mcpManager.connect(serverName);

      if (!connected) {
        throw new SchedulerExecutionError(`MCP server '${serverName}' is not connected`);
      }
    }

    const tool = this.findTool(serverName, toolName);
    const args = resolveTemplateJson(job.toolArguments, job);
    const output = await tool.execute(args, {
      runId: `scheduler_${job.id}_${Date.now()}`,
      userId: "scheduler"
    });

    return typeof output === "string" ? output : JSON.stringify(output, null, 2);
  }

  private findTool(serverName: string, toolName: string): MuseTool {
    const fullName = `${serverName}.${toolName}`;
    const tool = this.mcpManager.toMuseTools().find((candidate) => candidate.definition.name === fullName);

    if (!tool) {
      throw new SchedulerExecutionError(`MCP tool '${fullName}' was not found`);
    }

    return tool;
  }
}

export class NoOpScheduledAgentExecutor implements ScheduledAgentExecutor {
  execute(job: ScheduledJob): string {
    throw new SchedulerExecutionError(`No scheduled agent executor configured for job '${job.name}'`);
  }
}

export class ScheduledJobDispatcher {
  private readonly mcpInvoker: ScheduledMcpToolInvoker;
  private readonly agentExecutor: ScheduledAgentExecutor;
  private readonly defaultExecutionTimeoutMs: number;
  private readonly retryDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: ScheduledJobDispatcherOptions) {
    this.mcpInvoker = options.mcpInvoker;
    this.agentExecutor = options.agentExecutor;
    this.defaultExecutionTimeoutMs = options.defaultExecutionTimeoutMs ?? defaultExecutionTimeoutMs;
    this.retryDelayMs = options.retryDelayMs ?? defaultRetryDelayMs;
    this.sleep = options.sleep ?? delay;
  }

  async runWithTimeoutAndRetry(job: ScheduledJob): Promise<string> {
    const timeoutMs = resolveJobTimeout(job, this.defaultExecutionTimeoutMs);

    try {
      return await withTimeout(() => this.runWithRetry(job), timeoutMs);
    } catch (error) {
      if (error instanceof TimeoutError) {
        throw new SchedulerExecutionError(`Job '${job.name}' timed out after ${timeoutMs}ms`);
      }

      throw error;
    }
  }

  private async runWithRetry(job: ScheduledJob): Promise<string> {
    const attempts = job.retryOnFailure ? Math.max(1, job.maxRetryCount) : 1;
    let lastError: unknown;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await this.dispatchByType(job);
      } catch (error) {
        lastError = error;

        if (attempt < attempts) {
          await this.sleep(this.retryDelayMs);
        }
      }
    }

    throw lastError instanceof Error ? lastError : new SchedulerExecutionError(`Job '${job.name}' failed`);
  }

  private dispatchByType(job: ScheduledJob): Promise<string> {
    return job.jobType === "mcp_tool"
      ? Promise.resolve(this.mcpInvoker.invoke(job))
      : Promise.resolve(this.agentExecutor.execute(job));
  }
}

export class SchedulerMessaging {
  constructor(private readonly sender?: MessageSender) {}

  async sendResult(job: ScheduledJob, result: string): Promise<void> {
    const target = job.notificationChannelId ?? job.webhookUrl;

    if (!target || !this.sender) {
      return;
    }

    await this.sender.sendMessage(target, result, job);
  }
}

export class ScheduledJobExecutionRecorder {
  constructor(
    private readonly executionStore?: ScheduledJobExecutionStore,
    private readonly maxExecutionsPerJob = 50,
    private readonly now: () => Date = () => new Date()
  ) {}

  async recordExecution(options: {
    readonly job: ScheduledJob;
    readonly status: JobExecutionStatus;
    readonly result?: string;
    readonly durationMs: number;
    readonly dryRun: boolean;
    readonly startedAt: Date;
  }): Promise<void> {
    if (!this.executionStore) {
      return;
    }

    await this.executionStore.save({
      completedAt: this.now(),
      dryRun: options.dryRun,
      durationMs: options.durationMs,
      jobId: options.job.id,
      jobName: options.job.name,
      result: options.result,
      startedAt: options.startedAt,
      status: options.status
    });
    await this.executionStore.deleteOldestExecutions(options.job.id, this.maxExecutionsPerJob);
  }
}


// Distributed scheduler lock primitives live in
// packages/scheduler/src/scheduler-locks.ts.
export {
  createScheduledJobLockInsert,
  InMemoryDistributedSchedulerLock,
  KyselyDistributedSchedulerLock,
  NoOpDistributedSchedulerLock
} from "./scheduler-locks.js";

export class NodeCronScheduler implements CronScheduler {
  private readonly maxDelayMs: number;
  private readonly now: () => Date;

  constructor(options: NodeCronSchedulerOptions = {}) {
    this.maxDelayMs = Math.max(1, options.maxDelayMs ?? 2_147_483_647);
    this.now = options.now ?? (() => new Date());
  }

  schedule(job: ScheduledJob, callback: () => void): ScheduledTaskHandle | undefined {
    let cancelled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;

    const scheduleNext = () => {
      if (cancelled) {
        return;
      }

      const now = this.now();
      const nextRunAt = computeNextRunAt(job, now);
      const delayMs = Math.max(0, nextRunAt.getTime() - now.getTime());
      const boundedDelayMs = Math.min(delayMs, this.maxDelayMs);

      timeout = setTimeout(() => {
        if (cancelled) {
          return;
        }

        if (delayMs <= this.maxDelayMs) {
          callback();
        }

        scheduleNext();
      }, boundedDelayMs);
    };

    try {
      scheduleNext();
      return {
        cancel() {
          cancelled = true;

          if (timeout) {
            clearTimeout(timeout);
          }
        }
      };
    } catch {
      if (timeout) {
        clearTimeout(timeout);
      }

      return undefined;
    }
  }
}

export { DynamicScheduler, createSchedulerTools } from "./dynamic-scheduler.js";
