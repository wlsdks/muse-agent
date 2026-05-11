import { describe, expect, it } from "vitest";

import { OpenAICompatibleProvider } from "@muse/model";

import { createModelProvider } from "../src/autoconfigure-model-provider.js";

describe("createModelProvider — OpenAI-compatible presets", () => {
  it("groq routes through OpenAICompatibleProvider with the Groq base URL", () => {
    const provider = createModelProvider({
      GROQ_API_KEY: "grq-test",
      MUSE_MODEL: "groq/llama-3.1-70b-versatile",
      MUSE_MODEL_PROVIDER_ID: "groq"
    });
    expect(provider).toBeInstanceOf(OpenAICompatibleProvider);
    expect(provider?.id).toBe("groq");
  });

  it("deepseek routes through OpenAICompatibleProvider with the DeepSeek base URL", () => {
    const provider = createModelProvider({
      DEEPSEEK_API_KEY: "ds-test",
      MUSE_MODEL: "deepseek/deepseek-chat",
      MUSE_MODEL_PROVIDER_ID: "deepseek"
    });
    expect(provider).toBeInstanceOf(OpenAICompatibleProvider);
    expect(provider?.id).toBe("deepseek");
  });

  it("together routes through OpenAICompatibleProvider with the Together base URL", () => {
    const provider = createModelProvider({
      TOGETHER_API_KEY: "tg-test",
      MUSE_MODEL: "together/meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo",
      MUSE_MODEL_PROVIDER_ID: "together"
    });
    expect(provider).toBeInstanceOf(OpenAICompatibleProvider);
    expect(provider?.id).toBe("together");
  });

  it("MUSE_MODEL_API_KEY overrides provider-specific keys", () => {
    const provider = createModelProvider({
      GROQ_API_KEY: "wrong",
      MUSE_MODEL: "groq/llama-3.1-70b-versatile",
      MUSE_MODEL_API_KEY: "correct",
      MUSE_MODEL_PROVIDER_ID: "groq"
    });
    expect(provider).toBeDefined();
    expect(provider?.id).toBe("groq");
  });

  it("MUSE_MODEL_BASE_URL overrides the default preset base URL", () => {
    const provider = createModelProvider({
      GROQ_API_KEY: "grq",
      MUSE_MODEL: "groq/llama-3.1-70b-versatile",
      MUSE_MODEL_BASE_URL: "https://internal.proxy/openai/v1",
      MUSE_MODEL_PROVIDER_ID: "groq"
    });
    expect(provider).toBeInstanceOf(OpenAICompatibleProvider);
    expect(provider?.id).toBe("groq");
  });

  it("mistral derives provider from prefix and returns a usable provider with only MISTRAL_API_KEY", () => {
    const provider = createModelProvider({
      MISTRAL_API_KEY: "ms-test",
      MUSE_MODEL: "mistral-small-latest"
    });
    expect(provider).toBeInstanceOf(OpenAICompatibleProvider);
    expect(provider?.id).toBe("mistral");
  });

  it("moonshot derives provider from prefix and returns a usable provider with only MOONSHOT_API_KEY", () => {
    const provider = createModelProvider({
      MOONSHOT_API_KEY: "moon-test",
      MUSE_MODEL: "moonshot-v1-8k"
    });
    expect(provider).toBeInstanceOf(OpenAICompatibleProvider);
    expect(provider?.id).toBe("moonshot");
  });

  it("autoconfigures Groq when only GROQ_API_KEY is set (no MUSE_MODEL)", () => {
    const provider = createModelProvider({ GROQ_API_KEY: "grq" });
    expect(provider).toBeInstanceOf(OpenAICompatibleProvider);
    expect(provider?.id).toBe("groq");
  });

  it("autoconfigures DeepSeek when only DEEPSEEK_API_KEY is set", () => {
    const provider = createModelProvider({ DEEPSEEK_API_KEY: "ds" });
    expect(provider).toBeInstanceOf(OpenAICompatibleProvider);
    expect(provider?.id).toBe("deepseek");
  });

  it("autoconfigures Together when only TOGETHER_API_KEY is set", () => {
    const provider = createModelProvider({ TOGETHER_API_KEY: "tg" });
    expect(provider).toBeInstanceOf(OpenAICompatibleProvider);
    expect(provider?.id).toBe("together");
  });

  it("autoconfigures Mistral when only MISTRAL_API_KEY is set", () => {
    const provider = createModelProvider({ MISTRAL_API_KEY: "ms" });
    expect(provider).toBeInstanceOf(OpenAICompatibleProvider);
    expect(provider?.id).toBe("mistral");
  });

  it("autoconfigures Moonshot when only MOONSHOT_API_KEY is set", () => {
    const provider = createModelProvider({ MOONSHOT_API_KEY: "mn" });
    expect(provider).toBeInstanceOf(OpenAICompatibleProvider);
    expect(provider?.id).toBe("moonshot");
  });
});
