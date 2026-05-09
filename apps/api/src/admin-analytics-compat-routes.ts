/**
 * Personal-Muse admin analytics routes extracted from
 * reactor-compat-routes.ts.
 *
 * Wires:
 *   - GET /api/admin/audits (paginated, with optional category/action filter)
 *   - GET /api/admin/audits/export (CSV)
 *   - GET /api/admin/debug/replay (+ /:id)
 *   - GET /api/admin/input-guard/stats
 *   - GET /api/admin/jarvis/snapshot
 *   - GET /api/admin/metrics/latency/{summary,timeseries}
 *   - GET /api/admin/rag-analytics/{status,by-channel}
 *   - GET /api/admin/slack-activity/{channels,daily}
 *   - GET /api/admin/tenant/export/{executions,tools}
 *   - GET /api/admin/tools/{stats,accuracy}
 *   - POST /api/admin/task-memory/maintenance/{purge-expired,purge-terminal}
 */

import type { FastifyInstance, FastifyReply } from "fastify";
import {
  adminAuditRows,
  adminAuditStoreRecordToCompat,
  clampLimit,
  csvRows,
  dailyUsage,
  debugReplayResponse,
  errorResponse,
  getDebugReplayCapture,
  getStateRagCandidates,
  groupRecordsByField,
  groupRunsByChannel,
  inputGuardStatsResponse,
  latencySummary,
  latencySummaryFromQuery,
  latencyTimeseries,
  latencyTimeseriesFromQuery,
  latencyWindowStart,
  listAllRuns,
  listAllToolCalls,
  listDebugReplayCaptures,
  listDocuments,
  ragStatusSummary,
  readAuthUserId,
  readNumber,
  readQueryInteger,
  readQueryString,
  runsCsv,
  saveDebugReplayCapture,
  stringField,
  toAdminAuditResponse,
  toJsonObject,
  toolCallsCsv,
  toolOutcomeStats,
  type ReactorCompatibilityRouteOptions
} from "./reactor-compat-routes.js";
import type { JsonObject } from "@muse/shared";

export function registerAdminAnalyticsCompatRoutes(server: FastifyInstance, options: ReactorCompatibilityRouteOptions): void {
  registerAuditRoutes(server, options);
  registerDebugReplayRoutes(server, options);
  registerStatsRoutes(server, options);
  registerLatencyRoutes(server, options);
  registerRagAndSlackRoutes(server, options);
  registerTenantExportRoutes(server, options);
  registerToolStatsRoutes(server, options);
  registerTaskMemoryMaintenanceRoutes(server, options);
}

function registerAuditRoutes(server: FastifyInstance, options: ReactorCompatibilityRouteOptions): void {
  server.get("/api/admin/audits", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    const offset = Math.max(0, readQueryInteger(request, "offset", 0));
    const pageLimit = clampLimit(readQueryInteger(request, "pageLimit", 50));
    const category = readQueryString(request, "category") ?? undefined;
    const action = readQueryString(request, "action") ?? undefined;

    if (options.admin?.auditStore) {
      const auditPage = await options.admin.auditStore.query({
        ...(action ? { action } : {}),
        ...(category ? { category } : {}),
        limit: pageLimit,
        offset
      });
      const items = auditPage.items
        .map((record) => toAdminAuditResponse(adminAuditStoreRecordToCompat(record)));
      return {
        items,
        limit: pageLimit,
        offset,
        total: auditPage.total
      };
    }

    const limit = Math.max(1, readQueryInteger(request, "limit", 1000));
    const rows = await adminAuditRows(request, options, limit);
    return {
      items: rows.slice(offset, offset + pageLimit),
      limit: pageLimit,
      offset,
      total: Math.min(rows.length, limit)
    };
  });

  server.get("/api/admin/audits/export", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    const rows = await adminAuditRows(request, options, readQueryInteger(request, "limit", 5000));
    const stamp = new Date().toISOString().slice(0, 16).replace(/\D/gu, "");
    reply.header("content-disposition", `attachment; filename="audit-export-${stamp}.csv"`);
    reply.header("content-type", "text/csv; charset=utf-8");
    return csvRows(
      ["id", "timestamp", "category", "action", "actor", "resource_type", "resource_id", "detail"],
      rows.map((row) => [
        row.id,
        new Date(readNumber(row.createdAt, Date.now())).toISOString(),
        row.category,
        row.action,
        row.actor,
        row.resourceType ?? "",
        row.resourceId ?? "",
        row.detail ?? ""
      ])
    );
  });
}

function registerDebugReplayRoutes(server: FastifyInstance, options: ReactorCompatibilityRouteOptions): void {
  server.get("/api/admin/debug/replay", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
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

  server.get("/api/admin/debug/replay/:id", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    const { id } = request.params as { readonly id: string };
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

function registerStatsRoutes(server: FastifyInstance, options: ReactorCompatibilityRouteOptions): void {
  server.get("/api/admin/input-guard/stats", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    const hours = Math.min(168, Math.max(1, readQueryInteger(request, "hours", 24)));
    return inputGuardStatsResponse(options, hours);
  });

  server.get("/api/admin/jarvis/snapshot", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }
    if (!options.jarvisObservabilitySnapshot) {
      return reply.status(503).send({
        code: "JARVIS_SNAPSHOT_UNAVAILABLE",
        message: "JARVIS observability snapshot provider is not configured"
      });
    }
    const snapshot = await options.jarvisObservabilitySnapshot();
    return snapshot as unknown as JsonObject;
  });
}

function registerLatencyRoutes(server: FastifyInstance, options: ReactorCompatibilityRouteOptions): void {
  server.get("/api/admin/metrics/latency/summary", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
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
    if (!options.authorizeAdmin(request, reply)) {
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

function registerRagAndSlackRoutes(server: FastifyInstance, options: ReactorCompatibilityRouteOptions): void {
  server.get("/api/admin/rag-analytics/status", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    return ragStatusSummary(await listDocuments(options, { limit: 1000 }));
  });

  server.get("/api/admin/rag-analytics/by-channel", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    return groupRecordsByField([...getStateRagCandidates(), ...await listDocuments(options, { limit: 1000 })], "channelId", "api");
  });

  server.get("/api/admin/slack-activity/channels", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    return groupRunsByChannel(await listAllRuns(options));
  });

  server.get("/api/admin/slack-activity/daily", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    return dailyUsage(await listAllRuns(options));
  });
}

function registerTenantExportRoutes(server: FastifyInstance, options: ReactorCompatibilityRouteOptions): void {
  server.get("/api/admin/tenant/export/executions", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    reply.header("content-type", "text/csv; charset=utf-8");
    return runsCsv(await listAllRuns(options));
  });

  server.get("/api/admin/tenant/export/tools", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    reply.header("content-type", "text/csv; charset=utf-8");
    return toolCallsCsv(await listAllToolCalls(options));
  });
}

function registerToolStatsRoutes(server: FastifyInstance, options: ReactorCompatibilityRouteOptions): void {
  server.get("/api/admin/tools/stats", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    return toolOutcomeStats(await listAllToolCalls(options), readQueryString(request, "server"));
  });

  server.get("/api/admin/tools/accuracy", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
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

function registerTaskMemoryMaintenanceRoutes(server: FastifyInstance, options: ReactorCompatibilityRouteOptions): void {
  server.post("/api/admin/task-memory/maintenance/purge-expired", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    if (!options.taskMemoryMaintenance) {
      return taskMemoryMaintenanceUnavailable(reply);
    }

    const deleted = await options.taskMemoryMaintenance.purgeExpired();
    return { actor: readAuthUserId(request) ?? "admin", deleted };
  });

  server.post("/api/admin/task-memory/maintenance/purge-terminal", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
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
