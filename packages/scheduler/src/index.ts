import type { ScheduledJobExecutionTable, ScheduledJobTable, MuseDatabase } from "@muse/db";
import type { McpManager } from "@muse/mcp";
import { TimeoutError, withTimeout } from "@muse/resilience";
import { createRunId, type JsonObject, type JsonValue } from "@muse/shared";
import type { MuseTool } from "@muse/tools";
import { CronExpressionParser } from "cron-parser";
import type { Insertable, Kysely, Selectable } from "kysely";
import { NoOpDistributedSchedulerLock } from "./scheduler-locks.js";

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

type ScheduledJobRow = Selectable<ScheduledJobTable>;
type ScheduledJobInsert = Insertable<ScheduledJobTable>;
type ScheduledJobExecutionRow = Selectable<ScheduledJobExecutionTable>;
type ScheduledJobExecutionInsert = Insertable<ScheduledJobExecutionTable>;
const resultTruncationLimit = 5_000;
const defaultMaxJobs = 1_000;
const defaultMaxExecutions = 200;
const defaultTimezone = "UTC";
const defaultRetryCount = 3;
const defaultExecutionTimeoutMs = 300_000;
const defaultRetryDelayMs = 2_000;
const minExecutionTimeoutMs = 1_000;
const maxExecutionTimeoutMs = 3_600_000;
const minLockTtlMs = 5_000;
const defaultLockTtlBufferMs = 10_000;

export class SchedulerValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SchedulerValidationError";
  }
}

export class SchedulerExecutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SchedulerExecutionError";
  }
}

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

export class DynamicScheduler {
  private readonly store: ScheduledJobStore;
  private readonly dispatcher: ScheduledJobDispatcher;
  private readonly validator: ScheduledJobValidator;
  private readonly executionStore?: ScheduledJobExecutionStore;
  private readonly executionRecorder: ScheduledJobExecutionRecorder;
  private readonly messagingService: SchedulerMessaging;
  private readonly distributedLock: DistributedSchedulerLock;
  private readonly cronScheduler?: CronScheduler;
  private readonly now: () => Date;
  private readonly lockTtlBufferMs: number;
  private readonly handles = new Map<string, ScheduledTaskHandle>();

  constructor(options: DynamicSchedulerOptions) {
    this.store = options.store;
    this.dispatcher = options.dispatcher;
    this.validator = options.validator ?? new ScheduledJobValidator();
    this.executionStore = options.executionStore;
    this.executionRecorder =
      options.executionRecorder ?? new ScheduledJobExecutionRecorder(options.executionStore, 50, options.now);
    this.messagingService = options.messagingService ?? new SchedulerMessaging();
    this.distributedLock = options.distributedLock ?? new NoOpDistributedSchedulerLock();
    this.cronScheduler = options.cronScheduler;
    this.now = options.now ?? (() => new Date());
    this.lockTtlBufferMs = options.lockTtlBufferMs ?? defaultLockTtlBufferMs;
  }

  async loadEnabledJobs(): Promise<number> {
    const jobs = (await this.store.list()).filter((job) => job.enabled);

    for (const job of jobs) {
      this.registerJob(job);
    }

    return jobs.length;
  }

  async create(input: ScheduledJobInput): Promise<ScheduledJob> {
    this.validator.validate(input);
    const saved = await this.store.save(input);

    if (saved.enabled) {
      this.registerJob(saved);
    }

    return saved;
  }

  async update(id: string, input: ScheduledJobInput): Promise<ScheduledJob | undefined> {
    this.validator.validate(input);
    const updated = await this.store.update(id, input);

    if (!updated) {
      return undefined;
    }

    this.cancelJob(id);

    if (updated.enabled) {
      this.registerJob(updated);
    }

    return updated;
  }

  async delete(id: string): Promise<void> {
    this.cancelJob(id);
    await this.store.delete(id);
  }

  list(): Awaitable<readonly ScheduledJob[]> {
    return this.store.list();
  }

  findById(id: string): Awaitable<ScheduledJob | undefined> {
    return this.store.findById(id);
  }

  findByName(name: string): Awaitable<ScheduledJob | undefined> {
    return this.store.findByName(name);
  }

  getExecutions(jobId: string, limit = 20): Awaitable<readonly ScheduledJobExecution[]> {
    return this.executionStore?.findByJobId(jobId, limit) ?? [];
  }

  async trigger(id: string): Promise<string> {
    const job = await this.store.findById(id);

    if (!job) {
      return `Job not found: ${id}`;
    }

    return this.runScheduledJob(job, false);
  }

  async dryRun(id: string): Promise<string> {
    const job = await this.store.findById(id);

    if (!job) {
      return `Job not found: ${id}`;
    }

    return this.runScheduledJob(job, true);
  }

  destroy(): void {
    for (const handle of this.handles.values()) {
      handle.cancel();
    }

    this.handles.clear();
  }

  private registerJob(job: ScheduledJob): void {
    if (!this.cronScheduler) {
      return;
    }

    this.cancelJob(job.id);

    const handle = this.cronScheduler.schedule(job, () => {
      void this.runScheduledJob(job, false);
    });

    if (handle) {
      this.handles.set(job.id, handle);
    } else {
      void this.store.updateExecutionResult(job.id, "failed", `Failed to schedule job '${job.name}'`);
    }
  }

  private cancelJob(id: string): void {
    this.handles.get(id)?.cancel();
    this.handles.delete(id);
  }

  private async runScheduledJob(job: ScheduledJob, dryRun: boolean): Promise<string> {
    const lockTtlMs = Math.max(minLockTtlMs, resolveJobTimeout(job, defaultExecutionTimeoutMs) + this.lockTtlBufferMs);

    if (!dryRun && !(await this.distributedLock.tryAcquire(job.id, lockTtlMs))) {
      await this.store.updateExecutionResult(job.id, "skipped", "skipped: another instance holds lock");
      return "skipped: another instance holds lock";
    }

    const startedAt = this.now();

    try {
      if (!dryRun) {
        await this.store.updateExecutionResult(job.id, "running", undefined);
      }

      const result = await this.dispatcher.runWithTimeoutAndRetry(job);
      await this.handleSuccess(job, result, startedAt, dryRun);
      return result;
    } catch (error) {
      const message = `Job '${job.name}' failed: ${error instanceof Error ? error.name : "unknown"}`;
      await this.handleFailure(job, message, startedAt, dryRun);
      return message;
    } finally {
      if (!dryRun) {
        await this.distributedLock.release(job.id);
      }
    }
  }

  private async handleSuccess(job: ScheduledJob, result: string, startedAt: Date, dryRun: boolean): Promise<void> {
    if (!dryRun) {
      await this.messagingService.sendResult(job, result);
      await this.store.updateExecutionResult(job.id, "success", result);
    }

    await this.executionRecorder.recordExecution({
      dryRun,
      durationMs: this.now().getTime() - startedAt.getTime(),
      job,
      result,
      startedAt,
      status: "success"
    });
  }

  private async handleFailure(job: ScheduledJob, result: string, startedAt: Date, dryRun: boolean): Promise<void> {
    if (!dryRun) {
      await this.store.updateExecutionResult(job.id, "failed", result);
    }

    await this.executionRecorder.recordExecution({
      dryRun,
      durationMs: this.now().getTime() - startedAt.getTime(),
      job,
      result,
      startedAt,
      status: "failed"
    });
  }
}

export function createSchedulerTools(service: DynamicScheduler): readonly MuseTool[] {
  return [
    {
      definition: {
        description: "List configured scheduler jobs with their status and schedule metadata.",
        inputSchema: {
          additionalProperties: false,
          properties: {},
          type: "object"
        },
        keywords: ["scheduler", "schedule", "job", "jobs", "cron"],
        name: "scheduler_list_jobs",
        risk: "read"
      },
      async execute() {
        const jobs = await service.list();

        return {
          jobs: jobs.map(toSchedulerJobToolResult),
          total: jobs.length
        };
      }
    },
    {
      definition: {
        description: "Create a scheduler job for an agent or MCP tool workflow.",
        inputSchema: {
          additionalProperties: true,
          properties: {
            agentPrompt: { type: "string" },
            cronExpression: { type: "string" },
            jobType: { enum: ["agent", "mcp_tool"], type: "string" },
            mcpServerName: { type: "string" },
            name: { type: "string" },
            tags: { items: { type: "string" }, type: "array" },
            toolArguments: { type: "object" },
            toolName: { type: "string" }
          },
          required: ["cronExpression", "name"],
          type: "object"
        },
        keywords: ["scheduler", "schedule", "job", "jobs", "cron", "create", "add"],
        name: "scheduler_create_job",
        risk: "write"
      },
      async execute(args) {
        const job = await service.create(readScheduledJobInput(args));

        return toSchedulerJobToolResult(job);
      }
    },
    {
      definition: {
        description: "Trigger a scheduler job immediately and persist the execution result.",
        inputSchema: schedulerJobIdInputSchema(),
        keywords: ["scheduler", "schedule", "job", "jobs", "trigger", "run"],
        name: "scheduler_trigger_job",
        risk: "write"
      },
      async execute(args) {
        const jobId = readJobId(args);
        const result = await service.trigger(jobId);

        return { jobId, result };
      }
    },
    {
      definition: {
        description: "Dry-run a scheduler job immediately without mutating the job's last status.",
        inputSchema: schedulerJobIdInputSchema(),
        keywords: ["scheduler", "schedule", "job", "jobs", "dry", "dry-run", "test"],
        name: "scheduler_dry_run_job",
        risk: "write"
      },
      async execute(args) {
        const jobId = readJobId(args);
        const result = await service.dryRun(jobId);

        return { dryRun: true, jobId, result };
      }
    }
  ];
}

export function normalizeScheduledJob(
  input: ScheduledJobInput,
  options: { readonly id: string; readonly now: () => Date }
): ScheduledJob {
  const now = options.now();
  const createdAt = input.createdAt ?? now;
  const updatedAt = input.updatedAt ?? now;

  return {
    agentMaxToolCalls: input.agentMaxToolCalls ?? undefined,
    agentModel: blankToUndefined(input.agentModel),
    agentPrompt: blankToUndefined(input.agentPrompt),
    agentSystemPrompt: blankToUndefined(input.agentSystemPrompt),
    createdAt,
    cronExpression: input.cronExpression.trim(),
    description: blankToUndefined(input.description),
    enabled: input.enabled ?? true,
    executionTimeoutMs: input.executionTimeoutMs ?? undefined,
    id: input.id ?? options.id,
    jobType: input.jobType ?? "mcp_tool",
    lastResult: blankToUndefined(input.lastResult),
    lastRunAt: input.lastRunAt ?? undefined,
    lastStatus: input.lastStatus ?? undefined,
    maxRetryCount: input.maxRetryCount ?? defaultRetryCount,
    mcpServerName: blankToUndefined(input.mcpServerName),
    name: input.name.trim(),
    notificationChannelId: blankToUndefined(input.notificationChannelId),
    personaId: blankToUndefined(input.personaId),
    retryOnFailure: input.retryOnFailure ?? false,
    tags: [...(input.tags ?? [])].map((tag) => tag.trim()).filter(Boolean).sort(),
    timezone: input.timezone?.trim() || defaultTimezone,
    toolArguments: input.toolArguments ?? {},
    toolName: blankToUndefined(input.toolName),
    updatedAt,
    webhookUrl: blankToUndefined(input.webhookUrl)
  };
}

export function computeNextRunAt(
  job: Pick<ScheduledJob, "cronExpression" | "timezone">,
  from: Date = new Date()
): Date {
  return CronExpressionParser
    .parse(job.cronExpression, { currentDate: from, tz: job.timezone })
    .next()
    .toDate();
}

export function normalizeScheduledJobExecution(
  input: ScheduledJobExecutionInput,
  options: { readonly id: string; readonly now: () => Date }
): ScheduledJobExecution {
  const now = options.now();

  return {
    completedAt: input.completedAt ?? undefined,
    dryRun: input.dryRun ?? false,
    durationMs: input.durationMs ?? 0,
    id: input.id ?? options.id,
    jobId: input.jobId,
    jobName: input.jobName,
    result: blankToUndefined(input.result),
    startedAt: input.startedAt ?? now,
    status: input.status
  };
}

export function renderTemplateVariables(template: string, job: ScheduledJob, now = new Date()): string {
  const parts = dateParts(now, job.timezone);

  return template
    .replaceAll("{{date}}", parts.date)
    .replaceAll("{{time}}", parts.time)
    .replaceAll("{{datetime}}", `${parts.date} ${parts.time}`)
    .replaceAll("{{day_of_week}}", parts.dayOfWeek)
    .replaceAll("{{job_name}}", job.name)
    .replaceAll("{{job_id}}", job.id);
}

export function createScheduledJobInsert(
  input: ScheduledJobInput,
  options: Required<KyselyScheduledJobStoreOptions>
): ScheduledJobInsert {
  return scheduledJobToRow(normalizeScheduledJob(input, { id: input.id ?? options.idFactory(), now: options.now }));
}

export function createScheduledJobUpdate(
  input: ScheduledJobInput,
  existing: ScheduledJob,
  now: () => Date
) {
  return {
    ...scheduledJobToRow(
      normalizeScheduledJob(
        {
          ...input,
          id: existing.id,
          createdAt: existing.createdAt,
          lastResult: input.lastResult ?? existing.lastResult,
          lastRunAt: input.lastRunAt ?? existing.lastRunAt,
          lastStatus: input.lastStatus ?? existing.lastStatus
        },
        { id: existing.id, now }
      )
    ),
    id: undefined
  };
}

export function createScheduledJobExecutionInsert(
  input: ScheduledJobExecutionInput,
  options: Required<KyselyScheduledJobExecutionStoreOptions>
): ScheduledJobExecutionInsert {
  const execution = normalizeScheduledJobExecution(input, {
    id: input.id ?? options.idFactory(),
    now: options.now
  });

  return {
    completed_at: execution.completedAt ?? null,
    created_at: options.now(),
    dry_run: execution.dryRun,
    duration_ms: execution.durationMs,
    id: execution.id,
    job_id: execution.jobId,
    job_name: execution.jobName,
    result: execution.result ?? null,
    started_at: execution.startedAt,
    status: execution.status
  };
}


export function mapScheduledJobRow(row: ScheduledJobRow): ScheduledJob {
  return {
    agentMaxToolCalls: row.agent_max_tool_calls ?? undefined,
    agentModel: row.agent_model ?? undefined,
    agentPrompt: row.agent_prompt ?? undefined,
    agentSystemPrompt: row.agent_system_prompt ?? undefined,
    createdAt: toDate(row.created_at),
    cronExpression: row.cron_expression,
    description: row.description ?? undefined,
    enabled: row.enabled,
    executionTimeoutMs: row.execution_timeout_ms ?? undefined,
    id: row.id,
    jobType: row.job_type,
    lastResult: row.last_result ?? undefined,
    lastRunAt: row.last_run_at ? toDate(row.last_run_at) : undefined,
    lastStatus: row.last_status ?? undefined,
    maxRetryCount: row.max_retry_count,
    mcpServerName: row.mcp_server_name ?? undefined,
    name: row.name,
    notificationChannelId: row.notification_channel_id ?? undefined,
    personaId: row.persona_id ?? undefined,
    retryOnFailure: row.retry_on_failure,
    tags: stringArray(row.tags),
    timezone: row.timezone,
    toolArguments: toJsonObject(row.tool_arguments),
    toolName: row.tool_name ?? undefined,
    updatedAt: toDate(row.updated_at),
    webhookUrl: row.webhook_url ?? undefined
  };
}

export function mapScheduledJobExecutionRow(row: ScheduledJobExecutionRow): ScheduledJobExecution {
  return {
    completedAt: row.completed_at ? toDate(row.completed_at) : undefined,
    dryRun: row.dry_run,
    durationMs: row.duration_ms,
    id: row.id,
    jobId: row.job_id,
    jobName: row.job_name,
    result: row.result ?? undefined,
    startedAt: toDate(row.started_at),
    status: row.status
  };
}

function scheduledJobToRow(job: ScheduledJob): ScheduledJobInsert {
  return {
    agent_max_tool_calls: job.agentMaxToolCalls ?? null,
    agent_model: job.agentModel ?? null,
    agent_prompt: job.agentPrompt ?? null,
    agent_system_prompt: job.agentSystemPrompt ?? null,
    created_at: job.createdAt,
    cron_expression: job.cronExpression,
    description: job.description ?? null,
    enabled: job.enabled,
    execution_timeout_ms: job.executionTimeoutMs ?? null,
    id: job.id,
    job_type: job.jobType,
    last_result: job.lastResult ?? null,
    last_run_at: job.lastRunAt ?? null,
    last_status: job.lastStatus ?? null,
    max_retry_count: job.maxRetryCount,
    mcp_server_name: job.mcpServerName ?? null,
    name: job.name,
    notification_channel_id: job.notificationChannelId ?? null,
    persona_id: job.personaId ?? null,
    retry_on_failure: job.retryOnFailure,
    tags: [...job.tags],
    timezone: job.timezone,
    tool_arguments: job.toolArguments,
    tool_name: job.toolName ?? null,
    updated_at: job.updatedAt,
    webhook_url: job.webhookUrl ?? null
  };
}

function resolveJobTimeout(job: ScheduledJob, fallbackMs: number): number {
  const value = job.executionTimeoutMs ?? fallbackMs;
  return value <= 0 ? fallbackMs : value;
}

function validateTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
  } catch (error) {
    throw new SchedulerValidationError(`Invalid timezone: ${timezone}`);
  }
}

function validateCronExpression(cron: string): void {
  const fields = cron.trim().split(/\s+/u);

  if (fields.length !== 5 && fields.length !== 6) {
    throw new SchedulerValidationError(`Invalid cron expression: ${cron}`);
  }

  try {
    CronExpressionParser.parse(cron);
  } catch {
    throw new SchedulerValidationError(`Invalid cron expression: ${cron}`);
  }
}

function validateJobName(name: string): void {
  if (name.trim().length === 0) {
    throw new SchedulerValidationError("Scheduled job name must not be blank");
  }
}

function validateExecutionTimeout(timeoutMs: number | undefined): void {
  if (timeoutMs === undefined || timeoutMs === 0) {
    return;
  }

  if (timeoutMs < minExecutionTimeoutMs || timeoutMs > maxExecutionTimeoutMs) {
    throw new SchedulerValidationError(
      `executionTimeoutMs must be 0 or between ${minExecutionTimeoutMs} and ${maxExecutionTimeoutMs}`
    );
  }
}

function validateRetryConfig(retryOnFailure: boolean, maxRetryCount: number): void {
  if (retryOnFailure && maxRetryCount < 1) {
    throw new SchedulerValidationError("maxRetryCount must be at least 1 when retryOnFailure is enabled");
  }
}

function validateJobTypeFields(jobType: ScheduledJobType, job: ScheduledJobInput | ScheduledJob): void {
  if (jobType === "mcp_tool") {
    requireText(job.mcpServerName, "MCP tool jobs require mcpServerName");
    requireText(job.toolName, "MCP tool jobs require toolName");
    return;
  }

  requireText(job.agentPrompt, "Agent jobs require agentPrompt");
}

function requireText(value: string | null | undefined, message: string): string {
  const text = value?.trim();

  if (!text) {
    throw new SchedulerValidationError(message);
  }

  return text;
}

function schedulerJobIdInputSchema(): JsonObject {
  return {
    additionalProperties: false,
    properties: {
      jobId: { type: "string" }
    },
    required: ["jobId"],
    type: "object"
  };
}

function readJobId(args: JsonObject): string {
  return requireText(typeof args.jobId === "string" ? args.jobId : undefined, "scheduler tool requires jobId");
}

function readScheduledJobInput(args: JsonObject): ScheduledJobInput {
  return {
    agentMaxToolCalls: readOptionalNumber(args.agentMaxToolCalls),
    agentModel: readOptionalString(args.agentModel),
    agentPrompt: readOptionalString(args.agentPrompt),
    agentSystemPrompt: readOptionalString(args.agentSystemPrompt),
    cronExpression: requireText(readOptionalString(args.cronExpression), "scheduler create tool requires cronExpression"),
    description: readOptionalString(args.description),
    enabled: readOptionalBoolean(args.enabled),
    executionTimeoutMs: readOptionalNumber(args.executionTimeoutMs),
    jobType: readScheduledJobType(args.jobType),
    maxRetryCount: readOptionalNumber(args.maxRetryCount),
    mcpServerName: readOptionalString(args.mcpServerName),
    name: requireText(readOptionalString(args.name), "scheduler create tool requires name"),
    notificationChannelId: readOptionalString(args.notificationChannelId),
    personaId: readOptionalString(args.personaId),
    retryOnFailure: readOptionalBoolean(args.retryOnFailure),
    tags: readOptionalStringArray(args.tags),
    timezone: readOptionalString(args.timezone),
    toolArguments: readOptionalJsonObject(args.toolArguments),
    toolName: readOptionalString(args.toolName),
    webhookUrl: readOptionalString(args.webhookUrl)
  };
}

function readScheduledJobType(value: JsonValue | undefined): ScheduledJobType | undefined {
  return value === "agent" || value === "mcp_tool" ? value : undefined;
}

function readOptionalString(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readOptionalBoolean(value: JsonValue | undefined): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function readOptionalNumber(value: JsonValue | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readOptionalStringArray(value: JsonValue | undefined): readonly string[] | undefined {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : undefined;
}

function readOptionalJsonObject(value: JsonValue | undefined): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : undefined;
}

function toSchedulerJobToolResult(job: ScheduledJob): JsonObject {
  return {
    agentModel: job.agentModel ?? null,
    agentPrompt: job.agentPrompt ?? null,
    createdAt: job.createdAt.toISOString(),
    cronExpression: job.cronExpression,
    enabled: job.enabled,
    id: job.id,
    jobType: job.jobType,
    lastRunAt: job.lastRunAt?.toISOString() ?? null,
    lastStatus: job.lastStatus ?? null,
    mcpServerName: job.mcpServerName ?? null,
    name: job.name,
    tags: [...job.tags],
    timezone: job.timezone,
    toolName: job.toolName ?? null,
    updatedAt: job.updatedAt.toISOString()
  };
}

function resolveTemplateJson(value: JsonObject, job: ScheduledJob): JsonObject {
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, resolveTemplateValue(entry, job)])
  ) as JsonObject;
}

function resolveTemplateValue(value: JsonValue, job: ScheduledJob): JsonValue {
  if (typeof value === "string") {
    return renderTemplateVariables(value, job);
  }

  if (Array.isArray(value)) {
    return value.map((entry) => resolveTemplateValue(entry, job));
  }

  if (value && typeof value === "object") {
    return resolveTemplateJson(value, job);
  }

  return value;
}

function dateParts(date: Date, timeZone: string): {
  readonly date: string;
  readonly dayOfWeek: string;
  readonly time: string;
} {
  const dateFormatter = new Intl.DateTimeFormat("en-US", {
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
    minute: "2-digit",
    month: "2-digit",
    second: "2-digit",
    timeZone,
    year: "numeric"
  });
  const parts = Object.fromEntries(dateFormatter.formatToParts(date).map((part) => [part.type, part.value]));
  const dayOfWeek = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "long" }).format(date);

  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    dayOfWeek,
    time: `${parts.hour}:${parts.minute}:${parts.second}`
  };
}

function blankToUndefined(value: string | null | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

export function compareJobs(left: ScheduledJob, right: ScheduledJob): number {
  return left.createdAt.getTime() - right.createdAt.getTime() || left.name.localeCompare(right.name);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function toJsonObject(value: JsonValue): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function stringArray(value: JsonValue): readonly string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}
