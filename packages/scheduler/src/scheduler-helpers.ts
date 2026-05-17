/**
 * Pure helpers for the scheduler — normalizers, Kysely row mappers,
 * timeout / template / comparison utilities. Lifted out of
 * `index.ts` so the class implementations there can focus on
 * orchestration; this module is no-side-effect data shaping.
 *
 * `requireText` lives here too because it's used by every layer
 * (validator, mcp invoker, dynamic-scheduler arg parsers) and
 * because keeping it next to `SchedulerValidationError` (via
 * scheduler-errors.ts) avoids the circular import that would
 * otherwise force consumers to import from `index.ts`.
 */

import type { ScheduledJobExecutionTable, ScheduledJobTable } from "@muse/db";
import type { JsonObject, JsonValue } from "@muse/shared";
import { CronExpressionParser } from "cron-parser";
import type { Insertable, Selectable } from "kysely";

import { SchedulerValidationError } from "./scheduler-errors.js";

import type {
  KyselyScheduledJobExecutionStoreOptions,
  KyselyScheduledJobStoreOptions,
  ScheduledJob,
  ScheduledJobExecution,
  ScheduledJobExecutionInput,
  ScheduledJobInput,
  ScheduledJobType
} from "./index.js";

type ScheduledJobInsert = Insertable<ScheduledJobTable>;
type ScheduledJobRow = Selectable<ScheduledJobTable>;
type ScheduledJobExecutionInsert = Insertable<ScheduledJobExecutionTable>;
type ScheduledJobExecutionRow = Selectable<ScheduledJobExecutionTable>;

export const defaultTimezone = "UTC";
export const defaultRetryCount = 3;
const minExecutionTimeoutMs = 1_000;
const maxExecutionTimeoutMs = 3_600_000;

export function validateTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
  } catch {
    throw new SchedulerValidationError(`Invalid timezone: ${timezone}`);
  }
}

export function validateCronExpression(cron: string): void {
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

export function validateJobName(name: string): void {
  if (name.trim().length === 0) {
    throw new SchedulerValidationError("Scheduled job name must not be blank");
  }
}

export function validateExecutionTimeout(timeoutMs: number | undefined): void {
  if (timeoutMs === undefined || timeoutMs === 0) {
    return;
  }

  if (timeoutMs < minExecutionTimeoutMs || timeoutMs > maxExecutionTimeoutMs) {
    throw new SchedulerValidationError(
      `executionTimeoutMs must be 0 or between ${minExecutionTimeoutMs} and ${maxExecutionTimeoutMs}`
    );
  }
}

export function validateRetryConfig(retryOnFailure: boolean, maxRetryCount: number): void {
  if (retryOnFailure && maxRetryCount < 1) {
    throw new SchedulerValidationError("maxRetryCount must be at least 1 when retryOnFailure is enabled");
  }
}

export function validateJobTypeFields(jobType: ScheduledJobType, job: ScheduledJobInput | ScheduledJob): void {
  if (jobType === "mcp_tool") {
    requireText(job.mcpServerName, "MCP tool jobs require mcpServerName");
    requireText(job.toolName, "MCP tool jobs require toolName");
    return;
  }

  requireText(job.agentPrompt, "Agent jobs require agentPrompt");
}

export function requireText(value: string | null | undefined, message: string): string {
  const text = value?.trim();

  if (!text) {
    throw new SchedulerValidationError(message);
  }

  return text;
}

export function compareJobs(left: ScheduledJob, right: ScheduledJob): number {
  return left.createdAt.getTime() - right.createdAt.getTime() || left.name.localeCompare(right.name);
}

export function resolveJobTimeout(job: ScheduledJob, fallbackMs: number): number {
  const value = job.executionTimeoutMs ?? fallbackMs;
  // `??` does NOT catch NaN/Infinity: a corrupt persisted
  // executionTimeoutMs would otherwise flow into the lock TTL
  // (Math.max(min, NaN) → NaN) and the watchdog (setTimeout(NaN)
  // → 0 → instant timeout). Non-finite or non-positive → fallback.
  return Number.isFinite(value) && value > 0 ? value : fallbackMs;
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

export function normalizeScheduledJob(
  input: ScheduledJobInput,
  options: { readonly id: string; readonly now: () => Date }
): ScheduledJob {
  const now = options.now();
  const createdAt = input.createdAt ?? now;
  const updatedAt = input.updatedAt ?? now;
  // `??` does NOT catch NaN/Infinity: a corrupt persisted
  // maxRetryCount would make `Math.max(1, NaN)` NaN, so the
  // `attempt <= attempts` retry loop never runs and the job
  // silently never dispatches. validateRetryConfig only guards
  // the create path, not this normalize/load path.
  const maxRetryCount = typeof input.maxRetryCount === "number" && Number.isFinite(input.maxRetryCount)
    ? input.maxRetryCount
    : defaultRetryCount;

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
    maxRetryCount,
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

export function resolveTemplateJson(value: JsonObject, job: ScheduledJob): JsonObject {
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

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
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

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function toJsonObject(value: JsonValue): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function stringArray(value: JsonValue): readonly string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}
