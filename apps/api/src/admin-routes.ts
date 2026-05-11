import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { TraceEventInput } from "@muse/observability";
import type { TelemetryAggregator } from "@muse/agent-core";

export interface AdminRouteOptions {
  readonly requireAuthenticated: (request: FastifyRequest, reply: FastifyReply) => boolean;
  readonly admin?: AdminRouteState;
}

export interface AdminRouteState {
  readonly cache?: {
    readonly metrics?: { snapshot(): unknown };
    readonly responseCache?: {
      invalidateAll(): void;
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
    readonly telemetryAggregator?: TelemetryAggregator;
  };
  readonly resilience?: {
    readonly circuitBreakerRegistry?: {
      getIfExists(name: string): CircuitBreakerView | undefined;
      names(): readonly string[];
      resetAll(): void;
    };
  };
}

interface CircuitBreakerView {
  metrics(): unknown;
  reset(): void;
  state(): string;
}

export function registerAdminRoutes(server: FastifyInstance, options: AdminRouteOptions): void {
  server.get("/admin/metrics", async (request, reply) => {
    if (!options.requireAuthenticated(request, reply)) {
      return reply;
    }

    return {
      events: options.admin?.observability?.metrics?.recordedEvents() ?? [],
      spans: recordedSpans(options.admin?.observability?.tracer),
      traceEvents: recordedTraceEvents(options.admin?.observability?.traceSink)
    };
  });

  server.get("/admin/cache", async (request, reply) => {
    if (!options.requireAuthenticated(request, reply)) {
      return reply;
    }

    const cache = options.admin?.cache?.responseCache;

    return {
      metrics: options.admin?.cache?.metrics?.snapshot() ?? null,
      size: cache?.size?.() ?? null
    };
  });

  // Iter 38: surfaces the in-process `TelemetryAggregator` that
  // autoconfigure now instantiates by default. Reads the rolling
  // 7-day window of ctx.* flags, counters, budget tokens, latency
  // stats. Returns 503-shaped `{ enabled: false }` when the
  // aggregator is disabled via `MUSE_TELEMETRY_AGGREGATOR_ENABLED=false`
  // so callers can disambiguate "feature off" from "empty window".
  server.get("/admin/telemetry/summary", async (request, reply) => {
    if (!options.requireAuthenticated(request, reply)) {
      return reply;
    }

    const aggregator = options.admin?.observability?.telemetryAggregator;
    if (!aggregator) {
      return { enabled: false };
    }
    const sinceMsRaw = (request.query as { sinceMs?: string } | undefined)?.sinceMs;
    const sinceMs = typeof sinceMsRaw === "string" && /^\d+$/u.test(sinceMsRaw)
      ? Number.parseInt(sinceMsRaw, 10)
      : undefined;
    return {
      enabled: true,
      summary: aggregator.summary(sinceMs !== undefined ? { sinceMs } : undefined)
    };
  });

  server.get("/admin/telemetry/recent", async (request, reply) => {
    if (!options.requireAuthenticated(request, reply)) {
      return reply;
    }

    const aggregator = options.admin?.observability?.telemetryAggregator;
    if (!aggregator) {
      return { enabled: false, events: [] };
    }
    const query = (request.query ?? {}) as { limit?: string; sinceMs?: string };
    const limit = typeof query.limit === "string" && /^\d+$/u.test(query.limit)
      ? Number.parseInt(query.limit, 10)
      : 50;
    const sinceMs = typeof query.sinceMs === "string" && /^\d+$/u.test(query.sinceMs)
      ? Number.parseInt(query.sinceMs, 10)
      : undefined;
    return {
      enabled: true,
      events: aggregator.recent(sinceMs !== undefined ? { limit, sinceMs } : { limit })
    };
  });

  server.delete("/admin/cache", async (request, reply) => {
    if (!options.requireAuthenticated(request, reply)) {
      return reply;
    }

    options.admin?.cache?.responseCache?.invalidateAll();
    return { invalidated: true };
  });

  server.get("/admin/resilience/circuit-breakers", async (request, reply) => {
    if (!options.requireAuthenticated(request, reply)) {
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
    if (!options.requireAuthenticated(request, reply)) {
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
    if (!options.requireAuthenticated(request, reply)) {
      return reply;
    }

    options.admin?.resilience?.circuitBreakerRegistry?.resetAll();
    return { reset: true };
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

