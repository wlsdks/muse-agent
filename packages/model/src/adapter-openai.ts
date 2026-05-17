/**
 * OpenAI + OpenRouter provider classes. Both extend
 * `OpenAICompatibleProvider` (which lives in `./provider-base.ts`
 * as the leaf so cyclic imports stay one-way through this file).
 *
 * The OpenRouter subclass exists because Anthropic / DeepSeek /
 * other OpenRouter-hosted models need the same OpenAI-compat wire
 * with an extra `HTTP-Referer` / `X-Title` header pair. Otherwise
 * the override logic is identical.
 *
 * Wire-format helpers (toOpenAIResponsesRequest /
 * parseOpenAIResponsesStream / fromOpenAIResponsesResponse) live
 * in `./provider-openai.ts` so the adapter stays focused on the
 * HTTP shape.
 */

import { truncateErrorBody } from "@muse/shared";

import { ModelProviderError, OpenAICompatibleProvider, isRetryableHttpStatus } from "./provider-base.js";
import { parseJson } from "./provider-shared.js";
import {
  fromOpenAIResponsesResponse,
  parseOpenAIResponsesStream,
  toOpenAIResponsesRequest
} from "./provider-wire.js";

import type {
  ModelEvent,
  ModelRequest,
  ModelResponse,
  OpenAIProviderOptions,
  OpenRouterProviderOptions
} from "./index.js";

export class OpenAIProvider extends OpenAICompatibleProvider {
  private readonly openaiApiKey?: string;
  private readonly openaiBaseUrl: string;
  private readonly openaiDefaultModel?: string;
  private readonly openaiFetchImpl: typeof globalThis.fetch;
  private readonly openaiHeaders: Readonly<Record<string, string>>;

  constructor(options: OpenAIProviderOptions = {}) {
    super({
      ...options,
      baseUrl: options.baseUrl ?? "https://api.openai.com/v1",
      id: options.id ?? "openai"
    });
    this.openaiApiKey = options.apiKey;
    this.openaiBaseUrl = (options.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/u, "");
    this.openaiDefaultModel = options.defaultModel;
    this.openaiFetchImpl = options.fetch ?? globalThis.fetch;
    this.openaiHeaders = options.headers ?? {};
  }

  override async generate(request: ModelRequest): Promise<ModelResponse> {
    const policy = (request.metadata?.webSearchPolicy as { enabled: boolean; maxUses: number } | undefined)
      ?? { enabled: false, maxUses: 5 };

    const url = `${this.openaiBaseUrl}/responses`;
    const body = JSON.stringify(toOpenAIResponsesRequest(request, this.openaiDefaultModel, policy));

    const response = await this.openaiFetchImpl(url, {
      body,
      headers: {
        "content-type": "application/json",
        ...(this.openaiApiKey ? { authorization: `Bearer ${this.openaiApiKey}` } : {}),
        ...this.openaiHeaders
      },
      method: "POST"
    });

    if (!response.ok) {
      const errBody = await response.text().catch(() => "");
      throw new ModelProviderError(
        this.id,
        `OpenAI Responses API error: ${response.status}: ${truncateErrorBody(errBody) || response.statusText}`,
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
        `OpenAI Responses API response was not valid JSON: ${truncateErrorBody(rawBody) || response.statusText}`,
        true
      );
    }
    return fromOpenAIResponsesResponse(this.id, request.model, payload);
  }

  override async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    const policy = (request.metadata?.webSearchPolicy as { enabled: boolean; maxUses: number } | undefined)
      ?? { enabled: false, maxUses: 5 };

    const url = `${this.openaiBaseUrl}/responses`;
    const body = JSON.stringify({ ...toOpenAIResponsesRequest(request, this.openaiDefaultModel, policy), stream: true });

    const response = await this.openaiFetchImpl(url, {
      body,
      headers: {
        "content-type": "application/json",
        ...(this.openaiApiKey ? { authorization: `Bearer ${this.openaiApiKey}` } : {}),
        ...this.openaiHeaders
      },
      method: "POST"
    });

    if (!response.ok) {
      const errBody = await response.text().catch(() => "");
      yield {
        error: new ModelProviderError(
          this.id,
          `OpenAI Responses API stream error: ${response.status}: ${truncateErrorBody(errBody) || response.statusText}`,
          isRetryableHttpStatus(response.status)
        ),
        type: "error"
      };
      return;
    }

    if (!response.body) {
      const generated = await this.generate(request);
      yield { text: generated.output, type: "text-delta" };
      yield { response: generated, type: "done" };
      return;
    }

    yield* parseOpenAIResponsesStream(this.id, request.model, response.body);
  }
}

export class OpenRouterProvider extends OpenAICompatibleProvider {
  constructor(options: OpenRouterProviderOptions = {}) {
    super({
      ...options,
      baseUrl: options.baseUrl ?? "https://openrouter.ai/api/v1",
      headers: {
        ...(options.siteUrl ? { "HTTP-Referer": options.siteUrl } : {}),
        ...(options.appName ? { "X-Title": options.appName } : {}),
        ...(options.headers ?? {})
      },
      id: options.id ?? "openrouter"
    });
  }
}
