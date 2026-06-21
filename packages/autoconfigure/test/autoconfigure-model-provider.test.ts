import { describe, expect, it } from "vitest";

import { OpenAICompatibleProvider, OpenRouterProvider } from "@muse/model";

import { createModelProvider } from "../src/autoconfigure-model-provider.js";

describe("createModelProvider — OpenAI-compatible presets", () => {
  it("groq routes through OpenAICompatibleProvider with the Groq base URL", () => {
    const provider = createModelProvider({ MUSE_LOCAL_ONLY: "false",
      GROQ_API_KEY: "grq-test",
      MUSE_MODEL: "groq/llama-3.1-70b-versatile",
      MUSE_MODEL_PROVIDER_ID: "groq"
    });
    expect(provider).toBeInstanceOf(OpenAICompatibleProvider);
    expect(provider?.id).toBe("groq");
  });

  it("deepseek routes through OpenAICompatibleProvider with the DeepSeek base URL", () => {
    const provider = createModelProvider({ MUSE_LOCAL_ONLY: "false",
      DEEPSEEK_API_KEY: "ds-test",
      MUSE_MODEL: "deepseek/deepseek-chat",
      MUSE_MODEL_PROVIDER_ID: "deepseek"
    });
    expect(provider).toBeInstanceOf(OpenAICompatibleProvider);
    expect(provider?.id).toBe("deepseek");
  });

  it("together routes through OpenAICompatibleProvider with the Together base URL", () => {
    const provider = createModelProvider({ MUSE_LOCAL_ONLY: "false",
      TOGETHER_API_KEY: "tg-test",
      MUSE_MODEL: "together/meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo",
      MUSE_MODEL_PROVIDER_ID: "together"
    });
    expect(provider).toBeInstanceOf(OpenAICompatibleProvider);
    expect(provider?.id).toBe("together");
  });

  it("MUSE_MODEL_API_KEY overrides provider-specific keys", () => {
    const provider = createModelProvider({ MUSE_LOCAL_ONLY: "false",
      GROQ_API_KEY: "wrong",
      MUSE_MODEL: "groq/llama-3.1-70b-versatile",
      MUSE_MODEL_API_KEY: "correct",
      MUSE_MODEL_PROVIDER_ID: "groq"
    });
    expect(provider).toBeDefined();
    expect(provider?.id).toBe("groq");
  });

  it("MUSE_MODEL_BASE_URL overrides the default preset base URL", () => {
    const provider = createModelProvider({ MUSE_LOCAL_ONLY: "false",
      GROQ_API_KEY: "grq",
      MUSE_MODEL: "groq/llama-3.1-70b-versatile",
      MUSE_MODEL_BASE_URL: "https://internal.proxy/openai/v1",
      MUSE_MODEL_PROVIDER_ID: "groq"
    });
    expect(provider).toBeInstanceOf(OpenAICompatibleProvider);
    expect(provider?.id).toBe("groq");
  });

  it("mistral derives provider from prefix and returns a usable provider with only MISTRAL_API_KEY", () => {
    const provider = createModelProvider({ MUSE_LOCAL_ONLY: "false",
      MISTRAL_API_KEY: "ms-test",
      MUSE_MODEL: "mistral-small-latest"
    });
    expect(provider).toBeInstanceOf(OpenAICompatibleProvider);
    expect(provider?.id).toBe("mistral");
  });

  it("moonshot derives provider from prefix and returns a usable provider with only MOONSHOT_API_KEY", () => {
    const provider = createModelProvider({ MUSE_LOCAL_ONLY: "false",
      MOONSHOT_API_KEY: "moon-test",
      MUSE_MODEL: "moonshot-v1-8k"
    });
    expect(provider).toBeInstanceOf(OpenAICompatibleProvider);
    expect(provider?.id).toBe("moonshot");
  });

  it("autoconfigures Groq when only GROQ_API_KEY is set (no MUSE_MODEL)", () => {
    const provider = createModelProvider({ MUSE_LOCAL_ONLY: "false", GROQ_API_KEY: "grq" });
    expect(provider).toBeInstanceOf(OpenAICompatibleProvider);
    expect(provider?.id).toBe("groq");
  });

  it("autoconfigures DeepSeek when only DEEPSEEK_API_KEY is set", () => {
    const provider = createModelProvider({ MUSE_LOCAL_ONLY: "false", DEEPSEEK_API_KEY: "ds" });
    expect(provider).toBeInstanceOf(OpenAICompatibleProvider);
    expect(provider?.id).toBe("deepseek");
  });

  it("autoconfigures Together when only TOGETHER_API_KEY is set", () => {
    const provider = createModelProvider({ MUSE_LOCAL_ONLY: "false", TOGETHER_API_KEY: "tg" });
    expect(provider).toBeInstanceOf(OpenAICompatibleProvider);
    expect(provider?.id).toBe("together");
  });

  it("autoconfigures Mistral when only MISTRAL_API_KEY is set", () => {
    const provider = createModelProvider({ MUSE_LOCAL_ONLY: "false", MISTRAL_API_KEY: "ms" });
    expect(provider).toBeInstanceOf(OpenAICompatibleProvider);
    expect(provider?.id).toBe("mistral");
  });

  it("autoconfigures Moonshot when only MOONSHOT_API_KEY is set", () => {
    const provider = createModelProvider({ MUSE_LOCAL_ONLY: "false", MOONSHOT_API_KEY: "mn" });
    expect(provider).toBeInstanceOf(OpenAICompatibleProvider);
    expect(provider?.id).toBe("moonshot");
  });

  it("autoconfigures Cerebras when only CEREBRAS_API_KEY is set", () => {
    const provider = createModelProvider({ MUSE_LOCAL_ONLY: "false", CEREBRAS_API_KEY: "cs" });
    expect(provider).toBeInstanceOf(OpenAICompatibleProvider);
    expect(provider?.id).toBe("cerebras");
  });

  it("autoconfigures Ollama when only OLLAMA_BASE_URL is set", () => {
    const provider = createModelProvider({ MUSE_LOCAL_ONLY: "false", OLLAMA_BASE_URL: "http://localhost:11434" });
    expect(provider?.id).toBe("ollama");
  });

  it("routes openrouter through its OWN OpenRouterProvider (not the openai-compatible fallback)", () => {
    // OpenRouter is a first-class provider family with its own adapter; every
    // other preset test lands on OpenAICompatibleProvider, so this dedicated
    // case was unexercised.
    const provider = createModelProvider({
      MUSE_LOCAL_ONLY: "false",
      MUSE_MODEL: "openrouter/anthropic/claude-3.5-sonnet",
      MUSE_MODEL_PROVIDER_ID: "openrouter",
      OPENROUTER_API_KEY: "or-test"
    });
    expect(provider).toBeInstanceOf(OpenRouterProvider);
  });

  it("returns undefined for an unknown provider id with no base URL (can't build a compat client)", () => {
    // An unrecognized provider that isn't a preset needs a base URL to become an
    // openai-compatible client; without one there's nothing to construct → undefined,
    // not a crash.
    expect(createModelProvider({ MUSE_LOCAL_ONLY: "false", MUSE_MODEL: "weird/x", MUSE_MODEL_PROVIDER_ID: "weirdvendor" }))
      .toBeUndefined();
  });
});

describe("createModelProvider — Ollama base URL is honoured", () => {
  async function capturedGenerateUrl(env: Record<string, string>): Promise<string> {
    let url = "";
    const original = globalThis.fetch;
    // Stub BEFORE createModelProvider — OllamaProvider binds
    // globalThis.fetch at construction time.
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      url = String(input);
      return new Response(JSON.stringify({ message: { content: "ok" }, model: "m" }), { status: 200 });
    }) as typeof globalThis.fetch;
    try {
      // A REMOTE ollama host is egress, so testing remote URL routing requires
      // opting out of the default local-only gate (unless the env already set it).
      const provider = createModelProvider({ MUSE_LOCAL_ONLY: "false", ...env });
      expect(provider?.id).toBe("ollama");
      await provider?.generate({ messages: [{ content: "hi", role: "user" }], model: "ollama/llama3.2" });
    } finally {
      globalThis.fetch = original;
    }
    return url;
  }

  it("routes /api/chat to the OLLAMA_BASE_URL host (was silently 127.0.0.1)", async () => {
    expect(await capturedGenerateUrl({ OLLAMA_BASE_URL: "http://remote.test:11434" }))
      .toBe("http://remote.test:11434/api/chat");
    // Trailing slash and an already-/v1 form both normalise.
    expect(await capturedGenerateUrl({ OLLAMA_BASE_URL: "http://remote.test:11434/" }))
      .toBe("http://remote.test:11434/api/chat");
    expect(await capturedGenerateUrl({ OLLAMA_BASE_URL: "http://remote.test:11434/v1" }))
      .toBe("http://remote.test:11434/api/chat");
  });

  it("an explicit MUSE_MODEL_BASE_URL on the ollama provider still wins over OLLAMA_BASE_URL", async () => {
    // MUSE_MODEL_PROVIDER_ID forces the ollama case even with a
    // base URL set (otherwise a base URL routes via the generic
    // OpenAI-compat path); the explicit base must win the `??`.
    expect(await capturedGenerateUrl({
      MUSE_MODEL: "ollama/llama3.2",
      MUSE_MODEL_BASE_URL: "http://explicit.test:9999/v1",
      MUSE_MODEL_PROVIDER_ID: "ollama",
      OLLAMA_BASE_URL: "http://remote.test:11434"
    })).toBe("http://explicit.test:9999/api/chat");
  });

  it("falls back to the 127.0.0.1 default when neither base-URL env is set", async () => {
    expect(await capturedGenerateUrl({ MUSE_MODEL: "ollama/llama3.2" }))
      .toBe("http://127.0.0.1:11434/api/chat");
  });

  async function capturedGenerateOptions(env: Record<string, string>): Promise<Record<string, unknown>> {
    let options: Record<string, unknown> = {};
    const original = globalThis.fetch;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      options = (JSON.parse(String(init?.body)) as { options: Record<string, unknown> }).options;
      return new Response(JSON.stringify({ message: { content: "ok" }, model: "m" }), { status: 200 });
    }) as typeof globalThis.fetch;
    try {
      const provider = createModelProvider({ MUSE_LOCAL_ONLY: "false", ...env });
      await provider?.generate({ messages: [{ content: "hi", role: "user" }], model: "ollama/llama3.2" });
    } finally {
      globalThis.fetch = original;
    }
    return options;
  }

  it("maps MUSE_OLLAMA_NUM_BATCH onto the wire `num_batch`, and omits it when unset", async () => {
    expect(await capturedGenerateOptions({ MUSE_MODEL: "ollama/llama3.2", MUSE_OLLAMA_NUM_BATCH: "1024" }))
      .toMatchObject({ num_batch: 1024 });
    expect(await capturedGenerateOptions({ MUSE_MODEL: "ollama/llama3.2" }))
      .not.toHaveProperty("num_batch");
    // a junk value parses to 0 → adapter rejects (>0) → omitted, not a broken option on the wire
    expect(await capturedGenerateOptions({ MUSE_MODEL: "ollama/llama3.2", MUSE_OLLAMA_NUM_BATCH: "16x" }))
      .not.toHaveProperty("num_batch");
  });

  it("maps MUSE_OLLAMA_NUM_PREDICT onto the wire `num_predict` default (this generate sets no maxOutputTokens), and omits it when unset/junk", async () => {
    expect(await capturedGenerateOptions({ MUSE_MODEL: "ollama/llama3.2", MUSE_OLLAMA_NUM_PREDICT: "2048" }))
      .toMatchObject({ num_predict: 2048 });
    expect(await capturedGenerateOptions({ MUSE_MODEL: "ollama/llama3.2" }))
      .not.toHaveProperty("num_predict");
    expect(await capturedGenerateOptions({ MUSE_MODEL: "ollama/llama3.2", MUSE_OLLAMA_NUM_PREDICT: "3.5" }))
      .not.toHaveProperty("num_predict");
  });

  it("maps MUSE_OLLAMA_NUM_THREAD / MUSE_OLLAMA_NUM_GPU onto the wire (num_gpu=0 = CPU-only is kept), omits unset/junk", async () => {
    expect(await capturedGenerateOptions({ MUSE_MODEL: "ollama/llama3.2", MUSE_OLLAMA_NUM_THREAD: "8" }))
      .toMatchObject({ num_thread: 8 });
    // num_gpu=0 (CPU-only) is a valid opt-in — must reach the wire, not be dropped
    expect(await capturedGenerateOptions({ MUSE_MODEL: "ollama/llama3.2", MUSE_OLLAMA_NUM_GPU: "0" }))
      .toMatchObject({ num_gpu: 0 });
    expect(await capturedGenerateOptions({ MUSE_MODEL: "ollama/llama3.2", MUSE_OLLAMA_NUM_GPU: "33" }))
      .toMatchObject({ num_gpu: 33 });
    const none = await capturedGenerateOptions({ MUSE_MODEL: "ollama/llama3.2" });
    expect(none).not.toHaveProperty("num_thread");
    expect(none).not.toHaveProperty("num_gpu");
    expect(await capturedGenerateOptions({ MUSE_MODEL: "ollama/llama3.2", MUSE_OLLAMA_NUM_THREAD: "x" }))
      .not.toHaveProperty("num_thread");
  });
});
