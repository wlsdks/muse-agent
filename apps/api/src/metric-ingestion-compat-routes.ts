/**
 * Reactor-compat metric-ingestion routes extracted from
 * reactor-compat-routes.ts.
 *
 * Wires:
 *   - POST /api/admin/metrics/ingest/{mcp-health,tool-call,eval-result}
 *   - POST /api/admin/metrics/ingest/eval-results (batch with evalRunId/tenantId fan-out)
 *   - POST /api/admin/metrics/ingest/batch (bulk)
 */

import type { FastifyInstance } from "fastify";
import type { JsonObject } from "@muse/shared";
import {
  createRecord,
  errorResponse,
  getStateMetricEvents,
  isRecord,
  stringField,
  toJsonObject,
  type CompatRecord,
  type ReactorCompatibilityRouteOptions
} from "./reactor-compat-routes.js";

async function recordMetricEvent(
  options: ReactorCompatibilityRouteOptions,
  input: { readonly kind: string; readonly payload: JsonObject }
): Promise<CompatRecord> {
  if (options.admin?.metricEventStore) {
    const saved = await options.admin.metricEventStore.record({
      kind: input.kind,
      payload: input.payload
    });
    return {
      createdAt: saved.createdAt.toISOString(),
      id: saved.id,
      kind: saved.kind,
      payload: saved.payload,
      updatedAt: saved.createdAt.toISOString()
    };
  }

  return createRecord(getStateMetricEvents(), input, "metric_event");
}

export function registerMetricIngestionCompatRoutes(server: FastifyInstance, options: ReactorCompatibilityRouteOptions): void {
  for (const route of ["mcp-health", "tool-call", "eval-result"]) {
    server.post(`/api/admin/metrics/ingest/${route}`, async (request, reply) => {
      if (!options.authorizeAdmin(request, reply)) {
        return reply;
      }

      await recordMetricEvent(options, {
        kind: route,
        payload: toJsonObject(request.body)
      });
      return reply.status(202).send({ status: "accepted" });
    });
  }

  server.post("/api/admin/metrics/ingest/eval-results", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    const body = toJsonObject(request.body);
    const results = Array.isArray(body.results) ? body.results.filter(isRecord).map(toJsonObject) : [];

    if (results.length > 1000) {
      return reply.status(400).send(errorResponse("Batch size exceeds limit of 1000"));
    }

    if (results.length === 0) {
      return reply.status(400).send(errorResponse("Results list must not be empty"));
    }

    for (const result of results) {
      await recordMetricEvent(options, {
        kind: "eval-results",
        payload: {
          ...result,
          evalRunId: stringField(body.evalRunId, "")
        }
      });
    }

    return {
      accepted: results.length,
      dropped: 0,
      evalRunId: stringField(body.evalRunId, "")
    };
  });

  server.post("/api/admin/metrics/ingest/batch", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    const requests = Array.isArray(request.body) ? request.body.filter(isRecord).map(toJsonObject) : [];

    if (requests.length > 1000) {
      return reply.status(400).send(errorResponse("Batch size exceeds limit of 1000"));
    }

    for (const item of requests) {
      await recordMetricEvent(options, {
        kind: "batch",
        payload: item
      });
    }

    return {
      accepted: requests.length,
      dropped: 0
    };
  });
}
