/**
 * Muse compat auth helpers extracted from compat-routes.ts.
 * Covers required-service guards, credential parsing, response shape,
 * rate-limit key construction, and the generic Error → message helper.
 */

import type { LoginResult, MuseAuth } from "@muse/auth";
import type { JsonObject } from "@muse/shared";
import type { FastifyReply } from "fastify";
import {
  invalid,
  isRecord,
  type ParseResult,
  type CompatibilityRouteOptions
} from "./compat-routes.js";

export function requireAuthService(options: CompatibilityRouteOptions, reply: FastifyReply): MuseAuth | undefined {
  if (!options.authService) {
    reply.status(404).send({
      code: "AUTH_UNAVAILABLE",
      message: "Auth service is not configured"
    });
    return undefined;
  }

  return options.authService;
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

export function toCompatAuthResponse(login: LoginResult): JsonObject {
  return {
    error: null,
    token: login.token,
    user: toCompatUserResponse(login.user)
  };
}

export function toCompatUserResponse(user: LoginResult["user"]): JsonObject {
  return {
    email: user.email,
    id: user.id,
    name: user.name
  };
}

export function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
