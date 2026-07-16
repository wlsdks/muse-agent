import type { JsonObject, JsonValue } from "@muse/shared";
import type { MuseTool } from "@muse/tools";
import { isErrorLike } from "@muse/shared";

import { ActiveRunTracker } from "./active-run-tracker.js";
import { NoOpDistributedSchedulerLock } from "./scheduler-locks.js";
import {
  ScheduledJobExecutionRecorder,
  ScheduledJobValidator,
  SchedulerMessaging,
  defaultExecutionTimeoutMs,
  defaultLockTtlBufferMs,
  minLockTtlMs,
  requireText,
  resolveJobTimeout,
  type Awaitable,
  type CronScheduler,
  type DistributedSchedulerLock,
  type DynamicSchedulerOptions,
  type ScheduledJob,
  type ScheduledJobExecution,
  type ScheduledJobExecutionStore,
  type ScheduledJobInput,
  type ScheduledJobStore,
  type ScheduledJobType,
  type ScheduledJobUpdateInput,
  type ScheduledTaskHandle
} from "./index.js";

export class DynamicScheduler {
  private readonly store: ScheduledJobStore;
  private readonly dispatcher: DynamicSchedulerOptions["dispatcher"];
  private readonly validator: ScheduledJobValidator;
  private readonly executionStore?: ScheduledJobExecutionStore;
  private readonly executionRecorder: ScheduledJobExecutionRecorder;
  private readonly messagingService: SchedulerMessaging;
  private readonly distributedLock: DistributedSchedulerLock;
  private readonly cronScheduler?: CronScheduler;
  private readonly now: () => Date;
  private readonly lockTtlBufferMs: number;
  private readonly handles = new Map<string, ScheduledTaskHandle>();
  private readonly activeRuns = new ActiveRunTracker();
  // In-process re-entrancy guard (CRON-3): the default lock is a no-op, so a
  // job whose run outlasts its cron interval would pile up overlapping runs on
  // each tick. Tracks job ids with an automatic run in flight.
  private readonly runningJobIds = new Set<string>();
  private readonly isPaused?: () => Promise<boolean>;

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
    const lockTtlBufferMs = options.lockTtlBufferMs ?? defaultLockTtlBufferMs;
    if (!Number.isSafeInteger(lockTtlBufferMs) || lockTtlBufferMs < 0) {
      throw new RangeError("lockTtlBufferMs must be a non-negative safe integer");
    }
    this.lockTtlBufferMs = lockTtlBufferMs;
    this.isPaused = options.isPaused;
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

  async update(id: string, input: ScheduledJobUpdateInput): Promise<ScheduledJob | undefined> {
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

  /** Number of scheduled runs currently executing (CRON-9). */
  activeRunCount(): number {
    return this.activeRuns.size;
  }

  /**
   * Graceful shutdown (CRON-9): stop future firings, then wait for in-flight
   * runs to finish — up to `timeoutMs` so a hung run can't block forever.
   * Prefer this over `destroy()` when the runs' work should complete.
   */
  async shutdown(timeoutMs = 30_000): Promise<"drained" | "timeout"> {
    this.destroy();
    return this.activeRuns.drain(timeoutMs);
  }

  private registerJob(job: ScheduledJob): void {
    if (!this.cronScheduler) {
      return;
    }

    this.cancelJob(job.id);

    const handle = this.cronScheduler.schedule(job, () => {
      void this.activeRuns.track(this.runScheduledJob(job, false, true));
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

  private async runScheduledJob(job: ScheduledJob, dryRun: boolean, automatic = false): Promise<string> {
    // CRON-3 re-entrancy guard: skip an automatic fire while the same job's
    // prior run is still in flight (the default no-op lock can't). The has/add
    // pair is synchronous — no await between them — so two ticks can't both
    // pass. A manual trigger is exempt (explicit intent), as are dry runs.
    if (!automatic) {
      return this.executeScheduledJob(job, dryRun, automatic);
    }
    if (this.runningJobIds.has(job.id)) {
      await this.store.updateExecutionResult(job.id, "skipped", "skipped: previous run still in progress");
      return "skipped: previous run still in progress";
    }
    this.runningJobIds.add(job.id);
    try {
      return await this.executeScheduledJob(job, dryRun, automatic);
    } finally {
      this.runningJobIds.delete(job.id);
    }
  }

  private async executeScheduledJob(job: ScheduledJob, dryRun: boolean, automatic = false): Promise<string> {
    // User pause kill-switch: skip AUTONOMOUS (cron-fired) runs while paused;
    // a manual `trigger` still runs — explicit intent wins.
    if (automatic && this.isPaused && (await this.isPaused())) {
      await this.store.updateExecutionResult(job.id, "skipped", "skipped: scheduler paused by user");
      return "skipped: scheduler paused by user";
    }
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
      const message = `Job '${job.name}' failed: ${isErrorLike(error) ? error.name : "unknown"}`;
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
        domain: "tasks",
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
        domain: "tasks",
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
        domain: "tasks",
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
        domain: "tasks",
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
