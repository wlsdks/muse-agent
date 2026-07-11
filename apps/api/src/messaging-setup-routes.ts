import {
  resolveDiscordAfterFile,
  resolveDiscordInboxFile,
  resolveLineInboxFile,
  resolveSlackAfterFile,
  resolveSlackInboxFile,
  resolveTelegramInboxFile,
  resolveTelegramOffsetFile,
  type MuseEnvironment
} from "@muse/autoconfigure";
import {
  DiscordProvider,
  FileMessagingCredentialStore,
  LineProvider,
  SlackProvider,
  TelegramProvider,
  verifyMessagingToken,
  type MessagingProvider,
  type MessagingProviderRegistry,
  type TokenVerification
} from "@muse/messaging";

import { requireAuthenticated } from "./server-helpers.js";

import type { ServerOptions } from "./server.js";
import type { FastifyInstance } from "fastify";

/**
 * `/api/messaging/setup` — the web console's integrations surface.
 *
 *   - GET    /api/messaging/setup            connection status per provider
 *   - POST   /api/messaging/setup/:provider  verify a token LIVE, persist, hot-register
 *   - DELETE /api/messaging/setup/:provider  remove the credential + unregister
 *
 * Fail-close by construction: a token that does not pass the provider's own
 * identity endpoint is never persisted and never registered, and the stored
 * token is never echoed back to the client.
 */

interface ConnectableProvider {
  readonly id: "telegram" | "discord" | "slack" | "line";
  readonly displayName: string;
  readonly envKey: string;
  readonly docsUrl: string;
}

const CONNECTABLE: readonly ConnectableProvider[] = [
  { displayName: "Telegram", docsUrl: "https://core.telegram.org/bots#botfather", envKey: "MUSE_TELEGRAM_BOT_TOKEN", id: "telegram" },
  { displayName: "Discord", docsUrl: "https://discord.com/developers/applications", envKey: "MUSE_DISCORD_BOT_TOKEN", id: "discord" },
  { displayName: "Slack", docsUrl: "https://api.slack.com/apps", envKey: "MUSE_SLACK_BOT_TOKEN", id: "slack" },
  { displayName: "LINE", docsUrl: "https://developers.line.biz/console/", envKey: "MUSE_LINE_CHANNEL_ACCESS_TOKEN", id: "line" }
];

export interface MessagingSetupGate {
  readonly authService?: ServerOptions["authService"];
  readonly registry: MessagingProviderRegistry;
  readonly credentialsFile: string;
  readonly env: MuseEnvironment;
  /** Injectable for tests; defaults to the live per-provider identity check. */
  readonly verifyToken?: (providerId: string, token: string) => Promise<TokenVerification>;
}

function buildProvider(id: ConnectableProvider["id"], token: string, env: MuseEnvironment): MessagingProvider {
  switch (id) {
    case "telegram":
      return new TelegramProvider({ inboxFile: resolveTelegramInboxFile(env), offsetFile: resolveTelegramOffsetFile(env), token });
    case "discord":
      return new DiscordProvider({ afterFile: resolveDiscordAfterFile(env), inboxFile: resolveDiscordInboxFile(env), token });
    case "slack":
      return new SlackProvider({ afterFile: resolveSlackAfterFile(env), inboxFile: resolveSlackInboxFile(env), token });
    case "line":
      return new LineProvider({ inboxFile: resolveLineInboxFile(env), token });
  }
}

export function registerMessagingSetupRoutes(server: FastifyInstance, gate: MessagingSetupGate): void {
  const store = new FileMessagingCredentialStore(gate.credentialsFile);
  const verify = gate.verifyToken ?? ((providerId: string, token: string) => verifyMessagingToken(providerId, token));
  const authed = (request: Parameters<typeof requireAuthenticated>[0], reply: Parameters<typeof requireAuthenticated>[1]) =>
    requireAuthenticated(request, reply, Boolean(gate.authService));

  server.get("/api/messaging/setup", async (request, reply) => {
    if (!authed(request, reply)) {
      return reply;
    }
    const fromFile = new Set(await store.list());
    return {
      providers: CONNECTABLE.map((provider) => {
        const envToken = gate.env[provider.envKey]?.trim();
        const source = envToken ? "env" : fromFile.has(provider.id) ? "file" : null;
        return {
          configured: source !== null,
          displayName: provider.displayName,
          docsUrl: provider.docsUrl,
          id: provider.id,
          registered: gate.registry.has(provider.id),
          source
        };
      })
    };
  });

  server.post("/api/messaging/setup/:providerId", async (request, reply) => {
    if (!authed(request, reply)) {
      return reply;
    }
    const providerId = (request.params as { providerId: string }).providerId;
    const provider = CONNECTABLE.find((entry) => entry.id === providerId);
    if (!provider) {
      return reply.status(404).send({ reason: `unknown messaging provider "${providerId}"` });
    }
    const token = ((request.body as { token?: string } | undefined)?.token ?? "").trim();
    if (token.length === 0) {
      return reply.status(400).send({ message: "token is required", reason: "token is required" });
    }
    const verdict = await verify(provider.id, token);
    if (!verdict.ok) {
      return reply.status(400).send({ message: verdict.reason, ok: false, reason: verdict.reason });
    }
    await store.save(provider.id, { token });
    gate.registry.register(buildProvider(provider.id, token, gate.env));
    return { ok: true, ...(verdict.account ? { account: verdict.account } : {}) };
  });

  server.delete("/api/messaging/setup/:providerId", async (request, reply) => {
    if (!authed(request, reply)) {
      return reply;
    }
    const providerId = (request.params as { providerId: string }).providerId;
    const provider = CONNECTABLE.find((entry) => entry.id === providerId);
    if (!provider) {
      return reply.status(404).send({ reason: `unknown messaging provider "${providerId}"` });
    }
    if (gate.env[provider.envKey]?.trim()) {
      // An env-sourced credential outlives this process's file store —
      // deleting the file entry would silently NOT disconnect, so refuse.
      const reason = `${provider.displayName} is configured via ${provider.envKey}; unset the environment variable to disconnect`;
      return reply.status(409).send({ message: reason, reason });
    }
    await store.remove(provider.id);
    gate.registry.unregister(provider.id);
    return { ok: true };
  });
}
