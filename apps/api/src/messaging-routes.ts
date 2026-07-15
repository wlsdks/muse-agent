/**
 * `/api/messaging/*` routes — outbound messenger surface.
 *
 *   - GET  /api/messaging/providers
 *   - POST /api/messaging/send  { providerId, destination, text }
 *
 * Phase 1 is send-only across Telegram / Discord / Slack / LINE.
 * Phase 2 will add inbound (polling / Socket Mode / webhook) — see
 * `docs/design/messaging.md`.
 */

import {
  MAX_READ_LIMIT,
  MessagingProviderError,
  MessagingValidationError,
  type MessagingProviderRegistry
} from "@muse/messaging";
import { errorMessage } from "@muse/shared";
import type { FastifyInstance } from "fastify";

import { requireAuthenticated } from "./server-helpers.js";
import type { ServerOptions } from "./server.js";

interface MessagingRoutesGate {
  readonly authService: ServerOptions["authService"];
  readonly registry: MessagingProviderRegistry;
  /**
   * Shared with `muse.messaging.poll_now` MCP tool. When provided,
   * `POST /api/messaging/poll` is registered so the web console
   * can trigger an off-cadence pull on demand. Without it, the
   * endpoint isn't exposed (404).
   */
  readonly pollNow?: (providerId: string, source?: string) => Promise<{ ingested: number }>;
  /**
   * Shared with `muse.messaging.poll_all` MCP tool. When provided,
   * `POST /api/messaging/poll-all` is registered for one-shot
   * pulls across every wired provider.
   */
  readonly pollAll?: () => Promise<{
    readonly ingestedByProvider: Readonly<Record<string, number>>;
    readonly errors: readonly { readonly providerId: string; readonly message: string }[];
  }>;
}

export function registerMessagingRoutes(server: FastifyInstance, gate: MessagingRoutesGate): void {
  server.get("/api/messaging/inbox", async (request, reply) => {
    if (!requireAuthenticated(request, reply, Boolean(gate.authService))) {
      return reply;
    }
    const query = (request.query as { providerId?: string; limit?: string; source?: string } | undefined) ?? {};
    const providerId = typeof query.providerId === "string" ? query.providerId.trim() : "";
    if (providerId.length === 0) {
      return reply.status(400).send({
        code: "INVALID_MESSAGING_REQUEST",
        message: "providerId query parameter is required"
      });
    }
    const limitNum = query.limit ? Number(query.limit) : undefined;
    const opts: { limit?: number; source?: string } = {};
    if (limitNum !== undefined && Number.isFinite(limitNum)) {
      // Normalise at the HTTP boundary so a negative / zero / float
      // / unbounded `?limit=` can't reach a live-API provider
      // (Telegram / Discord / Slack) raw. Same clamp the file-backed
      // path applies internally, sharing one cap constant.
      opts.limit = Math.max(1, Math.min(MAX_READ_LIMIT, Math.trunc(limitNum)));
    }
    if (typeof query.source === "string" && query.source.length > 0) {
      opts.source = query.source;
    }
    try {
      const inbound = await gate.registry.fetchInbound(providerId, Object.keys(opts).length > 0 ? opts : undefined);
      return reply.status(200).send({ inbound, providerId, total: inbound.length });
    } catch (error) {
      if (error instanceof MessagingProviderError) {
        if (error.code === "PROVIDER_NOT_FOUND") {
          return reply.status(404).send({ code: "MESSAGING_PROVIDER_UNKNOWN", message: error.message });
        }
        return reply.status(502).send({
          code: "MESSAGING_PROVIDER_FAILED",
          message: error.message,
          providerId: error.providerId,
          ...(error.status !== undefined ? { upstreamStatus: error.status } : {})
        });
      }
      throw error;
    }
  });

  server.get("/api/messaging/providers", async (request, reply) => {
    if (!requireAuthenticated(request, reply, Boolean(gate.authService))) {
      return reply;
    }
    return { providers: gate.registry.describe() };
  });

  server.post("/api/messaging/send", async (request, reply) => {
    if (!requireAuthenticated(request, reply, Boolean(gate.authService))) {
      return reply;
    }
    const body = request.body as {
      readonly providerId?: unknown;
      readonly destination?: unknown;
      readonly text?: unknown;
    } | null;
    if (!body || typeof body.providerId !== "string" || body.providerId.trim().length === 0) {
      return reply.status(400).send({
        code: "INVALID_MESSAGING_REQUEST",
        message: "providerId must be a non-empty string"
      });
    }
    if (typeof body.destination !== "string" || body.destination.trim().length === 0) {
      return reply.status(400).send({
        code: "INVALID_MESSAGING_REQUEST",
        message: "destination must be a non-empty string"
      });
    }
    if (typeof body.text !== "string" || body.text.length === 0) {
      return reply.status(400).send({
        code: "INVALID_MESSAGING_REQUEST",
        message: "text must be a non-empty string"
      });
    }
    try {
      const receipt = await gate.registry.send(body.providerId, {
        destination: body.destination,
        text: body.text
      });
      return reply.status(200).send(receipt);
    } catch (error) {
      if (error instanceof MessagingValidationError) {
        return reply.status(400).send({ code: "INVALID_MESSAGING_REQUEST", field: error.field, message: error.message });
      }
      if (error instanceof MessagingProviderError) {
        if (error.code === "PROVIDER_NOT_FOUND") {
          return reply.status(404).send({ code: "MESSAGING_PROVIDER_UNKNOWN", message: error.message });
        }
        return reply.status(502).send({
          code: "MESSAGING_PROVIDER_FAILED",
          message: error.message,
          providerId: error.providerId,
          ...(error.status !== undefined ? { upstreamStatus: error.status } : {})
        });
      }
      throw error;
    }
  });

  if (gate.pollAll) {
    const pollAll = gate.pollAll;
    server.post("/api/messaging/poll-all", async (request, reply) => {
      if (!requireAuthenticated(request, reply, Boolean(gate.authService))) {
        return reply;
      }
      try {
        const result = await pollAll();
        return reply.status(200).send({
          errors: result.errors,
          ingestedByProvider: result.ingestedByProvider
        });
      } catch (error) {
        // Log the raw detail server-side; never echo it to the
        // network client (it can carry provider internals /
        // ECONNREFUSED hosts / connection URIs).
        reply.log.error({ err: error }, "messaging poll-all failed");
        return reply.status(500).send({ code: "MESSAGING_POLL_ALL_FAILED", message: "messaging poll-all failed" });
      }
    });
  }

  if (gate.pollNow) {
    const pollNow = gate.pollNow;
    server.post("/api/messaging/poll", async (request, reply) => {
      if (!requireAuthenticated(request, reply, Boolean(gate.authService))) {
        return reply;
      }
      const body = request.body as { readonly providerId?: unknown; readonly source?: unknown } | null;
      if (!body || typeof body.providerId !== "string" || body.providerId.trim().length === 0) {
        return reply.status(400).send({
          code: "INVALID_MESSAGING_REQUEST",
          message: "providerId must be a non-empty string"
        });
      }
      const source = typeof body.source === "string" && body.source.trim().length > 0
        ? body.source.trim()
        : undefined;
      try {
        const result = await pollNow(body.providerId, source);
        return reply.status(200).send({ ingested: result.ingested, providerId: body.providerId });
      } catch (error) {
        if (error instanceof MessagingProviderError) {
          return reply.status(502).send({
            code: "MESSAGING_PROVIDER_FAILED",
            message: error.message,
            providerId: error.providerId,
            ...(error.status !== undefined ? { upstreamStatus: error.status } : {})
          });
        }
        const message = errorMessage(error, "Invalid messaging poll request");
        // The autoconfigure-built dispatcher raises plain Errors for
        // "source required" and "LINE not pollable" — surface those
        // as 400 so the web caller can show the message verbatim.
        return reply.status(400).send({ code: "INVALID_MESSAGING_REQUEST", message });
      }
    });
  }
}
