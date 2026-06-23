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
  createLeadingThinkStripper,
  parseModelName,
  sanitizeGeminiSchema,
  stripLeadingThinkBlock,
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

describe("stripLeadingThinkBlock (goal 172)", () => {
  it("removes a leaked leading <think>…</think> block and its trailing whitespace", () => {
    expect(stripLeadingThinkBlock("<think>\nlet me reason\n</think>\n\nThe answer is 42."))
      .toBe("The answer is 42.");
    expect(stripLeadingThinkBlock("  <think></think>  hello")).toBe("hello");
  });

  it("leaves content without a leading think block untouched", () => {
    expect(stripLeadingThinkBlock("Just the answer.")).toBe("Just the answer.");
    // A <think> later in prose/code must NOT be stripped.
    expect(stripLeadingThinkBlock("Use the <think> tag like </think> in XML."))
      .toBe("Use the <think> tag like </think> in XML.");
  });

  it("strips a leading <think> with no closing tag (pure leaked reasoning → empty)", () => {
    expect(stripLeadingThinkBlock("<think>\nreasoning got cut off")).toBe("");
    expect(stripLeadingThinkBlock("  <think>still thinking, never closed")).toBe("");
    // Agrees with the streaming counterpart, which also yields ""
    // here — both honor reasoning=false instead of leaking CoT.
    expect(createLeadingThinkStripper()("<think>reasoning got cut off")).toBe("");
  });

  it("still preserves a partial answer after a CLOSED block (truncated answer)", () => {
    expect(stripLeadingThinkBlock("<think>done</think>The answer is 4"))
      .toBe("The answer is 4");
  });

  it("strips only the FIRST block (non-greedy), keeping later content", () => {
    expect(stripLeadingThinkBlock("<think>a</think>answer <think>b</think> tail"))
      .toBe("answer <think>b</think> tail");
  });
});

describe("createLeadingThinkStripper (goal 173)", () => {
  function feed(deltas: readonly string[]): string {
    const strip = createLeadingThinkStripper();
    return deltas.map((d) => strip(d)).join("");
  }

  it("suppresses a leading think block streamed in one chunk", () => {
    expect(feed(["<think>reasoning</think>\n\nThe answer."])).toBe("The answer.");
  });

  it("suppresses a think block whose tags are split across chunks", () => {
    expect(feed(["<th", "ink>\nrea", "soning more", "</thi", "nk>", " answer ", "here"]))
      .toBe("answer here");
  });

  it("passes non-think output through verbatim, including a later <think>", () => {
    expect(feed(["Hello ", "world. ", "Use <think> ", "in XML."]))
      .toBe("Hello world. Use <think> in XML.");
  });

  it("preserves leading whitespace when there is no think block", () => {
    expect(feed(["  ", "\nplain answer"])).toBe("  \nplain answer");
  });

  it("emits nothing for an unterminated think block (truncated stream)", () => {
    expect(feed(["<think>", "still reasoning, stream cut"])).toBe("");
  });

  it("handles the close tag immediately followed by the answer, no whitespace", () => {
    expect(feed(["<think>x</think>answer"])).toBe("answer");
  });

  it("swallows post-close whitespace spanning several whitespace-only chunks (trim mode)", () => {
    // The close tag + blank line + indentation commonly arrive as
    // separate SSE deltas — trim mode must persist across them.
    expect(feed(["<think>reasoning", "</think>", "\n", "\n  ", "  ", "The answer."]))
      .toBe("The answer.");
  });

  it("emits a buffered <thought>/<thinking> prefix verbatim — only exact <think> is stripped", () => {
    // "<th" is a prefix of "<think>" so scan-mode buffers it; once
    // it resolves to a different tag the buffered text must NOT be
    // eaten — it is real content.
    expect(feed(["<th", "ought>keep me</thought> done"]))
      .toBe("<thought>keep me</thought> done");
    expect(feed(["<thi", "nking>real text"])).toBe("<thinking>real text");
  });

  it("strips a think block preceded by whitespace split across chunks", () => {
    expect(feed(["  ", " <th", "ink>cot</think>", "real"])).toBe("real");
  });
});

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

  it("suppresses Qwen3 thinking via chat_template_kwargs, only for qwen3 models (goal 171)", async () => {
    const bodies: Record<string, unknown>[] = [];
    const makeProvider = (defaultModel: string) => new OpenAICompatibleProvider({
      baseUrl: "https://llm.example.test/v1",
      defaultModel,
      fetch: async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(JSON.stringify({
          choices: [{ message: { content: "ok" } }], id: "c1", model: defaultModel
        }));
      }
    });

    await makeProvider("qwen3:8b").generate({ messages: [{ content: "hi", role: "user" }], model: "ollama/qwen3:8b" });
    expect(bodies[0]).toMatchObject({ chat_template_kwargs: { enable_thinking: false } });

    await makeProvider("qwen/qwen3-30b-a3b").generate({ messages: [{ content: "hi", role: "user" }], model: "openrouter/qwen/qwen3-30b-a3b" });
    expect(bodies[1]).toMatchObject({ chat_template_kwargs: { enable_thinking: false } });

    // Non-Qwen models must NOT get the unknown key (strict
    // OpenAI/Azure would 400 on it).
    await makeProvider("gpt-test").generate({ messages: [{ content: "hi", role: "user" }], model: "openai/gpt-test" });
    expect(bodies[2]).not.toHaveProperty("chat_template_kwargs");

    await makeProvider("qwen2.5:7b").generate({ messages: [{ content: "hi", role: "user" }], model: "ollama/qwen2.5:7b" });
    expect(bodies[3]).not.toHaveProperty("chat_template_kwargs");
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

  it("surfaces a mid-stream `{error}` SSE chunk as an error event and stops (not a silently truncated answer)", async () => {
    const provider = new OpenAICompatibleProvider({
      baseUrl: "https://llm.example.test/v1",
      defaultModel: "gpt-test",
      fetch: async () => new Response(new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder();
          controller.enqueue(encoder.encode(
            "data: {\"id\":\"c\",\"model\":\"gpt-test\",\"choices\":[{\"delta\":{\"content\":\"partial\"}}]}\n\n"
          ));
          controller.enqueue(encoder.encode(
            "data: {\"error\":{\"message\":\"context length exceeded\",\"type\":\"invalid_request_error\"}}\n\n"
          ));
          controller.enqueue(encoder.encode(
            "data: {\"id\":\"c\",\"model\":\"gpt-test\",\"choices\":[{\"delta\":{\"content\":\" more\"}}]}\n\n"
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
    const errEvent = events.find((e) => e.type === "error") as { error: Error & { retryable?: boolean } } | undefined;
    expect(errEvent?.error.message).toContain("context length exceeded");
    expect(errEvent?.error.retryable).toBe(true);
    // The post-error chunk + [DONE] must NOT produce a done event.
    expect(events.some((e) => e.type === "done")).toBe(false);
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

  it("a failing no-body-stream fallback yields an error EVENT, never throws out of the generator", async () => {
    let call = 0;
    const provider = new OpenAICompatibleProvider({
      baseUrl: "https://llm.example.test/v1",
      defaultModel: "gpt-test",
      fetch: async () => {
        call += 1;
        // 1st (stream) call: 200 but a null body → triggers the
        // non-stream fallback. 2nd (generate fallback) call: 500.
        return call === 1
          ? new Response(null, { status: 200 })
          : new Response("upstream boom", { status: 500 });
      }
    });

    const events = [];
    // Must NOT throw: the contract is errors arrive as events.
    for await (const event of provider.stream({ messages: [], model: "gpt-test" })) {
      events.push(event);
    }

    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("error");
    const err = (events[0] as { error: unknown }).error;
    expect(err).toBeInstanceOf(ModelProviderError);
    expect((err as ModelProviderError).retryable).toBe(true); // 500 → retryable
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

  it("coalesces parallel tool results into a single role=function turn", async () => {
    let requestBody: { contents?: Array<{ role: string; parts: Array<{ functionResponse?: { name: string } }> }> } = {};
    const provider = new GeminiProvider({
      apiKey: "gemini-key",
      defaultModel: "gemini-test",
      fetch: async (_url, init) => {
        requestBody = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({
          candidates: [{ content: { parts: [{ text: "ok" }] } }],
          responseId: "gemini-2"
        }));
      }
    });

    await provider.generate({
      messages: [
        { content: "what is on my plate", role: "user" },
        {
          content: "",
          role: "assistant",
          toolCalls: [
            { arguments: {}, id: "call_a", name: "muse.tasks.list" },
            { arguments: {}, id: "call_b", name: "muse.calendar.events" },
            { arguments: {}, id: "call_c", name: "muse.notes.list" }
          ]
        },
        { content: "[]", name: "muse.tasks.list", role: "tool", toolCallId: "call_a" },
        { content: "[]", name: "muse.calendar.events", role: "tool", toolCallId: "call_b" },
        { content: "[]", name: "muse.notes.list", role: "tool", toolCallId: "call_c" }
      ],
      model: "gemini/gemini-test"
    });

    const contents = requestBody.contents ?? [];
    const functionTurns = contents.filter((c) => c.role === "function");
    expect(functionTurns).toHaveLength(1);
    expect(functionTurns[0].parts).toHaveLength(3);
    expect(functionTurns[0].parts.map((p) => p.functionResponse?.name)).toEqual([
      "muse.tasks.list",
      "muse.calendar.events",
      "muse.notes.list"
    ]);
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
        fetch: fakeOpenAIResponsesFetch({ forceError: true }),
        models: ["model-test"]
      }),
      provider: () => new OpenAIProvider({
        baseUrl: "https://openai.example.test/v1",
        defaultModel: "model-test",
        fetch: fakeOpenAIResponsesFetch(),
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
        fetch: fakeOllamaChatFetch({ forceError: true }),
        models: ["model-test"]
      }),
      provider: () => new OllamaProvider({
        baseUrl: "http://ollama.example.test/v1",
        defaultModel: "model-test",
        fetch: fakeOllamaChatFetch(),
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

  it("ollama native path treats a connection-level fetch rejection as retryable, not a hard fail", async () => {
    const econn = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    const provider = new OllamaProvider({
      baseUrl: "http://127.0.0.1:11434/v1",
      defaultModel: "qwen3:8b",
      fetch: async () => { throw econn; },
      models: ["qwen3:8b"]
    });

    await expect(provider.generate({ ...contractRequest, model: "ollama/qwen3:8b" }))
      .rejects
      .toMatchObject({ providerId: "ollama", retryable: true });

    const events = [];
    for await (const event of provider.stream({ ...contractRequest, model: "ollama/qwen3:8b" })) {
      events.push(event);
    }
    expect(events).toEqual([
      expect.objectContaining({
        error: expect.objectContaining({ providerId: "ollama", retryable: true }),
        type: "error"
      })
    ]);
  });

  it("openai-compatible base treats a connection-level fetch rejection as retryable, not a hard fail", async () => {
    const econn = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    const provider = new OpenAICompatibleProvider({
      baseUrl: "http://compat.example.test/v1",
      defaultModel: "model-test",
      fetch: async () => { throw econn; },
      id: "lmstudio",
      models: ["model-test"]
    });

    await expect(provider.generate({ ...contractRequest, model: "lmstudio/model-test" }))
      .rejects
      .toMatchObject({ providerId: "lmstudio", retryable: true });

    const events = [];
    for await (const event of provider.stream({ ...contractRequest, model: "lmstudio/model-test" })) {
      events.push(event);
    }
    expect(events).toEqual([
      expect.objectContaining({
        error: expect.objectContaining({ providerId: "lmstudio", retryable: true }),
        type: "error"
      })
    ]);
  });

  it("openai-compatible base gives an actionable connection-failure hint (local vs remote)", async () => {
    const econn = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    const makeProvider = (baseUrl: string) => new OpenAICompatibleProvider({
      baseUrl,
      defaultModel: "m",
      fetch: async () => { throw econn; },
      id: "lmstudio",
      models: ["m"]
    });

    const local = await makeProvider("http://127.0.0.1:1234/v1")
      .generate({ ...contractRequest, model: "lmstudio/m" })
      .then(() => undefined, (e: unknown) => e as Error);
    expect(local?.message).toContain("is the local model server running");
    expect(local?.message).toContain("fetch failed"); // underlying detail preserved

    const localhost = await makeProvider("http://localhost:8080")
      .generate({ ...contractRequest, model: "lmstudio/m" })
      .then(() => undefined, (e: unknown) => e as Error);
    expect(localhost?.message).toContain("is the local model server running");

    const remote = await makeProvider("https://openrouter.example/api/v1")
      .generate({ ...contractRequest, model: "lmstudio/m" })
      .then(() => undefined, (e: unknown) => e as Error);
    expect(remote?.message).toContain("endpoint unreachable");
    expect(remote?.message).not.toContain("local model server");
  });

  it("openai-compatible base wraps a 200-but-non-JSON body as a retryable ModelProviderError, not a raw SyntaxError", async () => {
    const htmlBody = `<!DOCTYPE html><html><body>captive portal login</body></html>${"x".repeat(5000)}`;
    const provider = new OpenAICompatibleProvider({
      baseUrl: "http://compat.example.test/v1",
      defaultModel: "model-test",
      fetch: async () => new Response(htmlBody, { status: 200, headers: { "content-type": "text/html" } }),
      id: "lmstudio",
      models: ["model-test"]
    });

    let caught: unknown;
    await provider.generate({ ...contractRequest, model: "lmstudio/model-test" })
      .catch((error: unknown) => { caught = error; });
    expect(caught).toMatchObject({ name: "ModelProviderError", providerId: "lmstudio", retryable: true });
    const message = (caught as { message: string }).message;
    expect(message).toContain("was not valid JSON");
    // The raw 5000-char body must not flow unbounded into the error.
    expect(message.length).toBeLessThan(360);
  });

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

  it("anthropic wraps a 200-but-non-JSON body as a retryable ModelProviderError", async () => {
    const htmlBody = `<!DOCTYPE html><html>captive portal</html>${"x".repeat(5000)}`;
    const provider = new AnthropicProvider({
      defaultModel: "claude-test",
      fetch: async () => new Response(htmlBody, { status: 200, headers: { "content-type": "text/html" } }),
      models: ["claude-test"]
    });
    let caught: unknown;
    await provider.generate({ ...contractRequest, model: "anthropic/claude-test" })
      .catch((error: unknown) => { caught = error; });
    expect(caught).toMatchObject({ name: "ModelProviderError", providerId: "anthropic", retryable: true });
    const message = (caught as { message: string }).message;
    expect(message).toContain("was not valid JSON");
    expect(message.length).toBeLessThan(360);
  });

  it("gemini wraps a 200-but-non-JSON body as a retryable ModelProviderError", async () => {
    const htmlBody = `<!DOCTYPE html><html>captive portal</html>${"x".repeat(5000)}`;
    const provider = new GeminiProvider({
      defaultModel: "gemini-test",
      fetch: async () => new Response(htmlBody, { status: 200, headers: { "content-type": "text/html" } }),
      models: ["gemini-test"]
    });
    let caught: unknown;
    await provider.generate({ ...contractRequest, model: "gemini/gemini-test" })
      .catch((error: unknown) => { caught = error; });
    expect(caught).toMatchObject({ name: "ModelProviderError", providerId: "gemini", retryable: true });
    const message = (caught as { message: string }).message;
    expect(message).toContain("was not valid JSON");
    expect(message.length).toBeLessThan(360);
  });

  it("openai responses wraps a 200-but-non-JSON body as a retryable ModelProviderError", async () => {
    const htmlBody = `<!DOCTYPE html><html>captive portal</html>${"x".repeat(5000)}`;
    const provider = new OpenAIProvider({
      defaultModel: "gpt-test",
      fetch: async () => new Response(htmlBody, { status: 200, headers: { "content-type": "text/html" } }),
      models: ["gpt-test"]
    });
    let caught: unknown;
    await provider.generate({ ...contractRequest, model: "openai/gpt-test" })
      .catch((error: unknown) => { caught = error; });
    expect(caught).toMatchObject({ name: "ModelProviderError", providerId: "openai", retryable: true });
    const message = (caught as { message: string }).message;
    expect(message).toContain("was not valid JSON");
    expect(message.length).toBeLessThan(360);
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

describe("OllamaProvider streaming tool-call delivered in a done:false chunk", () => {
  it("emits and finalizes a tool call when tool_calls arrive before the terminal done line", async () => {
    const fetch: typeof globalThis.fetch = async (url) => {
      if (String(url).includes("/models")) {
        return new Response(JSON.stringify({ data: [{ id: "qwen3:8b", object: "model" }] }));
      }
      return new Response(new ReadableStream({
        start(controller) {
          const enc = new TextEncoder();
          // Real qwen3:8b shape — tool_calls arrive in a done:false chunk …
          controller.enqueue(enc.encode(JSON.stringify({
            done: false,
            message: {
              content: "",
              role: "assistant",
              tool_calls: [{ function: { arguments: { city: "Paris" }, name: "get_weather" }, id: "call_x" }]
            },
            model: "qwen3:8b"
          }) + "\n"));
          // … and the terminal done:true line has NO tool_calls.
          controller.enqueue(enc.encode(JSON.stringify({
            done: true,
            eval_count: 3,
            message: { content: "", role: "assistant" },
            model: "qwen3:8b",
            prompt_eval_count: 7
          }) + "\n"));
          controller.close();
        }
      }));
    };
    const provider = new OllamaProvider({
      baseUrl: "http://o.test/v1",
      defaultModel: "qwen3:8b",
      fetch,
      models: ["qwen3:8b"]
    });
    const events: { type: string; toolCall?: unknown; response?: { toolCalls?: unknown } }[] = [];
    for await (const ev of provider.stream({ messages: [{ content: "weather?", role: "user" }], model: "ollama/qwen3:8b" })) {
      events.push(ev as (typeof events)[number]);
    }
    expect(events.filter((e) => e.type === "tool-call")).toEqual([
      { toolCall: { arguments: { city: "Paris" }, id: "call_x", name: "get_weather" }, type: "tool-call" }
    ]);
    const done = events.find((e) => e.type === "done");
    expect(done?.response?.toolCalls).toEqual([
      { arguments: { city: "Paris" }, id: "call_x", name: "get_weather" }
    ]);
  });
});

describe("OllamaProvider streaming flushes an unterminated final NDJSON line", () => {
  it("recovers the terminal done:true chunk (content + usage) when it has no trailing newline", async () => {
    const fetch: typeof globalThis.fetch = async (url) => {
      if (String(url).includes("/models")) {
        return new Response(JSON.stringify({ data: [{ id: "qwen3:8b", object: "model" }] }));
      }
      return new Response(new ReadableStream({
        start(controller) {
          const enc = new TextEncoder();
          // Non-terminal delta WITH newline …
          controller.enqueue(enc.encode(JSON.stringify({
            done: false,
            message: { content: "hel", role: "assistant" },
            model: "qwen3:8b"
          }) + "\n"));
          // … terminal done:true chunk with the rest of the answer
          // and the token usage, deliberately NOT newline-terminated.
          controller.enqueue(enc.encode(JSON.stringify({
            done: true,
            eval_count: 3,
            message: { content: "lo", role: "assistant" },
            model: "qwen3:8b",
            prompt_eval_count: 7
          })));
          controller.close();
        }
      }));
    };
    const provider = new OllamaProvider({
      baseUrl: "http://o.test/v1",
      defaultModel: "qwen3:8b",
      fetch,
      models: ["qwen3:8b"]
    });
    const events: { type: string; text?: string; response?: { output?: string; usage?: unknown } }[] = [];
    for await (const ev of provider.stream({ messages: [{ content: "hi", role: "user" }], model: "ollama/qwen3:8b" })) {
      events.push(ev as (typeof events)[number]);
    }
    const text = events.filter((e) => e.type === "text-delta").map((e) => e.text).join("");
    expect(text).toBe("hello");
    const done = events.find((e) => e.type === "done");
    expect(done?.response?.output).toBe("hello");
    expect(done?.response?.usage).toEqual({ inputTokens: 7, outputTokens: 3 });
  });
});

describe("OllamaProvider num_ctx (goal 165)", () => {
  function captureBodyFetch(): { fetch: typeof globalThis.fetch; bodies: Record<string, unknown>[] } {
    const bodies: Record<string, unknown>[] = [];
    const fetch: typeof globalThis.fetch = async (url, init) => {
      if (String(url).includes("/models")) {
        return new Response(JSON.stringify({ data: [{ id: "model-test", object: "model" }] }));
      }
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ message: { content: "ok", role: "assistant" }, model: "model-test" }));
    };
    return { bodies, fetch };
  }

  it("defaults num_ctx to 32768 so Muse's rich prompt isn't truncated", async () => {
    const { bodies, fetch } = captureBodyFetch();
    const provider = new OllamaProvider({ baseUrl: "http://o.test/v1", defaultModel: "model-test", fetch, models: ["model-test"] });
    await provider.generate({ messages: [{ content: "hi", role: "user" }], model: "ollama/model-test" });
    expect((bodies[0]?.options as { num_ctx?: number }).num_ctx).toBe(32768);
  });

  it("honours an explicit numCtx option and ignores non-positive values", async () => {
    const big = captureBodyFetch();
    const p1 = new OllamaProvider({ baseUrl: "http://o.test/v1", defaultModel: "model-test", fetch: big.fetch, models: ["model-test"], numCtx: 16384 });
    await p1.generate({ messages: [{ content: "hi", role: "user" }], model: "ollama/model-test" });
    expect((big.bodies[0]?.options as { num_ctx?: number }).num_ctx).toBe(16384);

    const bad = captureBodyFetch();
    const p2 = new OllamaProvider({ baseUrl: "http://o.test/v1", defaultModel: "model-test", fetch: bad.fetch, models: ["model-test"], numCtx: 0 });
    await p2.generate({ messages: [{ content: "hi", role: "user" }], model: "ollama/model-test" });
    expect((bad.bodies[0]?.options as { num_ctx?: number }).num_ctx).toBe(32768);
  });

  it("forwards responseFormat to Ollama's native `format` (structured output), and omits it otherwise", async () => {
    const schema = { type: "object", properties: { city: { type: "string" } }, required: ["city"] };
    const on = captureBodyFetch();
    const p1 = new OllamaProvider({ baseUrl: "http://o.test/v1", defaultModel: "model-test", fetch: on.fetch, models: ["model-test"] });
    await p1.generate({ messages: [{ content: "hi", role: "user" }], model: "ollama/model-test", responseFormat: schema });
    expect(on.bodies[0]?.format).toEqual(schema);

    const off = captureBodyFetch();
    const p2 = new OllamaProvider({ baseUrl: "http://o.test/v1", defaultModel: "model-test", fetch: off.fetch, models: ["model-test"] });
    await p2.generate({ messages: [{ content: "hi", role: "user" }], model: "ollama/model-test" });
    expect(off.bodies[0]).not.toHaveProperty("format");
  });
});

describe("OllamaProvider model-not-found hint (goal 176)", () => {
  const notFound: typeof globalThis.fetch = async (url) => {
    if (String(url).includes("/models")) {
      return new Response(JSON.stringify({ data: [] }));
    }
    return new Response(
      JSON.stringify({ error: "model 'qwen3:8b' not found, try pulling it first" }),
      { status: 404, statusText: "Not Found" }
    );
  };

  it("appends `ollama pull <model>` to a 404 model-not-found error (generate)", async () => {
    const provider = new OllamaProvider({ baseUrl: "http://o.test/v1", defaultModel: "qwen3:8b", fetch: notFound, models: ["qwen3:8b"] });
    const err = await provider.generate({ messages: [{ content: "hi", role: "user" }], model: "ollama/qwen3:8b" })
      .then(() => undefined, (e: unknown) => e as Error);
    expect(err?.message).toContain("Ollama /api/chat [qwen3:8b] failed with 404");
    expect(err?.message).toContain("ollama pull qwen3:8b");
  });

  it("appends the hint on the streaming path too", async () => {
    const provider = new OllamaProvider({ baseUrl: "http://o.test/v1", defaultModel: "qwen3:8b", fetch: notFound, models: ["qwen3:8b"] });
    const events = [];
    for await (const ev of provider.stream({ messages: [{ content: "hi", role: "user" }], model: "ollama/qwen3:8b" })) {
      events.push(ev);
    }
    const errEvent = events.find((e) => e.type === "error") as { error: Error } | undefined;
    expect(errEvent?.error.message).toContain("Ollama stream [qwen3:8b] failed with 404");
    expect(errEvent?.error.message).toContain("ollama pull qwen3:8b");
  });

  it("does NOT append a pull hint for non-404 / non-not-found failures", async () => {
    const five: typeof globalThis.fetch = async (url) => {
      if (String(url).includes("/models")) return new Response(JSON.stringify({ data: [] }));
      return new Response("upstream exploded", { status: 503, statusText: "Unavailable" });
    };
    const provider = new OllamaProvider({ baseUrl: "http://o.test/v1", defaultModel: "qwen3:8b", fetch: five, models: ["qwen3:8b"] });
    const err = await provider.generate({ messages: [{ content: "hi", role: "user" }], model: "ollama/qwen3:8b" })
      .then(() => undefined, (e: unknown) => e as Error);
    expect(err?.message).toContain("503");
    expect(err?.message).not.toContain("ollama pull");
  });
});

describe("OllamaProvider mid-stream error line", () => {
  it("surfaces an `{error}` NDJSON line (200 then mid-generation failure) as an error event and stops, not a silently truncated answer", async () => {
    const ndjson =
      `${JSON.stringify({ message: { content: "Thinking" }, model: "qwen3:8b" })}\n` +
      `${JSON.stringify({ error: "model runner has crashed: out of memory" })}\n` +
      `${JSON.stringify({ done: true, eval_count: 9, message: { content: " more" } })}\n`;
    const fetch: typeof globalThis.fetch = async (url) => {
      if (String(url).includes("/models")) return new Response(JSON.stringify({ data: [] }));
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(ndjson));
            controller.close();
          }
        }),
        { status: 200 }
      );
    };
    const provider = new OllamaProvider({ baseUrl: "http://o.test/v1", defaultModel: "qwen3:8b", fetch, models: ["qwen3:8b"] });
    const events = [];
    for await (const ev of provider.stream({ messages: [{ content: "hi", role: "user" }], model: "ollama/qwen3:8b" })) {
      events.push(ev);
    }
    const errEvent = events.find((e) => e.type === "error") as { error: Error & { retryable?: boolean } } | undefined;
    expect(errEvent?.error.message).toContain("out of memory");
    expect(errEvent?.error.retryable).toBe(true);
    // The post-error `done:true` line must NOT have produced a done
    // event — the stream stops at the error.
    expect(events.some((e) => e.type === "done")).toBe(false);
  });
});

describe("OllamaProvider native 200-but-non-JSON body", () => {
  it("wraps a 200 non-JSON /api/chat body as a retryable ModelProviderError, not a raw SyntaxError", async () => {
    const htmlBody = `<!DOCTYPE html><html>captive portal</html>${"x".repeat(5000)}`;
    const fetch: typeof globalThis.fetch = async (url) => {
      if (String(url).includes("/models")) return new Response(JSON.stringify({ data: [] }));
      return new Response(htmlBody, { status: 200, headers: { "content-type": "text/html" } });
    };
    const provider = new OllamaProvider({ baseUrl: "http://o.test/v1", defaultModel: "qwen3:8b", fetch, models: ["qwen3:8b"] });
    let caught: unknown;
    await provider.generate({ messages: [{ content: "hi", role: "user" }], model: "ollama/qwen3:8b" })
      .catch((error: unknown) => { caught = error; });
    expect(caught).toMatchObject({ name: "ModelProviderError", providerId: "ollama", retryable: true });
    const message = (caught as { message: string }).message;
    expect(message).toContain("was not valid JSON");
    expect(message.length).toBeLessThan(360);
  });
});

describe("OllamaProvider native tool-call request/response contract", () => {
  it("sends the native /api/chat tool shape + think:false and parses message.tool_calls", async () => {
    let captured: Record<string, unknown> | undefined;
    const fetch: typeof globalThis.fetch = async (url, init) => {
      if (String(url).includes("/models")) {
        return new Response(JSON.stringify({ data: [{ id: "qwen3:8b", object: "model" }] }));
      }
      captured = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        done: true,
        eval_count: 3,
        message: {
          content: "",
          role: "assistant",
          tool_calls: [{ function: { arguments: { city: "Paris" }, name: "get_weather" }, id: "call_x" }]
        },
        model: "qwen3:8b",
        prompt_eval_count: 7
      }));
    };
    const provider = new OllamaProvider({
      baseUrl: "http://o.test/v1",
      defaultModel: "qwen3:8b",
      fetch,
      models: ["qwen3:8b"]
    });

    const result = await provider.generate({
      messages: [{ content: "weather in Paris?", role: "user" }],
      model: "ollama/qwen3:8b",
      tools: [{
        description: "Get current weather for a city",
        inputSchema: { properties: { city: { type: "string" } }, required: ["city"], type: "object" },
        name: "get_weather"
      }]
    });

    // Request: native Ollama tool shape + the qwen3 CoT-suppression flag.
    expect(captured?.["stream"]).toBe(false);
    expect(captured?.["think"]).toBe(false);
    expect(captured?.["tools"]).toEqual([{
      function: {
        description: "Get current weather for a city",
        name: "get_weather",
        parameters: { properties: { city: { type: "string" } }, required: ["city"], type: "object" }
      },
      type: "function"
    }]);
    // Response: native message.tool_calls → result.toolCalls.
    expect(result.toolCalls).toEqual([
      { arguments: { city: "Paris" }, id: "call_x", name: "get_weather" }
    ]);
    expect(result.output).toBe("");
    expect(result.usage).toEqual({ inputTokens: 7, outputTokens: 3 });
  });
});

/**
 * Ollama's native /api/chat shape — used by OllamaProvider's
 * think:false override. NDJSON streaming, single-JSON non-streaming.
 * The OpenAI-compat shim (used by other providers) has a different
 * shape (`choices[]`, SSE) and is faked separately below.
 */
function fakeOllamaChatFetch(options: { readonly forceError?: boolean } = {}): typeof globalThis.fetch {
  return async (url, init) => {
    if (options.forceError) {
      return new Response("temporary provider failure", { status: 503, statusText: "Unavailable" });
    }
    // listModels still hits the /v1/models OpenAI-compat endpoint via
    // the parent. Forward those untouched through the OpenAI fake.
    if (String(url).includes("/models")) {
      return new Response(JSON.stringify({ data: [{ id: "model-test", object: "model" }] }));
    }
    const body = JSON.parse(String(init?.body)) as { readonly stream?: boolean };
    if (body.stream) {
      return new Response(new ReadableStream({
        start(controller) {
          const enc = new TextEncoder();
          controller.enqueue(enc.encode(JSON.stringify({ message: { content: "contract ", role: "assistant" }, model: "model-test" }) + "\n"));
          controller.enqueue(enc.encode(JSON.stringify({ message: { content: "response", role: "assistant" }, model: "model-test" }) + "\n"));
          controller.enqueue(enc.encode(JSON.stringify({
            done: true,
            eval_count: 5,
            message: {
              content: "",
              role: "assistant",
              tool_calls: [{ function: { arguments: { query: "muse" }, name: "search" }, id: "call-1" }]
            },
            model: "model-test",
            prompt_eval_count: 11
          }) + "\n"));
          controller.close();
        }
      }));
    }
    return new Response(JSON.stringify({
      done: true,
      eval_count: 5,
      message: {
        content: "contract response",
        role: "assistant",
        tool_calls: [{
          function: { arguments: { query: "muse" }, name: "search" },
          id: "call-1"
        }]
      },
      model: "model-test",
      prompt_eval_count: 11
    }));
  };
}

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

function fakeOpenAIResponsesFetch(options: { readonly forceError?: boolean } = {}): typeof globalThis.fetch {
  return async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { readonly stream?: boolean };

    if (options.forceError) {
      return new Response("temporary provider failure", { status: 503, statusText: "Unavailable" });
    }

    if (body.stream) {
      return new Response(new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder();
          const encode = (obj: unknown) => encoder.encode(`data: ${JSON.stringify(obj)}\n\n`);
          controller.enqueue(encode({ type: "response.output_text.delta", delta: "contract " }));
          controller.enqueue(encode({ type: "response.output_text.delta", delta: "response" }));
          controller.enqueue(encode({
            type: "response.output_item.done",
            item: { type: "function_call", call_id: "call-1", name: "search", arguments: "{\"query\":\"muse\"}" }
          }));
          controller.enqueue(encode({
            type: "response.completed",
            response: { id: "resp-contract", model: "model-test", usage: { input_tokens: 11, output_tokens: 5 } }
          }));
          controller.close();
        }
      }));
    }

    return new Response(JSON.stringify({
      id: "resp-contract",
      model: "model-test",
      output: [
        {
          type: "function_call",
          call_id: "call-1",
          name: "search",
          arguments: "{\"query\":\"muse\"}"
        },
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "contract response", annotations: [] }]
        }
      ],
      usage: { input_tokens: 11, output_tokens: 5 }
    }));
  };
}

describe("OpenAI Responses tool-call arguments are object-guarded (consistent with the chat + Ollama paths)", () => {
  function responsesFetchWithArgs(rawArgs: string, stream: boolean): typeof globalThis.fetch {
    return async () => {
      if (stream) {
        return new Response(new ReadableStream({
          start(controller) {
            const enc = new TextEncoder();
            const send = (o: unknown) => controller.enqueue(enc.encode(`data: ${JSON.stringify(o)}\n\n`));
            send({
              type: "response.output_item.done",
              item: { type: "function_call", call_id: "call-x", name: "search", arguments: rawArgs }
            });
            send({ type: "response.completed", response: { id: "r", model: "model-test", usage: {} } });
            controller.close();
          }
        }));
      }
      return new Response(JSON.stringify({
        id: "r",
        model: "model-test",
        output: [{ type: "function_call", call_id: "call-x", name: "search", arguments: rawArgs }],
        usage: { input_tokens: 1, output_tokens: 1 }
      }));
    };
  }

  const request = { messages: [{ content: "hi", role: "user" as const }], model: "model-test" };

  it("non-object / malformed argument JSON collapses to {} (never an array/primitive/null)", async () => {
    for (const raw of ["[1,2,3]", "\"just a string\"", "5", "null", "{not valid"]) {
      const provider = new OpenAIProvider({
        baseUrl: "https://openai.example.test/v1",
        defaultModel: "model-test",
        fetch: responsesFetchWithArgs(raw, false),
        models: ["model-test"]
      });
      const response = await provider.generate(request);
      expect(response.toolCalls?.[0]?.arguments).toEqual({});
    }
  });

  it("a well-formed object argument still parses through (no regression)", async () => {
    const provider = new OpenAIProvider({
      baseUrl: "https://openai.example.test/v1",
      defaultModel: "model-test",
      fetch: responsesFetchWithArgs("{\"query\":\"muse\"}", false),
      models: ["model-test"]
    });
    const response = await provider.generate(request);
    expect(response.toolCalls?.[0]?.arguments).toEqual({ query: "muse" });
  });

  it("the streaming Responses path applies the same object guard", async () => {
    const provider = new OpenAIProvider({
      baseUrl: "https://openai.example.test/v1",
      defaultModel: "model-test",
      fetch: responsesFetchWithArgs("[1,2,3]", true),
      models: ["model-test"]
    });
    const toolCalls = [];
    for await (const event of provider.stream(request)) {
      if (event.type === "tool-call") toolCalls.push(event.toolCall);
    }
    expect(toolCalls[0]?.arguments).toEqual({});
  });
});

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

describe("readFiniteNumber (provider usage-token boundary)", () => {
  it("returns a finite number (including 0) for a present numeric key", async () => {
    const { readFiniteNumber } = await import("../src/provider-shared.js");
    expect(readFiniteNumber({ input_tokens: 1234 }, "input_tokens")).toBe(1234);
    expect(readFiniteNumber({ output_tokens: 0 }, "output_tokens")).toBe(0);
    expect(readFiniteNumber({ x: -5 }, "x")).toBe(-5);
  });

  it("returns undefined for a non-finite value — a malformed provider count can't poison cost/budget", async () => {
    const { readFiniteNumber } = await import("../src/provider-shared.js");
    expect(readFiniteNumber({ t: Number.NaN }, "t")).toBeUndefined();
    expect(readFiniteNumber({ t: Number.POSITIVE_INFINITY }, "t")).toBeUndefined();
    expect(readFiniteNumber({ t: Number.NEGATIVE_INFINITY }, "t")).toBeUndefined();
  });

  it("returns undefined for a wrong-typed or absent key", async () => {
    const { readFiniteNumber } = await import("../src/provider-shared.js");
    expect(readFiniteNumber({ t: "123" }, "t")).toBeUndefined();   // stringified number
    expect(readFiniteNumber({ t: null }, "t")).toBeUndefined();
    expect(readFiniteNumber({ other: 1 }, "t")).toBeUndefined();
  });

  it("returns undefined for a non-record value (incl. the absent nested-usage case)", async () => {
    const { readFiniteNumber } = await import("../src/provider-shared.js");
    // Mirrors provider-openai's `readFiniteNumber(value.prompt_tokens_details, …)`
    // where the nested usage object is frequently undefined.
    expect(readFiniteNumber(undefined, "cached_tokens")).toBeUndefined();
    expect(readFiniteNumber(null, "x")).toBeUndefined();
    expect(readFiniteNumber("nope", "x")).toBeUndefined();
    expect(readFiniteNumber(42, "x")).toBeUndefined();
    expect(readFiniteNumber([1, 2], "0")).toBeUndefined();
  });
});

describe("model capability presets (local-first invariants)", () => {
  it("the local preset declares reasoning/vision OFF and local/free, but inherits tool-calling, streaming, and structured output", async () => {
    const { localModelCapabilities, defaultRemoteModelCapabilities } = await import("../src/provider-shared.js");
    const local = localModelCapabilities();

    // The product runs local Qwen with reasoning=false and no vision; a mutant
    // that dropped these overrides (inheriting the remote `true`s via the spread)
    // would silently re-enable chain-of-thought leakage / a vision claim the
    // local model can't honor.
    expect(local.reasoning).toBe(false);
    expect(local.vision).toBe(false);
    expect(local.local).toBe(true);
    expect(local.cost).toBe("free");
    expect(local.latencyProfile).toBe("interactive");
    expect(local.maxInputTokens).toBe(32_768);
    expect(local.maxOutputTokens).toBe(8_192);

    // These MUST survive the spread (a mutant deleting the `...remote` spread
    // would zero them out): the local model still calls tools and streams.
    expect(local.toolCalling).toBe(true);
    expect(local.streaming).toBe(true);
    expect(local.structuredOutput).toBe(true);

    // The remote default is the opposite posture on the overridden fields.
    const remote = defaultRemoteModelCapabilities();
    expect(remote.local).toBe(false);
    expect(remote.reasoning).toBe(true);
    expect(remote.vision).toBe(true);
    expect(remote.cost).toBe("unknown");
  });
});

describe("synthesizeStreamEventsFromResponse (Anthropic/Gemini stream parity)", () => {
  async function collect(response: unknown): Promise<readonly { type: string }[]> {
    const { synthesizeStreamEventsFromResponse } = await import("../src/provider-shared.js");
    const out: { type: string }[] = [];
    for await (const event of synthesizeStreamEventsFromResponse(response as never)) out.push(event);
    return out;
  }

  it("replays text, tool calls, and web_search/citation events in the native SSE order", async () => {
    const events = await collect({
      output: "hi",
      toolCalls: [{ id: "1", name: "t", arguments: {} }],
      citations: [{ url: "u", title: "x" }]
    });
    expect(events.map((e) => e.type)).toEqual([
      "text-delta",
      "tool-call",
      "tool-call-started",
      "tool-call-finished",
      "citations",
      "done"
    ]);
  });

  it("emits ONLY the terminal done event when output, tool calls, and citations are all empty", async () => {
    // No text-delta for empty output, and no web_search status/citation triplet
    // when there are zero citations — emitting them would fabricate a search the
    // provider never ran.
    const events = await collect({ output: "", toolCalls: [], citations: [] });
    expect(events.map((e) => e.type)).toEqual(["done"]);
  });

  it("emits text-delta + done for a plain text answer with no tools or citations", async () => {
    const events = await collect({ output: "answer" });
    expect(events.map((e) => e.type)).toEqual(["text-delta", "done"]);
  });

  it("reports the citation count on tool-call-finished and the full items on the citations event", async () => {
    const { synthesizeStreamEventsFromResponse } = await import("../src/provider-shared.js");
    const events = [];
    for await (const event of synthesizeStreamEventsFromResponse({
      output: "x",
      citations: [{ url: "u" }, { url: "v" }]
    } as never)) events.push(event);

    expect(events).toContainEqual({ count: 2, name: "web_search", type: "tool-call-finished" });
    expect(events).toContainEqual({ items: [{ url: "u" }, { url: "v" }], type: "citations" });
  });
});
