/**
 * Muse compat admin platform-infrastructure routes extracted from
 * compat-routes.ts. Covers the slice of /api/admin that deals with
 * runtime-settings, ops dashboard, capabilities, platform doctor,
 * and cache stats.
 *
 * Wires:
 *   - GET/PUT/DELETE /api/admin/settings (+ /:key)
 *   - POST /api/admin/settings/refresh
 *   - GET /api/ops/dashboard
 *   - GET /api/ops/metrics/names
 *   - GET /api/admin/capabilities
 *   - GET /api/admin/doctor (+ /summary)
 *   - GET /api/admin/platform/cache/stats
 *   - POST /api/admin/platform/cache/invalidate
 */

import type { FastifyInstance } from "fastify";
import {
  adminCapabilitiesResponse,
  adminDiagnostic,
  dashboardSummary,
  errorResponse,
  parseRuntimeSettingType,
  readAuthUserId,
  readBodyNullableString,
  readBodyString,
  coerceNumber,
  toBody,
  toJsonObject,
  toCompatRuntimeSetting,
  type CompatibilityRouteOptions
} from "./compat-routes.js";
import { readRouteParam } from "./compat-parsers.js";

export function registerAdminPlatformCompatRoutes(server: FastifyInstance, options: CompatibilityRouteOptions): void {
  registerRuntimeSettingsRoutes(server, options);
  registerOpsAndCapabilitiesRoutes(server, options);
  registerPlatformHealthRoutes(server, options);
  registerPlatformCacheInvalidationRoutes(server, options);
}

function registerRuntimeSettingsRoutes(server: FastifyInstance, options: CompatibilityRouteOptions): void {
  server.get("/api/admin/settings", async (request, reply) => {
    if (!options.requireAuthenticated(request, reply)) {
      return reply;
    }

    return (await options.runtimeSettings.list()).map(toCompatRuntimeSetting);
  });
  server.get("/api/admin/settings/:key", async (request, reply) => {
    if (!options.requireAuthenticated(request, reply)) {
      return reply;
    }

    const key = readRouteParam(request, "key");

    if (!key) {
      return reply.status(400).send(errorResponse("key is required"));
    }

    const setting = await options.runtimeSettings.find(key);
    return setting ? toCompatRuntimeSetting(setting) : reply.status(404).send(errorResponse(`설정을 찾을 수 없습니다: ${key}`));
  });
  server.put("/api/admin/settings/:key", async (request, reply) => {
    if (!options.requireAuthenticated(request, reply)) {
      return reply;
    }

    const key = readRouteParam(request, "key");
    const body = toBody(request.body);

    if (!key) {
      return reply.status(400).send(errorResponse("key is required"));
    }

    const value = readBodyString(body, "value");

    if (value === undefined) {
      return reply.status(400).send(errorResponse("요청 형식이 올바르지 않습니다"));
    }

    await options.runtimeSettings.set({
      category: readBodyString(body, "category"),
      description: readBodyNullableString(body, "description"),
      key,
      type: parseRuntimeSettingType(body.type),
      updatedBy: readAuthUserId(request) ?? null,
      value
    });

    return {
      key,
      status: "updated",
      value
    };
  });
  server.delete("/api/admin/settings/:key", async (request, reply) => {
    if (!options.requireAuthenticated(request, reply)) {
      return reply;
    }

    const key = readRouteParam(request, "key");

    if (!key) {
      return reply.status(400).send(errorResponse("key is required"));
    }

    await options.runtimeSettings.delete(key);
    return reply.status(204).send();
  });
  server.post("/api/admin/settings/refresh", async (request, reply) => {
    if (!options.requireAuthenticated(request, reply)) {
      return reply;
    }

    options.runtimeSettings.refreshCache();
    return { status: "cache_refreshed" };
  });
}

function registerOpsAndCapabilitiesRoutes(server: FastifyInstance, options: CompatibilityRouteOptions): void {
  server.get("/api/ops/dashboard", async (request, reply) => {
    if (!options.requireAuthenticated(request, reply)) {
      return reply;
    }

    return dashboardSummary(options);
  });
  server.get("/api/ops/metrics/names", async (request, reply) => {
    if (!options.requireAuthenticated(request, reply)) {
      return reply;
    }

    return ["agent_run", "tool_call", "cache", "scheduler"];
  });
  server.get("/api/admin/capabilities", async (request, reply) => {
    if (!options.requireAuthenticated(request, reply)) {
      return reply;
    }

    return adminCapabilitiesResponse(options);
  });
}

function registerPlatformHealthRoutes(server: FastifyInstance, options: CompatibilityRouteOptions): void {
  server.get("/api/admin/doctor", async (request, reply) => adminDiagnostic(request, reply, options, "report"));
  server.get("/api/admin/doctor/summary", async (request, reply) => adminDiagnostic(request, reply, options, "summary"));
  server.get("/api/admin/platform/cache/stats", async (request, reply) => {
    if (!options.requireAuthenticated(request, reply)) {
      return reply;
    }

    const snapshot = toJsonObject(options.admin?.cache?.metrics?.snapshot());
    const exact = coerceNumber(snapshot.exactHits, 0);
    const semantic = coerceNumber(snapshot.semanticHits, 0);
    const misses = coerceNumber(snapshot.misses, 0);
    const total = exact + semantic + misses;

    return {
      config: {
        cacheableTemperature: 1,
        maxCandidates: 50,
        maxSize: 1000,
        similarityThreshold: 0.92,
        ttlMinutes: 60
      },
      enabled: Boolean(options.admin?.cache?.responseCache),
      hitRate: total > 0 ? (exact + semantic) / total : 0,
      semanticEnabled: false,
      totalExactHits: exact,
      totalMisses: misses,
      totalSemanticHits: semantic
    };
  });
}

function registerPlatformCacheInvalidationRoutes(server: FastifyInstance, options: CompatibilityRouteOptions): void {
  server.post("/api/admin/platform/cache/invalidate", async (request, reply) => {
    if (!options.requireAuthenticated(request, reply)) {
      return reply;
    }

    const cache = options.admin?.cache?.responseCache;

    if (!cache) {
      return {
        cacheEnabled: false,
        invalidated: false,
        message: "Response cache is disabled"
      };
    }

    cache.invalidateAll();
    return {
      cacheEnabled: true,
      invalidated: true,
      message: "Response cache invalidated"
    };
  });
}
