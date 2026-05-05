import type { AgentRuntime } from "@muse/agent-core";
import {
  FetchSlackResponseUrlTransport,
  SlackSignatureVerifier,
  parseSlackSlashCommand,
  parseSlackUrlEncodedBody,
  toSlackCommandAck,
  type CommandEnvelope,
  type CommandHandler,
  type CommandResponse,
  type SlackResponseUrlTransport,
  type SlackSlashCommandPayload
} from "@muse/integrations";
import type { JsonObject } from "@muse/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

export interface SlackRouteOptions {
  readonly enabled?: boolean;
  readonly signingSecret?: string;
  readonly commandHandler?: CommandHandler;
  readonly responseTransport?: SlackResponseUrlTransport;
  readonly now?: () => Date;
}

export interface RegisterSlackRoutesOptions {
  readonly agentRuntime?: AgentRuntime;
  readonly defaultModel?: string;
  readonly slack?: SlackRouteOptions;
}

interface SlackEventState {
  readonly eventIds: Set<string>;
  readonly eventTypeByMessageKey: Map<string, string>;
}

const rawBodyKey = Symbol("muse.rawBody");
const processingText = "Processing your request...";
const blankPromptText = "Please enter a question. Example: /muse What should I do next?";
const maxRememberedSlackEvents = 10_000;

export function registerSlackRoutes(server: FastifyInstance, options: RegisterSlackRoutesOptions): void {
  installSlackBodyParsers(server);
  registerSlackMethodProbeRoutes(server);
  const eventState: SlackEventState = {
    eventIds: new Set(),
    eventTypeByMessageKey: new Map()
  };

  if (!options.slack?.enabled) {
    server.post("/api/slack/commands", async (_request, reply) => slackWebhookDisabled(reply));
    server.post("/slack/commands", async (_request, reply) => slackWebhookDisabled(reply));
    server.post("/api/slack/events", async (_request, reply) => slackWebhookDisabled(reply));
    server.post("/slack/events", async (_request, reply) => slackWebhookDisabled(reply));
    return;
  }

  server.post("/api/slack/commands", async (request, reply) => handleSlashCommand(request, reply, options));
  server.post("/slack/commands", async (request, reply) => handleSlashCommand(request, reply, options));
  server.post("/api/slack/events", async (request, reply) => handleEventCallback(request, reply, options, eventState));
  server.post("/slack/events", async (request, reply) => handleEventCallback(request, reply, options, eventState));
}

function registerSlackMethodProbeRoutes(server: FastifyInstance): void {
  server.get("/api/slack/commands", async (_request, reply) => slackWebhookPostOnly(reply));
  server.get("/slack/commands", async (_request, reply) => slackWebhookPostOnly(reply));
  server.get("/api/slack/events", async (_request, reply) => slackWebhookPostOnly(reply));
  server.get("/slack/events", async (_request, reply) => slackWebhookPostOnly(reply));
}

function slackWebhookPostOnly(reply: FastifyReply): FastifyReply {
  return reply.status(405).send({
    code: "METHOD_NOT_ALLOWED",
    message: "Slack webhook accepts POST only"
  });
}

function slackWebhookDisabled(reply: FastifyReply): FastifyReply {
  return reply.status(503).send({
    error: "slack_transport_socket_mode",
    message: "Slack HTTP webhook is disabled; transport-mode=socket_mode"
  });
}

async function handleSlashCommand(
  request: FastifyRequest,
  reply: FastifyReply,
  options: RegisterSlackRoutesOptions
) {
  if (!verifySlackRequest(request, reply, options.slack)) {
    return reply;
  }

  const payload = parseSlashPayload(request.body);

  if (!payload || !payload.command || !payload.user_id || !payload.channel_id || !payload.response_url) {
    return reply.status(400).send({
      response_type: "ephemeral",
      text: "Invalid Slack command payload"
    });
  }

  const envelope = parseSlackSlashCommand(payload, options.slack?.now);

  if (envelope.text.trim().length === 0) {
    return reply.send({
      response_type: "ephemeral",
      text: blankPromptText
    });
  }

  if (envelope.responseUrl) {
    void dispatchResponseUrl(envelope, options).catch(() => undefined);
    return reply.send({
      response_type: "ephemeral",
      text: processingText
    });
  }

  return reply.send(toSlackCommandAck(await executeSlackCommand(envelope, options)));
}

async function handleEventCallback(
  request: FastifyRequest,
  reply: FastifyReply,
  options: RegisterSlackRoutesOptions,
  state: SlackEventState
) {
  if (!verifySlackRequest(request, reply, options.slack)) {
    return reply;
  }

  if (!isRecord(request.body)) {
    return reply.status(400).send({
      code: "INVALID_SLACK_EVENT",
      message: "Slack event payload must be an object"
    });
  }

  if (typeof request.body.challenge === "string") {
    return { challenge: request.body.challenge };
  }

  const envelope = parseSlackEventEnvelope(request.body, state);

  if (envelope) {
    void executeSlackCommand(envelope, options).catch(() => undefined);
  }

  return {
    ok: true,
    retryNum: headerValue(request.headers["x-slack-retry-num"]),
    retryReason: headerValue(request.headers["x-slack-retry-reason"])
  };
}

function parseSlackEventEnvelope(body: Record<string, unknown>, state: SlackEventState): CommandEnvelope | undefined {
  const event = readRecord(body, "event");

  if (!event) {
    return undefined;
  }

  const eventType = readString(event, "type");

  if (eventType !== "app_mention" && eventType !== "message") {
    return undefined;
  }

  if (readString(event, "bot_id") || readString(event, "subtype")) {
    return undefined;
  }

  const eventId = readString(body, "event_id");

  if (eventId && isDuplicateSlackEventId(eventId, state)) {
    return undefined;
  }

  const channelId = readString(event, "channel");
  const userId = readString(event, "user");
  const ts = readString(event, "ts");

  if (!channelId || !userId) {
    return undefined;
  }

  const messageKey = ts ? `${channelId}:${ts}` : undefined;

  if (eventType === "app_mention" && messageKey) {
    state.eventTypeByMessageKey.set(messageKey, eventType);
  }

  if (eventType === "message") {
    if (messageKey && state.eventTypeByMessageKey.get(messageKey) === "app_mention") {
      return undefined;
    }

    if (messageKey) {
      state.eventTypeByMessageKey.set(messageKey, eventType);
    }

    const channelType = readString(event, "channel_type");
    const threadTs = readString(event, "thread_ts");

    if (channelType !== "im" && !threadTs) {
      return undefined;
    }
  }

  trimSlackEventState(state);

  return {
    channelId,
    command: eventType,
    id: eventId || createSlackEventCommandId(channelId, ts),
    metadata: {
      channelId,
      channelType: readString(event, "channel_type") ?? null,
      eventId: eventId ?? null,
      eventTs: ts ?? null,
      eventType,
      source: "slack_event",
      threadTs: readString(event, "thread_ts") ?? null,
      userId,
      workspaceId: readString(body, "team_id") ?? null
    },
    receivedAt: new Date(),
    source: "slack_event",
    text: stripSlackBotMentions(readString(event, "text") ?? ""),
    userId,
    workspaceId: readString(body, "team_id")
  };
}

async function dispatchResponseUrl(envelope: CommandEnvelope, options: RegisterSlackRoutesOptions): Promise<void> {
  const transport = options.slack?.responseTransport ?? new FetchSlackResponseUrlTransport();
  const response = await executeSlackCommand(envelope, options).catch((error) => ({
    text: error instanceof Error ? `Agent run failed: ${error.message}` : "Agent run failed",
    visibility: "ephemeral" as const
  }));

  const ack = toSlackCommandAck(response);
  await transport.post(envelope.responseUrl ?? "", {
    response_type: ack.response_type,
    text: ack.text
  });
}

async function executeSlackCommand(
  envelope: CommandEnvelope,
  options: RegisterSlackRoutesOptions
): Promise<CommandResponse> {
  if (options.slack?.commandHandler) {
    return options.slack.commandHandler.handle(envelope);
  }

  if (!options.agentRuntime) {
    return {
      text: "Agent runtime is not configured",
      visibility: "ephemeral"
    };
  }

  const result = await options.agentRuntime.run({
    messages: [{ content: envelope.text, role: "user" }],
    metadata: slackMetadata(envelope),
    model: options.defaultModel ?? "default"
  });

  return {
    text: result.response.output,
    visibility: "public"
  };
}

function parseSlashPayload(body: unknown): SlackSlashCommandPayload | undefined {
  if (typeof body === "string") {
    return parseSlackUrlEncodedBody(body);
  }

  if (!isRecord(body)) {
    return undefined;
  }

  return Object.fromEntries(
    Object.entries(body).filter((entry): entry is [string, string] => typeof entry[1] === "string")
  );
}

function verifySlackRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  options: SlackRouteOptions | undefined
): boolean {
  if (!options?.signingSecret) {
    return true;
  }

  const rawBody = readRawBody(request.body);
  const timestamp = headerValue(request.headers["x-slack-request-timestamp"]);
  const signature = headerValue(request.headers["x-slack-signature"]);
  const now = options.now;
  const verification = new SlackSignatureVerifier({
    nowSeconds: now ? () => Math.floor(now().getTime() / 1000) : undefined,
    signingSecret: options.signingSecret
  }).verify(timestamp, signature, rawBody);

  if (verification.ok) {
    return true;
  }

  reply.status(401).send({
    code: "SLACK_SIGNATURE_INVALID",
    message: verification.reason ?? "Invalid Slack signature"
  });
  return false;
}

function installSlackBodyParsers(server: FastifyInstance): void {
  if (server.hasContentTypeParser("application/json")) {
    server.removeContentTypeParser("application/json");
  }

  server.addContentTypeParser("application/json", { parseAs: "string" }, (_request, body, done) => {
    const rawBody = String(body);

    try {
      done(null, withRawBody(JSON.parse(rawBody), rawBody));
    } catch (error) {
      done(error as Error);
    }
  });

  if (!server.hasContentTypeParser("application/x-www-form-urlencoded")) {
    server.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_request, body, done) => {
      const rawBody = String(body);

      done(null, withRawBody(parseSlackUrlEncodedBody(rawBody), rawBody));
    });
  }
}

function withRawBody<T>(value: T, rawBody: string): T {
  if ((value && typeof value === "object") || Array.isArray(value)) {
    Object.defineProperty(value, rawBodyKey, {
      enumerable: false,
      value: rawBody
    });
  }

  return value;
}

function readRawBody(value: unknown): string {
  if (value && typeof value === "object") {
    const raw = (value as { readonly [rawBodyKey]?: string })[rawBodyKey];

    if (raw) {
      return raw;
    }
  }

  return typeof value === "string" ? value : JSON.stringify(value ?? {});
}

function slackMetadata(envelope: CommandEnvelope): JsonObject {
  return {
    channelId: envelope.channelId ?? null,
    command: envelope.command,
    ...(envelope.metadata ?? {}),
    source: envelope.source,
    userId: envelope.userId ?? null,
    workspaceId: envelope.workspaceId ?? null
  };
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function isDuplicateSlackEventId(eventId: string, state: SlackEventState): boolean {
  if (state.eventIds.has(eventId)) {
    return true;
  }

  state.eventIds.add(eventId);
  return false;
}

function trimSlackEventState(state: SlackEventState): void {
  trimOldestSetValues(state.eventIds, maxRememberedSlackEvents);
  trimOldestMapValues(state.eventTypeByMessageKey, maxRememberedSlackEvents);
}

function trimOldestSetValues<T>(set: Set<T>, maxSize: number): void {
  while (set.size > maxSize) {
    const oldest = set.values().next().value as T | undefined;

    if (oldest === undefined) {
      return;
    }

    set.delete(oldest);
  }
}

function trimOldestMapValues<K, V>(map: Map<K, V>, maxSize: number): void {
  while (map.size > maxSize) {
    const oldest = map.keys().next().value as K | undefined;

    if (oldest === undefined) {
      return;
    }

    map.delete(oldest);
  }
}

function createSlackEventCommandId(channelId: string, ts: string | undefined): string {
  return ts ? `slack_event:${channelId}:${ts}` : `slack_event:${channelId}:${Date.now()}`;
}

function stripSlackBotMentions(text: string): string {
  return text.replace(/<@[A-Z0-9]+>\s*/gu, "").trim();
}

function readRecord(value: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const candidate = value[key];
  return isRecord(candidate) ? candidate : undefined;
}

function readString(value: Record<string, unknown>, key: string): string | undefined {
  const candidate = value[key];
  return typeof candidate === "string" && candidate.trim().length > 0 ? candidate.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
