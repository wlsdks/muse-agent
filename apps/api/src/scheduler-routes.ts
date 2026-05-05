import {
  SchedulerValidationError,
  type DynamicSchedulerService,
  type ScheduledJob,
  type ScheduledJobExecutionStore,
  type ScheduledJobInput,
  type ScheduledJobStore,
  type ScheduledJobType
} from "@muse/scheduler";
import type { FastifyInstance } from "fastify";

export interface SchedulerRouteScheduler {
  readonly executionStore?: ScheduledJobExecutionStore;
  readonly service?: DynamicSchedulerService;
  readonly store: ScheduledJobStore;
}

export interface SchedulerRouteOptions {
  readonly authorizeAdmin: (
    request: unknown,
    reply: { status(statusCode: number): { send(payload: ApiError): void } }
  ) => boolean;
  readonly scheduler?: SchedulerRouteScheduler;
}

interface ApiError {
  readonly code?: string;
  readonly error?: string;
  readonly message?: string;
}

type ParseResult<T> = { readonly ok: true; readonly value: T } | { readonly error: ApiError; readonly ok: false };

export function registerSchedulerRoutes(server: FastifyInstance, options: SchedulerRouteOptions): void {
  for (const prefix of ["/admin/scheduler", "/scheduler", "/api/scheduler"]) {
    server.get(`${prefix}/jobs`, async (request, reply) => {
      if (!options.authorizeAdmin(request, reply)) {
        return reply;
      }

      if (!options.scheduler) {
        return [];
      }

      return options.scheduler.service?.list() ?? options.scheduler.store.list();
    });

    server.get(`${prefix}/jobs/:jobId`, async (request, reply) => {
      if (!options.authorizeAdmin(request, reply)) {
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

      return job;
    });

    server.post(`${prefix}/jobs`, async (request, reply) => {
      if (!options.authorizeAdmin(request, reply)) {
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
        return reply.status(201).send(await options.scheduler.service.create(parsed.value));
      } catch (error) {
        return sendSchedulerError(reply, error);
      }
    });

    server.put(`${prefix}/jobs/:jobId`, async (request, reply) => {
      if (!options.authorizeAdmin(request, reply)) {
        return reply;
      }

      return updateScheduledJob(request.params, request.body, options, reply);
    });

    server.patch(`${prefix}/jobs/:jobId`, async (request, reply) => {
      if (!options.authorizeAdmin(request, reply)) {
        return reply;
      }

      return updateScheduledJob(request.params, request.body, options, reply);
    });

    server.delete(`${prefix}/jobs/:jobId`, async (request, reply) => {
      if (!options.authorizeAdmin(request, reply)) {
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
      return { deleted: true, jobId };
    });

    server.post(`${prefix}/jobs/:jobId/trigger`, async (request, reply) => {
      if (!options.authorizeAdmin(request, reply)) {
        return reply;
      }

      return runScheduledJob(request.params, options, reply, false);
    });

    server.post(`${prefix}/jobs/:jobId/dry-run`, async (request, reply) => {
      if (!options.authorizeAdmin(request, reply)) {
        return reply;
      }

      return runScheduledJob(request.params, options, reply, true);
    });

    server.get(`${prefix}/jobs/:jobId/executions`, async (request, reply) => {
      if (!options.authorizeAdmin(request, reply)) {
        return reply;
      }

      if (!options.scheduler?.executionStore && !options.scheduler?.service) {
        return [];
      }

      const { jobId } = request.params as { readonly jobId: string };
      const { limit } = request.query as { readonly limit?: number | string };
      return options.scheduler.service?.getExecutions(jobId, parseLimit(limit))
        ?? options.scheduler.executionStore?.findByJobId(jobId, parseLimit(limit))
        ?? [];
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
    return await options.scheduler.service.update(jobId, parsed.value);
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

  return {
    dryRun,
    jobId,
    result: dryRun
      ? await options.scheduler.service.dryRun(jobId)
      : await options.scheduler.service.trigger(jobId)
  };
}

function sendSchedulerUnavailable(reply: { status(statusCode: number): { send(payload: ApiError): void } }) {
  return reply.status(404).send({
    error: "Scheduler not configured"
  });
}

function sendSchedulerServiceUnavailable(reply: { status(statusCode: number): { send(payload: ApiError): void } }) {
  return reply.status(503).send({
    error: "DynamicSchedulerService not configured"
  });
}

function sendSchedulerJobNotFound(
  reply: { status(statusCode: number): { send(payload: ApiError): void } },
  jobId: string
) {
  return reply.status(404).send({
    code: "SCHEDULED_JOB_NOT_FOUND",
    message: `Scheduled job not found: ${jobId}`
  });
}

function sendSchedulerError(
  reply: { status(statusCode: number): { send(payload: ApiError): void } },
  error: unknown
) {
  if (error instanceof SchedulerValidationError) {
    return reply.status(400).send({
      code: "INVALID_SCHEDULED_JOB",
      message: error.message
    });
  }

  return reply.status(500).send({
    code: "SCHEDULER_OPERATION_FAILED",
    message: error instanceof Error ? error.message : "Scheduler operation failed"
  });
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

function invalid(code: string, message: string): ParseResult<never> {
  return {
    error: { code, message },
    ok: false
  };
}

function parseScheduledJobType(value: unknown): ScheduledJobType | undefined {
  return value === "agent" || value === "mcp_tool" ? value : undefined;
}

function parseLimit(value: number | string | undefined): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(value ?? "", 10);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 20;
  }

  return Math.min(100, Math.floor(parsed));
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readString(value: Record<string, unknown>, key: string, fallback?: string): string | undefined {
  if (!hasOwn(value, key)) {
    return fallback;
  }

  return typeof value[key] === "string" ? value[key] : undefined;
}

function readNullableString(
  value: Record<string, unknown>,
  key: string,
  fallback?: string
): string | null | undefined {
  if (!hasOwn(value, key)) {
    return fallback;
  }

  return value[key] === null || typeof value[key] === "string" ? value[key] : undefined;
}

function readBoolean(value: Record<string, unknown>, key: string, fallback?: boolean): boolean | undefined {
  if (!hasOwn(value, key)) {
    return fallback;
  }

  return typeof value[key] === "boolean" ? value[key] : undefined;
}

function readNumber(value: Record<string, unknown>, key: string, fallback?: number): number | undefined {
  if (!hasOwn(value, key)) {
    return fallback;
  }

  return typeof value[key] === "number" && Number.isFinite(value[key]) ? value[key] : undefined;
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

function readJsonObject(
  value: Record<string, unknown>,
  key: string,
  fallback?: ScheduledJobInput["toolArguments"]
): ScheduledJobInput["toolArguments"] | false | undefined {
  if (!hasOwn(value, key)) {
    return fallback;
  }

  return isJsonObject(value[key]) ? value[key] : false;
}

function readStringArray(
  value: Record<string, unknown>,
  key: string,
  fallback?: readonly string[]
): readonly string[] | false | undefined {
  if (!hasOwn(value, key)) {
    return fallback;
  }

  return Array.isArray(value[key]) && value[key].every((item) => typeof item === "string")
    ? value[key]
    : false;
}

function isJsonObject(value: unknown): value is NonNullable<ScheduledJobInput["toolArguments"]> {
  if (!isRecord(value)) {
    return false;
  }

  return Object.values(value).every(isJsonValue);
}

function isJsonValue(value: unknown): boolean {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return true;
  }

  if (typeof value === "number") {
    return Number.isFinite(value);
  }

  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }

  return isRecord(value) && Object.values(value).every(isJsonValue);
}
