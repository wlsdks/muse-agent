import type {
  IntegrationMessagingProviderId,
  ResolvedIntegrationEnvironment,
  ResolvedMessagingProviderEnvironment
} from "@muse/autoconfigure";
import {
  DiscordProvider,
  FileMessagingCredentialStore,
  LineProvider,
  MatrixProvider,
  SlackProvider,
  TelegramProvider,
  verifyMessagingToken,
  type MessagingProvider,
  type MessagingProviderRegistry,
  type TokenVerification
} from "@muse/messaging";

import {
  getOrCreatePairingCode,
  readChannelOwner,
  removeChannelOwner,
  removePairingCode
} from "./channel-owner-store.js";
import { requireAuthenticated } from "./server-helpers.js";
import { readRouteParam, toBody } from "./compat-parsers.js";

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
  readonly id: "telegram" | "discord" | "slack" | "line" | "matrix";
  readonly displayName: string;
  readonly docsUrl: string;
  /** Providers on a user-chosen host need a homeserver URL alongside the token. */
  readonly requiresHomeserverUrl?: boolean;
}

const CONNECTABLE: readonly ConnectableProvider[] = [
  { displayName: "Telegram", docsUrl: "https://core.telegram.org/bots#botfather", id: "telegram" },
  { displayName: "Discord", docsUrl: "https://discord.com/developers/applications", id: "discord" },
  { displayName: "Slack", docsUrl: "https://api.slack.com/apps", id: "slack" },
  { displayName: "LINE", docsUrl: "https://developers.line.biz/console/", id: "line" },
  { displayName: "Matrix", docsUrl: "https://spec.matrix.org/latest/client-server-api/", id: "matrix", requiresHomeserverUrl: true }
];

export interface MessagingSetupGate {
  readonly authService?: ServerOptions["authService"];
  readonly registry: MessagingProviderRegistry;
  readonly integrationEnv: ResolvedIntegrationEnvironment;
  /** Injectable for tests; defaults to the live per-provider identity check. */
  readonly verifyToken?: (
    providerId: string,
    token: string,
    options?: { readonly homeserverUrl?: string }
  ) => Promise<TokenVerification>;
  /**
   * Fires after a verified token is persisted AND hot-registered —
   * the server hooks this to start the provider's ingest daemon so a
   * UI connect becomes conversational without a restart.
   */
  readonly onConnected?: (providerId: string) => void;
}

function buildProvider(
  id: ConnectableProvider["id"],
  token: string,
  paths: ResolvedMessagingProviderEnvironment,
  homeserverUrl?: string
): MessagingProvider {
  switch (id) {
    case "telegram":
      return new TelegramProvider({ inboxFile: paths.inboxFile, offsetFile: paths.pollCursorFile, token });
    case "discord":
      return new DiscordProvider({ afterFile: paths.pollCursorFile, inboxFile: paths.inboxFile, token });
    case "slack":
      return new SlackProvider({ afterFile: paths.pollCursorFile, inboxFile: paths.inboxFile, token });
    case "line":
      return new LineProvider({ inboxFile: paths.inboxFile, token });
    case "matrix":
      // The route rejects a matrix POST without a homeserver URL
      // before reaching here, so the fallback never fires in practice.
      return new MatrixProvider({
        accessToken: token,
        homeserverUrl: homeserverUrl ?? "",
        inboxFile: paths.inboxFile,
        sinceFile: paths.pollCursorFile
      });
  }
}

const LOCAL_ONLY_REMOTE_INTEGRATIONS_DISABLED = {
  code: "LOCAL_ONLY_REMOTE_INTEGRATIONS_DISABLED",
  message: "Remote calendar and messaging integrations are disabled while MUSE_LOCAL_ONLY=true."
} as const;

function pathsFor(
  integrationEnv: ResolvedIntegrationEnvironment,
  providerId: IntegrationMessagingProviderId
): ResolvedMessagingProviderEnvironment {
  return integrationEnv.messaging.providers[providerId];
}

export function registerMessagingSetupRoutes(server: FastifyInstance, gate: MessagingSetupGate): void {
  const authed = (request: Parameters<typeof requireAuthenticated>[0], reply: Parameters<typeof requireAuthenticated>[1]) =>
    requireAuthenticated(request, reply, Boolean(gate.authService));

  server.get("/api/messaging/setup", async (request, reply) => {
    if (!authed(request, reply)) {
      return reply;
    }
    if (gate.integrationEnv.localOnly) {
      return reply.status(403).send(LOCAL_ONLY_REMOTE_INTEGRATIONS_DISABLED);
    }
    const store = new FileMessagingCredentialStore(gate.integrationEnv.messaging.credentialsFile);
    const fromFile = new Set(await store.list());
    const { ownersFile, pairingCodesFile } = gate.integrationEnv.messaging;
    const owners = Object.fromEntries(
      await Promise.all(CONNECTABLE.map(async (provider) => [provider.id, await readChannelOwner(ownersFile, provider.id)]))
    ) as Record<string, string | undefined>;
    return {
      providers: await Promise.all(CONNECTABLE.map(async (provider) => {
        const source = pathsFor(gate.integrationEnv, provider.id).envConfigured ? "env" : fromFile.has(provider.id) ? "file" : null;
        const configured = source !== null;
        const pairedOwner = owners[provider.id];
        // A pairing code is only meaningful once the provider is connected
        // AND no owner has claimed it yet — this is the code the owner
        // reads here and sends to the bot to complete pairing (P2 #9: TOFU
        // adoption replaced by this one-time code).
        const pairingCode = configured && !pairedOwner
          ? await getOrCreatePairingCode(pairingCodesFile, provider.id, new Date())
          : undefined;
        return {
          configured,
          ...(pairedOwner ? { pairedOwner } : {}),
          ...(pairingCode ? { pairingCode } : {}),
          displayName: provider.displayName,
          docsUrl: provider.docsUrl,
          id: provider.id,
          registered: gate.registry.has(provider.id),
          source
        };
      }))
    };
  });

  server.post("/api/messaging/setup/:providerId", async (request, reply) => {
  if (!authed(request, reply)) {
      return reply;
    }
    if (gate.integrationEnv.localOnly) {
      return reply.status(403).send(LOCAL_ONLY_REMOTE_INTEGRATIONS_DISABLED);
    }
    const provider = findProviderByRoute(request);
    if (!provider) {
      return reply.status(404).send({ reason: `unknown messaging provider` });
    }
    const body = toBody(request.body);
    const token = typeof body.token === "string" ? body.token.trim() : "";
    if (token.length === 0) {
      return reply.status(400).send({ message: "token is required", reason: "token is required" });
    }
    const homeserverUrl = (body?.homeserverUrl ?? "").trim();
    if (provider.requiresHomeserverUrl && homeserverUrl.length === 0) {
      const reason = "homeserverUrl is required (e.g. https://matrix.org)";
      return reply.status(400).send({ message: reason, reason });
    }
    const verdict = await (gate.verifyToken
      ? gate.verifyToken(provider.id, token, provider.requiresHomeserverUrl ? { homeserverUrl } : {})
      : verifyMessagingToken(provider.id, token, provider.requiresHomeserverUrl ? { homeserverUrl } : {}));
    if (!verdict.ok) {
      return reply.status(400).send({ message: verdict.reason, ok: false, reason: verdict.reason });
    }
    const store = new FileMessagingCredentialStore(gate.integrationEnv.messaging.credentialsFile);
    await store.save(provider.id, { token, ...(provider.requiresHomeserverUrl ? { homeserverUrl } : {}) });
    gate.registry.register(buildProvider(provider.id, token, pathsFor(gate.integrationEnv, provider.id), provider.requiresHomeserverUrl ? homeserverUrl : undefined));
    gate.onConnected?.(provider.id);
    return { ok: true, ...(verdict.account ? { account: verdict.account } : {}) };
  });

  server.delete("/api/messaging/setup/:providerId/pairing", async (request, reply) => {
    if (!authed(request, reply)) {
      return reply;
    }
    if (gate.integrationEnv.localOnly) {
      return reply.status(403).send(LOCAL_ONLY_REMOTE_INTEGRATIONS_DISABLED);
    }
    const provider = findProviderByRoute(request);
    if (!provider) {
      return reply.status(404).send({ reason: `unknown messaging provider` });
    }
    // Pairing reset: clear the owner AND the in-flight pairing code, so the
    // next GET mints a fresh code and pairing must go through it again —
    // never falls back to auto-adopting whoever messages next.
    await Promise.all([
      removeChannelOwner(gate.integrationEnv.messaging.ownersFile, provider.id),
      removePairingCode(gate.integrationEnv.messaging.pairingCodesFile, provider.id)
    ]);
    return { ok: true };
  });

  server.post("/api/messaging/setup/:providerId/test-send", async (request, reply) => {
    if (!authed(request, reply)) {
      return reply;
    }
    if (gate.integrationEnv.localOnly) {
      return reply.status(403).send(LOCAL_ONLY_REMOTE_INTEGRATIONS_DISABLED);
    }
    const provider = findProviderByRoute(request);
    if (!provider) {
      return reply.status(404).send({ reason: `unknown messaging provider` });
    }
    // The test goes to the PAIRED owner chat only — never a guessed or
    // user-typed recipient, so this stays on outbound-safety's low-risk
    // "user's own channel" path.
    const owner = await readChannelOwner(gate.integrationEnv.messaging.ownersFile, provider.id);
    if (!owner) {
      const reason = `no chat has paired with ${provider.displayName} yet — message the bot once first`;
      return reply.status(409).send({ message: reason, reason });
    }
    if (!gate.registry.has(provider.id)) {
      const reason = `${provider.displayName} is not live in this server — connect it first`;
      return reply.status(409).send({ message: reason, reason });
    }
    try {
      await gate.registry.send(provider.id, {
        destination: owner,
        text: "✅ Muse test message — this channel is connected and can reach you."
      });
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      return reply.status(502).send({ message: reason, reason });
    }
    return { destination: owner, ok: true };
  });

  server.delete("/api/messaging/setup/:providerId", async (request, reply) => {
    if (!authed(request, reply)) {
      return reply;
    }
    if (gate.integrationEnv.localOnly) {
      return reply.status(403).send(LOCAL_ONLY_REMOTE_INTEGRATIONS_DISABLED);
    }
    const provider = findProviderByRoute(request);
    if (!provider) {
      return reply.status(404).send({ reason: `unknown messaging provider` });
    }
    if (pathsFor(gate.integrationEnv, provider.id).envConfigured) {
      // An env-sourced credential outlives this process's file store —
      // deleting the file entry would silently NOT disconnect, so refuse.
      const reason = `${provider.displayName} is configured via environment; unset the provider token to disconnect`;
      return reply.status(409).send({ message: reason, reason });
    }
    const store = new FileMessagingCredentialStore(gate.integrationEnv.messaging.credentialsFile);
    await store.remove(provider.id);
    gate.registry.unregister(provider.id);
    return { ok: true };
  });

  function findProviderByRoute(request: Parameters<typeof requireAuthenticated>[0]): ConnectableProvider | undefined {
    const providerId = readRouteParam(request, "providerId");
    if (!providerId) {
      return undefined;
    }
    return CONNECTABLE.find((entry) => entry.id === providerId);
  }
}
