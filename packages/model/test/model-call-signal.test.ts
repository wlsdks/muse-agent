import { describe, expect, it } from "vitest";

import {
  DEFAULT_MODEL_CALL_TIMEOUT_MS,
  modelCallSignal,
  ModelProviderError,
  OpenAICompatibleProvider,
  resolveModelCallTimeoutMs
} from "../src/index.js";

// A hung model socket froze the whole turn forever (the loop's cancellation
// check only runs BETWEEN steps), and ESC could not interrupt an in-flight
// generation. These pin the safety-cap timeout + caller-signal threading.

describe("resolveModelCallTimeoutMs", () => {
  it("defaults, honors an explicit value, 0 disables, garbage falls back", () => {
    expect(resolveModelCallTimeoutMs({} as NodeJS.ProcessEnv)).toBe(DEFAULT_MODEL_CALL_TIMEOUT_MS);
    expect(resolveModelCallTimeoutMs({ MUSE_MODEL_TIMEOUT_MS: "1500" } as NodeJS.ProcessEnv)).toBe(1500);
    expect(resolveModelCallTimeoutMs({ MUSE_MODEL_TIMEOUT_MS: "0" } as NodeJS.ProcessEnv)).toBeUndefined();
    expect(resolveModelCallTimeoutMs({ MUSE_MODEL_TIMEOUT_MS: "5m" } as NodeJS.ProcessEnv)).toBe(DEFAULT_MODEL_CALL_TIMEOUT_MS);
    expect(resolveModelCallTimeoutMs({ MUSE_MODEL_TIMEOUT_MS: "999999999999999999999" } as NodeJS.ProcessEnv)).toBe(DEFAULT_MODEL_CALL_TIMEOUT_MS);
    expect(resolveModelCallTimeoutMs({ MUSE_MODEL_TIMEOUT_MS: "2147483648" } as NodeJS.ProcessEnv)).toBe(DEFAULT_MODEL_CALL_TIMEOUT_MS);
  });
});

describe("modelCallSignal", () => {
  it("streaming: passes the caller signal through untouched (idle-timeout layer owns stalls)", () => {
    const controller = new AbortController();
    expect(modelCallSignal(controller.signal, { streaming: true })).toBe(controller.signal);
    expect(modelCallSignal(undefined, { streaming: true })).toBeUndefined();
  });

  it("non-streaming: composes caller signal with the timeout — caller abort fires the composed signal", () => {
    const controller = new AbortController();
    const composed = modelCallSignal(controller.signal, { env: { MUSE_MODEL_TIMEOUT_MS: "60000" } as NodeJS.ProcessEnv });
    expect(composed).toBeInstanceOf(AbortSignal);
    expect(composed?.aborted).toBe(false);
    controller.abort();
    expect(composed?.aborted).toBe(true);
  });

  it("non-streaming with no caller signal still gets the safety-cap timeout signal", () => {
    const signal = modelCallSignal(undefined, { env: {} as NodeJS.ProcessEnv });
    expect(signal).toBeInstanceOf(AbortSignal);
  });

  it("timeout disabled + no caller signal → undefined (no signal attached)", () => {
    expect(modelCallSignal(undefined, { env: { MUSE_MODEL_TIMEOUT_MS: "0" } as NodeJS.ProcessEnv })).toBeUndefined();
  });
});

function hangingFetch(): typeof fetch {
  return ((_url: unknown, init?: RequestInit) => {
    const { promise, reject } = Promise.withResolvers<Response>();
    init?.signal?.addEventListener("abort", () => reject(init.signal?.reason ?? new Error("aborted")));
    return promise;
  }) as unknown as typeof fetch;
}

describe("adapter threading (OpenAICompatibleProvider — the Ollama-compat path)", () => {
  it("generate() hands a signal to fetch and a CALLER abort rejects NON-retryable", async () => {
    const controller = new AbortController();
    let seenSignal: AbortSignal | undefined;
    const fetchImpl = ((url: unknown, init?: RequestInit) => {
      seenSignal = init?.signal ?? undefined;
      return hangingFetch()(url as string, init);
    }) as unknown as typeof fetch;
    const provider = new OpenAICompatibleProvider({ baseUrl: "http://127.0.0.1:9999/v1", defaultModel: "m", fetch: fetchImpl });

    const pending = provider.generate({ messages: [{ content: "hi", role: "user" }], model: "m", signal: controller.signal });
    const assertion = expect(pending).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(ModelProviderError);
      expect((error as ModelProviderError).retryable).toBe(false);
      expect((error as ModelProviderError).message).toContain("cancelled by the caller");
      return true;
    });
    controller.abort();
    await assertion;
    expect(seenSignal).toBeInstanceOf(AbortSignal);
  });

  it("generate() with a hung socket rejects RETRYABLE once the safety-cap timeout fires", async () => {
    const previous = process.env.MUSE_MODEL_TIMEOUT_MS;
    process.env.MUSE_MODEL_TIMEOUT_MS = "25";
    try {
      const provider = new OpenAICompatibleProvider({ baseUrl: "http://127.0.0.1:9999/v1", defaultModel: "m", fetch: hangingFetch() });
      await expect(
        provider.generate({ messages: [{ content: "hi", role: "user" }], model: "m" })
      ).rejects.toSatisfy((error: unknown) => {
        expect(error).toBeInstanceOf(ModelProviderError);
        expect((error as ModelProviderError).retryable).toBe(true);
        expect((error as ModelProviderError).message).toContain("timed out");
        return true;
      });
    } finally {
      if (previous === undefined) delete process.env.MUSE_MODEL_TIMEOUT_MS;
      else process.env.MUSE_MODEL_TIMEOUT_MS = previous;
    }
  });

  it("stream() passes ONLY the caller signal (no timeout cap on legitimate long streams)", async () => {
    const previous = process.env.MUSE_MODEL_TIMEOUT_MS;
    process.env.MUSE_MODEL_TIMEOUT_MS = "25";
    try {
      const controller = new AbortController();
      let seenSignal: AbortSignal | undefined | null;
      const fetchImpl = ((_url: unknown, init?: RequestInit) => {
        seenSignal = init?.signal;
        return Promise.resolve(new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" }, status: 200 }));
      }) as unknown as typeof fetch;
      const provider = new OpenAICompatibleProvider({ baseUrl: "http://127.0.0.1:9999/v1", defaultModel: "m", fetch: fetchImpl });
      for await (const _event of provider.stream({ messages: [{ content: "hi", role: "user" }], model: "m", signal: controller.signal })) {
        // drain
      }
      expect(seenSignal).toBe(controller.signal);
    } finally {
      if (previous === undefined) delete process.env.MUSE_MODEL_TIMEOUT_MS;
      else process.env.MUSE_MODEL_TIMEOUT_MS = previous;
    }
  });
});

describe("OllamaProvider native path", () => {
  it("generate() caller abort rejects non-retryable through the native /api/chat fetch", async () => {
    const { OllamaProvider } = await import("../src/index.js");
    const controller = new AbortController();
    const fetchImpl = ((_url: unknown, init?: RequestInit) =>
      {
        const { promise, reject } = Promise.withResolvers<Response>();
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason ?? new Error("aborted")));
        return promise;
      }) as unknown as typeof fetch;
    const provider = new OllamaProvider({ defaultModel: "gemma4:12b", fetch: fetchImpl });
    const pending = provider.generate({ messages: [{ content: "hi", role: "user" }], model: "gemma4:12b", signal: controller.signal });
    const assertion = expect(pending).rejects.toSatisfy((error: unknown) => {
      expect((error as ModelProviderError).retryable).toBe(false);
      expect((error as ModelProviderError).message).toContain("cancelled by the caller");
      return true;
    });
    controller.abort();
    await assertion;
  });
});
