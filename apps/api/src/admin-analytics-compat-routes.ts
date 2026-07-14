/**
 * Personal-Muse admin analytics routes extracted from
 * compat-routes.ts.
 *
 * Wires:
 *   - GET /api/admin/debug/replay (+ /:id)
 *   - GET /api/admin/muse/snapshot
 *   - GET /api/admin/metrics/latency/{summary,timeseries}
 *   - GET /api/admin/tools/{stats,accuracy}
 *   - POST /api/admin/task-memory/maintenance/{purge-expired,purge-terminal}
 */

import type { FastifyInstance, FastifyReply } from "fastify";
import {
  debugReplayResponse,
  errorResponse,
  getDebugReplayCapture,
  latencySummary,
  latencySummaryFromQuery,
  latencyTimeseries,
  latencyTimeseriesFromQuery,
  latencyWindowStart,
  listAllRuns,
  listAllToolCalls,
  listDebugReplayCaptures,
  readAuthUserId,
  readQueryInteger,
  readQueryString,
  saveDebugReplayCapture,
  stringField,
  toJsonObject,
  toolOutcomeStats,
  type CompatibilityRouteOptions
} from "./compat-routes.js";
import type { JsonObject } from "@muse/shared";

export function registerAdminAnalyticsCompatRoutes(server: FastifyInstance, options: CompatibilityRouteOptions): void {
  registerDebugReplayRoutes(server, options);
  registerStatsRoutes(server, options);
  registerLatencyRoutes(server, options);
  registerToolStatsRoutes(server, options);
  registerTaskMemoryMaintenanceRoutes(server, options);
}

function registerDebugReplayRoutes(server: FastifyInstance, options: CompatibilityRouteOptions): void {
  server.get("/api/admin/debug/replay", async (request, reply) => {
    if (!options.requireAuthenticated(request, reply)) {
      return reply;
    }

    const limit = Math.max(1, readQueryInteger(request, "limit", 50));
    const failedRuns = (await listAllRuns(options))
      .filter((run) => run.status === "failed")
      .slice(0, limit);
    const captures = await Promise.all(failedRuns.map((run) => saveDebugReplayCapture(options, debugReplayResponse(run))));
    const stored = await listDebugReplayCaptures(options, Math.max(0, limit - captures.length));
    const byId = new Map<string, JsonObject>();
    for (const capture of [...captures, ...stored]) {
      byId.set(stringField(capture.id, ""), capture);
    }
  return [...byId.values()].slice(0, limit);
  });

  server.get<{ readonly Params: { readonly id: string } }>("/api/admin/debug/replay/:id", async (request, reply) => {
    if (!options.requireAuthenticated(request, reply)) {
      return reply;
    }

    const { id } = request.params;
    const stored = await getDebugReplayCapture(options, id);
    if (stored) {
      return stored;
    }

    const run = await options.historyStore?.findRun(id);
    return run && run.status === "failed"
      ? saveDebugReplayCapture(options, debugReplayResponse(run))
      : reply.status(404).send(errorResponse("Replay target not found"));
  });
}

function registerStatsRoutes(server: FastifyInstance, options: CompatibilityRouteOptions): void {
  server.get("/api/admin/muse/snapshot", async (request, reply) => {
    if (!options.requireAuthenticated(request, reply)) {
      return reply;
    }
    if (!options.museObservabilitySnapshot) {
      return reply.status(503).send({
        code: "MUSE_SNAPSHOT_UNAVAILABLE",
        message: "Muse observability snapshot provider is not configured"
      });
    }
    const snapshot = await options.museObservabilitySnapshot();
    return toJsonObject(snapshot);
  });
}

function registerLatencyRoutes(server: FastifyInstance, options: CompatibilityRouteOptions): void {
  server.get("/api/admin/metrics/latency/summary", async (request, reply) => {
    if (!options.requireAuthenticated(request, reply)) {
      return reply;
    }

    const days = readQueryInteger(request, "days", 7);
    if (options.latencyQuery) {
      const summary = await options.latencyQuery.summary({
        from: latencyWindowStart(days),
        to: new Date()
      });
      return latencySummaryFromQuery(summary);
    }

    return latencySummary(await listAllRuns(options), days);
  });

  server.get("/api/admin/metrics/latency/timeseries", async (request, reply) => {
    if (!options.requireAuthenticated(request, reply)) {
      return reply;
    }

    const days = readQueryInteger(request, "days", 7);
    if (options.latencyQuery) {
      const points = await options.latencyQuery.timeSeries({
        bucketSizeMs: 24 * 60 * 60 * 1000,
        from: latencyWindowStart(days),
        to: new Date()
      });
      return latencyTimeseriesFromQuery(points);
    }

    return latencyTimeseries(await listAllRuns(options), days);
  });
}

function registerToolStatsRoutes(server: FastifyInstance, options: CompatibilityRouteOptions): void {
  server.get("/api/admin/tools/stats", async (request, reply) => {
    if (!options.requireAuthenticated(request, reply)) {
      return reply;
    }

    return toolOutcomeStats(await listAllToolCalls(options), readQueryString(request, "server"));
  });

  server.get("/api/admin/tools/accuracy", async (request, reply) => {
    if (!options.requireAuthenticated(request, reply)) {
      return reply;
    }

    const stats = toolOutcomeStats(await listAllToolCalls(options));
    const total = Number(stats.total);
    const byOutcome = toJsonObject(stats.byOutcome);
    const ok = Number(byOutcome.ok ?? 0);
    const invalidArg = Number(byOutcome.invalid_arg ?? 0);
    const timeout = Number(byOutcome.timeout ?? 0);
    const errors = Number(byOutcome.error ?? 0);
    const notFound = Number(byOutcome.not_found ?? 0);
    const denominator = total > 0 ? total : 1;
    return {
      accuracy: stats.accuracy,
      errorRate: errors / denominator,
      invalidCallRate: invalidArg / denominator,
      ok,
      notFoundRate: notFound / denominator,
      timeoutRate: timeout / denominator,
      total
    };
  });
}

function registerTaskMemoryMaintenanceRoutes(server: FastifyInstance, options: CompatibilityRouteOptions): void {
  server.post("/api/admin/task-memory/maintenance/purge-expired", async (request, reply) => {
    if (!options.requireAuthenticated(request, reply)) {
      return reply;
    }

    if (!options.taskMemoryMaintenance) {
      return taskMemoryMaintenanceUnavailable(reply);
    }

    const deleted = await options.taskMemoryMaintenance.purgeExpired();
    return { actor: readAuthUserId(request) ?? "admin", deleted };
  });

  server.post("/api/admin/task-memory/maintenance/purge-terminal", async (request, reply) => {
    if (!options.requireAuthenticated(request, reply)) {
      return reply;
    }

    const olderThanDays = readQueryInteger(request, "olderThanDays", 30);

    if (olderThanDays < 1) {
      return reply.status(400).send(errorResponse("olderThanDays는 1 이상이어야 합니다"));
    }

    if (!options.taskMemoryMaintenance) {
      return taskMemoryMaintenanceUnavailable(reply);
    }

    const cutoff = new Date(Date.now() - olderThanDays * 86_400_000);
    const deleted = await options.taskMemoryMaintenance.purgeTerminalOlderThan(cutoff);
    return { cutoff: cutoff.toISOString(), deleted };
  });
}

function taskMemoryMaintenanceUnavailable(reply: FastifyReply) {
  return reply.status(400).send(errorResponse("TaskMemoryMaintenance 미등록 — task memory 유지보수를 사용할 수 없습니다"));
}
