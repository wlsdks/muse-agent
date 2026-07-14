/**
 * Muse compat admin observability routes extracted from
 * compat-routes.ts.
 *
 * Wires:
 *   - GET /api/admin/traces (+ /:traceId/spans)
 *   - GET /api/admin/tool-calls (+ /ranking)
 *   - GET /api/admin/token-cost/{by-session,daily,top-expensive}
 *   - GET /api/admin/conversation-analytics/{failure-patterns,latency-distribution}
 */

import type { FastifyInstance } from "fastify";
import { recordedSpans, recordedTraceEvents } from "./admin-routes.js";
import { readRouteParam } from "./compat-parsers.js";
import {
  aggregateFailurePatterns,
  dailyUsage,
  isRecord,
  latencyDistribution,
  latencyWindowStart,
  listAllRuns,
  listAllToolCalls,
  readQueryInteger,
  readQueryString,
  errorResponse,
  toolCallRanking,
  type CompatibilityRouteOptions
} from "./compat-routes.js";


export function registerAdminObservabilityCompatRoutes(server: FastifyInstance, options: CompatibilityRouteOptions): void {
  registerTraceRoutes(server, options);
  registerToolCallRoutes(server, options);
  registerTokenCostRoutes(server, options);
  registerConversationAnalyticsRoutes(server, options);
}

function registerTraceRoutes(server: FastifyInstance, options: CompatibilityRouteOptions): void {
  server.get("/api/admin/traces", async (request, reply) => {
    if (!options.requireAuthenticated(request, reply)) {
      return reply;
    }

    const traceEvents = recordedTraceEvents(options.admin?.observability?.traceSink);

    return traceEvents.length > 0 ? traceEvents : recordedSpans(options.admin?.observability?.tracer);
  });
  server.get("/api/admin/traces/:traceId/spans", async (request, reply) => {
    if (!options.requireAuthenticated(request, reply)) {
      return reply;
    }

    const traceId = readRouteParam(request, "traceId");

    if (!traceId) {
      return reply.status(400).send(errorResponse("traceId is required"));
    }

    const traceEvents = recordedTraceEvents(options.admin?.observability?.traceSink, traceId);

    if (traceEvents.length > 0) {
      return traceEvents;
    }

    return recordedSpans(options.admin?.observability?.tracer)
      .filter((span) =>
        isRecord(span) &&
        (span.id === traceId || (isRecord(span.attributes) && span.attributes.runId === traceId))
      );
  });
}

function registerToolCallRoutes(server: FastifyInstance, options: CompatibilityRouteOptions): void {
  server.get("/api/admin/tool-calls", async (request, reply) => {
    if (!options.requireAuthenticated(request, reply)) {
      return reply;
    }

    const runId = readQueryString(request, "runId");
    return runId && options.historyStore
      ? options.historyStore.listToolCalls(runId)
      : listAllToolCalls(options);
  });
  server.get("/api/admin/tool-calls/ranking", async (request, reply) => {
    if (!options.requireAuthenticated(request, reply)) {
      return reply;
    }

    return toolCallRanking(await listAllToolCalls(options));
  });
}

function registerTokenCostRoutes(server: FastifyInstance, options: CompatibilityRouteOptions): void {
  server.get("/api/admin/token-cost/by-session", async (request, reply) => {
    if (!options.requireAuthenticated(request, reply)) {
      return reply;
    }

    if (options.tokenCostQuery) {
      const sessionId = readQueryString(request, "sessionId") ?? readQueryString(request, "runId");
      if (!sessionId) {
        return [];
      }
      const rows = await options.tokenCostQuery.bySession(sessionId);
      return rows.map((row) => ({
        completionTokens: row.completionTokens,
        estimatedCostUsd: row.estimatedCostUsd,
        model: row.model,
        promptTokens: row.promptTokens,
        provider: row.provider,
        runId: row.runId,
        stepType: row.stepType,
        time: row.time.toISOString(),
        totalTokens: row.totalTokens
      }));
    }

    return (await listAllRuns(options)).map((run) => ({
      costUsd: run.costUsd,
      model: run.model,
      runId: run.id,
      tokenUsage: run.tokenUsage,
      userId: run.userId ?? "anonymous"
    }));
  });
  server.get("/api/admin/token-cost/daily", async (request, reply) => {
    if (!options.requireAuthenticated(request, reply)) {
      return reply;
    }

    if (options.tokenCostQuery) {
      const days = readQueryInteger(request, "days", 7);
      const window = { from: latencyWindowStart(days), to: new Date() };
      const rows = await options.tokenCostQuery.daily(window);
      return rows.map((row) => ({
        completionTokens: row.completionTokens,
        day: row.day,
        model: row.model,
        promptTokens: row.promptTokens,
        totalCostUsd: row.totalCostUsd,
        totalTokens: row.totalTokens
      }));
    }

    return dailyUsage(await listAllRuns(options));
  });
  server.get("/api/admin/token-cost/top-expensive", async (request, reply) => {
    if (!options.requireAuthenticated(request, reply)) {
      return reply;
    }

    if (options.tokenCostQuery) {
      const days = readQueryInteger(request, "days", 7);
      const limit = Math.min(100, Math.max(1, readQueryInteger(request, "limit", 20)));
      const rows = await options.tokenCostQuery.topExpensive({
        from: latencyWindowStart(days),
        limit,
        to: new Date()
      });
      return rows.map((row) => ({
        model: row.model,
        runId: row.runId,
        time: row.time.toISOString(),
        totalCostUsd: row.totalCostUsd,
        totalTokens: row.totalTokens
      }));
    }

    const runs = await listAllRuns(options);
    return [...runs]
      .sort((left, right) => Number(right.costUsd) - Number(left.costUsd))
      .slice(0, 20);
  });
}

function registerConversationAnalyticsRoutes(server: FastifyInstance, options: CompatibilityRouteOptions): void {
  server.get("/api/admin/conversation-analytics/failure-patterns", async (request, reply) => {
    if (!options.requireAuthenticated(request, reply)) {
      return reply;
    }

    const failed = (await listAllRuns(options)).filter((run) => run.status === "failed");
    return aggregateFailurePatterns(failed);
  });
  server.get("/api/admin/conversation-analytics/latency-distribution", async (request, reply) => {
    if (!options.requireAuthenticated(request, reply)) {
      return reply;
    }

    return latencyDistribution(await listAllRuns(options));
  });
}
