import { describe, expect, it } from "vitest";
import {
  AnthropicProvider,
  canUseNativeTools,
  DiagnosticModelProvider,
  GeminiProvider,
  knownModelPrefixes,
  ModelProviderError,
  ModelProviderRegistry,
  OllamaProvider,
  OpenAICompatibleProvider,
  OpenAIProvider,
  OpenRouterProvider,
  parseModelName,
  sanitizeGeminiSchema,
  type ModelInfo,
  type ModelRequest,
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

describe("DiagnosticModelProvider", () => {
  it("returns deterministic local responses for runtime smoke tests", async () => {
    const provider = new DiagnosticModelProvider({ defaultModel: "diagnostic/smoke" });

    await expect(provider.listModels()).resolves.toMatchObject([
      {
        capabilities: {
          cost: "free",
          local: true,
          streaming: true,
          structuredOutput: true,
          toolCalling: false
        },
        modelId: "smoke",
        providerId: "diagnostic"
      }
    ]);

    await expect(provider.generate({
      messages: [{ content: "Compare launch options", role: "user" }],
      model: "diagnostic/smoke"
    })).resolves.toMatchObject({
      model: "diagnostic/smoke",
      output: "Diagnostic response: Compare launch options"
    });
  });

  it("emits an empty JSON plan when the system prompt is a planning prompt", async () => {
    const provider = new DiagnosticModelProvider({ defaultModel: "diagnostic/smoke" });
    const planningSystemPrompt = [
      "[Role]",
      "You are a planner.",
      "",
      "[Available Tools]",
      "- search_docs: search the workspace docs",
      "",
      "[Output Format]",
      "Return a JSON array of plan steps."
    ].join("\n");

    await expect(provider.generate({
      messages: [
        { content: planningSystemPrompt, role: "system" },
        { content: "Plan a quick onboarding overview", role: "user" }
      ],
      model: "diagnostic/smoke"
    })).resolves.toMatchObject({
      model: "diagnostic/smoke",
      output: "[]"
    });
  });

  it("emits a single-step plan calling time_now when it appears in [Available Tools]", async () => {
    const provider = new DiagnosticModelProvider({ defaultModel: "diagnostic/smoke" });
    const planningSystemPrompt = [
      "[Role]",
      "Planner.",
      "",
      "[Available Tools]",
      "- time_now: Returns the current time.",
      "- math_eval: Evaluates an arithmetic expression.",
      "",
      "[Output Format]",
      "JSON array of plan steps."
    ].join("\n");

    const response = await provider.generate({
      messages: [
        { content: planningSystemPrompt, role: "system" },
        { content: "What time is it?", role: "user" }
      ],
      model: "diagnostic/smoke"
    });
    const plan = JSON.parse(response.output) as readonly { readonly tool: string; readonly args: object }[];
    expect(plan).toEqual([
      expect.objectContaining({ args: {}, tool: "time_now" })
    ]);
  });

  it("does not emit a step plan when time_now is absent from [Available Tools]", async () => {
    const provider = new DiagnosticModelProvider({ defaultModel: "diagnostic/smoke" });
    const planningSystemPrompt = [
      "[Role]",
      "Planner.",
      "",
      "[Available Tools]",
      "- math_eval: Evaluates an arithmetic expression.",
      "",
      "[Output Format]",
      "JSON array of plan steps."
    ].join("\n");

    const response = await provider.generate({
      messages: [
        { content: planningSystemPrompt, role: "system" },
        { content: "Compute things", role: "user" }
      ],
      model: "diagnostic/smoke"
    });
    expect(response.output).toBe("[]");
  });

  it("falls through to the legacy diagnostic shape when only one of the planning markers is present", async () => {
    const provider = new DiagnosticModelProvider({ defaultModel: "diagnostic/smoke" });

    await expect(provider.generate({
      messages: [
        { content: "Some other system prompt mentioning [Role] alone", role: "system" },
        { content: "Hello", role: "user" }
      ],
      model: "diagnostic/smoke"
    })).resolves.toMatchObject({
      output: "Diagnostic response: Hello"
    });
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

describe("provider adapter contracts", () => {
  const contractRequest: ModelRequest = {
    messages: [{ content: "hello", role: "user" }],
    model: "provider/model-test",
    tools: [{
      description: "Search synthetic data",
      inputSchema: { type: "object" },
      name: "search",
      risk: "read"
    }]
  };

  const openAIProviderFactories = [
    {
      expectedLocal: false,
      id: "openai-compatible",
      model: "model-test",
      errorProvider: () => new OpenAICompatibleProvider({
        baseUrl: "https://llm.example.test/v1",
        defaultModel: "model-test",
        fetch: fakeOpenAIChatFetch({ forceError: true }),
        models: ["model-test"]
      }),
      provider: () => new OpenAICompatibleProvider({
        baseUrl: "https://llm.example.test/v1",
        defaultModel: "model-test",
        fetch: fakeOpenAIChatFetch(),
        models: ["model-test"]
      })
    },
    {
      expectedLocal: false,
      id: "openai",
      model: "model-test",
      errorProvider: () => new OpenAIProvider({
        baseUrl: "https://openai.example.test/v1",
        defaultModel: "model-test",
        fetch: fakeOpenAIChatFetch({ forceError: true }),
        models: ["model-test"]
      }),
      provider: () => new OpenAIProvider({
        baseUrl: "https://openai.example.test/v1",
        defaultModel: "model-test",
        fetch: fakeOpenAIChatFetch(),
        models: ["model-test"]
      })
    },
    {
      expectedLocal: false,
      id: "openrouter",
      model: "provider/model-test",
      errorProvider: () => new OpenRouterProvider({
        baseUrl: "https://openrouter.example.test/api/v1",
        defaultModel: "provider/model-test",
        fetch: fakeOpenAIChatFetch({ forceError: true }),
        models: ["provider/model-test"]
      }),
      provider: () => new OpenRouterProvider({
        baseUrl: "https://openrouter.example.test/api/v1",
        defaultModel: "provider/model-test",
        fetch: fakeOpenAIChatFetch(),
        models: ["provider/model-test"]
      })
    },
    {
      expectedLocal: true,
      id: "ollama",
      model: "model-test",
      errorProvider: () => new OllamaProvider({
        baseUrl: "http://ollama.example.test/v1",
        defaultModel: "model-test",
        fetch: fakeOpenAIChatFetch({ forceError: true }),
        models: ["model-test"]
      }),
      provider: () => new OllamaProvider({
        baseUrl: "http://ollama.example.test/v1",
        defaultModel: "model-test",
        fetch: fakeOpenAIChatFetch(),
        models: ["model-test"]
      })
    }
  ];

  for (const entry of openAIProviderFactories) {
    it(`${entry.id} maps model metadata, generate, stream, tool calls, and errors`, async () => {
      const provider = entry.provider();
      const models = await provider.listModels();
      const response = await provider.generate({ ...contractRequest, model: `${entry.id}/${entry.model}` });
      const events = [];
      const failingProvider = entry.errorProvider();

      for await (const event of provider.stream({ ...contractRequest, model: `${entry.id}/${entry.model}` })) {
        events.push(event);
      }

      expect(models).toEqual([
        expect.objectContaining({
          capabilities: expect.objectContaining({
            local: entry.expectedLocal,
            streaming: true,
            toolCalling: true
          }),
          modelId: entry.model,
          providerId: entry.id
        })
      ]);
      expect(response).toMatchObject({
        output: "contract response",
        toolCalls: [{ arguments: { query: "muse" }, id: "call-1", name: "search" }],
        usage: { inputTokens: 11, outputTokens: 5 }
      });
      expect(events).toEqual([
        { text: "contract ", type: "text-delta" },
        { text: "response", type: "text-delta" },
        {
          toolCall: { arguments: { query: "muse" }, id: "call-1", name: "search" },
          type: "tool-call"
        },
        expect.objectContaining({
          response: expect.objectContaining({
            output: "contract response",
            toolCalls: [{ arguments: { query: "muse" }, id: "call-1", name: "search" }]
          }),
          type: "done"
        })
      ]);
      await expect(failingProvider.generate(contractRequest))
        .rejects
        .toMatchObject({ providerId: entry.id, retryable: true });
    });
  }

  it("anthropic maps model metadata, generate, stream, tool calls, and errors", async () => {
    const provider = new AnthropicProvider({
      defaultModel: "claude-test",
      fetch: fakeAnthropicFetch(),
      models: ["claude-test"]
    });
    const failingProvider = new AnthropicProvider({
      defaultModel: "claude-test",
      fetch: fakeAnthropicFetch({ forceError: true }),
      models: ["claude-test"]
    });
    const models = await provider.listModels();
    const response = await provider.generate({ ...contractRequest, model: "anthropic/claude-test" });
    const events = [];

    for await (const event of provider.stream({ ...contractRequest, model: "anthropic/claude-test" })) {
      events.push(event);
    }

    expect(models).toEqual([
      expect.objectContaining({
        capabilities: expect.objectContaining({
          streaming: true,
          toolCalling: true
        }),
        modelId: "claude-test",
        providerId: "anthropic"
      })
    ]);
    expect(response).toMatchObject({
      output: "contract response",
      toolCalls: [{ arguments: { query: "muse" }, id: "tool-1", name: "search" }],
      usage: { inputTokens: 11, outputTokens: 5 }
    });
    expect(events).toEqual([
      { text: "contract response", type: "text-delta" },
      { toolCall: { arguments: { query: "muse" }, id: "tool-1", name: "search" }, type: "tool-call" },
      expect.objectContaining({ response: expect.objectContaining({ output: "contract response" }), type: "done" })
    ]);
    await expect(failingProvider.generate(contractRequest))
      .rejects
      .toMatchObject({ providerId: "anthropic", retryable: true });
  });

  it("gemini maps model metadata, generate, stream, tool calls, and errors", async () => {
    const provider = new GeminiProvider({
      defaultModel: "gemini-test",
      fetch: fakeGeminiFetch(),
      models: ["gemini-test"]
    });
    const failingProvider = new GeminiProvider({
      defaultModel: "gemini-test",
      fetch: fakeGeminiFetch({ forceError: true }),
      models: ["gemini-test"]
    });
    const models = await provider.listModels();
    const response = await provider.generate({ ...contractRequest, model: "gemini/gemini-test" });
    const events = [];

    for await (const event of provider.stream({ ...contractRequest, model: "gemini/gemini-test" })) {
      events.push(event);
    }

    expect(models).toEqual([
      expect.objectContaining({
        capabilities: expect.objectContaining({
          streaming: true,
          toolCalling: true
        }),
        modelId: "gemini-test",
        providerId: "gemini"
      })
    ]);
    expect(response).toMatchObject({
      output: "contract response",
      toolCalls: [{ arguments: { query: "muse" }, id: "gemini_tool_call_1", name: "search" }],
      usage: { inputTokens: 11, outputTokens: 5 }
    });
    expect(events).toEqual([
      { text: "contract response", type: "text-delta" },
      { toolCall: { arguments: { query: "muse" }, id: "gemini_tool_call_1", name: "search" }, type: "tool-call" },
      expect.objectContaining({ response: expect.objectContaining({ output: "contract response" }), type: "done" })
    ]);
    await expect(failingProvider.generate(contractRequest))
      .rejects
      .toMatchObject({ providerId: "gemini", retryable: true });
  });
});

describe("live provider smoke gates", () => {
  const liveEnabled = process.env.MUSE_RUN_LIVE_MODEL_TESTS === "1";

  it.skipIf(!liveEnabled || !process.env.OPENAI_API_KEY)("runs an optional OpenAI live smoke", async () => {
    const provider = new OpenAIProvider({
      apiKey: process.env.OPENAI_API_KEY,
      defaultModel: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
      models: [process.env.OPENAI_MODEL ?? "gpt-4o-mini"]
    });

    await expect(provider.generate({
      messages: [{ content: "Reply with ok.", role: "user" }],
      model: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
      maxOutputTokens: 8
    })).resolves.toMatchObject({ model: expect.any(String) });
  });

  it.skipIf(!liveEnabled || !process.env.ANTHROPIC_API_KEY)("runs an optional Anthropic live smoke", async () => {
    const model = process.env.ANTHROPIC_MODEL ?? "claude-3-5-haiku-latest";
    const provider = new AnthropicProvider({
      apiKey: process.env.ANTHROPIC_API_KEY,
      defaultModel: model,
      models: [model]
    });

    await expect(provider.generate({
      messages: [{ content: "Reply with ok.", role: "user" }],
      model,
      maxOutputTokens: 8
    })).resolves.toMatchObject({ model: expect.any(String) });
  });

  it.skipIf(!liveEnabled || (!process.env.GEMINI_API_KEY && !process.env.GOOGLE_API_KEY))(
    "runs an optional Gemini live smoke",
    async () => {
      const model = process.env.GEMINI_MODEL ?? "gemini-2.0-flash";
      const provider = new GeminiProvider({
        apiKey: process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY,
        defaultModel: model,
        models: [model]
      });

      await expect(provider.generate({
        messages: [{ content: "Reply with ok.", role: "user" }],
        model,
        maxOutputTokens: 8
      })).resolves.toMatchObject({ model });
    }
  );

  it.skipIf(!liveEnabled || !process.env.OPENROUTER_API_KEY)("runs an optional OpenRouter live smoke", async () => {
    const model = process.env.OPENROUTER_MODEL ?? "openai/gpt-4o-mini";
    const provider = new OpenRouterProvider({
      apiKey: process.env.OPENROUTER_API_KEY,
      defaultModel: model,
      models: [model]
    });

    await expect(provider.generate({
      messages: [{ content: "Reply with ok.", role: "user" }],
      model,
      maxOutputTokens: 8
    })).resolves.toMatchObject({ model: expect.any(String) });
  });

  it.skipIf(!liveEnabled || !process.env.OLLAMA_BASE_URL)("runs an optional Ollama live smoke", async () => {
    const model = process.env.OLLAMA_MODEL ?? "llama3.2";
    const provider = new OllamaProvider({
      baseUrl: process.env.OLLAMA_BASE_URL,
      defaultModel: model,
      models: [model]
    });

    await expect(provider.generate({
      messages: [{ content: "Reply with ok.", role: "user" }],
      model,
      maxOutputTokens: 8
    })).resolves.toMatchObject({ model: expect.any(String) });
  });
});

function fakeOpenAIChatFetch(options: { readonly forceError?: boolean } = {}): typeof globalThis.fetch {
  return async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { readonly stream?: boolean };

    if (options.forceError) {
      return new Response("temporary provider failure", { status: 503, statusText: "Unavailable" });
    }

    if (body.stream) {
      return new Response(new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder();
          controller.enqueue(encoder.encode(
            "data: {\"id\":\"stream-1\",\"model\":\"model-test\",\"choices\":[{\"delta\":{\"content\":\"contract \"}}]}\n\n"
          ));
          controller.enqueue(encoder.encode(
            "data: {\"id\":\"stream-1\",\"model\":\"model-test\",\"choices\":[{\"delta\":{\"content\":\"response\"}}]}\n\n"
          ));
          controller.enqueue(encoder.encode(
            "data: {\"id\":\"stream-1\",\"model\":\"model-test\",\"choices\":[{\"delta\":{\"tool_calls\":[{" +
            "\"index\":0,\"id\":\"call-1\",\"type\":\"function\",\"function\":{\"name\":\"search\"," +
            "\"arguments\":\"{\\\"query\\\":\\\"muse\\\"}\"}}]}}]}\n\n"
          ));
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        }
      }));
    }

    return new Response(JSON.stringify({
      choices: [{
        message: {
          content: "contract response",
          tool_calls: [{
            function: {
              arguments: "{\"query\":\"muse\"}",
              name: "search"
            },
            id: "call-1"
          }]
        }
      }],
      id: "chatcmpl-contract",
      model: "model-test",
      usage: {
        completion_tokens: 5,
        prompt_tokens: 11
      }
    }));
  };
}

function fakeAnthropicFetch(options: { readonly forceError?: boolean } = {}): typeof globalThis.fetch {
  return async () => {
    if (options.forceError) {
      return new Response("temporary provider failure", { status: 503, statusText: "Unavailable" });
    }

    return new Response(JSON.stringify({
      content: [
        { text: "contract response", type: "text" },
        { id: "tool-1", input: { query: "muse" }, name: "search", type: "tool_use" }
      ],
      id: "msg-contract",
      model: "claude-test",
      usage: {
        input_tokens: 11,
        output_tokens: 5
      }
    }));
  };
}

function fakeGeminiFetch(options: { readonly forceError?: boolean } = {}): typeof globalThis.fetch {
  return async () => {
    if (options.forceError) {
      return new Response("temporary provider failure", { status: 503, statusText: "Unavailable" });
    }

    return new Response(JSON.stringify({
      candidates: [{
        content: {
          parts: [
            { text: "contract response" },
            { functionCall: { args: { query: "muse" }, name: "search" } }
          ]
        }
      }],
      responseId: "gemini-contract",
      usageMetadata: {
        candidatesTokenCount: 5,
        promptTokenCount: 11
      }
    }));
  };
}

describe("sanitizeGeminiSchema", () => {
  it("strips additionalProperties at the root", () => {
    expect(
      sanitizeGeminiSchema({
        additionalProperties: false,
        type: "object",
        properties: { x: { type: "string" } }
      })
    ).toEqual({ type: "object", properties: { x: { type: "string" } } });
  });

  it("recursively strips additionalProperties from nested properties", () => {
    expect(
      sanitizeGeminiSchema({
        type: "object",
        additionalProperties: false,
        properties: {
          nested: {
            type: "object",
            additionalProperties: false,
            properties: { y: { type: "number" } }
          }
        }
      })
    ).toEqual({
      type: "object",
      properties: {
        nested: { type: "object", properties: { y: { type: "number" } } }
      }
    });
  });

  it("recursively strips inside items arrays", () => {
    expect(
      sanitizeGeminiSchema({
        type: "array",
        items: { type: "object", additionalProperties: false, properties: { z: { type: "string" } } }
      })
    ).toEqual({
      type: "array",
      items: { type: "object", properties: { z: { type: "string" } } }
    });
  });

  it("strips $schema, $id, $ref, definitions, patternProperties", () => {
    expect(
      sanitizeGeminiSchema({
        $schema: "http://json-schema.org/draft-07/schema#",
        $id: "x",
        $ref: "#/definitions/foo",
        definitions: { foo: { type: "object" } },
        patternProperties: { "^x_": { type: "string" } },
        type: "object"
      })
    ).toEqual({ type: "object" });
  });

  it("preserves enum, description, required, format", () => {
    expect(
      sanitizeGeminiSchema({
        type: "string",
        description: "the answer",
        enum: ["yes", "no"],
        format: "uri"
      })
    ).toEqual({ type: "string", description: "the answer", enum: ["yes", "no"], format: "uri" });
  });

  it("returns primitives unchanged", () => {
    expect(sanitizeGeminiSchema(undefined)).toBeUndefined();
    expect(sanitizeGeminiSchema(null)).toBeNull();
    expect(sanitizeGeminiSchema("string")).toBe("string");
    expect(sanitizeGeminiSchema(42)).toBe(42);
  });
});

describe("provider tool-schema contracts (regression for live-LLM bugs)", () => {
  const realisticTool = {
    description: "Search the corpus for documents matching the given query.",
    inputSchema: {
      $schema: "http://json-schema.org/draft-07/schema#",
      additionalProperties: false,
      properties: {
        filters: {
          additionalProperties: false,
          properties: {
            tenantId: { type: "string" },
            tags: { type: "array", items: { type: "string" } }
          },
          type: "object"
        },
        limit: { type: "integer", minimum: 1, maximum: 50 },
        query: { description: "free-text query", type: "string" }
      },
      required: ["query"],
      type: "object"
    },
    name: "search",
    risk: "read" as const
  };

  it("Gemini strips `additionalProperties` from every nested level of the tool schema", async () => {
    let requestBody: unknown;
    const provider = new GeminiProvider({
      apiKey: "gemini-key",
      defaultModel: "gemini-test",
      fetch: async (_url, init) => {
        requestBody = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({
          candidates: [{ content: { parts: [{ text: "ok" }] } }],
          responseId: "g-1",
          usageMetadata: { candidatesTokenCount: 1, promptTokenCount: 1 }
        }));
      }
    });

    await provider.generate({
      messages: [{ content: "search docs", role: "user" }],
      model: "gemini-test",
      tools: [realisticTool]
    });

    const stringified = JSON.stringify(requestBody);
    expect(stringified).not.toContain("additionalProperties");
    expect(stringified).not.toContain("$schema");
    // The allowed shape is preserved.
    expect(stringified).toContain('"required":["query"]');
    expect(stringified).toContain('"description":"free-text query"');
    // Verify nested filters.properties survived.
    expect(stringified).toContain('"tenantId"');
    expect(stringified).toContain('"tags"');
  });

  it("Gemini sanitizer also strips `$schema`, `$id`, `$ref`, `definitions`", async () => {
    let requestBody: unknown;
    const provider = new GeminiProvider({
      apiKey: "k",
      defaultModel: "gemini-test",
      fetch: async (_url, init) => {
        requestBody = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({
          candidates: [{ content: { parts: [{ text: "ok" }] } }],
          responseId: "g-2",
          usageMetadata: { candidatesTokenCount: 1, promptTokenCount: 1 }
        }));
      }
    });
    await provider.generate({
      messages: [{ content: "x", role: "user" }],
      model: "gemini-test",
      tools: [{
        ...realisticTool,
        inputSchema: {
          $id: "tool",
          $ref: "#/definitions/search",
          $schema: "http://json-schema.org/draft-07/schema#",
          definitions: { search: { type: "object" } },
          patternProperties: { "^x_": { type: "string" } },
          properties: { query: { type: "string" } },
          type: "object"
        }
      }]
    });
    const stringified = JSON.stringify(requestBody);
    expect(stringified).not.toContain("$schema");
    expect(stringified).not.toContain("$id");
    expect(stringified).not.toContain("$ref");
    expect(stringified).not.toContain("definitions");
    expect(stringified).not.toContain("patternProperties");
  });

  it("Anthropic passes the tool schema through unchanged (it accepts additionalProperties)", async () => {
    let requestBody: unknown;
    const provider = new AnthropicProvider({
      apiKey: "anthropic-key",
      defaultModel: "claude-test",
      fetch: async (_url, init) => {
        requestBody = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({
          content: [{ text: "ok", type: "text" }],
          id: "msg-1",
          model: "claude-test",
          usage: { input_tokens: 1, output_tokens: 1 }
        }));
      }
    });

    await provider.generate({
      messages: [{ content: "search docs", role: "user" }],
      model: "claude-test",
      tools: [realisticTool]
    });

    const stringified = JSON.stringify(requestBody);
    // Anthropic's tool API accepts JSON Schema verbatim, so additionalProperties
    // should still be present in the input_schema field.
    expect(stringified).toContain('"input_schema":');
    expect(stringified).toContain("additionalProperties");
    expect(stringified).toContain('"required":["query"]');
  });

  it("OpenAI-compatible adapter passes the tool schema through unchanged (strict mode requires additionalProperties)", async () => {
    let requestBody: unknown;
    const provider = new OpenAICompatibleProvider({
      apiKey: "openai-key",
      baseUrl: "https://api.example.test/v1",
      defaultModel: "gpt-test",
      fetch: async (_url, init) => {
        requestBody = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({
          choices: [{ message: { content: "ok" } }],
          id: "chatcmpl-1",
          model: "gpt-test",
          usage: { completion_tokens: 1, prompt_tokens: 1 }
        }));
      }
    });

    await provider.generate({
      messages: [{ content: "search docs", role: "user" }],
      model: "gpt-test",
      tools: [realisticTool]
    });

    const stringified = JSON.stringify(requestBody);
    // OpenAI/Chat Completions accepts JSON Schema directly under tool.function.parameters.
    expect(stringified).toContain('"parameters":');
    expect(stringified).toContain("additionalProperties");
  });
});
