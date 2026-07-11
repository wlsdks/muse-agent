import { describe, expect, it } from "vitest";
import { createAgentRuntime } from "@muse/agent-core";
import type { ModelProvider } from "@muse/model";
import { InMemoryTraceEventSink, PersistedMuseTracer } from "@muse/observability";
import { InMemoryAgentRunHistoryStore } from "@muse/runtime-state";
import { ToolRegistry } from "@muse/tools";
import { buildServer } from "../src/server.js";
import { createAuthService } from "./helpers/test-auth.js";

describe("api server: chat / SSE / multipart", () => {
  it("records diagnostic chat trace events in a queryable persisted sink", async () => {
    const traceSink = new InMemoryTraceEventSink();
    const tracer = new PersistedMuseTracer(traceSink);
    const agentRuntime = createAgentRuntime({
      modelProvider: createProvider("Diagnostic response"),
      tracer
    });
    const server = buildServer({
      admin: {
        observability: {
          traceSink
        }
      },
      agentRuntime,
      defaultModel: "provider/model",
      logger: false
    });

    const chat = await server.inject({
      headers: { "content-type": "application/json" },
      method: "POST",
      payload: {
        message: "diagnostic trace",
        runId: "diagnostic-trace-run"
      },
      url: "/api/chat"
    });
    await tracer.flush();
    const traces = await server.inject({
      method: "GET",
      url: "/api/admin/traces/diagnostic-trace-run/spans"
    });

    expect(chat.statusCode).toBe(200);
    expect(traceSink.listByRunId("diagnostic-trace-run").map((event) => event.name)).toEqual([
      "muse.model.generate",
      "muse.agent.run"
    ]);
    expect(traceSink.listByRunId("diagnostic-trace-run")).toEqual([
      expect.objectContaining({
        endedAt: expect.any(Date),
        name: "muse.model.generate",
        startedAt: expect.any(Date)
      }),
      expect.objectContaining({
        endedAt: expect.any(Date),
        name: "muse.agent.run",
        startedAt: expect.any(Date)
      })
    ]);
    expect(traces.json()).toMatchObject([
      { name: "muse.model.generate", runId: "diagnostic-trace-run" },
      { name: "muse.agent.run", runId: "diagnostic-trace-run" }
    ]);
  });

  it("runs chat through AgentRuntime behind auth and exposes SSE-compatible output", async () => {
    const authService = createAuthService();
    const registered = authService.register({
      email: "first_account",
      name: "First",
      password: "password-1"
    });
    const historyStore = new InMemoryAgentRunHistoryStore();
    const agentRuntime = createAgentRuntime({
      historyStore,
      modelProvider: createProvider("Runtime answer")
    });
    const server = buildServer({
      agentRuntime,
      authService,
      defaultModel: "provider/model",
      historyStore,
      logger: false,
      requireAuth: true
    });
    const headers = { authorization: `Bearer ${registered.token}` };

    const blocked = await server.inject({
      method: "POST",
      payload: { message: "Hello" },
      url: "/api/chat"
    });
    const chat = await server.inject({
      headers,
      method: "POST",
      payload: {
        message: "Hello",
        metadata: { tenantId: "tenant-1", userId: "user-1" },
        runId: "run-chat"
      },
      url: "/api/chat"
    });
    const extendedChat = await server.inject({
      headers,
      method: "POST",
      payload: {
        message: "Hello",
        runId: "run-chat-extended"
      },
      url: "/chat"
    });
    const stream = await server.inject({
      headers,
      method: "POST",
      payload: { message: "Hello", runId: "run-stream" },
      url: "/api/chat/stream"
    });

    expect(blocked.statusCode).toBe(401);
    expect(chat.statusCode).toBe(200);
    expect(chat.json()).toMatchObject({
      content: "Runtime answer",
      model: "provider/model",
      success: true
    });
    expect(chat.json()).not.toHaveProperty("response");
    expect(chat.json()).not.toHaveProperty("runId");
    expect(chat.json()).not.toHaveProperty("usage");
    expect(extendedChat.json()).toMatchObject({
      response: "Runtime answer",
      runId: "run-chat-extended"
    });
    expect(historyStore.findRun("run-chat")).toMatchObject({
      input: "Hello",
      status: "completed",
      userId: "user-1"
    });
    expect(historyStore.findRun("run-chat-extended")).toMatchObject({
      input: "Hello",
      status: "completed",
      userId: registered.user.id
    });
    expect(stream.statusCode).toBe(200);
    expect(stream.headers["content-type"]).toContain("text/event-stream");
    expect(stream.body).toContain("event: message");
    expect(stream.body).toContain("event: done");
    expect(stream.body).not.toContain("runId");
    expect(stream.body).not.toContain("response");
  });

  it("emits Muse compatible SSE tool lifecycle events", async () => {
    const toolCall = {
      arguments: { path: "docs/input.md" },
      id: "tool-1",
      name: "read_file"
    };
    let streamTurns = 0;
    const modelProvider: ModelProvider = {
      id: "test",
      async generate(request) {
        return {
          id: "response-final",
          model: request.model,
          output: "Tool complete"
        };
      },
      async listModels() {
        return [];
      },
      async *stream(request) {
        streamTurns += 1;

        if (streamTurns === 1) {
          yield { toolCall, type: "tool-call" };
          yield {
            response: {
              id: "response-tool",
              model: request.model,
              output: "",
              toolCalls: [toolCall]
            },
            type: "done"
          };
          return;
        }

        yield { text: "Tool complete", type: "text-delta" };
        yield {
          response: {
            id: "response-final",
            model: request.model,
            output: "Tool complete"
          },
          type: "done"
        };
      }
    };
    const agentRuntime = createAgentRuntime({
      modelProvider,
      toolRegistry: new ToolRegistry([
        {
          definition: {
            description: "Read a file",
            inputSchema: { type: "object" },
            name: "read_file",
            risk: "read"
          },
          execute: () => "file contents"
        }
      ])
    });
    const server = buildServer({
      agentRuntime,
      defaultModel: "provider/model",
      logger: false
    });

    const stream = await server.inject({
      method: "POST",
      payload: { message: "Read the file", runId: "run-stream-tools" },
      url: "/api/chat/stream"
    });

    const toolStartIndex = stream.body.indexOf("event: tool_start");
    const toolEndIndex = stream.body.indexOf("event: tool_end");

    expect(stream.statusCode).toBe(200);
    expect(toolStartIndex).toBeGreaterThanOrEqual(0);
    expect(toolEndIndex).toBeGreaterThan(toolStartIndex);
    expect(stream.body).toContain("data: read_file");
    expect(stream.body).toContain("event: message");
    expect(stream.body).toContain("event: done\ndata:\n\n");
    expect(stream.body).not.toContain("event: tool_call");
    expect(stream.body).not.toContain("run-stream-tools");
  });

  it("accepts Muse compatible multipart chat uploads", async () => {
    let capturedMetadata: unknown;
    const agentRuntime = createAgentRuntime({
      modelProvider: createProviderFrom(async (request) => {
        capturedMetadata = request.metadata;
        return {
          id: "response-1",
          model: request.model,
          output: "Multipart answer"
        };
      })
    });
    const server = buildServer({
      agentRuntime,
      defaultModel: "provider/model",
      logger: false
    });
    const boundary = "muse-test-boundary";
    const payload = [
      `--${boundary}`,
      "Content-Disposition: form-data; name=\"message\"",
      "",
      "Describe this file",
      `--${boundary}`,
      "Content-Disposition: form-data; name=\"files\"; filename=\"note.txt\"",
      "Content-Type: text/plain",
      "",
      "hello from upload",
      `--${boundary}--`,
      ""
    ].join("\r\n");

    const response = await server.inject({
      headers: {
        "content-type": `multipart/form-data; boundary=${boundary}`
      },
      method: "POST",
      payload,
      url: "/api/chat/multipart"
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ content: "Multipart answer", success: true });
    expect(response.json()).not.toHaveProperty("response");
    expect(response.json()).not.toHaveProperty("runId");
    expect(capturedMetadata).toMatchObject({
      channel: "web",
      media: [
        {
          contentBase64: Buffer.from("hello from upload").toString("base64"),
          contentType: "text/plain",
          filename: "note.txt",
          size: 17
        }
      ]
    });
  });

  it("preserves assistant tool call messages in chat requests", async () => {
    let capturedMessages: unknown;
    const agentRuntime = createAgentRuntime({
      modelProvider: createProviderFrom(async (request) => {
        capturedMessages = request.messages;
        return {
          id: "response-1",
          model: request.model,
          output: "Done"
        };
      })
    });
    const server = buildServer({
      agentRuntime,
      defaultModel: "provider/model",
      logger: false
    });

    const response = await server.inject({
      method: "POST",
      payload: {
        messages: [
          { content: "Read the file", role: "user" },
          {
            content: "",
            role: "assistant",
            toolCalls: [{ arguments: { path: "docs/input.md" }, id: "tool-1", name: "read_file" }]
          },
          { content: "file contents", role: "tool", toolCallId: "tool-1" }
        ]
      },
      url: "/api/chat"
    });

    expect(response.statusCode).toBe(200);
    const sent = capturedMessages as readonly { role: string; content: string }[];
    // The runtime now always prepends the composed system prompt (identity
    // core first) — the tool-call turns must survive UNDER it, unchanged.
    expect(sent[0]?.role).toBe("system");
    expect(sent[0]?.content).toContain("뮤즈");
    expect(sent.filter((message) => message.role !== "system")).toEqual([
      { content: "Read the file", name: undefined, role: "user", toolCallId: undefined, toolCalls: undefined },
      {
        content: "",
        name: undefined,
        role: "assistant",
        toolCallId: undefined,
        toolCalls: [{ arguments: { path: "docs/input.md" }, id: "tool-1", name: "read_file" }]
      },
      { content: "file contents", name: undefined, role: "tool", toolCallId: "tool-1", toolCalls: undefined }
    ]);
  });
});

function createProvider(output: string): ModelProvider {
  return createProviderFrom(async (request) => ({
    id: "response-1",
    model: request.model,
    output
  }));
}

function createProviderFrom(generate: ModelProvider["generate"]): ModelProvider {
  return {
    id: "test",
    generate,
    async listModels() {
      return [];
    },
    async *stream(request) {
      const response = await generate(request);
      yield { text: response.output, type: "text-delta" as const };
      yield { response, type: "done" as const };
    }
  };
}

describe("sseData line-splitting", () => {
  it("splits CRLF / lone CR / LF each as one SSE data segment", async () => {
    const { sseData } = await import("../src/server-multipart-sse.js");
    // A bare \r is an SSE line terminator; pre-fix it stayed raw
    // inside the data line and the client truncated the stream.
    expect(sseData("a\rb")).toBe("a\ndata: b");
    expect(sseData("a\rb")).not.toContain("\r");
    // CRLF and LF normalise to the same framing (no regression).
    expect(sseData("a\r\nb")).toBe("a\ndata: b");
    expect(sseData("a\nb")).toBe("a\ndata: b");
    // CRLF is one separator, not two — no spurious empty segment.
    expect(sseData("x\r\ny")).toBe("x\ndata: y");
    // Empty interior line still becomes a single-space data line.
    expect(sseData("a\n\nb")).toContain("data:  ");
  });
});
