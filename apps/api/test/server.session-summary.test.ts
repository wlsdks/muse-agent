import { describe, expect, it } from "vitest";
import { InMemoryConversationSummaryStore } from "@muse/memory";
import { buildServer } from "../src/server.js";

describe("api server: conversation summary endpoints", () => {
  it("GET /api/admin/sessions/:sessionId/summary returns the persisted summary", async () => {
    const conversationSummaryStore = new InMemoryConversationSummaryStore();
    await conversationSummaryStore.save({
      narrative: "[Conversation summary: stored]",
      sessionId: "sess-get-1",
      summarizedUpToIndex: 7
    });
    const server = buildServer({ conversationSummaryStore, logger: false });
    const response = await server.inject({ method: "GET", url: "/api/admin/sessions/sess-get-1/summary" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      narrative: "[Conversation summary: stored]",
      sessionId: "sess-get-1",
      summarizedUpToIndex: 7
    });
  });

  it("GET /api/admin/sessions/:sessionId/summary returns 404 when no summary stored", async () => {
    const server = buildServer({ conversationSummaryStore: new InMemoryConversationSummaryStore(), logger: false });
    const response = await server.inject({ method: "GET", url: "/api/admin/sessions/missing/summary" });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: "CONVERSATION_SUMMARY_NOT_FOUND" });
  });

  it("returns CONVERSATION_SUMMARY_STORE_UNAVAILABLE when no store is configured", async () => {
    const server = buildServer({ logger: false });
    const response = await server.inject({ method: "GET", url: "/api/admin/sessions/x/summary" });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: "CONVERSATION_SUMMARY_STORE_UNAVAILABLE" });
  });

  it("PUT /api/admin/sessions/:sessionId/summary persists narrative + summarizedUpToIndex", async () => {
    const conversationSummaryStore = new InMemoryConversationSummaryStore();
    const server = buildServer({ conversationSummaryStore, logger: false });
    const response = await server.inject({
      method: "PUT",
      payload: { narrative: "Operator-edited narrative", summarizedUpToIndex: 12 },
      url: "/api/admin/sessions/sess-put-1/summary"
    });
    expect(response.statusCode).toBe(200);
    expect(await conversationSummaryStore.get("sess-put-1")).toMatchObject({
      narrative: "Operator-edited narrative",
      sessionId: "sess-put-1",
      summarizedUpToIndex: 12
    });
  });

  it("PUT /api/admin/sessions/:sessionId/summary rejects empty narrative", async () => {
    const server = buildServer({
      conversationSummaryStore: new InMemoryConversationSummaryStore(),
      logger: false
    });
    const response = await server.inject({
      method: "PUT",
      payload: { narrative: "   " },
      url: "/api/admin/sessions/sess-bad/summary"
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "INVALID_CONVERSATION_SUMMARY" });
  });

  it("DELETE /api/admin/sessions/:sessionId/summary returns 204 when removed and 404 when absent", async () => {
    const conversationSummaryStore = new InMemoryConversationSummaryStore();
    await conversationSummaryStore.save({ narrative: "x", sessionId: "del-1", summarizedUpToIndex: 0 });
    const server = buildServer({ conversationSummaryStore, logger: false });

    const removed = await server.inject({ method: "DELETE", url: "/api/admin/sessions/del-1/summary" });
    expect(removed.statusCode).toBe(204);

    const absent = await server.inject({ method: "DELETE", url: "/api/admin/sessions/del-1/summary" });
    expect(absent.statusCode).toBe(404);
  });
});
