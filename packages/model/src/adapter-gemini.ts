/**
 * Gemini provider class. Wire-format transforms +
 * `geminiModelCapabilities` + `sanitizeGeminiSchema` live in
 * `./provider-gemini.ts`; this file owns the HTTP shape (API-key
 * query-param, content-type) and the `ModelProvider` interface
 * plumbing.
 */

import { truncateErrorBody } from "@muse/shared";

import { fetchOrThrowAsProviderError, ModelProviderError, isRetryableHttpStatus, modelCallSignal } from "./provider-base.js";
import { parseJson } from "./provider-shared.js";
import {
  fromGeminiResponse,
  geminiModelCapabilities,
  synthesizeStreamEventsFromResponse,
  toGeminiRequest
} from "./provider-wire.js";

import {
  parseModelName,
  type GeminiProviderOptions,
  type ModelEvent,
  type ModelInfo,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse
} from "./index.js";

export class GeminiProvider implements ModelProvider {
  readonly id: string;

  private readonly apiKey?: string;
  private readonly baseUrl: string;
  private readonly defaultModel?: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly headers: Readonly<Record<string, string>>;
  private readonly models: readonly string[];

  constructor(options: GeminiProviderOptions = {}) {
    this.id = options.id ?? "gemini";
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta").replace(/\/+$/u, "");
    this.defaultModel = options.defaultModel;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.headers = options.headers ?? {};
    this.models = options.models ?? (options.defaultModel ? [options.defaultModel] : []);
  }

  async listModels(): Promise<readonly ModelInfo[]> {
    return this.models.map((modelId) => ({
      capabilities: geminiModelCapabilities(modelId),
      displayName: modelId,
      modelId,
      providerId: this.id
    }));
  }

  async generate(request: ModelRequest): Promise<ModelResponse> {
    const model = parseModelName(request.model || this.defaultModel || "").modelId;
    const url = new URL(`${this.baseUrl}/models/${encodeURIComponent(model)}:generateContent`);

    if (this.apiKey) {
      url.searchParams.set("key", this.apiKey);
    }

    const policy = (request.metadata?.webSearchPolicy as { enabled: boolean; maxUses: number } | undefined)
      ?? { enabled: false, maxUses: 5 };

    const signal = modelCallSignal(request.signal);
    const response = await fetchOrThrowAsProviderError(this.fetchImpl, this.id, this.baseUrl, "Gemini", url.toString(), {
      body: JSON.stringify(toGeminiRequest(request, policy)),
      headers: {
        "content-type": "application/json",
        ...this.headers
      },
      method: "POST",
      ...(signal ? { signal } : {})
    }, request.signal);

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new ModelProviderError(
        this.id,
        `Gemini request failed with ${response.status}: ${truncateErrorBody(body) || response.statusText}`,
        isRetryableHttpStatus(response.status)
      );
    }

    const rawBody = await response.text().catch(() => "");
    const payload = parseJson(rawBody);
    if (payload === undefined) {
      // A non-JSON 200 is a transport anomaly (proxy/portal HTML,
      // truncated body) — retryable ModelProviderError, not a raw
      // SyntaxError, so the .retryable contract holds.
      throw new ModelProviderError(
        this.id,
        `Gemini response was not valid JSON: ${truncateErrorBody(rawBody) || response.statusText}`,
        true
      );
    }
    return fromGeminiResponse(this.id, model, payload);
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    const response = await this.generate(request);
    yield* synthesizeStreamEventsFromResponse(response);
  }
}
