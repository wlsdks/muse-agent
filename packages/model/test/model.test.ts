import { describe, expect, it } from "vitest";
import {
  canUseNativeTools,
  knownModelPrefixes,
  ModelProviderError,
  ModelProviderRegistry,
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
