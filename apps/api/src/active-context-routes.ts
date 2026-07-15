/**
 * `GET /api/active-context` — resolve and return the same Phase-1
 * Context-Engineering snapshot the agent loop injects as its
 * `[Active Context]` system section.
 *
 * Surface is read-only and provider-driven: the autoconfigure
 * assembly builds the `ActiveContextProvider` once and passes the
 * same instance into the agent runtime, so the REST view and the
 * agent prompt cannot drift.
 */

import type { ActiveContextProvider } from "@muse/agent-core";
import type { FastifyInstance } from "fastify";

import { requireAuthenticated } from "./server-helpers.js";
import type { ServerOptions } from "./server.js";

interface ActiveContextRoutesGate {
  readonly authService: ServerOptions["authService"];
  readonly activeContextProvider?: ActiveContextProvider;
}

export function registerActiveContextRoutes(
  server: FastifyInstance,
  gate: ActiveContextRoutesGate
): void {
  server.get("/api/active-context", async (request, reply) => {
    if (!requireAuthenticated(request, reply, Boolean(gate.authService))) {
      return reply;
    }
    const provider = gate.activeContextProvider;
    if (!provider) {
      return reply.status(404).send({
        error: "active context disabled (MUSE_ACTIVE_CONTEXT_ENABLED=false)",
        timestamp: new Date().toISOString()
      });
    }
    const query = request.query as { readonly userId?: string; readonly sessionId?: string } | undefined;
    const snapshot = await provider.resolve({
      ...(query?.userId ? { userId: query.userId } : {}),
      ...(query?.sessionId ? { sessionId: query.sessionId } : {})
    });
    if (!snapshot) {
      return reply.status(404).send({
        error: "active context provider returned no snapshot",
        timestamp: new Date().toISOString()
      });
    }
    return reply.status(200).send(snapshot);
  });
}
