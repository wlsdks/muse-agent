import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  Auth,
  DefaultAuthProvider,
  InMemoryUserStore,
  JwtTokenProvider
} from "@muse/auth";
import {
  MessagingProviderRegistry,
  readOutboundEffect,
  type MessagingProvider,
  type OutboundMessage,
  type OutboundReceipt
} from "@muse/messaging";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildServer } from "../src/server.js";

let root: string;
let actionLogFile: string;
let effectFile: string;
let servers: FastifyInstance[];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "muse-api-message-effects-"));
  actionLogFile = join(root, "action-log.json");
  effectFile = join(root, "outbound-effects.json");
  servers = [];
});

afterEach(async () => {
  await Promise.all(servers.map((server) => server.close()));
  await rm(root, { force: true, recursive: true });
});

function registryWith(
  send: (message: OutboundMessage) => Promise<OutboundReceipt>
): MessagingProviderRegistry {
  const provider: MessagingProvider = {
    describe: () => ({ description: "test", displayName: "Test", id: "test" }),
    id: "test",
    send
  };
  return new MessagingProviderRegistry([provider]);
}

function serverWith(registry: MessagingProviderRegistry, options: Record<string, unknown> = {}): FastifyInstance {
  const server = buildServer({
    actionLogFile,
    logger: false,
    messaging: registry,
    ...options
  });
  servers.push(server);
  return server;
}

const payload = {
  destination: "C123",
  effectId: "effect-api-1",
  providerId: "test",
  text: "hello"
};

describe("POST /api/messaging/send durable effect contract", () => {
  it("authenticates before validating or creating an effect", async () => {
    const userStore = new InMemoryUserStore();
    const authService = new Auth({
      authProvider: new DefaultAuthProvider(userStore),
      jwt: new JwtTokenProvider({ jwtSecret: "0123456789abcdef0123456789abcdef" }),
      userStore
    });
    let calls = 0;
    const server = serverWith(registryWith(async (message) => {
      calls += 1;
      return { destination: message.destination, messageId: "m-1", providerId: "test" };
    }), { authService, requireAuth: true });

    const response = await server.inject({
      method: "POST",
      payload: {},
      url: "/api/messaging/send"
    });
    expect(response.statusCode).toBe(401);
    expect(calls).toBe(0);
    await expect(access(effectFile)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("requires a client-stable effectId before any provider or ledger mutation", async () => {
    let calls = 0;
    const server = serverWith(registryWith(async (message) => {
      calls += 1;
      return { destination: message.destination, messageId: "m-1", providerId: "test" };
    }));
    const response = await server.inject({
      method: "POST",
      payload: { destination: "C123", providerId: "test", text: "hello" },
      url: "/api/messaging/send"
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "INVALID_MESSAGING_REQUEST" });
    expect(calls).toBe(0);
    await expect(access(effectFile)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects oversized or control-character effect IDs before any provider or ledger mutation", async () => {
    let calls = 0;
    const server = serverWith(registryWith(async (message) => {
      calls += 1;
      return { destination: message.destination, messageId: "m-1", providerId: "test" };
    }));

    for (const effectId of ["x".repeat(257), "effect\nlog-injection", "effect\u0085terminal-control"]) {
      const response = await server.inject({
        method: "POST",
        payload: { ...payload, effectId },
        url: "/api/messaging/send"
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        code: "INVALID_MESSAGING_REQUEST",
        message: "effectId must be at most 256 UTF-8 bytes and contain no control characters"
      });
    }
    expect(calls).toBe(0);
    await expect(access(effectFile)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("returns an accepted receipt and a fresh server replay makes zero provider calls", async () => {
    let firstCalls = 0;
    const first = serverWith(registryWith(async (message) => {
      firstCalls += 1;
      return { destination: message.destination, messageId: "m-1", providerId: "test" };
    }));
    const accepted = await first.inject({
      method: "POST",
      payload,
      url: "/api/messaging/send"
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toEqual({
      destination: "C123",
      effectId: "effect-api-1",
      messageId: "m-1",
      providerId: "test"
    });
    expect(firstCalls).toBe(1);
    expect((await readOutboundEffect(effectFile, "effect-api-1"))?.state).toBe("accepted");

    const restarted = serverWith(new MessagingProviderRegistry());
    const replay = await restarted.inject({
      method: "POST",
      payload,
      url: "/api/messaging/send"
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ effectId: "effect-api-1", messageId: "m-1" });

    const drift = await restarted.inject({
      method: "POST",
      payload: { ...payload, providerId: "removed-provider" },
      url: "/api/messaging/send"
    });
    expect(drift.statusCode).toBe(409);
    expect(drift.json()).toMatchObject({
      code: "OUTBOUND_EFFECT_ID_CONFLICT",
      effectId: "effect-api-1"
    });
  });

  it("records success-before-ack as unknown and restart replay never sends again", async () => {
    let firstCalls = 0;
    const first = serverWith(registryWith(async () => {
      firstCalls += 1;
      throw new Error("timeout after provider accepted");
    }));
    const unknown = await first.inject({
      method: "POST",
      payload,
      url: "/api/messaging/send"
    });
    expect(unknown.statusCode).toBe(409);
    expect(unknown.json()).toMatchObject({
      code: "OUTBOUND_EFFECT_UNKNOWN",
      effectId: "effect-api-1"
    });
    expect(unknown.json().message).toContain("do not retry with a new effectId");
    expect(firstCalls).toBe(1);

    let replayCalls = 0;
    const restarted = serverWith(registryWith(async () => {
      replayCalls += 1;
      throw new Error("must not run");
    }));
    const replay = await restarted.inject({
      method: "POST",
      payload,
      url: "/api/messaging/send"
    });
    expect(replay.statusCode).toBe(409);
    expect(replay.json()).toMatchObject({ code: "OUTBOUND_EFFECT_UNKNOWN" });
    expect(replayCalls).toBe(0);
  });

  it("rejects same-ID payload drift with zero additional provider calls", async () => {
    let calls = 0;
    const server = serverWith(registryWith(async (message) => {
      calls += 1;
      return { destination: message.destination, messageId: "m-1", providerId: "test" };
    }));
    expect((await server.inject({
      method: "POST",
      payload,
      url: "/api/messaging/send"
    })).statusCode).toBe(200);

    const drift = await server.inject({
      method: "POST",
      payload: { ...payload, text: "different" },
      url: "/api/messaging/send"
    });
    expect(drift.statusCode).toBe(409);
    expect(drift.json()).toMatchObject({
      code: "OUTBOUND_EFFECT_ID_CONFLICT",
      effectId: "effect-api-1"
    });
    expect(calls).toBe(1);
  });
});
