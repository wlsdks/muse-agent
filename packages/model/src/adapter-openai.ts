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
 * in `./provider-openai-responses.ts` so the adapter stays focused
 * on the HTTP shape.
 */

import { truncateErrorBody } from "@muse/shared";
import { readWebSearchPolicy } from "./web-search-policy.js";

import { ModelProviderError, OpenAICompatibleProvider, isRetryableHttpStatus, fetchOrThrowAsProviderError, modelCallSignal } from "./provider-base.js";
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

interface OpenAIWireConfig {
  readonly apiKey?: string;
  readonly baseUrl: string;
  readonly defaultModel?: string;
  readonly fetchImpl: typeof globalThis.fetch;
  readonly headers: Readonly<Record<string, string>>;
}

export class OpenAIProvider extends OpenAICompatibleProvider {
  private readonly wire: OpenAIWireConfig;

  constructor(options: OpenAIProviderOptions = {}) {
    super({
      ...options,
      baseUrl: options.baseUrl ?? "https://api.openai.com/v1",
      id: options.id ?? "openai"
    });
    this.wire = {
      apiKey: options.apiKey,
      baseUrl: (options.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/u, ""),
      defaultModel: options.defaultModel,
      fetchImpl: options.fetch ?? globalThis.fetch,
      headers: options.headers ?? {}
    };
  }

  override async generate(request: ModelRequest): Promise<ModelResponse> {
    const policy = readWebSearchPolicy(request.metadata?.webSearchPolicy);

    const url = `${this.wire.baseUrl}/responses`;
    const body = JSON.stringify(toOpenAIResponsesRequest(request, this.wire.defaultModel, policy));

    const signal = modelCallSignal(request.signal);
    const response = await fetchOrThrowAsProviderError(this.wire.fetchImpl, this.id, this.wire.baseUrl, "OpenAI Responses", url, {
      body,
      headers: {
        "content-type": "application/json",
        ...(this.wire.apiKey ? { authorization: `Bearer ${this.wire.apiKey}` } : {}),
        ...this.wire.headers
      },
      method: "POST",
      ...(signal ? { signal } : {})
    }, request.signal);

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
    const policy = readWebSearchPolicy(request.metadata?.webSearchPolicy);

    const url = `${this.wire.baseUrl}/responses`;
    const body = JSON.stringify({ ...toOpenAIResponsesRequest(request, this.wire.defaultModel, policy), stream: true });

    const signal = modelCallSignal(request.signal, { streaming: true });
    const response = await fetchOrThrowAsProviderError(this.wire.fetchImpl, this.id, this.wire.baseUrl, "OpenAI Responses", url, {
      body,
      headers: {
        "content-type": "application/json",
        ...(this.wire.apiKey ? { authorization: `Bearer ${this.wire.apiKey}` } : {}),
        ...this.wire.headers
      },
      method: "POST",
      ...(signal ? { signal } : {})
    }, request.signal);

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
