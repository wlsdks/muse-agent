import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FileMessagingCredentialStore, MessagingProviderRegistry } from "@muse/messaging";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";

import { registerMessagingSetupRoutes } from "../src/messaging-setup-routes.js";

import type { TokenVerification } from "@muse/messaging";

// Connect-time contract for the web console's integrations tab: a token is
// verified LIVE against the provider's identity endpoint before anything is
// persisted (fail-close — an invalid token saves nothing and registers
// nothing), a verified token is saved AND hot-registered so the running
// server can send without a restart, and disconnect unregisters + deletes.

function build(options: {
  readonly env?: Record<string, string>;
  readonly verify?: (providerId: string, token: string, verifyOptions?: { readonly homeserverUrl?: string }) => TokenVerification;
}) {
  const dir = mkdtempSync(join(tmpdir(), "muse-setup-routes-"));
  const credentialsFile = join(dir, "messaging.json");
  const registry = new MessagingProviderRegistry();
  const env = { MUSE_DOT_DIR_SENTINEL: dir, ...options.env };
  const server = Fastify({ logger: false });
  registerMessagingSetupRoutes(server, {
    credentialsFile,
    env,
    registry,
    ...(options.verify
      ? { verifyToken: async (providerId, token, verifyOptions) => options.verify!(providerId, token, verifyOptions) }
      : {})
  });
  return { credentialsFile, registry, server };
}

describe("/api/messaging/setup", () => {
  it("GET lists the five connectable providers, unconfigured on a fresh box", async () => {
    const { server } = build({});
    const response = await server.inject({ method: "GET", url: "/api/messaging/setup" });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { providers: { id: string; configured: boolean; source: string | null }[] };
    expect(body.providers.map((p) => p.id)).toEqual(["telegram", "discord", "slack", "line", "matrix"]);
    expect(body.providers.every((p) => !p.configured && p.source === null)).toBe(true);
  });

  it("GET reports an env-sourced token as configured (without ever echoing it)", async () => {
    const { server } = build({ env: { MUSE_TELEGRAM_BOT_TOKEN: "123:secret" } });
    const response = await server.inject({ method: "GET", url: "/api/messaging/setup" });
    const body = response.json() as { providers: { id: string; configured: boolean; source: string | null }[] };
    const telegram = body.providers.find((p) => p.id === "telegram");
    expect(telegram).toMatchObject({ configured: true, source: "env" });
    expect(response.body).not.toContain("123:secret");
  });

  it("POST verifies, persists, and hot-registers a valid token", async () => {
    const seen: string[] = [];
    const { credentialsFile, registry, server } = build({
      verify: (providerId, token) => {
        seen.push(`${providerId}:${token}`);
        return { account: "@muse_bot", ok: true };
      }
    });
    const response = await server.inject({
      method: "POST",
      payload: { token: "123:abc" },
      url: "/api/messaging/setup/telegram"
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ account: "@muse_bot", ok: true });
    expect(seen).toEqual(["telegram:123:abc"]);
    expect(registry.has("telegram")).toBe(true);
    const store = new FileMessagingCredentialStore(credentialsFile);
    expect(await store.load("telegram")).toEqual({ token: "123:abc" });
  });

  it("POST with a failing verification saves NOTHING and registers NOTHING (fail-close)", async () => {
    const { credentialsFile, registry, server } = build({
      verify: () => ({ ok: false, reason: "Unauthorized" })
    });
    const response = await server.inject({
      method: "POST",
      payload: { token: "bad" },
      url: "/api/messaging/setup/telegram"
    });
    expect(response.statusCode).toBe(400);
    expect((response.json() as { reason?: string }).reason).toContain("Unauthorized");
    expect(registry.has("telegram")).toBe(false);
    const store = new FileMessagingCredentialStore(credentialsFile);
    expect(await store.load("telegram")).toBeUndefined();
  });

  it("POST with a blank token 400s without calling the verifier", async () => {
    const { server } = build({
      verify: () => {
        throw new Error("must not verify");
      }
    });
    const response = await server.inject({
      method: "POST",
      payload: { token: "   " },
      url: "/api/messaging/setup/telegram"
    });
    expect(response.statusCode).toBe(400);
  });

  it("POST to an unknown provider 404s", async () => {
    const { server } = build({ verify: () => ({ ok: true }) });
    const response = await server.inject({
      method: "POST",
      payload: { token: "t" },
      url: "/api/messaging/setup/smoke-signals"
    });
    expect(response.statusCode).toBe(404);
  });

  it("POST matrix verifies with the homeserver URL, persists BOTH fields, and hot-registers", async () => {
    const seen: { providerId: string; token: string; homeserverUrl?: string }[] = [];
    const { credentialsFile, registry, server } = build({
      verify: (providerId, token, verifyOptions) => {
        seen.push({ providerId, token, ...(verifyOptions?.homeserverUrl ? { homeserverUrl: verifyOptions.homeserverUrl } : {}) });
        return { account: "@muse:hs.test", ok: true };
      }
    });
    const response = await server.inject({
      method: "POST",
      payload: { homeserverUrl: "https://hs.test", token: "syt_tok" },
      url: "/api/messaging/setup/matrix"
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ account: "@muse:hs.test", ok: true });
    expect(seen).toEqual([{ homeserverUrl: "https://hs.test", providerId: "matrix", token: "syt_tok" }]);
    expect(registry.has("matrix")).toBe(true);
    const store = new FileMessagingCredentialStore(credentialsFile);
    expect(await store.load("matrix")).toEqual({ homeserverUrl: "https://hs.test", token: "syt_tok" });
  });

  it("POST matrix without a homeserver URL 400s fail-close: no verify, no save, no register", async () => {
    const { credentialsFile, registry, server } = build({
      verify: () => {
        throw new Error("must not verify");
      }
    });
    const response = await server.inject({
      method: "POST",
      payload: { token: "syt_tok" },
      url: "/api/messaging/setup/matrix"
    });
    expect(response.statusCode).toBe(400);
    expect((response.json() as { reason?: string }).reason).toContain("homeserver");
    expect(registry.has("matrix")).toBe(false);
    const store = new FileMessagingCredentialStore(credentialsFile);
    expect(await store.load("matrix")).toBeUndefined();
  });

  it("POST matrix with a failing verification saves NOTHING (fail-close)", async () => {
    const { credentialsFile, registry, server } = build({
      verify: () => ({ ok: false, reason: "Invalid access token" })
    });
    const response = await server.inject({
      method: "POST",
      payload: { homeserverUrl: "https://hs.test", token: "bad" },
      url: "/api/messaging/setup/matrix"
    });
    expect(response.statusCode).toBe(400);
    expect(registry.has("matrix")).toBe(false);
    const store = new FileMessagingCredentialStore(credentialsFile);
    expect(await store.load("matrix")).toBeUndefined();
  });

  it("DELETE removes a file-sourced credential and unregisters the live provider", async () => {
    const { credentialsFile, registry, server } = build({ verify: () => ({ ok: true }) });
    await server.inject({ method: "POST", payload: { token: "123:abc" }, url: "/api/messaging/setup/telegram" });
    expect(registry.has("telegram")).toBe(true);

    const response = await server.inject({ method: "DELETE", url: "/api/messaging/setup/telegram" });
    expect(response.statusCode).toBe(200);
    expect(registry.has("telegram")).toBe(false);
    const store = new FileMessagingCredentialStore(credentialsFile);
    expect(await store.load("telegram")).toBeUndefined();
  });

  it("DELETE on an env-sourced credential 409s and leaves the provider registered", async () => {
    const { registry, server } = build({ env: { MUSE_TELEGRAM_BOT_TOKEN: "123:env" }, verify: () => ({ ok: true }) });
    registry.register({
      describe: () => ({ description: "stub", displayName: "Telegram", id: "telegram" }),
      id: "telegram",
      send: async () => ({ destination: "d", messageId: "m", providerId: "telegram" })
    });
    const response = await server.inject({ method: "DELETE", url: "/api/messaging/setup/telegram" });
    expect(response.statusCode).toBe(409);
    expect(registry.has("telegram")).toBe(true);
  });
});

describe("onConnected hot-start hook", () => {
  it("fires after a verified connect and never on a failed one", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-setup-hook-"));
    const registry = new MessagingProviderRegistry();
    const connected: string[] = [];
    const server = Fastify({ logger: false });
    registerMessagingSetupRoutes(server, {
      credentialsFile: join(dir, "messaging.json"),
      env: {},
      onConnected: (providerId) => {
        connected.push(providerId);
      },
      registry,
      verifyToken: async (_providerId, token) =>
        token === "good" ? { ok: true } : { ok: false, reason: "bad token" }
    });

    await server.inject({ method: "POST", payload: { token: "bad" }, url: "/api/messaging/setup/telegram" });
    expect(connected).toEqual([]);

    await server.inject({ method: "POST", payload: { token: "good" }, url: "/api/messaging/setup/telegram" });
    expect(connected).toEqual(["telegram"]);
  });
});

describe("POST /api/messaging/setup/:providerId/test-send", () => {
  function buildWithOwner(_options: { readonly owner?: string } = {}) {
    const dir = mkdtempSync(join(tmpdir(), "muse-testsend-"));
    const sent: { destination: string; text: string }[] = [];
    const registry = new MessagingProviderRegistry([{
      describe: () => ({ description: "stub", displayName: "Telegram", id: "telegram" }),
      id: "telegram",
      send: async (message) => {
        sent.push({ destination: message.destination, text: message.text });
        return { destination: message.destination, messageId: "m1", providerId: "telegram" };
      }
    }]);
    const ownersFile = join(dir, "channel-owners.json");
    const server = Fastify({ logger: false });
    registerMessagingSetupRoutes(server, {
      credentialsFile: join(dir, "messaging.json"),
      env: { MUSE_CHANNEL_OWNERS_FILE: ownersFile },
      registry,
      verifyToken: async () => ({ ok: true })
    });
    return { ownersFile, sent, server };
  }

  it("sends a hello to the PAIRED owner chat and echoes the destination", async () => {
    const { ownersFile, sent, server } = buildWithOwner();
    const { adoptChannelOwner } = await import("../src/channel-owner-store.js");
    await adoptChannelOwner(ownersFile, "telegram", "8303165569");

    const response = await server.inject({ method: "POST", url: "/api/messaging/setup/telegram/test-send" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ destination: "8303165569", ok: true });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.destination).toBe("8303165569");
    expect(sent[0]?.text.length).toBeGreaterThan(0);
  });

  it("409s when no chat has paired yet (nothing is sent — no guessed recipient)", async () => {
    const { sent, server } = buildWithOwner();
    const response = await server.inject({ method: "POST", url: "/api/messaging/setup/telegram/test-send" });
    expect(response.statusCode).toBe(409);
    expect(sent).toHaveLength(0);
  });

  it("404s for an unknown provider", async () => {
    const { server } = buildWithOwner();
    const response = await server.inject({ method: "POST", url: "/api/messaging/setup/smoke-signals/test-send" });
    expect(response.statusCode).toBe(404);
  });
});

describe("pairing surface", () => {
  it("GET exposes the paired owner chat per provider", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-pair-ui-"));
    const ownersFile = join(dir, "channel-owners.json");
    const { adoptChannelOwner } = await import("../src/channel-owner-store.js");
    await adoptChannelOwner(ownersFile, "telegram", "8303165569");
    const server = Fastify({ logger: false });
    registerMessagingSetupRoutes(server, {
      credentialsFile: join(dir, "messaging.json"),
      env: { MUSE_CHANNEL_OWNERS_FILE: ownersFile },
      registry: new MessagingProviderRegistry(),
      verifyToken: async () => ({ ok: true })
    });
    const response = await server.inject({ method: "GET", url: "/api/messaging/setup" });
    const body = response.json() as { providers: { id: string; pairedOwner?: string }[] };
    expect(body.providers.find((p) => p.id === "telegram")?.pairedOwner).toBe("8303165569");
    expect(body.providers.find((p) => p.id === "discord")?.pairedOwner).toBeUndefined();
  });

  it("DELETE …/pairing resets the owner so the NEXT chat re-pairs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-pair-reset-"));
    const ownersFile = join(dir, "channel-owners.json");
    const { adoptChannelOwner, readChannelOwner } = await import("../src/channel-owner-store.js");
    await adoptChannelOwner(ownersFile, "telegram", "8303165569");
    const server = Fastify({ logger: false });
    registerMessagingSetupRoutes(server, {
      credentialsFile: join(dir, "messaging.json"),
      env: { MUSE_CHANNEL_OWNERS_FILE: ownersFile },
      registry: new MessagingProviderRegistry(),
      verifyToken: async () => ({ ok: true })
    });
    const response = await server.inject({ method: "DELETE", url: "/api/messaging/setup/telegram/pairing" });
    expect(response.statusCode).toBe(200);
    expect(await readChannelOwner(ownersFile, "telegram")).toBeUndefined();
  });
});
