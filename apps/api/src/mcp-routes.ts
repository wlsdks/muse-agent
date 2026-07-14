import { MCP_EXTERNAL_TRANSPORT_BLOCKED, McpSecurityPolicyProvider, type McpManager, type McpSecurityPolicyStore, type McpServer } from "@muse/mcp";
import { ToolOutputSanitizer } from "@muse/policy";
import type { FastifyInstance, FastifyRequest } from "fastify";

import {
  parseMcpSecurityPolicyInput,
  parseMcpServerInput,
  parseToolCallBody,
  type ApiError
} from "./mcp-routes-parsers.js";
import {
  sendMcpError,
  sendMcpSecurityUnavailable,
  sendMcpServerNotFound,
  stringifyToolOutput,
  toCompatEnum,
  toMcpSecurityPolicyResponse,
  toServerDetail,
  toServerSummary
} from "./mcp-routes-shapers.js";

export interface McpRouteMcp {
  readonly manager: McpManager;
  readonly securityPolicyProvider?: McpSecurityPolicyProvider;
  readonly securityPolicyStore?: McpSecurityPolicyStore;
}

export interface McpRouteOptions {
  readonly requireAuthenticated: (
    request: unknown,
    reply: { status(statusCode: number): { send(payload: ApiError): void } }
  ) => boolean;
  readonly mcp?: McpRouteMcp;
}

type McpRoutePathParams = { name: string };
type McpToolRoutePathParams = { name: string; toolName: string };

export function registerMcpRoutes(server: FastifyInstance, options: McpRouteOptions): void {
  for (const prefix of ["/api/mcp", "/mcp", "/admin/mcp"]) {
    server.get(`${prefix}/servers`, async (request, reply) => {
      if (!options.requireAuthenticated(request, reply)) {
        return reply;
      }

      const mcp = requireMcp(options, reply);

      if (!mcp) {
        return reply;
      }

      return (await mcp.manager.listServers()).map((entry) => toServerSummary(entry, mcp.manager));
    });

    server.post(`${prefix}/servers`, async (request, reply) => {
      if (!options.requireAuthenticated(request, reply)) {
        return reply;
      }

      const mcp = requireMcp(options, reply);

      if (!mcp) {
        return reply;
      }

      const parsed = parseMcpServerInput(request.body);

      if (!parsed.ok) {
        return reply.status(400).send(parsed.error);
      }

      try {
        const saved = await mcp.manager.register(parsed.value);

        if (!saved) {
          return reply.status(403).send(mcpMutationDenied(mcp.manager, parsed.value.name));
        }

        if (saved.autoConnect) {
          await mcp.manager.connect(saved.name);
        }

        return reply.status(201).send(toServerSummary(saved, mcp.manager));
      } catch (error) {
        return sendMcpError(reply, error);
      }
    });

    server.get(`${prefix}/servers/:name`, async (request: FastifyRequest<{ Params: McpRoutePathParams }>, reply) => {
      if (!options.requireAuthenticated(request, reply)) {
        return reply;
      }

      const mcp = requireMcp(options, reply);

      if (!mcp) {
        return reply;
      }

      const { name } = request.params;
      const entry = await findMcpServer(mcp.manager, name);

      if (!entry) {
        return sendMcpServerNotFound(reply, name);
      }

      return toServerDetail(entry, mcp.manager);
    });

    server.put(`${prefix}/servers/:name`, async (request: FastifyRequest<{ Params: McpRoutePathParams }>, reply) => {
      if (!options.requireAuthenticated(request, reply)) {
        return reply;
      }

      return updateMcpServer(request.params.name, request.body, options, reply);
    });

    server.patch(`${prefix}/servers/:name`, async (request: FastifyRequest<{ Params: McpRoutePathParams }>, reply) => {
      if (!options.requireAuthenticated(request, reply)) {
        return reply;
      }

      return updateMcpServer(request.params.name, request.body, options, reply);
    });

    server.delete(`${prefix}/servers/:name`, async (request: FastifyRequest<{ Params: McpRoutePathParams }>, reply) => {
      if (!options.requireAuthenticated(request, reply)) {
        return reply;
      }

      const mcp = requireMcp(options, reply);

      if (!mcp) {
        return reply;
      }

      const { name } = request.params;

      if (!(await findMcpServer(mcp.manager, name))) {
        return sendMcpServerNotFound(reply, name);
      }

      await mcp.manager.unregister(name);
      return reply.status(204).send(undefined);
    });

    server.post(`${prefix}/servers/:name/connect`, async (request: FastifyRequest<{ Params: McpRoutePathParams }>, reply) => {
      if (!options.requireAuthenticated(request, reply)) {
        return reply;
      }

      return connectMcpServer(request.params.name, options, reply);
    });

    server.post(`${prefix}/servers/:name/disconnect`, async (request: FastifyRequest<{ Params: McpRoutePathParams }>, reply) => {
      if (!options.requireAuthenticated(request, reply)) {
        return reply;
      }

      const mcp = requireMcp(options, reply);

      if (!mcp) {
        return reply;
      }

      const { name } = request.params;

      if (!(await findMcpServer(mcp.manager, name))) {
        return sendMcpServerNotFound(reply, name);
      }

      await mcp.manager.disconnect(name);
      return { status: toCompatEnum(mcp.manager.getStatus(name) ?? "disconnected") };
    });

    server.get(`${prefix}/servers/:name/health`, async (request: FastifyRequest<{ Params: McpRoutePathParams }>, reply) => {
      if (!options.requireAuthenticated(request, reply)) {
        return reply;
      }

      return checkMcpServerHealth(request.params.name, options, reply);
    });

    server.post(`${prefix}/servers/:name/reconnect`, async (request: FastifyRequest<{ Params: McpRoutePathParams }>, reply) => {
      if (!options.requireAuthenticated(request, reply)) {
        return reply;
      }

      return reconnectMcpServer(request.params.name, options, reply);
    });

    server.post(`${prefix}/reconnect-due`, async (request, reply) => {
      if (!options.requireAuthenticated(request, reply)) {
        return reply;
      }

      const mcp = requireMcp(options, reply);

      if (!mcp) {
        return reply;
      }

      if (!mcp.manager.isExternalTransportAllowed()) {
        return reply.status(403).send(externalMcpTransportBlocked());
      }

      return mcp.manager.reconnectDue();
    });

    server.get(`${prefix}/servers/:name/tools`, async (request: FastifyRequest<{ Params: McpRoutePathParams }>, reply) => {
      if (!options.requireAuthenticated(request, reply)) {
        return reply;
      }

      const mcp = requireMcp(options, reply);

      if (!mcp) {
        return reply;
      }

      if (!(await findMcpServer(mcp.manager, request.params.name))) {
        return sendMcpServerNotFound(reply, request.params.name);
      }

      return mcp.manager.getToolCatalog(request.params.name);
    });

    server.get(`${prefix}/tools`, async (request, reply) => {
      if (!options.requireAuthenticated(request, reply)) {
        return reply;
      }

      const mcp = requireMcp(options, reply);

      if (!mcp) {
        return reply;
      }

      return mcp.manager.getToolCatalog();
    });

    server.post(
      `${prefix}/servers/:name/tools/:toolName/call`,
      async (request: FastifyRequest<{ Params: McpToolRoutePathParams }>, reply) => {
      if (!options.requireAuthenticated(request, reply)) {
        return reply;
      }

      return callMcpTool(request.params, request.body, options, reply);
    });

    server.get(`${prefix}/security`, async (request, reply) => {
      if (!options.requireAuthenticated(request, reply)) {
        return reply;
      }

      return getMcpSecurityPolicy(options, reply);
    });

    server.put(`${prefix}/security`, async (request, reply) => {
      if (!options.requireAuthenticated(request, reply)) {
        return reply;
      }

      return updateMcpSecurityPolicy(request.body, options, reply);
    });

    server.delete(`${prefix}/security`, async (request, reply) => {
      if (!options.requireAuthenticated(request, reply)) {
        return reply;
      }

      if (!options.mcp?.securityPolicyStore) {
        return sendMcpSecurityUnavailable(reply);
      }

      await options.mcp.securityPolicyStore.delete();
      return reply.status(204).send(undefined);
    });
  }
}

async function updateMcpServer(
  name: string,
  body: unknown,
  options: McpRouteOptions,
  reply: { status(statusCode: number): { send(payload: ApiError | undefined): void } }
) {
  const mcp = requireMcp(options, reply);

  if (!mcp) {
    return reply;
  }

  const existing = await findMcpServer(mcp.manager, name);

  if (!existing) {
    return sendMcpServerNotFound(reply, name);
  }

  const parsed = parseMcpServerInput(body, existing);

  if (!parsed.ok) {
    return reply.status(400).send(parsed.error);
  }

  const wasConnected = mcp.manager.getStatus(name) === "connected";

  try {
    const updated = await mcp.manager.syncRuntimeServer(parsed.value);

    if (!updated) {
      return reply.status(403).send(mcpMutationDenied(mcp.manager, name));
    }

    if (wasConnected || updated.autoConnect) {
      await mcp.manager.disconnect(name);
      await mcp.manager.connect(name);
    }

    return toServerSummary(updated, mcp.manager);
  } catch (error) {
    return sendMcpError(reply, error);
  }
}

async function connectMcpServer(
  name: string,
  options: McpRouteOptions,
  reply: { status(statusCode: number): { send(payload: ApiError | unknown): void } }
) {
  const mcp = requireMcp(options, reply);

  if (!mcp) {
    return reply;
  }

  if (!(await findMcpServer(mcp.manager, name))) {
    return sendMcpServerNotFound(reply, name);
  }

  if (!mcp.manager.isExternalTransportAllowed()) {
    return reply.status(403).send(externalMcpTransportBlocked());
  }

  const connected = await mcp.manager.connect(name);
  const status = mcp.manager.getStatus(name) ?? "failed";

  if (!connected) {
    return reply.status(503).send({
      code: "MCP_CONNECT_FAILED",
      message: `Failed to connect to MCP server: ${name}`
    });
  }

  return {
    status: toCompatEnum(status),
    tools: mcp.manager.getToolCatalog(name).map((tool) => tool.name)
  };
}

async function checkMcpServerHealth(
  name: string,
  options: McpRouteOptions,
  reply: { status(statusCode: number): { send(payload: ApiError | unknown): void } }
) {
  const mcp = requireMcp(options, reply);

  if (!mcp) {
    return reply;
  }

  if (!(await findMcpServer(mcp.manager, name))) {
    return sendMcpServerNotFound(reply, name);
  }

  return mcp.manager.healthCheck(name);
}

async function reconnectMcpServer(
  name: string,
  options: McpRouteOptions,
  reply: { status(statusCode: number): { send(payload: ApiError | unknown): void } }
) {
  const mcp = requireMcp(options, reply);

  if (!mcp) {
    return reply;
  }

  if (!(await findMcpServer(mcp.manager, name))) {
    return sendMcpServerNotFound(reply, name);
  }

  if (!mcp.manager.isExternalTransportAllowed()) {
    return reply.status(403).send(externalMcpTransportBlocked());
  }

  const connected = await mcp.manager.reconnect(name);

  if (!connected) {
    return reply.status(503).send({
      code: "MCP_RECONNECT_FAILED",
      message: `Failed to reconnect MCP server: ${name}`
    });
  }

  return {
    health: mcp.manager.getHealth(name),
    status: toCompatEnum(mcp.manager.getStatus(name) ?? "failed"),
    tools: mcp.manager.getToolCatalog(name)
  };
}

async function callMcpTool(
  params: McpToolRoutePathParams,
  body: unknown,
  options: McpRouteOptions,
  reply: { status(statusCode: number): { send(payload: ApiError | unknown): void } }
) {
  const mcp = requireMcp(options, reply);

  if (!mcp) {
    return reply;
  }

  const { name, toolName } = params;
  const parsed = parseToolCallBody(body);

  if (!parsed.ok) {
    return reply.status(400).send(parsed.error);
  }

  if (!mcp.manager.isExternalTransportAllowed()) {
    return reply.status(403).send(externalMcpTransportBlocked());
  }

  const tool = mcp.manager.toMuseTools().find((candidate) => candidate.definition.name === `${name}.${toolName}`);

  if (!tool) {
    return reply.status(404).send({
      code: "MCP_TOOL_NOT_FOUND",
      message: `MCP tool not found: ${name}.${toolName}`
    });
  }

  const policy = await resolveMcpSecurityPolicyProvider(options.mcp)?.currentPolicy();
  const sanitizer = new ToolOutputSanitizer({ maxOutputLength: policy?.maxToolOutputLength });
  const rawOutput = await tool.execute(parsed.value, {
    runId: `mcp_api_${Date.now()}`,
    userId: "owner"
  });
  const sanitized = sanitizer.sanitize(tool.definition.name, stringifyToolOutput(rawOutput));

  return {
    output: sanitized.content,
    sanitized
  };
}

async function getMcpSecurityPolicy(
  options: McpRouteOptions,
  reply: { status(statusCode: number): { send(payload: ApiError): void } }
) {
  const provider = resolveMcpSecurityPolicyProvider(options.mcp);

  if (!provider) {
    return sendMcpSecurityUnavailable(reply);
  }

  const effective = await provider.currentPolicy();
  const stored = await options.mcp?.securityPolicyStore?.getOrNull();

  return {
    configDefault: toMcpSecurityPolicyResponse(provider.configDefaultPolicy()),
    effective: toMcpSecurityPolicyResponse(effective),
    stored: stored ? toMcpSecurityPolicyResponse(stored) : null
  };
}

async function updateMcpSecurityPolicy(
  body: unknown,
  options: McpRouteOptions,
  reply: { status(statusCode: number): { send(payload: ApiError): void } }
) {
  if (!options.mcp?.securityPolicyStore) {
    return sendMcpSecurityUnavailable(reply);
  }

  const parsed = parseMcpSecurityPolicyInput(body);

  if (!parsed.ok) {
    return reply.status(400).send(parsed.error);
  }

  return toMcpSecurityPolicyResponse(await options.mcp.securityPolicyStore.save(parsed.value));
}

function requireMcp(
  options: McpRouteOptions,
  reply: { status(statusCode: number): { send(payload: ApiError): void } }
): McpRouteMcp | undefined {
  if (options.mcp) {
    return options.mcp;
  }

  reply.status(404).send({
    code: "MCP_UNAVAILABLE",
    message: "MCP manager is not configured"
  });
  return undefined;
}

async function findMcpServer(manager: McpManager, name: string): Promise<McpServer | undefined> {
  return (await manager.listServers()).find((entry) => entry.name === name);
}

function resolveMcpSecurityPolicyProvider(mcp: McpRouteMcp | undefined): McpSecurityPolicyProvider | undefined {
  if (mcp?.securityPolicyProvider) {
    return mcp.securityPolicyProvider;
  }

  return mcp?.securityPolicyStore ? new McpSecurityPolicyProvider(mcp.securityPolicyStore) : undefined;
}

function mcpMutationDenied(manager: McpManager, name: string): ApiError {
  return manager.isExternalTransportAllowed()
    ? {
        code: "MCP_SERVER_DENIED",
        message: `MCP server is not allowed by policy: ${name}`
      }
    : externalMcpTransportBlocked();
}

function externalMcpTransportBlocked(): ApiError {
  return {
    code: MCP_EXTERNAL_TRANSPORT_BLOCKED,
    message: "External MCP transport is disabled by the local-only privacy posture"
  };
}
