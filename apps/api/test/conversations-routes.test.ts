import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FileConversationStore } from "@muse/stores";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";

import { CONVERSATION_DETAIL_TURN_CAP, registerConversationsRoutes } from "../src/conversations-routes.js";
import { buildServer } from "../src/server.js";
import { createAuthService } from "./helpers/test-auth.js";

function tmpConversationsFile(): string {
  return join(mkdtempSync(join(tmpdir(), "muse-conversations-routes-")), "conversations.json");
}

describe("GET /api/conversations", () => {
  it("lists summaries newest-first, without turns", async () => {
    const conversationStore = new FileConversationStore({ file: tmpConversationsFile() });
    await conversationStore.appendTurns("conv_older", [{ content: "hi", role: "user" }], { origin: "cli" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await conversationStore.appendTurns("conv_newer", [{ content: "hey", role: "user" }], { origin: "web" });

    const server = Fastify({ logger: false });
    registerConversationsRoutes(server, { conversationStore });
    const response = await server.inject({ method: "GET", url: "/api/conversations" });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { conversations: Array<Record<string, unknown>> };
    expect(body.conversations.map((c) => c.id)).toEqual(["conv_newer", "conv_older"]);
    expect(body.conversations[0]).toEqual({
      createdAt: expect.any(String),
      id: "conv_newer",
      origin: "web",
      title: "hey",
      turnCount: 1,
      updatedAt: expect.any(String)
    });
    expect(body.conversations[0]).not.toHaveProperty("turns");
  });

  it("empty store returns an empty list, never a 500", async () => {
    const conversationStore = new FileConversationStore({ file: tmpConversationsFile() });
    const server = Fastify({ logger: false });
    registerConversationsRoutes(server, { conversationStore });
    const response = await server.inject({ method: "GET", url: "/api/conversations" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ conversations: [] });
  });
});

describe("GET /api/conversations/:id", () => {
  it("returns the summary fields plus turns for a known id", async () => {
    const conversationStore = new FileConversationStore({ file: tmpConversationsFile() });
    await conversationStore.appendTurns(
      "conv_abc123",
      [
        { content: "hello", role: "user" },
        { content: "hi there", role: "assistant" }
      ],
      { origin: "cli" }
    );

    const server = Fastify({ logger: false });
    registerConversationsRoutes(server, { conversationStore });
    const response = await server.inject({ method: "GET", url: "/api/conversations/conv_abc123" });

    expect(response.statusCode).toBe(200);
    const body = response.json() as Record<string, unknown>;
    expect(body.id).toBe("conv_abc123");
    expect(body.origin).toBe("cli");
    expect(body.turns).toHaveLength(2);
  });

  it("unknown id → 404 with a reason, never a 500", async () => {
    const conversationStore = new FileConversationStore({ file: tmpConversationsFile() });
    const server = Fastify({ logger: false });
    registerConversationsRoutes(server, { conversationStore });
    const response = await server.inject({ method: "GET", url: "/api/conversations/conv_nope" });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ reason: expect.stringContaining("conv_nope") });
  });

  it("a telegram-origin id (with a colon) round-trips through the URL-encoded :id param", async () => {
    const conversationStore = new FileConversationStore({ file: tmpConversationsFile() });
    await conversationStore.appendTurns("telegram:123", [{ content: "hi", role: "user" }], { origin: "telegram" });

    const server = Fastify({ logger: false });
    registerConversationsRoutes(server, { conversationStore });
    const response = await server.inject({
      method: "GET",
      url: `/api/conversations/${encodeURIComponent("telegram:123")}`
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as Record<string, unknown>;
    expect(body.id).toBe("telegram:123");
    expect(body.origin).toBe("telegram");
  });

  it("caps turns to CONVERSATION_DETAIL_TURN_CAP on a very long conversation", async () => {
    const conversationStore = new FileConversationStore({ file: tmpConversationsFile() });
    const turns = Array.from({ length: CONVERSATION_DETAIL_TURN_CAP + 20 }, (_unused, index) => ({
      content: `turn-${String(index)}`,
      role: (index % 2 === 0 ? "user" : "assistant") as "user" | "assistant"
    }));
    await conversationStore.appendTurns("conv_long", turns, { origin: "cli" });

    const server = Fastify({ logger: false });
    registerConversationsRoutes(server, { conversationStore });
    const response = await server.inject({ method: "GET", url: "/api/conversations/conv_long" });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { turns: Array<{ content: string }> };
    expect(body.turns).toHaveLength(CONVERSATION_DETAIL_TURN_CAP);
    expect(body.turns[body.turns.length - 1]?.content).toBe(`turn-${String(turns.length - 1)}`);
  });
});

describe("/api/conversations — auth gate", () => {
  it("401s without a bearer token when requireAuth is on, and 200s with a valid one", async () => {
    const authService = createAuthService();
    const registered = authService.register({ email: "owner@example.com", name: "Owner", password: "password-1" });
    const server = buildServer({
      authService,
      conversationsFile: tmpConversationsFile(),
      logger: false,
      requireAuth: true
    });

    const anon = await server.inject({ method: "GET", url: "/api/conversations" });
    expect(anon.statusCode).toBe(401);

    const authed = await server.inject({
      headers: { authorization: `Bearer ${registered.token}` },
      method: "GET",
      url: "/api/conversations"
    });
    expect(authed.statusCode).toBe(200);
    expect(authed.json()).toEqual({ conversations: [] });
  });
});
