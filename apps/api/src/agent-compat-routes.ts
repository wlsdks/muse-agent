/**
 * Muse compat agent-spec + agent-card + admin-models routes
 * extracted from compat-routes.ts.
 *
 * Wires:
 *   - GET /.well-known/agent-card.json (the A2A discovery surface)
 *   - GET/POST/PUT/DELETE /api/admin/agent-specs (+ /:id, /:id/system-prompt)
 *   - GET /api/admin/models (model-registry catalog)
 */

import type { FastifyInstance } from "fastify";
import {
  agentCardResponse,
  agentSpecInputError,
  agentSpecNotFound,
  errorResponse,
  findAgentSpec,
  findAgentSpecOrReply,
  isRecord,
  parseAgentMode,
  parseAgentSpecInput,
  readQueryBoolean,
  toAgentSpecResponse,
  toAgentSpecUpdateInput,
  type CompatibilityRouteOptions
} from "./compat-routes.js";
import { readRouteParam } from "./compat-parsers.js";

export function registerAgentCompatibilityRoutes(server: FastifyInstance, options: CompatibilityRouteOptions): void {
  server.get("/.well-known/agent-card.json", async () => agentCardResponse(options));

  server.get("/api/admin/agent-specs", async (request, reply) => {
    if (!options.requireAuthenticated(request, reply)) {
      return reply;
    }

    const enabled = readQueryBoolean(request, "enabled", false);
    const specs = enabled
      ? await options.agentSpecRegistry.listEnabled()
      : await options.agentSpecRegistry.list();
    return specs.map(toAgentSpecResponse);
  });

  server.get("/api/admin/agent-specs/:id", async (request, reply) => {
    if (!options.requireAuthenticated(request, reply)) {
      return reply;
    }

    const id = readRouteParam(request, "id");

    if (!id) {
      return reply.status(400).send(errorResponse("id is required"));
    }

    const spec = await findAgentSpec(options.agentSpecRegistry, id);

    if (!spec) {
      return reply.status(404).send(agentSpecNotFound(id));
    }

    return toAgentSpecResponse(spec);
  });

  server.get("/api/admin/agent-specs/:id/system-prompt", async (request, reply) => {
    const spec = await findAgentSpecOrReply(request, reply, options);
    return spec ?? reply;
  });

  server.post("/api/admin/agent-specs", async (request, reply) => {
    if (!options.requireAuthenticated(request, reply)) {
      return reply;
    }

    const parsed = parseAgentSpecInput(request.body);

    if (!parsed.ok) {
      return reply.status(400).send(agentSpecInputError(parsed.error));
    }

    if (await options.agentSpecRegistry.getByName(parsed.value.name)) {
      return reply.status(409).send(errorResponse(`이름 '${parsed.value.name}'은 이미 사용 중입니다`));
    }

    return reply.status(201).send(toAgentSpecResponse(await options.agentSpecRegistry.save(parsed.value)));
  });

  server.put("/api/admin/agent-specs/:id", async (request, reply) => {
    if (!options.requireAuthenticated(request, reply)) {
      return reply;
    }

    const id = readRouteParam(request, "id");

    if (!id) {
      return reply.status(400).send(errorResponse("id is required"));
    }

    const mode = isRecord(request.body) ? parseAgentMode(request.body.mode) : undefined;

    if (!isRecord(request.body)) {
      return reply.status(400).send(errorResponse("요청 형식이 올바르지 않습니다"));
    }

    if (request.body.mode !== undefined && !mode) {
      return reply.status(400).send(errorResponse(`유효하지 않은 모드: ${String(request.body.mode)}`));
    }

    const existing = await options.agentSpecRegistry.getById(id);

    if (!existing) {
      return reply.status(404).send(agentSpecNotFound(id));
    }

    return toAgentSpecResponse(await options.agentSpecRegistry.save(toAgentSpecUpdateInput(request.body, existing)));
  });

  server.delete("/api/admin/agent-specs/:id", async (request, reply) => {
    if (!options.requireAuthenticated(request, reply)) {
      return reply;
    }

    const id = readRouteParam(request, "id");

    if (!id) {
      return reply.status(400).send(errorResponse("id is required"));
    }

    const spec = await findAgentSpec(options.agentSpecRegistry, id);

    if (!spec) {
      return reply.status(404).send(agentSpecNotFound(id));
    }

    await options.agentSpecRegistry.deleteById(spec.id);
    return reply.status(204).send();
  });
}
