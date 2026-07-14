import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { createAgentRuntime } from "@muse/agent-core";
import { FileConversationStore } from "@muse/stores";
import type { ModelProvider } from "@muse/model";

import { buildServer } from "../src/server.js";

// AC1/AC5: the shared conversation store threads through the single-`message`
// chat body — a second post with the returned conversationId sees the first
// exchange, an explicit {messages:[...]} body bypasses it entirely, a corrupt/
// unknown id fails soft (never a 500), and a failed run persists nothing.

function tmpConversationsFile(): string {
  return join(mkdtempSync(join(tmpdir(), "muse-conv-continuity-")), "conversations.json");
}

function recordingProvider(replyPrefix: string, seen: Array<readonly { role: string; content: string }[]>): ModelProvider {
  return {
    id: "test",
    async generate(request) {
      seen.push(request.messages.map((m) => ({ content: m.content, role: m.role })));
      return { id: "r1", model: request.model, output: `${replyPrefix}${seen.length.toString()}` };
    },
    async listModels() {
      return [];
    },
    async *stream(request) {
      seen.push(request.messages.map((m) => ({ content: m.content, role: m.role })));
      const output = `${replyPrefix}${seen.length.toString()}`;
      yield { text: output, type: "text-delta" as const };
      yield { response: { id: "r1", model: request.model, output }, runId: "r", type: "done" as const };
    }
  };
}

function failingProvider(): ModelProvider {
  return {
    id: "test-fail",
    async generate() {
      throw new Error("boom");
    },
    async listModels() {
      return [];
    },
    stream() {
      throw new Error("boom");
    }
  } satisfies ModelProvider;
}

describe("chat conversation continuity — AC1", () => {
  it("a second {message} post with the returned conversationId sees the first exchange as prior context", async () => {
    const conversationsFile = tmpConversationsFile();
    const seen: Array<readonly { role: string; content: string }[]> = [];
    const server = buildServer({
      agentRuntime: createAgentRuntime({ modelProvider: recordingProvider("answer-", seen) }),
      conversationsFile,
      defaultModel: "provider/model",
      logger: false
    });

    const first = await server.inject({
      method: "POST",
      payload: { message: "my name is Sam" },
      url: "/api/chat"
    });
    expect(first.statusCode).toBe(200);
    const firstBody = first.json() as { conversationId?: string; content?: string };
    expect(typeof firstBody.conversationId).toBe("string");
    expect(firstBody.content).toBe("answer-1");

    const second = await server.inject({
      method: "POST",
      payload: { conversationId: firstBody.conversationId, message: "what's my name?" },
      url: "/api/chat"
    });
    expect(second.statusCode).toBe(200);
    const secondBody = second.json() as { conversationId?: string };
    expect(secondBody.conversationId).toBe(firstBody.conversationId);

    // The SECOND model call's input carries the first exchange verbatim (a
    // persona system prompt may also ride along — irrelevant here).
    expect(seen[1]?.filter((m) => m.role !== "system")).toEqual([
      { content: "my name is Sam", role: "user" },
      { content: "answer-1", role: "assistant" },
      { content: "what's my name?", role: "user" }
    ]);

    const store = new FileConversationStore({ file: conversationsFile });
    const conversation = await store.get(firstBody.conversationId!);
    expect(conversation?.origin).toBe("web");
    expect(conversation?.turns.map((t) => t.content)).toEqual([
      "my name is Sam",
      "answer-1",
      "what's my name?",
      "answer-2"
    ]);
  });

  it("an explicit {messages:[...]} body bypasses the store entirely — nothing persisted, no conversationId in the response", async () => {
    const conversationsFile = tmpConversationsFile();
    const seen: Array<readonly { role: string; content: string }[]> = [];
    const server = buildServer({
      agentRuntime: createAgentRuntime({ modelProvider: recordingProvider("answer-", seen) }),
      conversationsFile,
      defaultModel: "provider/model",
      logger: false
    });

    const res = await server.inject({
      method: "POST",
      payload: { messages: [{ content: "hi there", role: "user" }] },
      url: "/api/chat"
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).not.toHaveProperty("conversationId");

    const store = new FileConversationStore({ file: conversationsFile });
    expect(await store.list()).toEqual([]);
  });

  it("an unknown conversationId is treated as new — fail-soft, never a 500, and adopts the client's id", async () => {
    const conversationsFile = tmpConversationsFile();
    const seen: Array<readonly { role: string; content: string }[]> = [];
    const server = buildServer({
      agentRuntime: createAgentRuntime({ modelProvider: recordingProvider("answer-", seen) }),
      conversationsFile,
      defaultModel: "provider/model",
      logger: false
    });

    const res = await server.inject({
      method: "POST",
      payload: { conversationId: "conv_doesnotexist", message: "hello" },
      url: "/api/chat"
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { conversationId?: string };
    expect(body.conversationId).toBe("conv_doesnotexist");
    // No prior turns were fabricated for the unknown id.
    expect(seen[0]?.filter((m) => m.role !== "system")).toEqual([{ content: "hello", role: "user" }]);
  });

  it("a corrupt conversations file fails soft — the request still succeeds (never a 500)", async () => {
    const conversationsFile = tmpConversationsFile();
    writeFileSync(conversationsFile, "not json at all");
    const seen: Array<readonly { role: string; content: string }[]> = [];
    const server = buildServer({
      agentRuntime: createAgentRuntime({ modelProvider: recordingProvider("answer-", seen) }),
      conversationsFile,
      defaultModel: "provider/model",
      logger: false
    });

    const res = await server.inject({
      method: "POST",
      payload: { conversationId: "conv_whatever", message: "hello" },
      url: "/api/chat"
    });
    expect(res.statusCode).toBe(200);
  });
});

describe("chat conversation continuity — AC5 safety", () => {
  it("a failed agent run appends NOTHING to the conversation", async () => {
    const conversationsFile = tmpConversationsFile();
    const server = buildServer({
      agentRuntime: createAgentRuntime({ modelProvider: failingProvider() }),
      conversationsFile,
      defaultModel: "provider/model",
      logger: false
    });

    const res = await server.inject({
      method: "POST",
      payload: { message: "this will fail" },
      url: "/api/chat"
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);

    const store = new FileConversationStore({ file: conversationsFile });
    expect(await store.list()).toEqual([]);
  });

  it("the streaming path ALSO persists only after a successful done frame, and carries conversationId on the grounding frame", async () => {
    const conversationsFile = tmpConversationsFile();
    const seen: Array<readonly { role: string; content: string }[]> = [];
    const server = buildServer({
      agentRuntime: createAgentRuntime({ modelProvider: recordingProvider("streamed-", seen) }),
      conversationsFile,
      defaultModel: "provider/model",
      logger: false
    });

    const res = await server.inject({
      method: "POST",
      payload: { message: "stream please" },
      url: "/api/chat/stream"
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("event: grounding");
    const groundingLine = res.body.split("\n").find((line) => line.startsWith("data: ") && line.includes("conversationId"));
    expect(groundingLine).toBeTruthy();
    const payload = JSON.parse(groundingLine!.slice("data: ".length)) as { conversationId?: string };
    expect(typeof payload.conversationId).toBe("string");

    const store = new FileConversationStore({ file: conversationsFile });
    const conversation = await store.get(payload.conversationId!);
    expect(conversation?.turns.map((t) => t.role)).toEqual(["user", "assistant"]);
  });

  it("CLI (direct store) and web (API route) appends to the SAME conversation interleave without corrupting either write", async () => {
    const conversationsFile = tmpConversationsFile();
    const seen: Array<readonly { role: string; content: string }[]> = [];
    const server = buildServer({
      agentRuntime: createAgentRuntime({ modelProvider: recordingProvider("web-answer-", seen) }),
      conversationsFile,
      defaultModel: "provider/model",
      logger: false
    });
    const directStore = new FileConversationStore({ file: conversationsFile });
    const sharedId = directStore.newId();

    await Promise.all([
      server.inject({
        method: "POST",
        payload: { conversationId: sharedId, message: "from the web" },
        url: "/api/chat"
      }),
      directStore.appendTurns(sharedId, [
        { content: "from the CLI", role: "user" },
        { content: "cli reply", role: "assistant" }
      ], { origin: "cli" })
    ]);

    const conversation = await directStore.get(sharedId);
    expect(conversation?.turns).toHaveLength(4);
    const contents = conversation?.turns.map((t) => t.content) ?? [];
    expect(contents).toContain("from the web");
    expect(contents).toContain("from the CLI");
    expect(contents).toContain("cli reply");
  });
});
