import {
  McpRegistryError,
  McpSecurityPolicyProvider,
  type McpManager,
  type McpSecurityPolicyInput,
  type McpSecurityPolicyStore,
  type McpServer,
  type McpServerInput,
  type McpTransportType
} from "@muse/mcp";
import type { FastifyInstance } from "fastify";

export interface McpRouteMcp {
  readonly manager: McpManager;
  readonly securityPolicyProvider?: McpSecurityPolicyProvider;
  readonly securityPolicyStore?: McpSecurityPolicyStore;
}

export interface McpRouteOptions {
  readonly authorizeAdmin: (
    request: unknown,
    reply: { status(statusCode: number): { send(payload: ApiError): void } }
  ) => boolean;
  readonly mcp?: McpRouteMcp;
}

interface ApiError {
  readonly code: string;
  readonly message: string;
}

type ParseResult<T> = { readonly ok: true; readonly value: T } | { readonly error: ApiError; readonly ok: false };
type JsonObject = NonNullable<McpServerInput["config"]>;

export function registerMcpRoutes(server: FastifyInstance, options: McpRouteOptions): void {
  for (const prefix of ["/api/mcp", "/mcp", "/admin/mcp"]) {
    server.get(`${prefix}/servers`, async (request, reply) => {
      if (!options.authorizeAdmin(request, reply)) {
        return reply;
      }

      const mcp = requireMcp(options, reply);

      if (!mcp) {
        return reply;
      }

      return (await mcp.manager.listServers()).map((entry) => toServerSummary(entry, mcp.manager));
    });

    server.post(`${prefix}/servers`, async (request, reply) => {
      if (!options.authorizeAdmin(request, reply)) {
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
          return reply.status(403).send({
            code: "MCP_SERVER_DENIED",
            message: `MCP server is not allowed by policy: ${parsed.value.name}`
          });
        }

        if (saved.autoConnect) {
          await mcp.manager.connect(saved.name);
        }

        return reply.status(201).send(toServerDetail(saved, mcp.manager));
      } catch (error) {
        return sendMcpError(reply, error);
      }
    });

    server.get(`${prefix}/servers/:name`, async (request, reply) => {
      if (!options.authorizeAdmin(request, reply)) {
        return reply;
      }

      const mcp = requireMcp(options, reply);

      if (!mcp) {
        return reply;
      }

      const { name } = request.params as { readonly name: string };
      const entry = await findMcpServer(mcp.manager, name);

      if (!entry) {
        return sendMcpServerNotFound(reply, name);
      }

      return toServerDetail(entry, mcp.manager);
    });

    server.put(`${prefix}/servers/:name`, async (request, reply) => {
      if (!options.authorizeAdmin(request, reply)) {
        return reply;
      }

      return updateMcpServer(request.params, request.body, options, reply);
    });

    server.patch(`${prefix}/servers/:name`, async (request, reply) => {
      if (!options.authorizeAdmin(request, reply)) {
        return reply;
      }

      return updateMcpServer(request.params, request.body, options, reply);
    });

    server.delete(`${prefix}/servers/:name`, async (request, reply) => {
      if (!options.authorizeAdmin(request, reply)) {
        return reply;
      }

      const mcp = requireMcp(options, reply);

      if (!mcp) {
        return reply;
      }

      const { name } = request.params as { readonly name: string };

      if (!(await findMcpServer(mcp.manager, name))) {
        return sendMcpServerNotFound(reply, name);
      }

      await mcp.manager.unregister(name);
      return reply.status(204).send(undefined);
    });

    server.post(`${prefix}/servers/:name/connect`, async (request, reply) => {
      if (!options.authorizeAdmin(request, reply)) {
        return reply;
      }

      return connectMcpServer(request.params, options, reply);
    });

    server.post(`${prefix}/servers/:name/disconnect`, async (request, reply) => {
      if (!options.authorizeAdmin(request, reply)) {
        return reply;
      }

      const mcp = requireMcp(options, reply);

      if (!mcp) {
        return reply;
      }

      const { name } = request.params as { readonly name: string };

      if (!(await findMcpServer(mcp.manager, name))) {
        return sendMcpServerNotFound(reply, name);
      }

      await mcp.manager.disconnect(name);
      return { status: mcp.manager.getStatus(name) ?? "disconnected" };
    });

    server.get(`${prefix}/servers/:name/tools`, async (request, reply) => {
      if (!options.authorizeAdmin(request, reply)) {
        return reply;
      }

      const mcp = requireMcp(options, reply);

      if (!mcp) {
        return reply;
      }

      const { name } = request.params as { readonly name: string };

      if (!(await findMcpServer(mcp.manager, name))) {
        return sendMcpServerNotFound(reply, name);
      }

      return mcp.manager.getToolCatalog(name);
    });

    server.get(`${prefix}/tools`, async (request, reply) => {
      if (!options.authorizeAdmin(request, reply)) {
        return reply;
      }

      const mcp = requireMcp(options, reply);

      if (!mcp) {
        return reply;
      }

      return mcp.manager.getToolCatalog();
    });

    server.post(`${prefix}/servers/:name/tools/:toolName/call`, async (request, reply) => {
      if (!options.authorizeAdmin(request, reply)) {
        return reply;
      }

      return callMcpTool(request.params, request.body, options, reply);
    });

    server.get(`${prefix}/security`, async (request, reply) => {
      if (!options.authorizeAdmin(request, reply)) {
        return reply;
      }

      return getMcpSecurityPolicy(options, reply);
    });

    server.put(`${prefix}/security`, async (request, reply) => {
      if (!options.authorizeAdmin(request, reply)) {
        return reply;
      }

      return updateMcpSecurityPolicy(request.body, options, reply);
    });

    server.delete(`${prefix}/security`, async (request, reply) => {
      if (!options.authorizeAdmin(request, reply)) {
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
  params: unknown,
  body: unknown,
  options: McpRouteOptions,
  reply: { status(statusCode: number): { send(payload: ApiError | undefined): void } }
) {
  const mcp = requireMcp(options, reply);

  if (!mcp) {
    return reply;
  }

  const { name } = params as { readonly name: string };
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
      return reply.status(403).send({
        code: "MCP_SERVER_DENIED",
        message: `MCP server is not allowed by policy: ${name}`
      });
    }

    if (wasConnected || updated.autoConnect) {
      await mcp.manager.disconnect(name);
      await mcp.manager.connect(name);
    }

    return toServerDetail(updated, mcp.manager);
  } catch (error) {
    return sendMcpError(reply, error);
  }
}

async function connectMcpServer(
  params: unknown,
  options: McpRouteOptions,
  reply: { status(statusCode: number): { send(payload: ApiError | unknown): void } }
) {
  const mcp = requireMcp(options, reply);

  if (!mcp) {
    return reply;
  }

  const { name } = params as { readonly name: string };

  if (!(await findMcpServer(mcp.manager, name))) {
    return sendMcpServerNotFound(reply, name);
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
    status,
    tools: mcp.manager.getToolCatalog(name)
  };
}

async function callMcpTool(
  params: unknown,
  body: unknown,
  options: McpRouteOptions,
  reply: { status(statusCode: number): { send(payload: ApiError | unknown): void } }
) {
  const mcp = requireMcp(options, reply);

  if (!mcp) {
    return reply;
  }

  const { name, toolName } = params as { readonly name: string; readonly toolName: string };
  const parsed = parseToolCallBody(body);

  if (!parsed.ok) {
    return reply.status(400).send(parsed.error);
  }

  const tool = mcp.manager.toMuseTools().find((candidate) => candidate.definition.name === `${name}.${toolName}`);

  if (!tool) {
    return reply.status(404).send({
      code: "MCP_TOOL_NOT_FOUND",
      message: `MCP tool not found: ${name}.${toolName}`
    });
  }

  return {
    output: await tool.execute(parsed.value, {
      runId: `mcp_api_${Date.now()}`,
      userId: "admin",
      workspaceId: "admin"
    })
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

  return {
    effective: await provider.currentPolicy(),
    stored: await options.mcp?.securityPolicyStore?.getOrNull()
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

  return options.mcp.securityPolicyStore.save(parsed.value);
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

function toServerSummary(server: McpServer, manager: McpManager) {
  return {
    autoConnect: server.autoConnect,
    createdAt: server.createdAt.toISOString(),
    description: server.description,
    id: server.id,
    name: server.name,
    status: manager.getStatus(server.name) ?? "pending",
    toolCount: manager.getToolCatalog(server.name).length,
    transportType: server.transportType,
    updatedAt: server.updatedAt.toISOString(),
    version: server.version
  };
}

function toServerDetail(server: McpServer, manager: McpManager) {
  return {
    ...toServerSummary(server, manager),
    config: sanitizeConfig(server.config),
    tools: manager.getToolCatalog(server.name)
  };
}

function sendMcpServerNotFound(
  reply: { status(statusCode: number): { send(payload: ApiError): void } },
  name: string
) {
  return reply.status(404).send({
    code: "MCP_SERVER_NOT_FOUND",
    message: `MCP server not found: ${name}`
  });
}

function sendMcpSecurityUnavailable(reply: { status(statusCode: number): { send(payload: ApiError): void } }) {
  return reply.status(404).send({
    code: "MCP_SECURITY_UNAVAILABLE",
    message: "MCP security policy store is not configured"
  });
}

function sendMcpError(
  reply: { status(statusCode: number): { send(payload: ApiError): void } },
  error: unknown
) {
  if (error instanceof McpRegistryError) {
    return reply.status(409).send({
      code: "MCP_REGISTRY_ERROR",
      message: error.message
    });
  }

  return reply.status(500).send({
    code: "MCP_OPERATION_FAILED",
    message: error instanceof Error ? error.message : "MCP operation failed"
  });
}

function parseMcpServerInput(value: unknown, existing?: McpServer): ParseResult<McpServerInput> {
  if (!isRecord(value)) {
    return invalid("INVALID_MCP_SERVER", "Body must be an object");
  }

  const name = existing?.name ?? readString(value, "name");
  const transportType = parseTransportType(readString(value, "transportType", existing?.transportType));

  if (!name || name.trim().length === 0) {
    return invalid("INVALID_MCP_SERVER", "Body must include a non-empty name");
  }

  if (!transportType) {
    return invalid("INVALID_MCP_SERVER", "transportType must be stdio, sse, streamable, or http");
  }

  const config = readJsonObject(value, "config", existing?.config);

  if (config === false) {
    return invalid("INVALID_MCP_SERVER", "config must be a JSON object");
  }

  return {
    ok: true,
    value: {
      autoConnect: readBoolean(value, "autoConnect", existing?.autoConnect ?? true),
      config: config ?? {},
      description: readNullableString(value, "description", existing?.description),
      name,
      transportType,
      version: readNullableString(value, "version", existing?.version)
    }
  };
}

function parseToolCallBody(value: unknown): ParseResult<JsonObject> {
  if (!isRecord(value)) {
    return invalid("INVALID_MCP_TOOL_CALL", "Body must be an object");
  }

  const args = hasOwn(value, "args") ? value.args : value.arguments;

  if (!isJsonObject(args)) {
    return invalid("INVALID_MCP_TOOL_CALL", "Body must include args or arguments as a JSON object");
  }

  return {
    ok: true,
    value: args
  };
}

function parseMcpSecurityPolicyInput(value: unknown): ParseResult<McpSecurityPolicyInput> {
  if (!isRecord(value)) {
    return invalid("INVALID_MCP_SECURITY_POLICY", "Body must be an object");
  }

  const allowedServerNames = readStringArray(value, "allowedServerNames");
  const allowedStdioCommands = readStringArray(value, "allowedStdioCommands");

  if (allowedServerNames === false || allowedStdioCommands === false) {
    return invalid("INVALID_MCP_SECURITY_POLICY", "Allowlist fields must be arrays of strings");
  }

  const maxToolOutputLength = readNumber(value, "maxToolOutputLength");

  return {
    ok: true,
    value: {
      allowedServerNames,
      allowedStdioCommands,
      maxToolOutputLength
    }
  };
}

function resolveMcpSecurityPolicyProvider(mcp: McpRouteMcp | undefined): McpSecurityPolicyProvider | undefined {
  if (mcp?.securityPolicyProvider) {
    return mcp.securityPolicyProvider;
  }

  return mcp?.securityPolicyStore ? new McpSecurityPolicyProvider(mcp.securityPolicyStore) : undefined;
}

function parseTransportType(value: unknown): McpTransportType | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  return normalized === "stdio" || normalized === "sse" || normalized === "streamable" || normalized === "http"
    ? normalized
    : undefined;
}

function sanitizeConfig(config: JsonObject): JsonObject {
  return Object.fromEntries(
    Object.entries(config).map(([key, value]) => [
      key,
      isSensitiveConfigKey(key) ? "[redacted]" : sanitizeConfigValue(value)
    ])
  ) as JsonObject;
}

function sanitizeConfigValue(value: JsonObject[string]): JsonObject[string] {
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeConfigValue(entry)) as JsonObject[string];
  }

  if (isRecord(value)) {
    return sanitizeConfig(value as JsonObject);
  }

  return value;
}

function isSensitiveConfigKey(key: string): boolean {
  return /authorization|password|secret|token|api[_-]?key|credential/iu.test(key);
}

function invalid(code: string, message: string): ParseResult<never> {
  return {
    error: { code, message },
    ok: false
  };
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isJsonObject(value: unknown): value is JsonObject {
  if (!isRecord(value)) {
    return false;
  }

  return Object.values(value).every(isJsonValue);
}

function isJsonValue(value: unknown): boolean {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return true;
  }

  if (typeof value === "number") {
    return Number.isFinite(value);
  }

  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }

  return isRecord(value) && Object.values(value).every(isJsonValue);
}

function readString(value: Record<string, unknown>, key: string, fallback?: string): string | undefined {
  if (!hasOwn(value, key)) {
    return fallback;
  }

  return typeof value[key] === "string" ? value[key] : undefined;
}

function readNullableString(
  value: Record<string, unknown>,
  key: string,
  fallback?: string
): string | null | undefined {
  if (!hasOwn(value, key)) {
    return fallback;
  }

  return value[key] === null || typeof value[key] === "string" ? value[key] : undefined;
}

function readBoolean(value: Record<string, unknown>, key: string, fallback?: boolean): boolean | undefined {
  if (!hasOwn(value, key)) {
    return fallback;
  }

  return typeof value[key] === "boolean" ? value[key] : undefined;
}

function readNumber(value: Record<string, unknown>, key: string): number | undefined {
  if (!hasOwn(value, key)) {
    return undefined;
  }

  return typeof value[key] === "number" && Number.isFinite(value[key]) ? value[key] : undefined;
}

function readJsonObject(
  value: Record<string, unknown>,
  key: string,
  fallback?: JsonObject
): JsonObject | false | undefined {
  if (!hasOwn(value, key)) {
    return fallback;
  }

  return isJsonObject(value[key]) ? value[key] : false;
}

function readStringArray(value: Record<string, unknown>, key: string): readonly string[] | false | undefined {
  if (!hasOwn(value, key)) {
    return undefined;
  }

  return Array.isArray(value[key]) && value[key].every((item) => typeof item === "string")
    ? value[key]
    : false;
}
