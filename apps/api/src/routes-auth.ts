// Registration/login/logout/identity registrars — split out of server-routes.ts (domain cohesion).

import { extractBearerToken } from "@muse/auth";
import type { FastifyInstance } from "fastify";

import { getAuthIdentity, parseAuthCredentials, toLoginResponse } from "./server-helpers.js";
import type { ServerOptions } from "./server.js";

export function registerAuthRoutes(server: FastifyInstance, authService: NonNullable<ServerOptions["authService"]>): void {
  server.post("/auth/register", async (request, reply) => {
    const parsed = parseAuthCredentials(request.body, "register");

    if (!parsed.ok) {
      return reply.status(400).send(parsed.error);
    }

    try {
      return reply.status(201).send(toLoginResponse(await authService.register(parsed.value)));
    } catch (error) {
      return reply.status(400).send({
        code: error instanceof Error && "code" in error ? String(error.code) : "REGISTRATION_FAILED",
        message: error instanceof Error ? error.message : "Registration failed"
      });
    }
  });

  server.post("/auth/login", async (request, reply) => {
    const parsed = parseAuthCredentials(request.body, "login");

    if (!parsed.ok) {
      return reply.status(400).send(parsed.error);
    }

    const login = await authService.login(parsed.value.email, parsed.value.password);

    if (!login) {
      return reply.status(401).send({
        code: "INVALID_CREDENTIALS",
        message: "Invalid credentials"
      });
    }

    return toLoginResponse(login);
  });

  server.get("/auth/me", async (request, reply) => {
    const identity = getAuthIdentity(request);

    if (!identity) {
      return reply.status(401).send({
        code: "UNAUTHENTICATED",
        message: "A valid bearer token is required"
      });
    }

    return { identity };
  });

  server.post("/auth/logout", async (request) => ({
    revoked: await authService.logout(extractBearerToken(request.headers.authorization))
  }));
}
