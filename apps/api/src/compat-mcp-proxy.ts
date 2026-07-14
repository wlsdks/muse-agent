/**
 * Muse compat MCP admin proxy helpers extracted from
 * compat-routes.ts. Wraps fetch() with admin-token auth +
 * configurable timeout, and parses MCP access policy bodies.
 */

import { MCP_EXTERNAL_TRANSPORT_BLOCKED, type McpManager, type McpServer } from "@muse/mcp";
import { createRunId, type JsonObject } from "@muse/shared";
import type { FastifyReply, FastifyRequest } from "fastify";
import {
  invalid,
  nowIso,
  readBodyString,
  coerceNumber,
  coerceStringSet,
  toBody,
  type ParseResult,
  type CompatibilityRouteOptions
} from "./compat-routes.js";
import { readRouteParam } from "./compat-parsers.js";

export async function findMcpCompatServer(
  options: CompatibilityRouteOptions,
  name: string
): Promise<McpServer | undefined> {
  return (await options.mcp?.manager.listServers())?.find((server) => server.name === name);
}

export function mcpProxyUnavailable(
  request: FastifyRequest,
  reply: FastifyReply,
  options: CompatibilityRouteOptions
) {
  const name = readRouteParam(request, "name");
  if (!name) {
    return reply.status(400).send({
      error: "MCP server name is required",
      timestamp: nowIso()
    });
  }

  if (!options.mcp) {
    return reply.status(503).send({
      error: "MCP manager is not configured",
      timestamp: nowIso()
    });
  }

  return reply.status(404).send({
    error: `MCP server '${name}' not found`,
    timestamp: nowIso()
  });
}

export async function proxySwaggerSourceRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  options: CompatibilityRouteOptions,
  method: "GET" | "POST" | "PUT",
  path: string,
  body?: JsonObject
) {
  if (!options.requireAuthenticated(request, reply)) {
    return reply;
  }

  const name = readRouteParam(request, "name");
  if (!name) {
    return reply.status(400).send({
      error: "MCP server name is required",
      timestamp: nowIso()
    });
  }
  const serverConfig = await findMcpCompatServer(options, name);

  if (!serverConfig) {
    return mcpProxyUnavailable(request, reply, options);
  }

  if (!options.mcp?.manager.isExternalTransportAllowed()) {
    return mcpExternalTransportBlocked(reply);
  }

  if (method === "GET" && path === "/admin/swagger/spec-sources" && !readBodyString(serverConfig.config, "adminToken")) {
    return reply
      .header("X-Mcp-Admin-Available", "false")
      .header("X-Mcp-Admin-Reason", "no-admin-token")
      .send([]);
  }

  return proxyMcpAdminRequest(reply, options.mcp?.manager, serverConfig, method, path, body);
}

export function swaggerSourcePath(request: FastifyRequest): string {
  const sourceName = readRouteParam(request, "sourceName");
  return `/admin/swagger/spec-sources/${encodeURIComponent(sourceName ?? "")}`;
}

export function readAdminUrl(config: JsonObject): string | null {
  const adminUrl = readBodyString(config, "adminUrl");

  if (adminUrl && isHttpUrl(adminUrl)) {
    return adminUrl;
  }

  const url = readBodyString(config, "url");

  if (url && isHttpUrl(url)) {
    return url.replace(/\/sse\/?$/u, "");
  }

  return null;
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export async function proxyMcpAdminRequest(
  reply: FastifyReply,
  manager: McpManager | undefined,
  serverConfig: McpServer,
  method: "DELETE" | "GET" | "POST" | "PUT",
  path: string,
  body?: JsonObject
) {
  if (!manager?.isExternalTransportAllowed()) {
    return mcpExternalTransportBlocked(reply);
  }

  const adminUrl = readAdminUrl(serverConfig.config);

  if (!adminUrl) {
    return reply.status(400).send({
      error: `MCP server '${serverConfig.name}' has invalid admin URL`,
      timestamp: nowIso()
    });
  }

  const adminToken = readBodyString(serverConfig.config, "adminToken");

  if (!adminToken) {
    return reply.status(400).send({
      error: `MCP server '${serverConfig.name}' has no admin token. Set config.adminToken`,
      timestamp: nowIso()
    });
  }

  const timeoutMs = coerceNumber(serverConfig.config.adminTimeoutMs, 15_000);
  const timeoutSignal = Number.isFinite(timeoutMs) && timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined;
  const requestInit: RequestInit = {
    body: body ? JSON.stringify(body) : undefined,
    headers: {
      "content-type": "application/json",
      "x-admin-actor": "muse-admin",
      "x-admin-token": adminToken,
      "x-request-id": createRunId("mcp_admin")
    },
    method
  };
  if (timeoutSignal !== undefined) {
    requestInit.signal = timeoutSignal;
  }

  try {
    const upstream = await fetch(new URL(path, adminUrl), requestInit);
    const text = await upstream.text();

    if (upstream.status === 204 || text.length === 0) {
      return reply.status(upstream.status).send();
    }

    return reply.status(upstream.status).send(parseJsonOrText(text));
  } catch (error) {
    const isTimeout = isTimeoutError(error);
    return reply.status(isTimeout ? 504 : 502).send({
      error: isTimeout ? `MCP admin API timed out after ${timeoutMs}ms` : "Failed to call MCP admin API",
      timestamp: nowIso()
    });
  }
}

function isTimeoutError(cause: unknown): cause is Error {
  return cause instanceof DOMException
    ? cause.name === "AbortError" || cause.name === "TimeoutError"
    : cause instanceof Error && cause.name === "TimeoutError";
}

export function mcpExternalTransportBlocked(reply: FastifyReply) {
  return reply.status(403).send({
    code: MCP_EXTERNAL_TRANSPORT_BLOCKED,
    error: "External MCP transport is disabled by the local-only privacy posture",
    timestamp: nowIso()
  });
}

function parseJsonOrText(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function parseMcpAccessPolicy(value: unknown): ParseResult<JsonObject> {
  const body = toBody(value);
  const parsed: JsonObject = {
    allowedBitbucketRepositories: coerceStringSet(body.allowedBitbucketRepositories),
    allowedConfluenceSpaceKeys: coerceStringSet(body.allowedConfluenceSpaceKeys),
    allowedJiraProjectKeys: coerceStringSet(body.allowedJiraProjectKeys),
    allowedSourceNames: coerceStringSet(body.allowedSourceNames),
    allowDirectUrlLoads: nullableBoolean(body.allowDirectUrlLoads),
    allowPreviewReads: nullableBoolean(body.allowPreviewReads),
    allowPreviewWrites: nullableBoolean(body.allowPreviewWrites),
    publishedOnly: nullableBoolean(body.publishedOnly)
  };

  for (const [key, list] of Object.entries(parsed)) {
    if (Array.isArray(list) && list.length > 300) {
      return invalid("INVALID_MCP_ACCESS_POLICY", `${key} must not exceed 300 entries`);
    }
  }

  return { ok: true, value: parsed };
}

function nullableBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}
