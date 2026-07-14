/**
 * Muse compat session routes extracted from compat-routes.ts.
 *
 * Wires `/api/sessions*` and `/api/models` so call sites in
 * registerCompatibilityRoutes don't change.
 */

import type { FastifyInstance } from "fastify";
import {
  clampLimit,
  errorResponse,
  exportSession,
  listSessionModels,
  nowIso,
  compatSessionDetail,
  readAuthUserId,
  readQueryInteger,
  toSessionResponse,
  type CompatibilityRouteOptions
} from "./compat-routes.js";
import { readRouteParam } from "./compat-parsers.js";

export function registerSessionCompatibilityRoutes(server: FastifyInstance, options: CompatibilityRouteOptions): void {
  server.get("/api/sessions", async (request, reply) => {
    const userId = readAuthUserId(request);
    const offset = Math.max(0, readQueryInteger(request, "offset", 0));
    const limit = clampLimit(readQueryInteger(request, "limit", 50));

    if (!userId) {
      return reply.status(401).send(errorResponse("인증이 필요합니다"));
    }

    if (!options.historyStore) {
      return {
        items: [],
        limit,
        offset,
        total: 0
      };
    }

    const runs = await options.historyStore.listRunsByUser(userId);
    const paged = runs.slice(offset, offset + limit);
    const items = await Promise.all(paged.map((run) => toSessionResponse(run, options)));

    return {
      items,
      limit,
      offset,
      total: runs.length
    };
  });

  server.get("/api/sessions/:sessionId", async (request, reply) => compatSessionDetail(request, reply, options));
  server.get("/api/sessions/:sessionId/export", async (request, reply) =>
    exportSession(request, reply, options, "compat")
  );
  server.delete("/api/sessions/:sessionId", async (request, reply) => {
    const sessionId = readRouteParam(request, "sessionId");
    const userId = readAuthUserId(request);

    if (!sessionId) {
      return reply.status(400).send({ code: "INVALID_SESSION_ID", message: "sessionId is required" });
    }

    if (!userId) {
      return reply.status(401).send({
        error: "인증이 필요합니다",
        timestamp: nowIso()
      });
    }

    if (!options.historyStore) {
      return reply.status(404).send(errorResponse("Run history store is not configured"));
    }

    const run = await options.historyStore.findRun(sessionId);

    if (!run) {
      return reply.status(404).send({
        error: `Session not found: ${sessionId}`,
        timestamp: nowIso()
      });
    }

    await options.historyStore.deleteRun(sessionId);
    return reply.status(204).send();
  });

  server.get("/api/models", async () => listSessionModels(options));
}
