/**
 * HTTP-plumbing helpers extracted from `server-helpers.ts`.
 *
 * Covers the cross-cutting bits Fastify hooks reach for: CORS,
 * security/compat-version response headers, the
 * Spring-style→OpenAPI path template translator, the public-route
 * allowlist, and the OpenAPI document generator. Everything in this
 * module is request-shaped (header reads/writes, URL string ops) —
 * no domain logic, no model invocation, no auth identity.
 *
 * Re-exported from `server-helpers.ts` so the existing import sites
 * across the API package keep working without import-site edits.
 */

import { randomUUID } from "node:crypto";

import type { JsonObject } from "@muse/shared";

import type { CorsOptions } from "./server.js";

export function toSpringPathTemplate(path: string): string {
  return path.replace(/:([A-Za-z0-9_]+)/gu, "{$1}");
}

export function applyCompatWebContractHeaders(
  path: string,
  requestIdHeader: string | string[] | undefined,
  reply: {
    header(name: string, value: string): unknown;
  }
): void {
  reply.header("X-Request-ID", headerValue(requestIdHeader)?.trim() || randomUUID());
  reply.header("X-Content-Type-Options", "nosniff");
  reply.header("X-Frame-Options", "DENY");
  reply.header("Content-Security-Policy", isSwaggerPath(path)
    ? "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'"
    : "default-src 'self'");
  reply.header("X-XSS-Protection", "0");
  reply.header("Referrer-Policy", "strict-origin-when-cross-origin");
  reply.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains; preload");
  reply.header("Permissions-Policy", "geolocation=(), camera=(), microphone=(), payment=()");
  reply.header("X-Muse-Api-Version", currentCompatApiVersion());
  reply.header("X-Muse-Api-Supported-Versions", supportedCompatApiVersions().join(","));

  if (isSensitivePath(path)) {
    reply.header("Cache-Control", "no-store");
  }
}

export function applyCorsHeaders(
  options: CorsOptions | undefined,
  originHeader: string | string[] | undefined,
  reply: {
    header(name: string, value: string): unknown;
  }
): void {
  if (!options) {
    return;
  }

  const origin = headerValue(originHeader)?.trim();
  const allowedOrigin = allowedCorsOrigin(origin, options.allowedOrigins ?? defaultCorsOrigins());

  if (!allowedOrigin) {
    return;
  }

  reply.header("Access-Control-Allow-Origin", allowedOrigin);
  reply.header("Vary", "Origin");
  reply.header("Access-Control-Allow-Methods", (options.allowedMethods ?? defaultCorsMethods()).join(","));
  reply.header("Access-Control-Allow-Headers", (options.allowedHeaders ?? defaultCorsHeaders()).join(","));

  if (options.allowCredentials) {
    reply.header("Access-Control-Allow-Credentials", "true");
  }

  if (options.maxAgeSeconds !== undefined) {
    reply.header("Access-Control-Max-Age", String(Math.max(0, Math.trunc(options.maxAgeSeconds))));
  }
}

function allowedCorsOrigin(origin: string | undefined, allowedOrigins: readonly string[]): string | undefined {
  if (!origin) {
    return undefined;
  }

  return allowedOrigins.includes("*") || allowedOrigins.includes(origin) ? origin : undefined;
}

function defaultCorsOrigins(): readonly string[] {
  return ["http://127.0.0.1:5173", "http://localhost:5173"];
}

function defaultCorsMethods(): readonly string[] {
  return ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];
}

function defaultCorsHeaders(): readonly string[] {
  return ["authorization", "content-type", "x-request-id", "x-muse-api-version"];
}

export function currentCompatApiVersion(): string {
  return "1";
}

export function supportedCompatApiVersions(): readonly string[] {
  return [currentCompatApiVersion()];
}

function isSensitivePath(path: string): boolean {
  return path === "/api/chat"
    || path.startsWith("/api/chat/")
    || path === "/api/auth"
    || path.startsWith("/api/auth/");
}

function isSwaggerPath(path: string): boolean {
  return path.startsWith("/swagger-ui") || path.startsWith("/v3/api-docs") || path.startsWith("/webjars");
}

export function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function routeMethods(method: string | readonly string[]): readonly string[] {
  return typeof method === "string" ? [method] : method;
}

export function createOpenApiDocument(apiRouteMethods: ReadonlyMap<string, ReadonlySet<string>>): JsonObject {
  return {
    info: {
      title: "Muse API",
      version: "0.0.0"
    },
    openapi: "3.1.0",
    paths: Object.fromEntries(
      [...apiRouteMethods.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([path, methods]) => [
          path,
          Object.fromEntries(
            [...methods]
              .filter((method) => method !== "head" && method !== "options")
              .sort()
              .map((method) => [
                method,
                {
                  responses: {
                    "200": {
                      description: "OK"
                    }
                  },
                  summary: `${method.toUpperCase()} ${path}`
                }
              ])
          )
        ])
    )
  };
}

export function isPublicRequest(method: string, url: string): boolean {
  const path = url.split("?")[0] ?? url;
  return (
    path === "/health" ||
    path === "/spec" ||
    path === "/v3/api-docs" ||
    path === "/api/openapi.json" ||
    path === "/.well-known/agent-card.json" ||
    path === "/api/muse/runtime" ||
    path === "/api/muse/loopback" ||
    (method === "POST" && (
      path === "/auth/login" ||
      path === "/auth/register" ||
      path === "/api/auth/login" ||
      path === "/api/auth/register" ||
      path === "/api/error-report"
    ))
  );
}
