import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type {
  AdminAlertInput,
  AdminAlertSeverity,
  AdminCostUsage,
  AdminAuditStore,
  MetricAuditEventStore,
  AdminOperationsStore,
  AdminSloInput
} from "@muse/runtime-state";
import type { TraceEventInput } from "@muse/observability";

export interface AdminRouteOptions {
  readonly authorizeAdmin: (request: FastifyRequest, reply: FastifyReply) => boolean;
  readonly admin?: AdminRouteState;
}

export interface AdminRouteState {
  readonly cache?: {
    readonly metrics?: { snapshot(): unknown };
    readonly responseCache?: {
      invalidateAll(): void;
      invalidate?(key: string): boolean;
      invalidateByPattern?(pattern: string): number;
      size?(): number;
    };
  };
  readonly observability?: {
    readonly metrics?: { recordedEvents(): readonly unknown[] };
    readonly traceSink?: {
      list(): readonly TraceEventInput[];
      listByRunId?(runId: string): readonly TraceEventInput[];
    };
    readonly tracer?: unknown;
  };
  readonly auditStore?: AdminAuditStore;
  readonly metricEventStore?: MetricAuditEventStore;
  readonly resilience?: {
    readonly circuitBreakerRegistry?: {
      getIfExists(name: string): CircuitBreakerView | undefined;
      names(): readonly string[];
      resetAll(): void;
    };
  };
  readonly operations?: AdminOperationsStore;
}

interface CircuitBreakerView {
  metrics(): unknown;
  reset(): void;
  state(): string;
}

export function registerAdminRoutes(server: FastifyInstance, options: AdminRouteOptions): void {
  server.get("/admin/metrics", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    return {
      events: options.admin?.observability?.metrics?.recordedEvents() ?? [],
      spans: recordedSpans(options.admin?.observability?.tracer),
      traceEvents: recordedTraceEvents(options.admin?.observability?.traceSink)
    };
  });

  server.get("/admin/cache", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    const cache = options.admin?.cache?.responseCache;

    return {
      metrics: options.admin?.cache?.metrics?.snapshot() ?? null,
      size: cache?.size?.() ?? null
    };
  });

  server.delete("/admin/cache", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    options.admin?.cache?.responseCache?.invalidateAll();
    return { invalidated: true };
  });

  server.delete("/admin/cache/:key", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    const { key } = request.params as { readonly key: string };
    return {
      invalidated: options.admin?.cache?.responseCache?.invalidate?.(key) ?? false,
      key
    };
  });

  server.post("/admin/cache/invalidate-pattern", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    if (!isRecord(request.body) || typeof request.body.pattern !== "string") {
      return reply.status(400).send({
        code: "INVALID_CACHE_PATTERN",
        message: "Body must include a pattern string"
      });
    }

    return {
      invalidated: options.admin?.cache?.responseCache?.invalidateByPattern?.(request.body.pattern) ?? 0,
      pattern: request.body.pattern
    };
  });

  server.get("/admin/resilience/circuit-breakers", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    const registry = options.admin?.resilience?.circuitBreakerRegistry;

    return (registry?.names() ?? []).map((name) => {
      const breaker = registry?.getIfExists(name);

      return {
        metrics: breaker?.metrics() ?? null,
        name,
        state: breaker?.state() ?? "unknown"
      };
    });
  });

  server.post("/admin/resilience/circuit-breakers/:name/reset", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    const { name } = request.params as { readonly name: string };
    const breaker = options.admin?.resilience?.circuitBreakerRegistry?.getIfExists(name);

    if (!breaker) {
      return reply.status(404).send({
        code: "CIRCUIT_BREAKER_NOT_FOUND",
        message: `Circuit breaker not found: ${name}`
      });
    }

    breaker.reset();
    return {
      name,
      state: breaker.state()
    };
  });

  server.post("/admin/resilience/circuit-breakers/reset", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    options.admin?.resilience?.circuitBreakerRegistry?.resetAll();
    return { reset: true };
  });

  server.get("/admin/alerts", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    const operations = requireOperations(options, reply);
    return operations ? operations.listAlerts() : reply;
  });

  server.post("/admin/alerts", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    const operations = requireOperations(options, reply);

    if (!operations) {
      return reply;
    }

    const parsed = parseAlertInput(request.body);

    if (!parsed.ok) {
      return reply.status(400).send(parsed.error);
    }

    return reply.status(201).send(await operations.createAlert(parsed.value));
  });

  server.get("/admin/slos", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    const operations = requireOperations(options, reply);
    return operations ? operations.listSlos() : reply;
  });

  server.put("/admin/slos/:sloId", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    const operations = requireOperations(options, reply);

    if (!operations) {
      return reply;
    }

    const { sloId } = request.params as { readonly sloId: string };
    const parsed = parseSloInput(request.body, sloId);

    if (!parsed.ok) {
      return reply.status(400).send(parsed.error);
    }

    return operations.upsertSlo(parsed.value);
  });

  server.get("/admin/costs/summary", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    const operations = requireOperations(options, reply);
    return operations ? operations.costSummary() : reply;
  });

  server.post("/admin/costs/usage", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    const operations = requireOperations(options, reply);

    if (!operations) {
      return reply;
    }

    const parsed = parseCostUsage(request.body);

    if (!parsed.ok) {
      return reply.status(400).send(parsed.error);
    }

    return operations.recordCost(parsed.value);
  });
}

export function recordedSpans(tracer: unknown): readonly unknown[] {
  return tracer &&
    typeof tracer === "object" &&
    "recordedSpans" in tracer &&
    typeof tracer.recordedSpans === "function"
    ? tracer.recordedSpans() as readonly unknown[]
    : [];
}

export function recordedTraceEvents(traceSink: unknown, runId?: string): readonly unknown[] {
  if (!traceSink || typeof traceSink !== "object") {
    return [];
  }

  if (
    runId &&
    "listByRunId" in traceSink &&
    typeof traceSink.listByRunId === "function"
  ) {
    return traceSink.listByRunId(runId) as readonly unknown[];
  }

  return "list" in traceSink && typeof traceSink.list === "function"
    ? traceSink.list() as readonly unknown[]
    : [];
}

type ParseResult<T> = { readonly ok: true; readonly value: T } | { readonly error: ApiError; readonly ok: false };

interface ApiError {
  readonly code: string;
  readonly message: string;
}

function requireOperations(options: AdminRouteOptions, reply: FastifyReply): AdminOperationsStore | undefined {
  const operations = options.admin?.operations;

  if (!operations) {
    reply.status(404).send({
      code: "ADMIN_OPERATIONS_UNAVAILABLE",
      message: "Admin operations store is not configured"
    });
    return undefined;
  }

  return operations;
}

function parseAlertInput(value: unknown): ParseResult<AdminAlertInput> {
  if (!isRecord(value) || typeof value.message !== "string" || value.message.trim().length === 0) {
    return invalid("INVALID_ADMIN_ALERT", "Body must include a non-empty message");
  }

  const severity = parseAlertSeverity(value.severity);

  if (!severity.ok) {
    return severity;
  }

  const target = optionalString(value.target);
  return {
    ok: true,
    value: {
      message: value.message.trim(),
      ...(severity.value ? { severity: severity.value } : {}),
      ...(target ? { target } : {})
    }
  };
}

function parseSloInput(value: unknown, sloId: string): ParseResult<AdminSloInput> {
  if (
    !isRecord(value) ||
    typeof value.name !== "string" ||
    value.name.trim().length === 0 ||
    typeof value.window !== "string" ||
    value.window.trim().length === 0
  ) {
    return invalid("INVALID_ADMIN_SLO", "Body must include non-empty name and window strings");
  }

  const target = parseNumber(value.target, "INVALID_ADMIN_SLO", "SLO target must be a finite number");

  if (!target.ok) {
    return target;
  }

  const actual = value.actual === undefined
    ? ({ ok: true, value: undefined } as const)
    : parseNumber(value.actual, "INVALID_ADMIN_SLO", "SLO actual must be a finite number");

  if (!actual.ok) {
    return actual;
  }

  return {
    ok: true,
    value: {
      id: sloId,
      ...(actual.value !== undefined ? { actual: actual.value } : {}),
      name: value.name.trim(),
      target: target.value,
      window: value.window.trim()
    }
  };
}

function parseCostUsage(value: unknown): ParseResult<AdminCostUsage> {
  if (!isRecord(value)) {
    return invalid("INVALID_ADMIN_COST_USAGE", "Body must be an object");
  }

  const costUsd = parseRequiredCost(value.costUsd, "INVALID_ADMIN_COST_USAGE");

  if (!costUsd.ok) {
    return costUsd;
  }

  const model = optionalString(value.model);
  return {
    ok: true,
    value: {
      costUsd: costUsd.value,
      ...(model ? { model } : {})
    }
  };
}

function parseAlertSeverity(value: unknown): ParseResult<AdminAlertSeverity | undefined> {
  if (value === undefined) {
    return { ok: true, value: undefined };
  }

  if (value === "info" || value === "warning" || value === "critical") {
    return { ok: true, value };
  }

  return invalid("INVALID_ADMIN_ALERT", "Alert severity must be info, warning, or critical");
}

function parseRequiredCost(value: unknown, code: string): ParseResult<string> {
  if (typeof value !== "string" && typeof value !== "number") {
    return invalid(code, "Cost must be a finite numeric value");
  }

  return parseCost(value, code);
}

function parseCost(value: string | number, code: string): ParseResult<string> {
  const parsed = Number(value);

  if (!Number.isFinite(parsed) || parsed < 0) {
    return invalid(code, "Cost must be a finite non-negative value");
  }

  return { ok: true, value: parsed.toFixed(8) };
}

function parseNumber(value: unknown, code: string, message: string): ParseResult<number> {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return invalid(code, message);
  }

  return { ok: true, value };
}

function invalid(code: string, message: string): ParseResult<never> {
  return {
    error: { code, message },
    ok: false
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  const trimmed = typeof value === "string" ? value.trim() : undefined;
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}
