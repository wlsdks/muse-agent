/**
 * Coverage for the on-demand pull endpoint `POST /api/messaging/poll`,
 * shared with the `muse.messaging.poll_now` MCP tool. The
 * route is only registered when a `messagingPollNow` dispatcher is
 * threaded through ServerOptions — without one, it 404s, which lets
 * fresh installs / tests stay quiet.
 */

import { MAX_READ_LIMIT, MessagingProviderError, MessagingProviderRegistry } from "@muse/messaging";
import { describe, expect, it } from "vitest";

import { buildServer } from "../src/server.js";

function buildMessagingRegistryWithStub(): MessagingProviderRegistry {
  const registry = new MessagingProviderRegistry();
  registry.register({
    describe: () => ({ description: "stub", displayName: "Stub", id: "stub" }),
    id: "stub",
    send: async () => { throw new Error("not used"); }
  });
  return registry;
}

describe("POST /api/messaging/poll", () => {
  it("404s when no messagingPollNow dispatcher is wired (default boot)", async () => {
    const server = buildServer({
      logger: false,
      messaging: buildMessagingRegistryWithStub()
    });
    const response = await server.inject({
      method: "POST",
      payload: { providerId: "telegram" },
      url: "/api/messaging/poll"
    });
    expect(response.statusCode).toBe(404);
  });

  it("invokes the dispatcher and returns 200 with ingested count", async () => {
    const calls: { providerId: string; source?: string }[] = [];
    const server = buildServer({
      logger: false,
      messaging: buildMessagingRegistryWithStub(),
      messagingPollNow: async (providerId, source) => {
        calls.push({ providerId, ...(source !== undefined ? { source } : {}) });
        return { ingested: 2 };
      }
    });
    const response = await server.inject({
      method: "POST",
      payload: { providerId: "telegram" },
      url: "/api/messaging/poll"
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ingested: 2, providerId: "telegram" });
    expect(calls).toEqual([{ providerId: "telegram" }]);
  });

  it("threads `source` through for per-channel providers", async () => {
    let seen: { providerId: string; source?: string } | null = null;
    const server = buildServer({
      logger: false,
      messaging: buildMessagingRegistryWithStub(),
      messagingPollNow: async (providerId, source) => {
        seen = { providerId, ...(source !== undefined ? { source } : {}) };
        return { ingested: 0 };
      }
    });
    const response = await server.inject({
      method: "POST",
      payload: { providerId: "discord", source: "ch-9" },
      url: "/api/messaging/poll"
    });
    expect(response.statusCode).toBe(200);
    expect(seen).toEqual({ providerId: "discord", source: "ch-9" });
  });

  it("rejects missing providerId with 400 before invoking the dispatcher", async () => {
    let called = 0;
    const server = buildServer({
      logger: false,
      messaging: buildMessagingRegistryWithStub(),
      messagingPollNow: async () => { called += 1; return { ingested: 0 }; }
    });
    const response = await server.inject({
      method: "POST",
      payload: {},
      url: "/api/messaging/poll"
    });
    expect(response.statusCode).toBe(400);
    expect(called).toBe(0);
  });

  it("surfaces dispatcher errors as 400 with the message verbatim", async () => {
    const server = buildServer({
      logger: false,
      messaging: buildMessagingRegistryWithStub(),
      messagingPollNow: async () => { throw new Error("source (channel id) is required for discord"); }
    });
    const response = await server.inject({
      method: "POST",
      payload: { providerId: "discord" },
      url: "/api/messaging/poll"
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().message).toContain("source (channel id) is required");
  });

  it("POST /api/messaging/poll-all 404s when no messagingPollAll dispatcher is wired", async () => {
    const server = buildServer({
      logger: false,
      messaging: buildMessagingRegistryWithStub()
    });
    const response = await server.inject({
      method: "POST",
      payload: {},
      url: "/api/messaging/poll-all"
    });
    expect(response.statusCode).toBe(404);
  });

  it("POST /api/messaging/poll-all returns 200 with per-provider counts + errors", async () => {
    let called = 0;
    const server = buildServer({
      logger: false,
      messaging: buildMessagingRegistryWithStub(),
      messagingPollAll: async () => {
        called += 1;
        return {
          errors: [{ message: "channel ch-bad: not_found", providerId: "discord" }],
          ingestedByProvider: { discord: 1, slack: 0, telegram: 3 }
        };
      }
    });
    const response = await server.inject({
      method: "POST",
      payload: {},
      url: "/api/messaging/poll-all"
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      errors: [{ message: "channel ch-bad: not_found", providerId: "discord" }],
      ingestedByProvider: { discord: 1, slack: 0, telegram: 3 }
    });
    expect(called).toBe(1);
  });

  it("POST /api/messaging/poll-all returns a generic 500 without leaking the raw error", async () => {
    const server = buildServer({
      logger: false,
      messaging: buildMessagingRegistryWithStub(),
      messagingPollAll: async () => {
        throw new Error("ECONNREFUSED 10.0.0.5:6379 /Users/internal/secret/path");
      }
    });
    const response = await server.inject({
      method: "POST",
      payload: {},
      url: "/api/messaging/poll-all"
    });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ code: "MESSAGING_POLL_ALL_FAILED", message: "messaging poll-all failed" });
    // The raw internal detail must never reach the network client.
    expect(response.body).not.toContain("ECONNREFUSED");
    expect(response.body).not.toContain("/Users/internal/secret/path");
  });

  it("upstream MessagingProviderError becomes 502 with provider details", async () => {
    const server = buildServer({
      logger: false,
      messaging: buildMessagingRegistryWithStub(),
      messagingPollNow: async () => {
        throw new MessagingProviderError("telegram", "UPSTREAM_FAILED", "Telegram getUpdates failed: 503", 503);
      }
    });
    const response = await server.inject({
      method: "POST",
      payload: { providerId: "telegram" },
      url: "/api/messaging/poll"
    });
    expect(response.statusCode).toBe(502);
    expect(response.json()).toMatchObject({
      code: "MESSAGING_PROVIDER_FAILED",
      providerId: "telegram",
      upstreamStatus: 503
    });
  });
});

describe("GET /api/messaging/inbox limit normalisation", () => {
  function registryCapturing(received: (number | undefined)[]): MessagingProviderRegistry {
    const registry = new MessagingProviderRegistry();
    registry.register({
      describe: () => ({ description: "cap", displayName: "Cap", id: "cap" }),
      fetchInbound: async (options) => {
        received.push(options?.limit);
        return [];
      },
      id: "cap",
      send: async () => { throw new Error("not used"); }
    });
    return registry;
  }

  it("clamps a negative / zero / float / unbounded ?limit at the HTTP boundary", async () => {
    for (const [raw, expected] of [
      ["-5", 1],
      ["0", 1],
      ["5.9", 5],
      ["99999", MAX_READ_LIMIT],
      ["50", 50]
    ] as const) {
      const received: (number | undefined)[] = [];
      const server = buildServer({ logger: false, messaging: registryCapturing(received) });
      const response = await server.inject({
        method: "GET",
        url: `/api/messaging/inbox?providerId=cap&limit=${raw}`
      });
      expect(response.statusCode).toBe(200);
      expect(received).toEqual([expected]);
    }
  });

  it("drops a non-numeric ?limit instead of forwarding NaN to the provider", async () => {
    const received: (number | undefined)[] = [];
    const server = buildServer({ logger: false, messaging: registryCapturing(received) });
    const response = await server.inject({
      method: "GET",
      url: "/api/messaging/inbox?providerId=cap&limit=abc"
    });
    expect(response.statusCode).toBe(200);
    expect(received).toEqual([undefined]);
  });
});
