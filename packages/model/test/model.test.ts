import { describe, expect, it } from "vitest";
import {
  canUseNativeTools,
  knownModelPrefixes,
  ModelProviderError,
  ModelProviderRegistry,
  OpenAICompatibleProvider,
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
});
