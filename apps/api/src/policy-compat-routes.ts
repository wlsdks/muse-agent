/**
 * Reactor-compat tool-policy routes extracted from
 * reactor-compat-routes.ts.
 *
 * Wires:
 *   - GET/PUT/DELETE /api/tool-policy   (effective + stored shape)
 */

import type { FastifyInstance } from "fastify";
import {
  clearToolPolicy,
  getStateToolPolicy,
  readStoredToolPolicy,
  saveToolPolicy,
  toBody,
  toToolPolicyResponse,
  validateToolPolicyBody,
  validationErrorResponse,
  type ReactorCompatibilityRouteOptions
} from "./reactor-compat-routes.js";

export function registerPolicyCompatibilityRoutes(server: FastifyInstance, options: ReactorCompatibilityRouteOptions): void {
  server.get("/api/tool-policy", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    const stored = await readStoredToolPolicy(options);

    return {
      configEnabled: true,
      dynamicEnabled: true,
      effective: toToolPolicyResponse(stored ?? getStateToolPolicy()),
      stored: stored ? toToolPolicyResponse(stored) : null
    };
  });
  server.put("/api/tool-policy", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    const validationError = validateToolPolicyBody(toBody(request.body));

    if (validationError) {
      return reply.status(400).send(validationErrorResponse(validationError));
    }

    const policy = await saveToolPolicy(options, request.body);
    return toToolPolicyResponse(policy);
  });
  server.delete("/api/tool-policy", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    await clearToolPolicy(options);
    return reply.status(204).send();
  });
}
