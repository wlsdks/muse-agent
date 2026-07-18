import type { McpManager } from "@muse/mcp";
import { classifyError, TimeoutError, withTimeout } from "@muse/resilience";
import type { MuseTool } from "@muse/tools";
import { isErrorLike } from "@muse/shared";

import { SchedulerExecutionError } from "./scheduler-errors.js";
import {
  computeNextRunAt,
  defaultRetryCount,
  defaultTimezone,
  delay,
  maxRetryCountCeiling,
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
import type {
  CronScheduler,
  JobExecutionStatus,
  MessageSender,
  NodeCronSchedulerOptions,
  ScheduledAgentExecutor,
  ScheduledJob,
  ScheduledJobDispatcherOptions,
  ScheduledJobExecutionStore,
  ScheduledJobInput,
  ScheduledTaskHandle
} from "./index.js";

export const defaultExecutionTimeoutMs = 300_000;
const defaultRetryDelayMs = 2_000;
export const minLockTtlMs = 5_000;
export const defaultLockTtlBufferMs = 10_000;

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

export interface ScheduledMcpToolInvokerOptions {
  /**
   * Additional `MuseTool`s resolvable by exact `${server}.${tool}` name,
   * checked BEFORE `McpManager` — Muse's built-in loopback tools
   * (`muse.time.now`, `muse.text.stats`, ...) live in the host's agent tool
   * registry and are never registered as an `McpManager` connection, so a
   * scheduled `mcp_tool` job targeting one would otherwise always fail the
   * connection check below. Kept as an injected function (not a direct
   * import) so this package stays provider-agnostic — the caller (the API
   * process) decides what "extra tools" means. Absent -> unchanged McpManager-only
   * resolution.
   */
  readonly extraTools?: () => readonly MuseTool[];
}

export class ScheduledMcpToolInvoker {
  constructor(
    private readonly mcpManager: McpManager,
    private readonly options: ScheduledMcpToolInvokerOptions = {}
  ) {}

  async invoke(job: ScheduledJob): Promise<string> {
    if (job.jobType !== "mcp_tool") {
      throw new SchedulerExecutionError(`Job '${job.name}' is not an MCP tool job`);
    }

    const serverName = requireText(job.mcpServerName, `MCP job '${job.name}' requires mcpServerName`);
    const toolName = requireText(job.toolName, `MCP job '${job.name}' requires toolName`);
    const fullName = `${serverName}.${toolName}`;

    const tool = this.findExtraTool(fullName) ?? await this.resolveMcpManagerTool(serverName, fullName);
    // Runner-level backstop mirroring the Builder picker's policy (진안
    // 2026-07-18): execute-class never runs unattended, and a write tool on
    // an outbound-capable server would be an autonomous third-party send.
    // The picker/copilot already refuse to CREATE such jobs — this guard
    // keeps the floor even for a job created through the raw API or a
    // future surface, independent of any per-tool approval gate.
    const risk = tool.definition.risk;
    if (risk === "execute" || (risk === "write" && serverName === "muse.messaging")) {
      throw new SchedulerExecutionError(`Tool '${fullName}' is not schedulable unattended (risk: ${risk})`);
    }
    const args = resolveTemplateJson(job.toolArguments, job);
    const output = await tool.execute(args, {
      runId: `scheduler_${job.id}_${Date.now()}`,
      userId: "scheduler"
    });

    return typeof output === "string" ? output : JSON.stringify(output, null, 2);
  }

  private findExtraTool(fullName: string): MuseTool | undefined {
    return this.options.extraTools?.().find((candidate) => candidate.definition.name === fullName);
  }

  private async resolveMcpManagerTool(serverName: string, fullName: string): Promise<MuseTool> {
    if (this.mcpManager.getStatus(serverName) !== "connected") {
      const connected = await this.mcpManager.connect(serverName);

      if (!connected) {
        throw new SchedulerExecutionError(`MCP server '${serverName}' is not connected`);
      }
    }

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
    this.defaultExecutionTimeoutMs = requirePositiveSafeInteger(
      options.defaultExecutionTimeoutMs ?? defaultExecutionTimeoutMs,
      "defaultExecutionTimeoutMs"
    );
    this.retryDelayMs = requireNonNegativeSafeInteger(options.retryDelayMs ?? defaultRetryDelayMs, "retryDelayMs");
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
    // Execution-layer clamp: the create/update gate
    // (`validateRetryConfig`) bounds maxRetryCount to
    // [1, maxRetryCountCeiling], but a legacy DB row (written before
    // that gate existed) or a hand-edited row could still carry an
    // unbounded / non-finite count. Defend the dispatch loop directly
    // so a stale row can't become a retry-storm.
    const attempts = job.retryOnFailure
      ? Math.min(maxRetryCountCeiling, Math.max(1, Number.isFinite(job.maxRetryCount) ? Math.trunc(job.maxRetryCount) : 1))
      : 1;
    let lastError: unknown;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await this.dispatchByType(job);
      } catch (error) {
        lastError = error;

        // Fail fast on a clearly-permanent error (bad tool name,
        // model-not-found, auth, validation) — retrying it just burns the
        // remaining attempts and delays the inevitable failure. Transient
        // and genuinely-unknown errors still retry.
        if (!classifyError(error).recovery.retryable) {
          break;
        }
        if (attempt < attempts) {
          await this.sleep(this.retryDelayMs);
        }
      }
    }

    throw isErrorLike(lastError) ? lastError : new SchedulerExecutionError(`Job '${job.name}' failed`);
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

export class NodeCronScheduler implements CronScheduler {
  private readonly maxDelayMs: number;
  private readonly now: () => Date;

  constructor(options: NodeCronSchedulerOptions = {}) {
    this.maxDelayMs = Math.max(
      1,
      requireNonNegativeSafeInteger(options.maxDelayMs ?? 2_147_483_647, "maxDelayMs")
    );
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

function requireNonNegativeSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function requirePositiveSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return value;
}
