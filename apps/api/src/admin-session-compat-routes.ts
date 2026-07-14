/**
 * Muse compat admin sessions + users routes extracted from
 * compat-routes.ts.
 *
 * Wires:
 *   - GET /api/admin/sessions/overview
 *   - GET /api/admin/sessions (paginated)
 *   - GET /api/admin/sessions/:sessionId/export
 *   - POST/DELETE /api/admin/sessions/:sessionId/tags(/:tagId)
 *   - GET/DELETE /api/admin/sessions/:sessionId
 *   - GET /api/admin/users
 *   - GET /api/admin/users/:userId/sessions
 *   - GET /admin/doctor (legacy alias)
 */

import type { FastifyInstance } from "fastify";
import {
  adminDiagnostic,
  createSessionTag,
  deleteSessionTag,
  deleteSessionTags,
  errorResponse,
  exportSession,
  isRecord,
  listAllRuns,
  listSessionTags,
  readBodyNullableString,
  readBodyString,
  readQueryInteger,
  sessionDetail,
  type CompatibilityRouteOptions
} from "./compat-routes.js";
import { readRouteParam } from "./compat-parsers.js";

export function registerAdminSessionCompatRoutes(server: FastifyInstance, options: CompatibilityRouteOptions): void {
  registerSessionRoutes(server, options);

  server.get("/admin/doctor", async (request, reply) => adminDiagnostic(request, reply, options, "report"));
}

function registerSessionRoutes(server: FastifyInstance, options: CompatibilityRouteOptions): void {
  server.get("/api/admin/sessions/overview", async (request, reply) => {
    if (!options.requireAuthenticated(request, reply)) {
      return reply;
    }

    const runs = await listAllRuns(options);
    const completed = runs.filter((run) => run.status === "completed").length;
    const failed = runs.filter((run) => run.status === "failed").length;
    return {
      completed,
      failed,
      running: runs.filter((run) => run.status === "running").length,
      total: runs.length
    };
  });
  server.get("/api/admin/sessions", async (request, reply) => {
    if (!options.requireAuthenticated(request, reply)) {
      return reply;
    }

    const offset = readQueryInteger(request, "offset", 0);
    const limit = readQueryInteger(request, "limit", 30);
    const runs = await listAllRuns(options, { limit, offset });
    return {
      items: runs,
      limit: Math.max(0, limit),
      offset: Math.max(0, offset),
      total: (await listAllRuns(options)).length
    };
  });
  server.get("/api/admin/sessions/:sessionId/export", async (request, reply) => {
    if (!options.requireAuthenticated(request, reply)) {
      return reply;
    }

    return exportSession(request, reply, options);
  });
  server.post("/api/admin/sessions/:sessionId/tags", async (request, reply) => {
    if (!options.requireAuthenticated(request, reply)) {
      return reply;
    }

    const sessionId = readRouteParam(request, "sessionId");
    if (!sessionId) {
      return reply.status(400).send(errorResponse("sessionId is required"));
    }

    const label = readBodyString(request.body, "label");

    if (!label) {
      return reply.status(400).send(errorResponse("label is required"));
    }

    return createSessionTag(options, request, sessionId, label, readBodyNullableString(request.body, "comment") ?? null);
  });
  server.delete("/api/admin/sessions/:sessionId/tags/:tagId", async (request, reply) => {
    if (!options.requireAuthenticated(request, reply)) {
      return reply;
    }

    const sessionId = readRouteParam(request, "sessionId");
    const tagId = readRouteParam(request, "tagId");

    if (!sessionId || !tagId) {
      return reply.status(400).send(errorResponse("sessionId and tagId are required"));
    }

    const deleted = await deleteSessionTag(options, sessionId, tagId);

    if (!deleted) {
      return reply.status(404).send(errorResponse("Tag not found"));
    }

    return reply.status(204).send();
  });
  server.get("/api/admin/sessions/:sessionId", async (request, reply) => {
    if (!options.requireAuthenticated(request, reply)) {
      return reply;
    }

    const sessionId = readRouteParam(request, "sessionId");
    if (!sessionId) {
      return reply.status(400).send(errorResponse("sessionId is required"));
    }

    const detail = await sessionDetail(request, reply, options);
    const tags = await listSessionTags(options, sessionId);
    return isRecord(detail) && "run" in detail ? { ...detail, tags } : detail;
  });
  server.delete("/api/admin/sessions/:sessionId", async (request, reply) => {
    if (!options.requireAuthenticated(request, reply)) {
      return reply;
    }

    const sessionId = readRouteParam(request, "sessionId");

    if (!sessionId) {
      return reply.status(400).send(errorResponse("sessionId is required"));
    }

    if (!options.historyStore) {
      return reply.status(404).send({
        code: "RUN_HISTORY_UNAVAILABLE",
        message: "Run history store is not configured"
      });
    }

    const deleted = await options.historyStore.deleteRun(sessionId);
    await deleteSessionTags(options, sessionId);
    return deleted
      ? reply.status(204).send()
      : reply.status(404).send({ code: "SESSION_NOT_FOUND", message: `Session not found: ${sessionId}` });
  });
}
