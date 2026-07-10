import { describe, expect, it } from "vitest";

import { createModelProvider, createModelProviderFor, LOCAL_FIRST_DEFAULT_MODEL, LOCAL_FIRST_VISION_MODEL, resolveDefaultModel, resolveVisionModel } from "./autoconfigure-model-provider.js";

// The vision-model knob (MUSE_VISION_MODEL) + measured local default. Pure so the
// swap policy AND the fail-soft path (optional model not pulled → fall back to the
// chat model, never crash) are pinned without a live model.
describe("resolveVisionModel — MUSE_VISION_MODEL knob + fail-soft", () => {
  it("no env, chat model IS the local default → the vision default (currently == chat default, no-op swap per the 2026-07 measurement)", () => {
    expect(resolveVisionModel({ env: {} as never, sessionModel: LOCAL_FIRST_DEFAULT_MODEL })).toBe(LOCAL_FIRST_VISION_MODEL);
    expect(LOCAL_FIRST_VISION_MODEL).toBe(LOCAL_FIRST_DEFAULT_MODEL);
  });
  it("explicit MUSE_VISION_MODEL wins (the manual override — e.g. pin qwen3-vl)", () => {
    expect(resolveVisionModel({ env: { MUSE_VISION_MODEL: "ollama/qwen3-vl:8b" } as never, sessionModel: LOCAL_FIRST_DEFAULT_MODEL })).toBe("ollama/qwen3-vl:8b");
  });
  it("an explicit non-default chat model is respected (no vision override)", () => {
    expect(resolveVisionModel({ env: {} as never, sessionModel: "anthropic/claude-haiku-4-5-20251001" })).toBe("anthropic/claude-haiku-4-5-20251001");
    expect(resolveVisionModel({ env: {} as never, sessionModel: "ollama/qwen3:8b" })).toBe("ollama/qwen3:8b");
  });
  it("FAIL-SOFT: a MUSE_VISION_MODEL override not pulled → falls back to the chat model", () => {
    expect(resolveVisionModel({ availableModels: ["gemma4:12b"], env: { MUSE_VISION_MODEL: "ollama/does-not-exist:8b" } as never, sessionModel: LOCAL_FIRST_DEFAULT_MODEL })).toBe(LOCAL_FIRST_DEFAULT_MODEL);
  });
  it("a MUSE_VISION_MODEL override IS pulled (tags may carry the ollama/ prefix) → used", () => {
    expect(resolveVisionModel({ availableModels: ["qwen3-vl:8b", "gemma4:12b"], env: { MUSE_VISION_MODEL: "ollama/qwen3-vl:8b" } as never, sessionModel: LOCAL_FIRST_DEFAULT_MODEL })).toBe("ollama/qwen3-vl:8b");
    expect(resolveVisionModel({ availableModels: ["ollama/qwen3-vl:8b"], env: { MUSE_VISION_MODEL: "ollama/qwen3-vl:8b" } as never, sessionModel: LOCAL_FIRST_DEFAULT_MODEL })).toBe("ollama/qwen3-vl:8b");
  });
  it("a non-ollama MUSE_VISION_MODEL override is passed through (no ollama availability check applies)", () => {
    expect(resolveVisionModel({ availableModels: ["gemma4:12b"], env: { MUSE_VISION_MODEL: "gemini/gemini-2.0-flash" } as never, sessionModel: LOCAL_FIRST_DEFAULT_MODEL })).toBe("gemini/gemini-2.0-flash");
  });
});

// Gate the BYO-cloud path (muse setup cloud): once MUSE_LOCAL_ONLY=false + a key is set, the
// router MUST build the matching cloud provider; with local-only on (the default), a cloud
// model MUST fail-close. This keeps the cloud capability + the privacy floor from silently rotting.
describe("createModelProvider — cloud BYO-key routing + local-only fail-close", () => {
  it("MUSE_LOCAL_ONLY=false + ANTHROPIC_API_KEY → an anthropic provider", () => {
    const p = createModelProvider({ ANTHROPIC_API_KEY: "k", MUSE_LOCAL_ONLY: "false", MUSE_MODEL: "anthropic/claude-haiku-4-5-20251001" } as never);
    expect(p?.id).toBe("anthropic");
  });
  it("MUSE_LOCAL_ONLY=false + GEMINI_API_KEY → a gemini provider", () => {
    const p = createModelProvider({ GEMINI_API_KEY: "k", MUSE_LOCAL_ONLY: "false", MUSE_MODEL: "gemini/gemini-2.0-flash" } as never);
    expect(p?.id).toBe("gemini");
  });
  it("local-only opt-in (MUSE_LOCAL_ONLY=true) + a cloud model → throws LocalOnlyViolationError (fail-close)", () => {
    expect(() => createModelProvider({ ANTHROPIC_API_KEY: "k", MUSE_MODEL: "anthropic/claude-haiku-4-5-20251001", MUSE_LOCAL_ONLY: "true" } as never))
      .toThrowError(/LocalOnly|local-only|local only/i);
  });
  it("a local Ollama model needs no key and no opt-out", () => {
    const p = createModelProvider({ MUSE_MODEL: "ollama/gemma4:12b" } as never);
    expect(p?.id).toBe("ollama");
  });
});

// Codex delegation (opt-in ChatGPT-subscription route via the official codex CLI).
// It is CLOUD, must NEVER be the default, and must fail-close under local-only.
describe("createModelProvider — codex delegation routing", () => {
  it("MUSE_MODEL=codex/<model> → a CodexCliProvider (id 'codex')", () => {
    const p = createModelProvider({ MUSE_MODEL: "codex/gpt-5.1" } as never);
    expect(p?.id).toBe("codex");
  });
  it("MUSE_MODEL_PROVIDER_ID=codex also selects codex", () => {
    const p = createModelProvider({ MUSE_MODEL: "codex/gpt-5.1", MUSE_MODEL_PROVIDER_ID: "codex" } as never);
    expect(p?.id).toBe("codex");
  });
  it("local-only (MUSE_LOCAL_ONLY=true) + a codex model → throws LocalOnlyViolationError (fail-close)", () => {
    expect(() => createModelProvider({ MUSE_LOCAL_ONLY: "true", MUSE_MODEL: "codex/gpt-5.1" } as never))
      .toThrowError(/LocalOnly|local-only|local only/i);
  });
  it("resolveDefaultModel NEVER returns codex when unconfigured (local stays the default)", () => {
    expect(resolveDefaultModel({} as never)).toBe(LOCAL_FIRST_DEFAULT_MODEL);
    expect(resolveDefaultModel({ MUSE_LOCAL_ONLY: "true" } as never)).toBe(LOCAL_FIRST_DEFAULT_MODEL);
  });
});

// MUSE_MODEL_EXTRA_HEADERS (DS-22): the self-hosted LAN LLM gateway (LiteLLM, a
// reverse proxy, Cloudflare-Access service-token auth) needs a header beyond the
// standard `Authorization: Bearer <apiKey>`. These pin the FULL path from the env
// var down to the actual fetch call for the custom OpenAI-compatible endpoint —
// the real-world local-first scenario this closes.
describe("createModelProvider — MUSE_MODEL_EXTRA_HEADERS (LAN gateway auth header)", () => {
  async function generateAndCaptureHeaders(env: Record<string, string | undefined>): Promise<Record<string, string> | undefined> {
    const originalFetch = globalThis.fetch;
    let seenHeaders: Record<string, string> | undefined;
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      seenHeaders = init?.headers as Record<string, string> | undefined;
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }], id: "c1", model: "m" }));
    }) as typeof fetch;
    try {
      const provider = createModelProvider(env as never);
      await provider?.generate({ messages: [{ content: "hi", role: "user" }], model: "m" });
    } finally {
      globalThis.fetch = originalFetch;
    }
    return seenHeaders;
  }

  it("a well-formed MUSE_MODEL_EXTRA_HEADERS reaches the actual fetch call for a custom OpenAI-compatible endpoint", async () => {
    const headers = await generateAndCaptureHeaders({
      MUSE_MODEL: "openai-compatible/local-model",
      MUSE_MODEL_BASE_URL: "http://127.0.0.1:4000/v1",
      MUSE_MODEL_EXTRA_HEADERS: '{"X-Gateway-Token":"secret-token-abc"}'
    });
    expect(headers?.["X-Gateway-Token"]).toBe("secret-token-abc");
  });

  it("flows into every OpenAI-compat-wire provider family, not just the custom-endpoint fallback (openai/Responses API here)", async () => {
    // NOTE: this deliberately does NOT cover OllamaProvider — its generate()/
    // stream() override the OpenAI-compat base to hit Ollama's own native
    // /api/chat endpoint (adapter-ollama.ts), which never merges `this.headers`
    // at all (a separate, pre-existing gap outside this change's file scope).
    const headers = await generateAndCaptureHeaders({
      MUSE_LOCAL_ONLY: "false",
      MUSE_MODEL: "openai/gpt-4o-mini",
      MUSE_MODEL_EXTRA_HEADERS: '{"X-Gateway-Token":"secret-token-abc"}',
      OPENAI_API_KEY: "sk-test"
    });
    expect(headers?.["X-Gateway-Token"]).toBe("secret-token-abc");
  });

  it("a malformed MUSE_MODEL_EXTRA_HEADERS fails SOFT — no throw, provider still built, just no extra header", async () => {
    let threw = false;
    let headers: Record<string, string> | undefined;
    try {
      headers = await generateAndCaptureHeaders({
        MUSE_MODEL: "openai-compatible/local-model",
        MUSE_MODEL_BASE_URL: "http://127.0.0.1:4000/v1",
        MUSE_MODEL_EXTRA_HEADERS: "not valid json"
      });
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    expect(headers?.["content-type"]).toBe("application/json");
    expect(Object.keys(headers ?? {})).not.toContain("X-Gateway-Token");
  });

  it("an absent MUSE_MODEL_EXTRA_HEADERS builds the provider exactly as before (no behavior change)", async () => {
    const headers = await generateAndCaptureHeaders({
      MUSE_MODEL: "openai-compatible/local-model",
      MUSE_MODEL_BASE_URL: "http://127.0.0.1:4000/v1"
    });
    expect(headers).toEqual({ "content-type": "application/json" });
  });
});

// createModelProviderFor — privacy-tiered routing's cloud leg: build a SECOND
// provider instance for an explicit model string, isolated from whatever the
// session's own default-model env carries (a local Ollama session pins
// MUSE_MODEL_PROVIDER_ID=ollama + MUSE_MODEL_BASE_URL for ITS model; the cloud
// override must resolve its provider from its OWN prefix, never inherit those).
describe("createModelProviderFor — isolated from the session's local provider pins", () => {
  it("builds a gemini provider for an explicit cloud model", () => {
    const p = createModelProviderFor("gemini/gemini-2.5-flash", { GEMINI_API_KEY: "k" } as never);
    expect(p?.id).toBe("gemini");
  });

  it("ignores a session MUSE_MODEL_PROVIDER_ID=ollama pin when building the cloud override", () => {
    const p = createModelProviderFor("gemini/gemini-2.5-flash", {
      GEMINI_API_KEY: "k",
      MUSE_MODEL: "ollama/gemma4:12b",
      MUSE_MODEL_PROVIDER_ID: "ollama"
    } as never);
    expect(p?.id).toBe("gemini");
  });

  it("ignores a session MUSE_MODEL_BASE_URL pin (a local Ollama base URL) when building the cloud override", () => {
    const p = createModelProviderFor("anthropic/claude-haiku-4-5-20251001", {
      ANTHROPIC_API_KEY: "k",
      MUSE_MODEL_BASE_URL: "http://127.0.0.1:11434/v1"
    } as never);
    expect(p?.id).toBe("anthropic");
  });

  it("still fails closed under MUSE_LOCAL_ONLY (second enforcement layer)", () => {
    expect(() => createModelProviderFor("anthropic/claude-haiku-4-5-20251001", {
      ANTHROPIC_API_KEY: "k",
      MUSE_LOCAL_ONLY: "true"
    } as never)).toThrowError(/LocalOnly|local-only|local only/i);
  });

  it("a local model override still builds (createModelProviderFor isn't cloud-only)", () => {
    const p = createModelProviderFor("ollama/gemma4:12b", {} as never);
    expect(p?.id).toBe("ollama");
  });
});
