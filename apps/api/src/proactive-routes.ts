/**
 * `/api/proactive/*` routes — operator-side audit for the
 * proactive surfacing daemon. Mirror of `/api/reminders/history`.
 *
 * Endpoints:
 *   - GET /api/proactive/history?limit=N   newest-first audit log
 *
 * The route is only registered when a `proactiveHistoryFile` is
 * configured on the server (matches the reminder-history gate).
 * Default off so a fresh install doesn't expose an empty file.
 */

import { readProactiveHistory } from "@muse/stores";
import type { FastifyInstance } from "fastify";

import { requireAuthenticated } from "./server-helpers.js";
import { parseHistoryLimit } from "./server-input-utils.js";
import { readQueryString } from "./compat-parsers.js";
import type { ServerOptions } from "./server.js";

interface ProactiveRoutesGate {
  readonly authService: ServerOptions["authService"];
  readonly proactiveHistoryFile: string;
}

export function registerProactiveRoutes(server: FastifyInstance, gate: ProactiveRoutesGate): void {
  server.get("/api/proactive/history", async (request, reply) => {
    if (!requireAuthenticated(request, reply, Boolean(gate.authService))) {
      return reply;
    }
    const limit = parseHistoryLimit(readQueryString(request, "limit"), 500);
    const entries = await readProactiveHistory(gate.proactiveHistoryFile, limit);
    return { entries, total: entries.length };
  });
}
