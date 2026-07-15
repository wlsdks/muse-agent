import {
  SchedulerValidationError,
  type DynamicScheduler,
  type ScheduledJob,
  type ScheduledJobExecution,
  type ScheduledJobExecutionStore,
  type ScheduledJobInput,
  type ScheduledJobStore,
  type ScheduledJobType
} from "@muse/scheduler";
import type { FastifyInstance } from "fastify";

import { hasOwn, isRecord, readBoolean, readJsonObject, readNullableString, readNumber, readString, readStringArray } from "./server-input-utils.js";

export interface SchedulerRouteScheduler {
  readonly executionStore?: ScheduledJobExecutionStore;
  readonly service?: DynamicScheduler;
  readonly store: ScheduledJobStore;
}

export interface SchedulerRouteOptions {
  readonly requireAuthenticated: (
    request: unknown,
    reply: { status(statusCode: number): { send(payload: ApiError): void } }
  ) => boolean;
  readonly scheduler?: SchedulerRouteScheduler;
}

interface ApiError {
  readonly code?: string;
  readonly error?: string;
  readonly message?: string;
  readonly timestamp?: string;
}

type ParseResult<T> = { readonly ok: true; readonly value: T } | { readonly error: ApiError; readonly ok: false };

export function registerSchedulerRoutes(server: FastifyInstance, options: SchedulerRouteOptions): void {
  for (const prefix of ["/admin/scheduler", "/scheduler", "/api/scheduler"]) {
    server.get(`${prefix}/jobs`, async (request, reply) => {
      if (!options.requireAuthenticated(request, reply)) {
        return reply;
      }

      if (!options.scheduler) {
        return [];
      }

      const jobs = await (options.scheduler.service?.list() ?? options.scheduler.store.list());
      const query = request.query as {
        readonly limit?: number | string;
        readonly offset?: number | string;
        readonly tag?: string;
      };
      const tag = typeof query.tag === "string" && query.tag.trim().length > 0 ? query.tag.trim() : undefined;
      const filtered = tag ? jobs.filter((job) => job.tags.includes(tag)) : jobs;
      return paginate(
        filtered.map(toScheduledJobResponse),
        parseOffset(query.offset),
        parseLimit(query.limit, 50, 200)
      );
    });

    server.get(`${prefix}/jobs/:jobId`, async (request, reply) => {
      if (!options.requireAuthenticated(request, reply)) {
        return reply;
      }

      if (!options.scheduler) {
        return sendSchedulerUnavailable(reply);
      }

      const { jobId } = request.params as { readonly jobId: string };
      const job = await (options.scheduler.service?.findById(jobId) ?? options.scheduler.store.findById(jobId));

      if (!job) {
        return sendSchedulerJobNotFound(reply, jobId);
      }

      return toScheduledJobResponse(job);
    });

    server.post(`${prefix}/jobs`, async (request, reply) => {
      if (!options.requireAuthenticated(request, reply)) {
        return reply;
      }

      if (!options.scheduler?.service) {
        return sendSchedulerServiceUnavailable(reply);
      }

      const parsed = parseScheduledJobInput(request.body);

      if (!parsed.ok) {
        return reply.status(400).send(parsed.error);
      }

      try {
        return reply.status(201).send(toScheduledJobResponse(await options.scheduler.service.create(parsed.value)));
      } catch (error) {
        return sendSchedulerError(reply, error);
      }
    });

    server.put(`${prefix}/jobs/:jobId`, async (request, reply) => {
      if (!options.requireAuthenticated(request, reply)) {
        return reply;
      }

      return updateScheduledJob(request.params, request.body, options, reply);
    });

    server.patch(`${prefix}/jobs/:jobId`, async (request, reply) => {
      if (!options.requireAuthenticated(request, reply)) {
        return reply;
      }

      return updateScheduledJob(request.params, request.body, options, reply);
    });

    server.delete(`${prefix}/jobs/:jobId`, async (request, reply) => {
      if (!options.requireAuthenticated(request, reply)) {
        return reply;
      }

      if (!options.scheduler?.service) {
        return sendSchedulerServiceUnavailable(reply);
      }

      const { jobId } = request.params as { readonly jobId: string };

      if (!(await options.scheduler.service.findById(jobId))) {
        return sendSchedulerJobNotFound(reply, jobId);
      }

      await options.scheduler.service.delete(jobId);
      return reply.status(204).send(undefined);
    });

    server.post(`${prefix}/jobs/:jobId/trigger`, async (request, reply) => {
      if (!options.requireAuthenticated(request, reply)) {
        return reply;
      }

      return runScheduledJob(request.params, options, reply, false);
    });

    server.post(`${prefix}/jobs/:jobId/dry-run`, async (request, reply) => {
      if (!options.requireAuthenticated(request, reply)) {
        return reply;
      }

      return runScheduledJob(request.params, options, reply, true);
    });

    server.get(`${prefix}/jobs/:jobId/executions`, async (request, reply) => {
      if (!options.requireAuthenticated(request, reply)) {
        return reply;
      }

      if (!options.scheduler?.executionStore && !options.scheduler?.service) {
        return [];
      }

      const { jobId } = request.params as { readonly jobId: string };

      if (options.scheduler.service && !(await options.scheduler.service.findById(jobId))) {
        return sendSchedulerJobNotFound(reply, jobId);
      }

      const query = request.query as {
        readonly limit?: number | string;
        readonly offset?: number | string;
        readonly pageLimit?: number | string;
      };
      const executionLimit = parseLimit(query.limit, 20);
      const executions = await (options.scheduler.service?.getExecutions(jobId, executionLimit)
        ?? options.scheduler.executionStore?.findByJobId(jobId, executionLimit)
        ?? []);
      return paginate(
        executions.map(toScheduledJobExecutionResponse),
        parseOffset(query.offset),
        parseLimit(query.pageLimit, 50, 200)
      );
    });
  }
}

async function updateScheduledJob(
  params: unknown,
  body: unknown,
  options: SchedulerRouteOptions,
  reply: { status(statusCode: number): { send(payload: ApiError): void } }
) {
  if (!options.scheduler?.service) {
    return sendSchedulerServiceUnavailable(reply);
  }

  const { jobId } = params as { readonly jobId: string };
  const existing = await options.scheduler.service.findById(jobId);

  if (!existing) {
    return sendSchedulerJobNotFound(reply, jobId);
  }

  const parsed = parseScheduledJobInput(body, existing);

  if (!parsed.ok) {
    return reply.status(400).send(parsed.error);
  }

  try {
    const updated = await options.scheduler.service.update(jobId, parsed.value);
    return updated ? toScheduledJobResponse(updated) : sendSchedulerJobNotFound(reply, jobId);
  } catch (error) {
    return sendSchedulerError(reply, error);
  }
}

async function runScheduledJob(
  params: unknown,
  options: SchedulerRouteOptions,
  reply: { status(statusCode: number): { send(payload: ApiError): void } },
  dryRun: boolean
) {
  if (!options.scheduler?.service) {
    return sendSchedulerServiceUnavailable(reply);
  }

  const { jobId } = params as { readonly jobId: string };

  if (!(await options.scheduler.service.findById(jobId))) {
    return sendSchedulerJobNotFound(reply, jobId);
  }

  const result = dryRun
    ? await options.scheduler.service.dryRun(jobId)
    : await options.scheduler.service.trigger(jobId);

  return dryRun ? { dryRun: true, result } : { result };
}

function sendSchedulerUnavailable(reply: { status(statusCode: number): { send(payload: ApiError): void } }) {
  return reply.status(404).send(errorResponse("Scheduler not configured"));
}

function sendSchedulerServiceUnavailable(reply: { status(statusCode: number): { send(payload: ApiError): void } }) {
  return reply.status(503).send(errorResponse("DynamicScheduler not configured"));
}

function sendSchedulerJobNotFound(
  reply: { status(statusCode: number): { send(payload: ApiError): void } },
  jobId: string
) {
  return reply.status(404).send(errorResponse(`Scheduled job not found: ${jobId}`));
}

function sendSchedulerError(
  reply: { status(statusCode: number): { send(payload: ApiError): void } },
  error: unknown
) {
  if (error instanceof SchedulerValidationError) {
    return reply.status(400).send(errorResponse("Invalid request"));
  }

  return reply.status(500).send(errorResponse("서버 오류가 발생했습니다"));
}

function toScheduledJobResponse(job: ScheduledJob) {
  return {
    agentMaxToolCalls: job.agentMaxToolCalls ?? null,
    agentModel: job.agentModel ?? null,
    agentPrompt: job.agentPrompt ?? null,
    agentSystemPrompt: job.agentSystemPrompt ?? null,
    createdAt: job.createdAt.getTime(),
    cronExpression: job.cronExpression,
    description: job.description ?? null,
    enabled: job.enabled,
    executionTimeoutMs: job.executionTimeoutMs ?? null,
    id: job.id,
    jobType: toCompatSchedulerEnum(job.jobType),
    lastFailureReason: schedulerFailureReason(job.lastResult) ?? null,
    lastResult: job.lastResult ?? null,
    lastResultPreview: schedulerResultPreview(job.lastResult) ?? null,
    lastRunAt: job.lastRunAt?.getTime() ?? null,
    lastStatus: job.lastStatus ? toCompatSchedulerEnum(job.lastStatus) : null,
    maxRetryCount: job.maxRetryCount,
    mcpServerName: job.mcpServerName ?? null,
    name: job.name,
    notificationChannelId: job.notificationChannelId ?? null,
    personaId: job.personaId ?? null,
    retryOnFailure: job.retryOnFailure,
    tags: job.tags,
    timezone: job.timezone,
    webhookUrl: job.webhookUrl ?? null,
    toolArguments: job.toolArguments,
    toolName: job.toolName ?? null,
    updatedAt: job.updatedAt.getTime()
  };
}

function toScheduledJobExecutionResponse(execution: ScheduledJobExecution) {
  return {
    completedAt: execution.completedAt?.getTime() ?? null,
    dryRun: execution.dryRun,
    durationMs: execution.durationMs,
    failureReason: schedulerFailureReason(execution.result) ?? null,
    id: execution.id,
    jobId: execution.jobId,
    jobName: execution.jobName,
    result: execution.result ?? null,
    resultPreview: schedulerResultPreview(execution.result) ?? null,
    startedAt: execution.startedAt.getTime(),
    status: toCompatSchedulerEnum(execution.status)
  };
}

function toCompatSchedulerEnum(value: string): string {
  return value.toUpperCase();
}

function schedulerFailureReason(result: string | undefined): string | undefined {
  const value = result?.trim() ?? "";

  if (!value || !value.toLowerCase().includes("failed:")) {
    return undefined;
  }

  const cleaned = value.replace(/^Job\s+'[^']+'\s+failed:\s*/iu, "").trim();
  return cleaned.length > 0 ? cleaned : undefined;
}

function schedulerResultPreview(result: string | undefined, maxLength = 140): string | undefined {
  const normalized = result?.replaceAll(/\s+/gu, " ").trim() ?? "";

  if (!normalized) {
    return undefined;
  }

  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 1).trimEnd()}…`;
}

function parseScheduledJobInput(value: unknown, existing?: ScheduledJob): ParseResult<ScheduledJobInput> {
  if (!isRecord(value)) {
    return invalid("INVALID_SCHEDULED_JOB", "Body must be an object");
  }

  const name = readString(value, "name", existing?.name);
  const cronExpression = readString(value, "cronExpression", existing?.cronExpression);

  if (!name || name.trim().length === 0 || !cronExpression || cronExpression.trim().length === 0) {
    return invalid("INVALID_SCHEDULED_JOB", "Body must include name and cronExpression strings");
  }

  const parsedType = parseScheduledJobType(value.jobType);

  if (hasOwn(value, "jobType") && !parsedType) {
    return invalid("INVALID_SCHEDULED_JOB", "jobType must be mcp_tool or agent");
  }

  const toolArguments = readJsonObject(value, "toolArguments", existing?.toolArguments);

  if (toolArguments === false) {
    return invalid("INVALID_SCHEDULED_JOB", "toolArguments must be a JSON object");
  }

  const tags = readStringArray(value, "tags", existing?.tags);

  if (tags === false) {
    return invalid("INVALID_SCHEDULED_JOB", "tags must be an array of strings");
  }

  return {
    ok: true,
    value: {
      agentMaxToolCalls: readNullableNumber(value, "agentMaxToolCalls", existing?.agentMaxToolCalls),
      agentModel: readNullableString(value, "agentModel", existing?.agentModel),
      agentPrompt: readNullableString(value, "agentPrompt", existing?.agentPrompt),
      agentSystemPrompt: readNullableString(value, "agentSystemPrompt", existing?.agentSystemPrompt),
      cronExpression,
      description: readNullableString(value, "description", existing?.description),
      enabled: readBoolean(value, "enabled", existing?.enabled),
      executionTimeoutMs: readNullableNumber(value, "executionTimeoutMs", existing?.executionTimeoutMs),
      jobType: parsedType ?? existing?.jobType,
      maxRetryCount: readNumber(value, "maxRetryCount", existing?.maxRetryCount),
      mcpServerName: readNullableString(value, "mcpServerName", existing?.mcpServerName),
      name,
      notificationChannelId: readNullableString(
        value,
        "notificationChannelId",
        existing?.notificationChannelId
      ),
      personaId: readNullableString(value, "personaId", existing?.personaId),
      retryOnFailure: readBoolean(value, "retryOnFailure", existing?.retryOnFailure),
      tags: tags === undefined ? undefined : tags,
      timezone: readString(value, "timezone", existing?.timezone),
      toolArguments: toolArguments === undefined ? undefined : toolArguments,
      toolName: readNullableString(value, "toolName", existing?.toolName),
      webhookUrl: readNullableString(value, "webhookUrl", existing?.webhookUrl)
    }
  };
}

function invalid(_code: string, _message: string): ParseResult<never> {
  return {
    error: errorResponse("Invalid request"),
    ok: false
  };
}

function errorResponse(error: string): ApiError {
  return {
    error,
    timestamp: new Date().toISOString()
  };
}

function parseScheduledJobType(value: unknown): ScheduledJobType | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();

  if (normalized === "agent") {
    return "agent";
  }

  return normalized === "mcp_tool" ? "mcp_tool" : undefined;
}

// `Number.parseInt` is lenient — `parseInt("100x") === 100`, so a
// typo'd `?limit=100x` / unit-slip `?offset=7d` silently returned
// the leading digits instead of the fallback. Mirrors the
// strict-parse posture on the CLI side: require the WHOLE trimmed
// token to be a plain decimal integer.
const STRICT_INT_RE = /^[+-]?\d+$/u;

function strictParseInt(value: number | string | undefined): number {
  if (typeof value === "number") return value;
  if (typeof value !== "string") return Number.NaN;
  const trimmed = value.trim();
  if (!STRICT_INT_RE.test(trimmed)) return Number.NaN;
  return Number(trimmed);
}

export function parseLimit(value: number | string | undefined, fallback = 20, max = 100): number {
  const parsed = strictParseInt(value);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return Math.min(max, Math.floor(parsed));
}

export function parseOffset(value: number | string | undefined): number {
  const parsed = strictParseInt(value);

  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

function paginate<T>(items: readonly T[], offset: number, limit: number) {
  const safeOffset = Math.max(0, offset);
  const safeLimit = Math.min(500, Math.max(1, limit));

  return {
    items: items.slice(safeOffset, safeOffset + safeLimit),
    limit: safeLimit,
    offset: safeOffset,
    total: items.length
  };
}

function readNullableNumber(
  value: Record<string, unknown>,
  key: string,
  fallback?: number
): number | null | undefined {
  if (!hasOwn(value, key)) {
    return fallback;
  }

  if (value[key] === null) {
    return null;
  }

  return typeof value[key] === "number" && Number.isFinite(value[key]) ? value[key] : undefined;
}


