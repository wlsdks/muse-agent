// Conversation-summary + runtime-settings registrars — split out of server-routes.ts (domain cohesion).

import type { RuntimeSettings } from "@muse/runtime-settings";
import type { FastifyInstance } from "fastify";

import { requireAuthenticated, parseRuntimeSettingInput } from "./server-helpers.js";
import { readAuthUserId } from "./compat-parsers.js";
import type { AdminGate } from "./routes-admin-run.js";
import type { ServerOptions } from "./server.js";

export function registerSessionSummaryRoutes(
  server: FastifyInstance,
  options: ServerOptions,
  gate: AdminGate
): void {
  server.get("/api/admin/sessions/:sessionId/summary", async (request, reply) => {
    if (!requireAuthenticated(request, reply, Boolean(gate.authService))) {
      return reply;
    }
    if (!options.conversationSummaryStore) {
      return reply.status(404).send({
        code: "CONVERSATION_SUMMARY_STORE_UNAVAILABLE",
        message: "Conversation summary store is not configured"
      });
    }
    const { sessionId } = request.params as { readonly sessionId: string };
    const summary = await options.conversationSummaryStore.get(sessionId);
    if (!summary) {
      return reply.status(404).send({
        code: "CONVERSATION_SUMMARY_NOT_FOUND",
        message: `No conversation summary stored for session ${sessionId}`
      });
    }
    return summary;
  });

  server.put("/api/admin/sessions/:sessionId/summary", async (request, reply) => {
    if (!requireAuthenticated(request, reply, Boolean(gate.authService))) {
      return reply;
    }
    if (!options.conversationSummaryStore) {
      return reply.status(404).send({
        code: "CONVERSATION_SUMMARY_STORE_UNAVAILABLE",
        message: "Conversation summary store is not configured"
      });
    }
    const { sessionId } = request.params as { readonly sessionId: string };
    const body = request.body as { readonly narrative?: unknown; readonly summarizedUpToIndex?: unknown } | null | undefined;
    const narrative = typeof body?.narrative === "string" ? body.narrative.trim() : "";
    if (narrative.length === 0) {
      return reply.status(400).send({
        code: "INVALID_CONVERSATION_SUMMARY",
        message: "narrative must be a non-empty string"
      });
    }
    const summarizedUpToIndex = Number.isInteger(body?.summarizedUpToIndex)
      ? (body!.summarizedUpToIndex as number)
      : 0;
    if (summarizedUpToIndex < 0) {
      return reply.status(400).send({
        code: "INVALID_CONVERSATION_SUMMARY",
        message: "summarizedUpToIndex must be a non-negative integer"
      });
    }
    return options.conversationSummaryStore.save({
      narrative,
      sessionId,
      summarizedUpToIndex
    });
  });

  server.delete("/api/admin/sessions/:sessionId/summary", async (request, reply) => {
    if (!requireAuthenticated(request, reply, Boolean(gate.authService))) {
      return reply;
    }
    if (!options.conversationSummaryStore) {
      return reply.status(404).send({
        code: "CONVERSATION_SUMMARY_STORE_UNAVAILABLE",
        message: "Conversation summary store is not configured"
      });
    }
    const { sessionId } = request.params as { readonly sessionId: string };
    const deleted = await options.conversationSummaryStore.delete(sessionId);
    return reply.status(deleted ? 204 : 404).send();
  });
}

export function registerRuntimeSettingsRoutes(
  server: FastifyInstance,
  runtimeSettings: RuntimeSettings,
  options: { readonly useAuthenticatedActor?: boolean } = {}
): void {
  server.get("/settings", async () => runtimeSettings.list());

  server.get("/settings/:key", async (request, reply) => {
    const { key } = request.params as { readonly key: string };
    const setting = await runtimeSettings.find(key);

    if (!setting) {
      return reply.status(404).send({
        code: "RUNTIME_SETTING_NOT_FOUND",
        message: `Runtime setting not found: ${key}`
      });
    }

    return setting;
  });

  server.put("/settings/:key", async (request, reply) => {
    const { key } = request.params as { readonly key: string };
    const parsed = parseRuntimeSettingInput(key, request.body);

    if (!parsed.ok) {
      return reply.status(400).send(parsed.error);
    }

    return runtimeSettings.set({
      ...parsed.value,
      updatedBy: options.useAuthenticatedActor ? readAuthUserId(request) ?? null : parsed.value.updatedBy
    });
  });

  server.delete("/settings/:key", async (request) => {
    const { key } = request.params as { readonly key: string };

    await runtimeSettings.delete(key);
    return { deleted: true, key };
  });
}
