/**
 * Reactor-compat auth helpers extracted from reactor-compat-routes.ts.
 * Covers required-service guards, credential parsing, response shape,
 * rate-limit key construction, and the generic Error → message helper.
 */

import type { LoginResult, MuseAuth } from "@muse/auth";
import type { PendingApprovalStore } from "@muse/runtime-state";
import type { JsonObject } from "@muse/shared";
import type { FastifyReply } from "fastify";
import {
  invalid,
  isRecord,
  type ParseResult,
  type ReactorCompatibilityRouteOptions
} from "./reactor-compat-routes.js";

export function requireAuthService(options: ReactorCompatibilityRouteOptions, reply: FastifyReply): MuseAuth | undefined {
  if (!options.authService) {
    reply.status(404).send({
      code: "AUTH_UNAVAILABLE",
      message: "Auth service is not configured"
    });
    return undefined;
  }

  return options.authService;
}

export function requirePendingApprovalStore(
  options: ReactorCompatibilityRouteOptions,
  reply: FastifyReply
): PendingApprovalStore | undefined {
  if (!options.pendingApprovalStore) {
    reply.status(404).send({
      code: "APPROVAL_STORE_UNAVAILABLE",
      message: "Pending approval store is not configured"
    });
    return undefined;
  }

  return options.pendingApprovalStore;
}

export function parseAuthCredentials(
  value: unknown,
  mode: "login" | "register"
): ParseResult<{ readonly email: string; readonly name: string; readonly password: string }> {
  if (!isRecord(value) || typeof value.email !== "string" || typeof value.password !== "string") {
    return invalid("INVALID_AUTH_REQUEST", "Body must include email and password strings");
  }

  if (value.email.trim().length === 0 || value.password.length === 0) {
    return invalid("INVALID_AUTH_REQUEST", "Email and password must not be blank");
  }

  if (mode === "register" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value.email.trim())) {
    return invalid("INVALID_AUTH_REQUEST", "Invalid email format");
  }

  if (mode === "register" && value.password.length < 8) {
    return invalid("INVALID_AUTH_REQUEST", "Password must be at least 8 characters");
  }

  if (mode === "register" && (typeof value.name !== "string" || value.name.trim().length === 0)) {
    return invalid("INVALID_AUTH_REQUEST", "Registration requires a non-empty name");
  }

  return {
    ok: true,
    value: {
      email: value.email,
      name: typeof value.name === "string" ? value.name : value.email,
      password: value.password
    }
  };
}

export function toReactorAuthResponse(login: LoginResult): JsonObject {
  return {
    error: null,
    token: login.token,
    user: toReactorUserResponse(login.user)
  };
}

export function toReactorUserResponse(user: LoginResult["user"]): JsonObject {
  return {
    adminScope: user.role === "admin" ? "FULL" : null,
    email: user.email,
    id: user.id,
    name: user.name,
    role: user.role.toUpperCase()
  };
}

export function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export function authRateLimitKey(
  forwardedFor: string | string[] | undefined,
  fallbackIp: string,
  path: string
): string {
  const forwarded = Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor;
  const ip = forwarded?.split(",")[0]?.trim() || fallbackIp || "unknown";
  return `${ip}:${path}`;
}
