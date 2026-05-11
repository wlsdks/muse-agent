/**
 * Muse compat MCP admin proxy helpers extracted from
 * compat-routes.ts. Wraps fetch() with admin-token auth +
 * configurable timeout, and parses MCP access policy bodies.
 */

import type { McpServer } from "@muse/mcp";
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
  const { name } = request.params as { readonly name: string };

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

  const serverConfig = await findMcpCompatServer(options, (request.params as { readonly name: string }).name);

  if (!serverConfig) {
    return mcpProxyUnavailable(request, reply, options);
  }

  if (method === "GET" && path === "/admin/swagger/spec-sources" && !readBodyString(serverConfig.config, "adminToken")) {
    return reply
      .header("X-Mcp-Admin-Available", "false")
      .header("X-Mcp-Admin-Reason", "no-admin-token")
      .send([]);
  }

  return proxyMcpAdminRequest(reply, serverConfig, method, path, body);
}

export function swaggerSourcePath(request: FastifyRequest): string {
  const { sourceName } = request.params as { readonly sourceName: string };
  return `/admin/swagger/spec-sources/${encodeURIComponent(sourceName)}`;
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
  serverConfig: McpServer,
  method: "DELETE" | "GET" | "POST" | "PUT",
  path: string,
  body?: JsonObject
) {
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
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), timeoutMs);

  try {
    const upstream = await fetch(new URL(path, adminUrl), {
      body: body ? JSON.stringify(body) : undefined,
      headers: {
        "content-type": "application/json",
        "x-admin-actor": "muse-admin",
        "x-admin-token": adminToken,
        "x-request-id": createRunId("mcp_admin")
      },
      method,
      signal: abort.signal
    });
    const text = await upstream.text();

    if (upstream.status === 204 || text.length === 0) {
      return reply.status(upstream.status).send();
    }

    return reply.status(upstream.status).send(parseJsonOrText(text));
  } catch (error) {
    return reply.status(error instanceof DOMException && error.name === "AbortError" ? 504 : 502).send({
      error: error instanceof DOMException && error.name === "AbortError"
        ? `MCP admin API timed out after ${timeoutMs}ms`
        : "Failed to call MCP admin API",
      timestamp: nowIso()
    });
  } finally {
    clearTimeout(timeout);
  }
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
