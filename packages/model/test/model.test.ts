import { describe, expect, it } from "vitest";
import {
  AnthropicProvider,
  canUseNativeTools,
  GeminiProvider,
  knownModelPrefixes,
  ModelProviderError,
  ModelProviderRegistry,
  OllamaProvider,
  OpenAICompatibleProvider,
  OpenAIProvider,
  OpenRouterProvider,
  parseModelName,
  type ModelInfo,
  type ModelProvider
} from "../src/index.js";

const baseModel: ModelInfo = {
  providerId: "test",
  modelId: "test-model",
  capabilities: {
    cost: "unknown",
    latencyProfile: "unknown",
    local: false,
    maxInputTokens: 128000,
    maxOutputTokens: 4096,
    promptCaching: false,
    reasoning: false,
    streaming: true,
    structuredOutput: true,
    toolCalling: true,
    vision: false
  }
};

describe("canUseNativeTools", () => {
  it("requires native tool calling and structured output", () => {
    expect(canUseNativeTools(baseModel)).toBe(true);
    expect(
      canUseNativeTools({
        ...baseModel,
        capabilities: { ...baseModel.capabilities, structuredOutput: false }
      })
    ).toBe(false);
  });
});

function createProvider(id: string, models: readonly ModelInfo[]): ModelProvider {
  return {
    id,
    async generate(request) {
      return {
        id: "response",
        model: request.model,
        output: "ok"
      };
    },
    async listModels() {
      return models;
    },
    async *stream() {
      yield {
        response: {
          id: "response",
          model: models[0]?.modelId ?? "unknown",
          output: "ok"
        },
        type: "done"
      };
    }
  };
}

describe("ModelProviderRegistry", () => {
  const openai = createProvider("openai", [
    {
      ...baseModel,
      modelId: "gpt-5.5",
      providerId: "openai"
    }
  ]);
  const anthropic = createProvider("anthropic", [
    {
      ...baseModel,
      capabilities: { ...baseModel.capabilities, structuredOutput: false },
      modelId: "claude-sonnet-4.5",
      providerId: "anthropic"
    }
  ]);
  const ollama = createProvider("ollama", [
    {
      ...baseModel,
      capabilities: { ...baseModel.capabilities, local: true, maxInputTokens: 8192 },
      modelId: "llama3.2",
      providerId: "ollama"
    }
  ]);

  it("uses the default provider when no model is provided", () => {
    const registry = new ModelProviderRegistry([openai, anthropic], "openai");

    expect(registry.getProvider().id).toBe("openai");
  });

  it("resolves provider/model references", () => {
    const registry = new ModelProviderRegistry([openai, anthropic], "openai");

    expect(registry.getProvider("anthropic/claude-sonnet-4.5").id).toBe("anthropic");
  });

  it("resolves known model prefixes", () => {
    const registry = new ModelProviderRegistry([openai, anthropic, ollama], "openai");

    expect(registry.getProvider("claude-sonnet-4.5").id).toBe("anthropic");
    expect(registry.getProvider("llama3.2").id).toBe("ollama");
  });

  it("fails fast for unknown providers", () => {
    const registry = new ModelProviderRegistry([openai], "openai");

    expect(() => registry.getProvider("unknown/model")).toThrow(ModelProviderError);
  });

  it("selects a model by capability requirements", async () => {
    const registry = new ModelProviderRegistry([openai, anthropic], "openai");

    await expect(
      registry.selectModel({
        model: "openai/gpt-5.5",
        requires: { structuredOutput: true, toolCalling: true }
      })
    ).resolves.toMatchObject({
      model: { modelId: "gpt-5.5" },
      provider: { id: "openai" }
    });
  });

  it("selects the cheapest compatible model across providers when no provider is pinned", async () => {
    const expensive = createProvider("expensive", [
      {
        ...baseModel,
        capabilities: { ...baseModel.capabilities, cost: "high", latencyProfile: "balanced" },
        modelId: "expensive-model",
        providerId: "expensive"
      }
    ]);
    const cheap = createProvider("cheap", [
      {
        ...baseModel,
        capabilities: { ...baseModel.capabilities, cost: "low", latencyProfile: "interactive" },
        modelId: "cheap-model",
        providerId: "cheap"
      }
    ]);
    const registry = new ModelProviderRegistry([expensive, cheap], "expensive");

    await expect(registry.selectModel({
      prefer: { cost: "lowest", latencyProfile: "interactive" },
      requires: { toolCalling: true }
    })).resolves.toMatchObject({
      model: { modelId: "cheap-model" },
      provider: { id: "cheap" }
    });
  });

  it("rejects incompatible capability requirements", async () => {
    const registry = new ModelProviderRegistry([anthropic], "anthropic");

    await expect(
      registry.selectModel({
        model: "anthropic/claude-sonnet-4.5",
        requires: { structuredOutput: true }
      })
    ).rejects.toBeInstanceOf(ModelProviderError);
  });
});

describe("parseModelName", () => {
  it("keeps provider-prefixed model references split", () => {
    expect(parseModelName("openrouter/anthropic/claude-sonnet")).toEqual({
      modelId: "anthropic/claude-sonnet",
      providerId: "openrouter"
    });
  });

  it("exposes known model prefix aliases", () => {
    expect(knownModelPrefixes()["gpt-"]).toBe("openai");
  });
});

describe("OpenAICompatibleProvider", () => {
  it("sends chat completions requests and maps text, tool calls, and usage", async () => {
    let requestBody: unknown;
    const provider = new OpenAICompatibleProvider({
      apiKey: "test-key",
      baseUrl: "https://llm.example.test/v1/",
      defaultModel: "gpt-test",
      fetch: async (_url, init) => {
        requestBody = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({
          choices: [
            {
              message: {
                content: "hello",
                tool_calls: [
                  {
                    function: {
                      arguments: "{\"path\":\"docs/input.md\"}",
                      name: "read_file"
                    },
                    id: "call-1"
                  }
                ]
              }
            }
          ],
          id: "chatcmpl-1",
          model: "gpt-test",
          usage: {
            completion_tokens: 3,
            prompt_tokens: 5
          }
        }))
      }
    });

    const response = await provider.generate({
      messages: [{ content: "hi", role: "user" }],
      model: "openai/gpt-test",
      tools: [{
        description: "Read file",
        inputSchema: { type: "object" },
        name: "read_file",
        risk: "read"
      }]
    });

    expect(requestBody).toMatchObject({
      model: "gpt-test",
      tools: [{ function: { name: "read_file" }, type: "function" }]
    });
    expect(response).toMatchObject({
      id: "chatcmpl-1",
      output: "hello",
      toolCalls: [{ arguments: { path: "docs/input.md" }, id: "call-1", name: "read_file" }],
      usage: { inputTokens: 5, outputTokens: 3 }
    });
  });

  it("streams server-sent event text deltas into model events", async () => {
    const provider = new OpenAICompatibleProvider({
      baseUrl: "https://llm.example.test/v1",
      defaultModel: "gpt-test",
      fetch: async () => new Response(new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder();
          controller.enqueue(encoder.encode(
            "data: {\"id\":\"chunk-1\",\"model\":\"gpt-test\",\"choices\":[{\"delta\":{\"content\":\"hel\"}}]}\n\n"
          ));
          controller.enqueue(encoder.encode(
            "data: {\"id\":\"chunk-1\",\"model\":\"gpt-test\",\"choices\":[{\"delta\":{\"content\":\"lo\"}}]}\n\n"
          ));
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        }
      }))
    });
    const events = [];

    for await (const event of provider.stream({ messages: [], model: "gpt-test" })) {
      events.push(event);
    }

    expect(events).toMatchObject([
      { text: "hel", type: "text-delta" },
      { text: "lo", type: "text-delta" },
      { response: { output: "hello" }, type: "done" }
    ]);
  });

  it("streams server-sent event tool call deltas into model events", async () => {
    const provider = new OpenAICompatibleProvider({
      baseUrl: "https://llm.example.test/v1",
      defaultModel: "gpt-test",
      fetch: async () => new Response(new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder();
          controller.enqueue(encoder.encode(
            "data: {\"id\":\"chunk-2\",\"model\":\"gpt-test\",\"choices\":[{\"delta\":{\"tool_calls\":[{" +
            "\"index\":0,\"id\":\"call-1\",\"type\":\"function\",\"function\":{\"name\":\"search\"," +
            "\"arguments\":\"{\\\"query\\\":\\\"hel\"}}]}}]}\n\n"
          ));
          controller.enqueue(encoder.encode(
            "data: {\"id\":\"chunk-2\",\"model\":\"gpt-test\",\"choices\":[{\"delta\":{\"tool_calls\":[{" +
            "\"index\":0,\"function\":{\"arguments\":\"lo\\\"}\"}}]}}]}\n\n"
          ));
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        }
      }))
    });
    const events = [];

    for await (const event of provider.stream({ messages: [], model: "gpt-test" })) {
      events.push(event);
    }

    expect(events).toMatchObject([
      { toolCall: { arguments: { query: "hello" }, id: "call-1", name: "search" }, type: "tool-call" },
      {
        response: {
          output: "",
          toolCalls: [{ arguments: { query: "hello" }, id: "call-1", name: "search" }]
        },
        type: "done"
      }
    ]);
  });
});

describe("provider adapters", () => {
  it("configures OpenAI, OpenRouter, and Ollama adapter identities", async () => {
    const openai = new OpenAIProvider({ defaultModel: "gpt-test" });
    const openrouter = new OpenRouterProvider({
      appName: "Muse",
      defaultModel: "anthropic/claude-test",
      siteUrl: "https://example.com"
    });
    const ollama = new OllamaProvider({ defaultModel: "llama3.2" });

    expect(openai.id).toBe("openai");
    expect(openrouter.id).toBe("openrouter");
    expect((await ollama.listModels())[0]).toMatchObject({
      capabilities: { cost: "free", local: true },
      modelId: "llama3.2"
    });
  });

  it("maps Anthropic message responses to provider-neutral responses", async () => {
    let requestBody: unknown;
    const provider = new AnthropicProvider({
      apiKey: "anthropic-key",
      defaultModel: "claude-test",
      fetch: async (_url, init) => {
        requestBody = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({
          content: [
            { text: "hello", type: "text" },
            { id: "tool-1", input: { query: "muse" }, name: "search", type: "tool_use" }
          ],
          id: "msg-1",
          model: "claude-test",
          usage: {
            input_tokens: 7,
            output_tokens: 3
          }
        }));
      }
    });

    const response = await provider.generate({
      messages: [
        { content: "Be useful", role: "system" },
        { content: "hi", role: "user" }
      ],
      model: "anthropic/claude-test",
      tools: [{
        description: "Search",
        inputSchema: { type: "object" },
        name: "search",
        risk: "read"
      }]
    });

    expect(requestBody).toMatchObject({
      model: "claude-test",
      system: "Be useful",
      tools: [{ name: "search" }]
    });
    expect(response).toMatchObject({
      id: "msg-1",
      output: "hello",
      toolCalls: [{ arguments: { query: "muse" }, id: "tool-1", name: "search" }],
      usage: { inputTokens: 7, outputTokens: 3 }
    });
  });

  it("maps Gemini generateContent responses to provider-neutral responses", async () => {
    let requestUrl = "";
    let requestBody: unknown;
    const provider = new GeminiProvider({
      apiKey: "gemini-key",
      defaultModel: "gemini-test",
      fetch: async (url, init) => {
        requestUrl = String(url);
        requestBody = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({
          candidates: [{
            content: {
              parts: [
                { text: "hello" },
                { functionCall: { args: { query: "muse" }, name: "search" } }
              ]
            }
          }],
          responseId: "gemini-1",
          usageMetadata: {
            candidatesTokenCount: 3,
            promptTokenCount: 6
          }
        }));
      }
    });

    const response = await provider.generate({
      messages: [
        { content: "Be useful", role: "system" },
        { content: "hi", role: "user" }
      ],
      model: "gemini/gemini-test",
      tools: [{
        description: "Search",
        inputSchema: { type: "object" },
        name: "search",
        risk: "read"
      }]
    });

    expect(requestUrl).toContain("/models/gemini-test:generateContent?key=gemini-key");
    expect(requestBody).toMatchObject({
      contents: [{ parts: [{ text: "hi" }], role: "user" }],
      tools: [{ functionDeclarations: [{ name: "search" }] }]
    });
    expect(response).toMatchObject({
      id: "gemini-1",
      output: "hello",
      toolCalls: [{ arguments: { query: "muse" }, id: "gemini_tool_call_1", name: "search" }],
      usage: { inputTokens: 6, outputTokens: 3 }
    });
  });
});
