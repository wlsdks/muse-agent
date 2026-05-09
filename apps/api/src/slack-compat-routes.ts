/**
 * Reactor-compat Slack admin routes extracted from reactor-compat-routes.ts.
 *
 * Wires the Slack admin surface:
 *   - /api/admin/slack-bots CRUD
 *   - /api/proactive-channels list/post/delete
 *   - /api/admin/slack/channels/faq full registration + ingest/probe/dry-run + stats + events + feedback
 *
 * Slack workspace credentials are NEVER baked in here — these are admin routes
 * that delegate to the underlying registries. Live workspace integration stays
 * out of the migration loop per project rules.
 */

import type { FastifyInstance } from "fastify";
import {
  compatRecord,
  createSlackBot,
  deleteSlackBot,
  deleteSlackFaqRegistration,
  deleteStateSlackFaqChannel,
  errorResponse,
  getSlackBot,
  getSlackFaqRegistration,
  getStateSlackFaqEvents,
  getStateSlackFaqFeedback,
  listProactiveChannels,
  listSlackBots,
  listSlackFaqRegistrations,
  nowIso,
  nullableStringResponse,
  readAuthUserId,
  readBoolean,
  readBodyNullableString,
  readBodyString,
  readNullableStringField,
  readNumber,
  saveProactiveChannels,
  saveSlackFaqRegistration,
  slackBotNotFound,
  slackFaqAutoReplyMode,
  slackFaqDryRun,
  slackFaqIngest,
  slackFaqNotFound,
  slackFaqProbe,
  slackFaqStats,
  stringField,
  toBody,
  toJsonObject,
  toProactiveChannelResponse,
  toSlackBotResponse,
  toSlackFaqEvent,
  toSlackFaqRegistration,
  updateSlackBot,
  validateSlackBotCreate,
  validateSlackFaqChannelId,
  validationErrorResponse,
  type ReactorCompatibilityRouteOptions
} from "./reactor-compat-routes.js";

export function registerSlackCompatibilityRoutes(server: FastifyInstance, options: ReactorCompatibilityRouteOptions): void {
  registerSlackBotRoutes(server, options);
  registerProactiveChannelRoutes(server, options);
  registerSlackFaqRoutes(server, options);
}

function registerSlackBotRoutes(server: FastifyInstance, options: ReactorCompatibilityRouteOptions): void {
  server.get("/api/admin/slack-bots", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    return (await listSlackBots(options)).map(toSlackBotResponse);
  });
  server.get("/api/admin/slack-bots/:id", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    const { id } = request.params as { readonly id: string };
    const bot = await getSlackBot(options, id);
    return bot ? toSlackBotResponse(bot) : slackBotNotFound(reply, id);
  });
  server.post("/api/admin/slack-bots", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    const name = readBodyString(request.body, "name") ?? "";
    const validationError = validateSlackBotCreate(toBody(request.body));

    if (validationError) {
      return reply.status(400).send(validationErrorResponse(validationError));
    }

    if ((await listSlackBots(options)).some((bot) => bot.name === name)) {
      return reply.status(409).send(errorResponse(`이름 '${name}'은 이미 사용 중입니다`));
    }

    return reply.status(201).send(toSlackBotResponse(await createSlackBot(options, request.body)));
  });
  server.put("/api/admin/slack-bots/:id", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    const { id } = request.params as { readonly id: string };
    const existing = await getSlackBot(options, id);

    if (!existing) {
      return slackBotNotFound(reply, id);
    }

    return toSlackBotResponse(await updateSlackBot(options, existing, request.body));
  });
  server.delete("/api/admin/slack-bots/:id", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    const { id } = request.params as { readonly id: string };
    const existing = await getSlackBot(options, id);

    if (!existing) {
      return slackBotNotFound(reply, id);
    }

    await deleteSlackBot(options, stringField(existing.id, id));
    return reply.status(204).send();
  });
}

function registerProactiveChannelRoutes(server: FastifyInstance, options: ReactorCompatibilityRouteOptions): void {
  server.get("/api/proactive-channels", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    return (await listProactiveChannels(options)).map(toProactiveChannelResponse);
  });
  server.post("/api/proactive-channels", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    const body = toBody(request.body);
    const channelId = readBodyString(body, "channelId")?.trim();

    if (!channelId) {
      return reply.status(400).send(validationErrorResponse({ channelId: "channelId must not be blank" }));
    }

    if (channelId.length > 50) {
      return reply.status(400).send(validationErrorResponse({
        channelId: "channelId must not exceed 50 characters"
      }));
    }

    if (typeof body.channelName === "string" && body.channelName.length > 200) {
      return reply.status(400).send(validationErrorResponse({
        channelName: "channelName must not exceed 200 characters"
      }));
    }

    const existing = await listProactiveChannels(options);

    if (existing.some((channel) => stringField(channel.channelId, "") === channelId)) {
      return reply.status(409).send({
        error: "Channel already in proactive list",
        timestamp: nowIso()
      });
    }

    const record = compatRecord({
      addedAt: Date.now(),
      channelId,
      channelName: readNullableStringField(body, "channelName"),
      id: channelId
    }, "proactive_channel");
    await saveProactiveChannels(options, [...existing, record]);
    return reply.status(201).send(toProactiveChannelResponse(record));
  });
  server.delete("/api/proactive-channels/:channelId", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    const { channelId } = request.params as { readonly channelId: string };
    const existing = await listProactiveChannels(options);
    const remaining = existing.filter((channel) => stringField(channel.channelId, "") !== channelId);

    if (remaining.length === existing.length) {
      return reply.status(404).send({
        error: "Channel not found in proactive list",
        timestamp: nowIso()
      });
    }

    await saveProactiveChannels(options, remaining);
    return reply.status(204).send();
  });
}

function registerSlackFaqRoutes(server: FastifyInstance, options: ReactorCompatibilityRouteOptions): void {
  server.post("/api/admin/slack/channels/faq", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    const body = toJsonObject(request.body);
    const channelId = readBodyString(body, "channelId");

    const validation = validateSlackFaqChannelId(channelId, reply);
    if (validation) {
      return validation;
    }

    const channelKey = channelId ?? "";
    const saved = await saveSlackFaqRegistration(options, {
      autoReplyMode: slackFaqAutoReplyMode(readBodyString(body, "autoReplyMode")),
      channelId: channelKey,
      channelName: readBodyNullableString(body, "channelName") ?? null,
      confidenceThreshold: readNumber(body.confidenceThreshold, 0.8),
      daysBack: readNumber(body.daysBack, 30),
      enabled: readBoolean(body.enabled, true),
      id: channelKey,
      lastChunkCount: null,
      lastError: null,
      lastIngestedAt: null,
      lastMessageCount: null,
      lastStatus: null,
      reIngestIntervalHours: readNumber(body.reIngestIntervalHours, 24),
      registeredBy: readAuthUserId(request) ?? null,
    });
    return toSlackFaqRegistration(saved);
  });
  server.get("/api/admin/slack/channels/faq", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    return { registrations: (await listSlackFaqRegistrations(options)).map(toSlackFaqRegistration) };
  });
  server.get("/api/admin/slack/channels/faq/stats", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    return slackFaqStats();
  });
  server.get("/api/admin/slack/channels/faq/:channelId", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    const { channelId } = request.params as { readonly channelId: string };
    const validation = validateSlackFaqChannelId(channelId, reply);
    if (validation) {
      return validation;
    }

    const record = await getSlackFaqRegistration(options, channelId);
    return record ? toSlackFaqRegistration(record) : slackFaqNotFound(reply, channelId);
  });
  server.patch("/api/admin/slack/channels/faq/:channelId", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    const { channelId } = request.params as { readonly channelId: string };
    const validation = validateSlackFaqChannelId(channelId, reply);
    if (validation) {
      return validation;
    }

    const existing = await getSlackFaqRegistration(options, channelId);
    if (!existing) {
      return slackFaqNotFound(reply, channelId);
    }

    const body = toBody(request.body);
    const saved = await saveSlackFaqRegistration(options, {
      ...existing,
      autoReplyMode: body.autoReplyMode === undefined
        ? stringField(existing.autoReplyMode, "MENTION")
        : slackFaqAutoReplyMode(readBodyString(body, "autoReplyMode")),
      channelId,
      channelName: readBodyNullableString(body, "channelName") ?? nullableStringResponse(existing.channelName),
      confidenceThreshold: body.confidenceThreshold === undefined
        ? readNumber(existing.confidenceThreshold, 0.8)
        : readNumber(body.confidenceThreshold, 0.8),
      daysBack: body.daysBack === undefined ? readNumber(existing.daysBack, 30) : readNumber(body.daysBack, 30),
      enabled: body.enabled === undefined ? readBoolean(existing.enabled, true) : readBoolean(body.enabled, true),
      id: channelId,
      reIngestIntervalHours: body.reIngestIntervalHours === undefined
        ? readNumber(existing.reIngestIntervalHours, 24)
        : readNumber(body.reIngestIntervalHours, 24),
    });
    return toSlackFaqRegistration(saved);
  });
  server.delete("/api/admin/slack/channels/faq/:channelId", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    const { channelId } = request.params as { readonly channelId: string };
    const validation = validateSlackFaqChannelId(channelId, reply);
    if (validation) {
      return validation;
    }

    const deleted = await deleteSlackFaqRegistration(options, channelId);
    deleteStateSlackFaqChannel(channelId);
    return deleted ? { deleted: channelId } : slackFaqNotFound(reply, channelId);
  });
  server.post("/api/admin/slack/channels/faq/:channelId/ingest", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    return slackFaqIngest(request, reply, options);
  });
  server.post("/api/admin/slack/channels/faq/:channelId/probe", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    return slackFaqProbe(request, reply, options);
  });
  server.post("/api/admin/slack/channels/faq/:channelId/dry-run", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    return slackFaqDryRun(request, reply, options);
  });
  server.get("/api/admin/slack/channels/faq/:channelId/stats", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    const { channelId } = request.params as { readonly channelId: string };
    return slackFaqStats(channelId);
  });
  server.get("/api/admin/slack/channels/faq/:channelId/events", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    const { channelId } = request.params as { readonly channelId: string };
    return { events: getStateSlackFaqEvents(channelId).slice(0, 50).map(toSlackFaqEvent) };
  });
  server.get("/api/admin/slack/channels/faq/:channelId/feedback", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    const { channelId } = request.params as { readonly channelId: string };
    const feedback = getStateSlackFaqFeedback(channelId);
    return {
      feedback: Object.fromEntries(Object.entries(feedback).map(([docId, item]) => [docId, {
        docId,
        negativeRatio: item.thumbsDown + item.thumbsUp === 0
          ? 0
          : item.thumbsDown / (item.thumbsDown + item.thumbsUp),
        thumbsDown: item.thumbsDown,
        thumbsUp: item.thumbsUp,
        total: item.thumbsDown + item.thumbsUp
      }]))
    };
  });
}
