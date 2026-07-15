/**
 * Response shapers + sanitizers extracted from `mcp-routes.ts`.
 *
 * Pure formatting — no Fastify-import dependency, no parsing logic.
 * Each function takes a domain object (`McpServer`, `McpManager`,
 * `McpSecurityPolicy`, raw config / tool output) and produces the
 * JSON-serialisable response shape (or stringified output) that
 * the route handlers return.
 *
 * The sanitization cluster (`sanitizeConfig` /
 * `sanitizeConfigValue` / `isSensitiveConfigKey`) redacts
 * authorization / password / token / api-key / credential fields
 * before any config payload leaves the server.
 */

import { McpRegistryError, type McpManager, type McpSecurityPolicy, type McpServer } from "@muse/mcp";

import { isRecord, type ApiError, type JsonObject } from "./mcp-routes-parsers.js";

type ReplyLike = { status(statusCode: number): { send(payload: ApiError): void } };

export function toServerSummary(server: McpServer, manager: McpManager) {
  return {
    autoConnect: server.autoConnect,
    createdAt: server.createdAt.getTime(),
    description: server.description ?? null,
    id: server.id,
    name: server.name,
    status: toCompatEnum(manager.getStatus(server.name) ?? "pending"),
    toolCount: manager.getToolCatalog(server.name).length,
    transportType: toCompatEnum(server.transportType),
    updatedAt: server.updatedAt.getTime()
  };
}

export function toServerDetail(server: McpServer, manager: McpManager) {
  return {
    autoConnect: server.autoConnect,
    config: sanitizeConfig(server.config),
    createdAt: server.createdAt.getTime(),
    description: server.description ?? null,
    id: server.id,
    name: server.name,
    status: toCompatEnum(manager.getStatus(server.name) ?? "pending"),
    tools: manager.getToolCatalog(server.name).map((tool) => tool.name),
    transportType: toCompatEnum(server.transportType),
    updatedAt: server.updatedAt.getTime(),
    version: server.version ?? null
  };
}

export function sendMcpServerNotFound(reply: ReplyLike, name: string) {
  return reply.status(404).send({
    code: "MCP_SERVER_NOT_FOUND",
    message: `MCP server not found: ${name}`
  });
}

export function sendMcpSecurityUnavailable(reply: ReplyLike) {
  return reply.status(404).send({
    code: "MCP_SECURITY_UNAVAILABLE",
    message: "MCP security policy store is not configured"
  });
}

export function sendMcpError(reply: ReplyLike, error: unknown) {
  if (error instanceof McpRegistryError) {
    return reply.status(409).send({
      code: "MCP_REGISTRY_ERROR",
      message: error.message
    });
  }

  // Unexpected (non-McpRegistryError) failure: a raw error
  // message can leak internals to the network client, so return
  // a generic message. The typed 409 branch above keeps its
  // curated, client-safe message.
  return reply.status(500).send({
    code: "MCP_OPERATION_FAILED",
    message: "MCP operation failed"
  });
}

export function toCompatEnum(value: string): string {
  return value.toUpperCase();
}

export function toMcpSecurityPolicyResponse(policy: McpSecurityPolicy) {
  return {
    allowedServerNames: [...policy.allowedServerNames],
    allowedStdioCommands: [...policy.allowedStdioCommands],
    createdAt: policy.createdAt.getTime(),
    maxToolOutputLength: policy.maxToolOutputLength,
    updatedAt: policy.updatedAt.getTime()
  };
}

export function sanitizeConfig(config: JsonObject): JsonObject {
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

export function stringifyToolOutput(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  return JSON.stringify(value);
}

export function isSensitiveConfigKey(key: string): boolean {
  return /authorization|password|secret|token|api[_-]?key|credential/iu.test(key);
}
