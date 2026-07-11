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
  readonly verify?: (providerId: string, token: string) => TokenVerification;
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
    ...(options.verify ? { verifyToken: async (providerId, token) => options.verify!(providerId, token) } : {})
  });
  return { credentialsFile, registry, server };
}

describe("/api/messaging/setup", () => {
  it("GET lists the four connectable providers, unconfigured on a fresh box", async () => {
    const { server } = build({});
    const response = await server.inject({ method: "GET", url: "/api/messaging/setup" });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { providers: { id: string; configured: boolean; source: string | null }[] };
    expect(body.providers.map((p) => p.id)).toEqual(["telegram", "discord", "slack", "line"]);
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
