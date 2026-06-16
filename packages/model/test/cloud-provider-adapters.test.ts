import { describe, expect, it } from "vitest";

import { AnthropicProvider, GeminiProvider, ModelProviderError } from "../src/index.js";
import type { ModelEvent, ModelRequest } from "../src/index.js";

let captured: { url: string; headers: Record<string, string>; body: Record<string, unknown> };

function okFetch(payload: unknown) {
  return async (url: string | URL, init: { headers: Record<string, string>; body: string }) => {
    captured = { body: JSON.parse(init.body), headers: init.headers, url: url.toString() };
    return { ok: true, status: 200, statusText: "OK", text: async () => JSON.stringify(payload) } as unknown as Response;
  };
}
function statusFetch(status: number, body = "upstream error") {
  return async (url: string | URL, init: { headers: Record<string, string> }) => {
    captured = { body: {}, headers: init.headers, url: url.toString() };
    return { ok: false, status, statusText: "Err", text: async () => body } as unknown as Response;
  };
}
function htmlFetch() {
  return async () => ({ ok: true, status: 200, statusText: "OK", text: async () => "<html>proxy portal</html>" }) as unknown as Response;
}

const req = (over: Partial<ModelRequest> = {}): ModelRequest => ({
  messages: [{ content: "hi", role: "user" }],
  model: "gemini-2.0-flash",
  ...over
});
const collect = async (it: AsyncIterable<ModelEvent>): Promise<ModelEvent[]> => {
  const out: ModelEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
};

describe("GeminiProvider — HTTP plumbing", () => {
  const payload = {
    candidates: [{ content: { parts: [{ text: "Hello from Gemini" }] } }],
    usageMetadata: { candidatesTokenCount: 3, promptTokenCount: 5 }
  };

  it("POSTs to <baseUrl>/models/<model>:generateContent with the api key as a query param", async () => {
    const p = new GeminiProvider({ apiKey: "KEY123", fetch: okFetch(payload), headers: { "x-custom": "v" } });
    const r = await p.generate(req({ model: "gemini/gemini-1.5-pro" }));
    expect(r.output).toBe("Hello from Gemini");
    expect(captured.url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:generateContent?key=KEY123");
    expect(captured.headers["content-type"]).toBe("application/json");
    expect(captured.headers["x-custom"]).toBe("v");
  });

  it("strips trailing slashes from a custom base URL", async () => {
    const p = new GeminiProvider({ baseUrl: "https://example.com/v1beta///", fetch: okFetch(payload) });
    await p.generate(req());
    expect(captured.url.startsWith("https://example.com/v1beta/models/")).toBe(true);
  });

  it("omits the key query param when no api key is configured", async () => {
    const p = new GeminiProvider({ fetch: okFetch(payload) });
    await p.generate(req());
    expect(captured.url.includes("key=")).toBe(false);
  });

  it("throws with status-based retryability (404 not, 503 yes) and retryable on a non-JSON 200", async () => {
    await expect(new GeminiProvider({ fetch: statusFetch(404) }).generate(req())).rejects.toMatchObject({ retryable: false });
    await expect(new GeminiProvider({ fetch: statusFetch(503) }).generate(req())).rejects.toMatchObject({ retryable: true });
    const err = await new GeminiProvider({ fetch: htmlFetch() }).generate(req()).catch((e) => e);
    expect(err).toBeInstanceOf(ModelProviderError);
    expect(err.retryable).toBe(true);
  });

  it("normalizes a transport-level fetch rejection into a retryable ModelProviderError (not a raw TypeError)", async () => {
    const rejectingFetch = () => Promise.reject(new TypeError("fetch failed"));
    const err = await new GeminiProvider({ fetch: rejectingFetch }).generate(req()).catch((e) => e);
    expect(err).toBeInstanceOf(ModelProviderError);
    expect(err.retryable).toBe(true);
  });

  it("lists models from the configured set with gemini capabilities (empty / defaultModel variants)", async () => {
    const models = await new GeminiProvider({ models: ["gemini-2.0-flash", "gemini-1.5-pro"] }).listModels();
    expect(models.map((m) => m.modelId)).toEqual(["gemini-2.0-flash", "gemini-1.5-pro"]);
    expect(models[0]!.providerId).toBe("gemini");
    expect(models[0]!.capabilities).toBeTruthy();
    expect(await new GeminiProvider({}).listModels()).toHaveLength(0);
    expect((await new GeminiProvider({ defaultModel: "gemini-x" }).listModels()).map((m) => m.modelId)).toEqual(["gemini-x"]);
  });

  it("streams by synthesizing events from the generated response", async () => {
    const events = await collect(new GeminiProvider({ apiKey: "K", fetch: okFetch(payload) }).stream(req()));
    expect(events.map((e) => e.type)).toEqual(["text-delta", "done"]);
  });
});

describe("AnthropicProvider — HTTP plumbing", () => {
  const payload = { content: [{ text: "Hello from Claude", type: "text" }], usage: { input_tokens: 4, output_tokens: 2 } };

  it("POSTs to <baseUrl>/messages with x-api-key, the anthropic-version, and custom headers", async () => {
    const p = new AnthropicProvider({ apiKey: "SK", fetch: okFetch(payload), headers: { "x-extra": "y" }, version: "2026-01-01" });
    const r = await p.generate(req({ model: "anthropic/claude" }));
    expect(r.output).toBe("Hello from Claude");
    expect(captured.url.endsWith("/messages")).toBe(true);
    expect(captured.headers["x-api-key"]).toBe("SK");
    expect(captured.headers["anthropic-version"]).toBe("2026-01-01");
    expect(captured.headers["x-extra"]).toBe("y");
  });

  it("defaults the anthropic-version and omits x-api-key when no key is set", async () => {
    const p = new AnthropicProvider({ fetch: okFetch(payload) });
    await p.generate(req());
    expect(captured.headers["anthropic-version"]).toBe("2023-06-01");
    expect("x-api-key" in captured.headers).toBe(false);
  });

  it("throws with status-based retryability (429 yes, 400 no) and retryable on a non-JSON 200", async () => {
    await expect(new AnthropicProvider({ fetch: statusFetch(429) }).generate(req())).rejects.toMatchObject({ retryable: true });
    await expect(new AnthropicProvider({ fetch: statusFetch(400) }).generate(req())).rejects.toMatchObject({ retryable: false });
    const err = await new AnthropicProvider({ fetch: htmlFetch() }).generate(req()).catch((e) => e);
    expect(err).toBeInstanceOf(ModelProviderError);
    expect(err.retryable).toBe(true);
  });

  it("normalizes a transport-level fetch rejection into a retryable ModelProviderError (not a raw TypeError)", async () => {
    const rejectingFetch = () => Promise.reject(new TypeError("fetch failed"));
    const err = await new AnthropicProvider({ fetch: rejectingFetch }).generate(req()).catch((e) => e);
    expect(err).toBeInstanceOf(ModelProviderError);
    expect(err.retryable).toBe(true);
  });

  it("lists models from the configured set with anthropic capabilities", async () => {
    const models = await new AnthropicProvider({ models: ["claude-opus", "claude-haiku"] }).listModels();
    expect(models.map((m) => m.modelId)).toEqual(["claude-opus", "claude-haiku"]);
    expect(models[0]!.providerId).toBe("anthropic");
    expect(models[0]!.capabilities).toBeTruthy();
  });

  it("streams by synthesizing events from the generated response", async () => {
    const events = await collect(new AnthropicProvider({ apiKey: "K", fetch: okFetch(payload) }).stream(req()));
    expect(events.map((e) => e.type)).toEqual(["text-delta", "done"]);
  });
});
