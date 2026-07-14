/**
 * Muse compat MCP server admin routes extracted from
 * compat-routes.ts.
 *
 * Wires:
 *   - GET    /api/mcp/servers/:name/preflight
 *   - GET/PUT/DELETE /api/mcp/servers/:name/access-policy
 *   - POST   /api/mcp/servers/:name/access-policy/emergency-deny-all
 *   - GET    /api/mcp/servers/:name/swagger/sources
 *   - GET/POST/PUT /api/mcp/servers/:name/swagger/sources/:sourceName
 *   - POST   /api/mcp/servers/:name/swagger/sources/:sourceName/sync
 *   - POST   /api/mcp/servers/:name/swagger/sources/:sourceName/publish
 *   - GET    /api/mcp/servers/:name/swagger/sources/:sourceName/revisions
 *   - GET    /api/mcp/servers/:name/swagger/sources/:sourceName/diff
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import {
  errorResponse,
  findMcpCompatServer,
  mcpProxyUnavailable,
  nowIso,
  parseMcpAccessPolicy,
  proxyMcpAdminRequest,
  proxySwaggerSourceRequest,
  readAdminUrl,
  readBodyString,
  readQueryString,
  swaggerSourcePath,
  toBody,
  toJsonObject,
  type CompatibilityRouteOptions
} from "./compat-routes.js";
import { readRouteParam } from "./compat-parsers.js";

async function resolveServer(
  request: FastifyRequest,
  options: CompatibilityRouteOptions
): Promise<Awaited<ReturnType<typeof findMcpCompatServer>> | undefined> {
  const name = readRouteParam(request, "name");
  if (!name) {
    return undefined;
  }
  const serverConfig = await findMcpCompatServer(options, name);
  if (!serverConfig) {
    return undefined;
  }
  return serverConfig;
}

async function requireServer(
  request: FastifyRequest,
  reply: FastifyReply,
  options: CompatibilityRouteOptions
): Promise<Awaited<ReturnType<typeof findMcpCompatServer>> | undefined> {
  const resolved = await resolveServer(request, options);
  const serverConfig = resolved;

  if (!serverConfig) {
    const name = readRouteParam(request, "name");

    if (!name) {
      reply.status(400).send({
        code: 400,
        error: "MCP server name is required"
      });
      return undefined;
    }

    mcpProxyUnavailable(request, reply, options);
    return undefined;
  }

  return serverConfig;
}

export function registerMcpCompatibilityRoutes(server: FastifyInstance, options: CompatibilityRouteOptions): void {
  server.get("/api/mcp/servers/:name/preflight", async (request, reply) => {
    if (!options.requireAuthenticated(request, reply)) {
      return reply;
    }
    const serverConfig = await requireServer(request, reply, options);
    if (!serverConfig) {
      return reply;
    }

    const manager = options.mcp?.manager;
    if (manager && !manager.isExternalTransportAllowed()) {
      // Local-only preflight is a diagnostic, not an action: return the
      // manager-owned blocked report before reading admin URL/token config.
      return manager.preflight(serverConfig.name);
    }

    const adminUrl = readAdminUrl(serverConfig.config);

    if (!adminUrl) {
      return options.mcp?.manager.preflight(serverConfig.name) ?? reply.status(400).send({
        error: `MCP server '${serverConfig.name}' has invalid admin URL`,
        timestamp: nowIso()
      });
    }

    if (!readBodyString(serverConfig.config, "adminToken")) {
      return reply.header("X-Preflight-Skipped", "no-admin-token").status(204).send();
    }

    return proxyMcpAdminRequest(reply, manager, serverConfig, "GET", "/admin/preflight");
  });
  server.get("/api/mcp/servers/:name/access-policy", async (request, reply) => {
    if (!options.requireAuthenticated(request, reply)) {
      return reply;
    }

    const serverConfig = await requireServer(request, reply, options);
    if (!serverConfig) {
      return reply;
    }

    return proxyMcpAdminRequest(reply, options.mcp?.manager, serverConfig, "GET", "/admin/access-policy");
  });
  server.put("/api/mcp/servers/:name/access-policy", async (request, reply) => {
    if (!options.requireAuthenticated(request, reply)) {
      return reply;
    }

    const serverConfig = await requireServer(request, reply, options);
    if (!serverConfig) {
      return reply;
    }

    const parsed = parseMcpAccessPolicy(request.body);

    if (!parsed.ok) {
      return reply.status(400).send(parsed.error);
    }

    return proxyMcpAdminRequest(reply, options.mcp?.manager, serverConfig, "PUT", "/admin/access-policy", parsed.value);
  });
  server.delete("/api/mcp/servers/:name/access-policy", async (request, reply) => {
    if (!options.requireAuthenticated(request, reply)) {
      return reply;
    }

    const serverConfig = await requireServer(request, reply, options);
    if (!serverConfig) {
      return reply;
    }

    return proxyMcpAdminRequest(reply, options.mcp?.manager, serverConfig, "DELETE", "/admin/access-policy");
  });
  server.post("/api/mcp/servers/:name/access-policy/emergency-deny-all", async (request, reply) => {
    if (!options.requireAuthenticated(request, reply)) {
      return reply;
    }

    const serverConfig = await requireServer(request, reply, options);
    if (!serverConfig) {
      return reply;
    }

    return proxyMcpAdminRequest(reply, options.mcp?.manager, serverConfig, "POST", "/admin/access-policy/emergency-deny-all");
  });
  server.get("/api/mcp/servers/:name/swagger/sources", async (request, reply) =>
    proxySwaggerSourceRequest(request, reply, options, "GET", "/admin/swagger/spec-sources")
  );
  server.get("/api/mcp/servers/:name/swagger/sources/:sourceName", async (request, reply) =>
    proxySwaggerSourceRequest(request, reply, options, "GET", swaggerSourcePath(request))
  );
  server.post("/api/mcp/servers/:name/swagger/sources", async (request, reply) => {
    const body = toBody(request.body);

    if (!readBodyString(body, "name") || !readBodyString(body, "url")) {
      return reply.status(400).send(errorResponse("Body must include name and url"));
    }

    return proxySwaggerSourceRequest(request, reply, options, "POST", "/admin/swagger/spec-sources", toJsonObject(body));
  });
  server.put("/api/mcp/servers/:name/swagger/sources/:sourceName", async (request, reply) =>
    proxySwaggerSourceRequest(request, reply, options, "PUT", swaggerSourcePath(request), toJsonObject(request.body))
  );
  server.post("/api/mcp/servers/:name/swagger/sources/:sourceName/sync", async (request, reply) =>
    proxySwaggerSourceRequest(request, reply, options, "POST", `${swaggerSourcePath(request)}/sync`, {})
  );
  server.post("/api/mcp/servers/:name/swagger/sources/:sourceName/publish", async (request, reply) => {
    const body = toBody(request.body);

    if (!readBodyString(body, "revisionId")) {
      return reply.status(400).send(errorResponse("Body must include revisionId"));
    }

    return proxySwaggerSourceRequest(request, reply, options, "POST", `${swaggerSourcePath(request)}/publish`, toJsonObject(body));
  });
  server.get("/api/mcp/servers/:name/swagger/sources/:sourceName/revisions", async (request, reply) => {
    const limit = readQueryString(request, "limit");
    const suffix = limit ? `?limit=${encodeURIComponent(limit)}` : "";
    return proxySwaggerSourceRequest(request, reply, options, "GET", `${swaggerSourcePath(request)}/revisions${suffix}`);
  });
  server.get("/api/mcp/servers/:name/swagger/sources/:sourceName/diff", async (request, reply) => {
    const params = new URLSearchParams();
    const from = readQueryString(request, "from");
    const to = readQueryString(request, "to");

    if (from) params.set("from", from);
    if (to) params.set("to", to);

    const suffix = params.size > 0 ? `?${params.toString()}` : "";
    return proxySwaggerSourceRequest(request, reply, options, "GET", `${swaggerSourcePath(request)}/diff${suffix}`);
  });
}
