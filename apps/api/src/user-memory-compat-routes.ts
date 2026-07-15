/**
 * Muse compat user-memory routes extracted from compat-routes.ts.
 *
 * Wires `/api/user-memory/:userId` GET/PUT(facts/preferences)/DELETE plus
 * the `/api/error-report` 204 acknowledger. The feedback routes that
 * previously rode along inside registerMemoryAndFeedbackRoutes now register
 * separately at the call site so this module stays focused on user memory.
 */

import type { FastifyInstance } from "fastify";
import {
  canAccessUserMemory,
  deleteUserMemory,
  readUserMemory,
  toUserMemoryResponse,
  updateUserMemory,
  userForbidden,
  userMemoryNotFound,
  type CompatibilityRouteOptions
} from "./compat-routes.js";

export function registerUserMemoryCompatRoutes(server: FastifyInstance, options: CompatibilityRouteOptions): void {
  server.get("/api/user-memory/:userId", async (request, reply) => {
    const { userId } = request.params as { readonly userId: string };
    if (!(await canAccessUserMemory(request, options, userId))) {
      return userForbidden(reply);
    }

    const memory = await readUserMemory(options, userId);
    return memory ? toUserMemoryResponse(memory) : userMemoryNotFound(reply, userId);
  });
  server.put("/api/user-memory/:userId/facts", async (request, reply) => {
    if (!(await canAccessUserMemory(request, options, (request.params as { readonly userId: string }).userId))) {
      return userForbidden(reply);
    }

    return updateUserMemory(request, reply, "facts", options);
  });
  server.put("/api/user-memory/:userId/preferences", async (request, reply) => {
    if (!(await canAccessUserMemory(request, options, (request.params as { readonly userId: string }).userId))) {
      return userForbidden(reply);
    }

    return updateUserMemory(request, reply, "preferences", options);
  });
  server.delete("/api/user-memory/:userId", async (request, reply) => {
    const { userId } = request.params as { readonly userId: string };
    if (!(await canAccessUserMemory(request, options, userId))) {
      return userForbidden(reply);
    }

    await deleteUserMemory(options, userId);
    return reply.status(204).send();
  });

  server.post("/api/error-report", async (_request, reply) => reply.status(204).send());
}
