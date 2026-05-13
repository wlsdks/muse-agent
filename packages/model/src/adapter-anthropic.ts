/**
 * Anthropic provider class. Wire-format transforms +
 * `anthropicModelCapabilities` live in `./provider-anthropic.ts`;
 * this file owns the HTTP shape (headers, retry classification)
 * and the `ModelProvider` interface plumbing.
 */

import { ModelProviderError } from "./provider-base.js";
import {
  anthropicModelCapabilities,
  fromAnthropicResponse,
  synthesizeStreamEventsFromResponse,
  toAnthropicRequest
} from "./provider-wire.js";

import type {
  AnthropicProviderOptions,
  ModelEvent,
  ModelInfo,
  ModelProvider,
  ModelRequest,
  ModelResponse
} from "./index.js";

export class AnthropicProvider implements ModelProvider {
  readonly id: string;

  private readonly apiKey?: string;
  private readonly baseUrl: string;
  private readonly defaultModel?: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly headers: Readonly<Record<string, string>>;
  private readonly models: readonly string[];
  private readonly version: string;

  constructor(options: AnthropicProviderOptions = {}) {
    this.id = options.id ?? "anthropic";
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? "https://api.anthropic.com/v1").replace(/\/+$/u, "");
    this.defaultModel = options.defaultModel;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.headers = options.headers ?? {};
    this.models = options.models ?? (options.defaultModel ? [options.defaultModel] : []);
    this.version = options.version ?? "2023-06-01";
  }

  async listModels(): Promise<readonly ModelInfo[]> {
    return this.models.map((modelId) => ({
      capabilities: anthropicModelCapabilities(modelId),
      displayName: modelId,
      modelId,
      providerId: this.id
    }));
  }

  async generate(request: ModelRequest): Promise<ModelResponse> {
    const policy = (request.metadata?.webSearchPolicy as { enabled: boolean; maxUses: number } | undefined)
      ?? { enabled: false, maxUses: 5 };

    const response = await this.fetchImpl(`${this.baseUrl}/messages`, {
      body: JSON.stringify(toAnthropicRequest(request, this.defaultModel, policy)),
      headers: this.requestHeaders(),
      method: "POST"
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new ModelProviderError(
        this.id,
        `Anthropic request failed with ${response.status}: ${body || response.statusText}`,
        response.status >= 500
      );
    }

    return fromAnthropicResponse(this.id, request.model, await response.json());
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    const response = await this.generate(request);
    yield* synthesizeStreamEventsFromResponse(response);
  }

  private requestHeaders(): Record<string, string> {
    return {
      "anthropic-version": this.version,
      "content-type": "application/json",
      ...(this.apiKey ? { "x-api-key": this.apiKey } : {}),
      ...this.headers
    };
  }
}
