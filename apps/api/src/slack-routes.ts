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

const rawBodyKey = Symbol("muse.rawBody");
const processingText = "Processing your request...";
const blankPromptText = "Please enter a question. Example: /muse What should I do next?";

export function registerSlackRoutes(server: FastifyInstance, options: RegisterSlackRoutesOptions): void {
  installSlackBodyParsers(server);
  registerSlackMethodProbeRoutes(server);

  if (!options.slack?.enabled) {
    server.post("/api/slack/commands", async (_request, reply) => slackWebhookDisabled(reply));
    server.post("/slack/commands", async (_request, reply) => slackWebhookDisabled(reply));
    server.post("/api/slack/events", async (_request, reply) => slackWebhookDisabled(reply));
    server.post("/slack/events", async (_request, reply) => slackWebhookDisabled(reply));
    return;
  }

  server.post("/api/slack/commands", async (request, reply) => handleSlashCommand(request, reply, options));
  server.post("/slack/commands", async (request, reply) => handleSlashCommand(request, reply, options));
  server.post("/api/slack/events", async (request, reply) => handleEventCallback(request, reply, options));
  server.post("/slack/events", async (request, reply) => handleEventCallback(request, reply, options));
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
  options: RegisterSlackRoutesOptions
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

  return {
    ok: true,
    retryNum: headerValue(request.headers["x-slack-retry-num"]),
    retryReason: headerValue(request.headers["x-slack-retry-reason"])
  };
}

async function dispatchResponseUrl(envelope: CommandEnvelope, options: RegisterSlackRoutesOptions): Promise<void> {
  const transport = options.slack?.responseTransport ?? new FetchSlackResponseUrlTransport();
  const response = await executeSlackCommand(envelope, options).catch((error) => ({
    text: error instanceof Error ? `Agent run failed: ${error.message}` : "Agent run failed",
    visibility: "ephemeral" as const
  }));

  await transport.post(envelope.responseUrl ?? "", {
    response_type: response.visibility === "public" ? "in_channel" : "ephemeral",
    text: response.text
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
    source: envelope.source,
    userId: envelope.userId ?? null,
    workspaceId: envelope.workspaceId ?? null
  };
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
