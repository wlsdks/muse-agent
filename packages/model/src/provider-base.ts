/**
 * Base classes shared by every OpenAI-compatible adapter
 * (`OpenAICompatibleProvider`, `OllamaProvider`, `OpenRouterProvider`)
 * plus the `ModelProviderError` everyone throws.
 *
 * Extracted so per-vendor adapter files (`adapter-ollama.ts`, etc.)
 * can extend `OpenAICompatibleProvider` without creating a runtime
 * import cycle through `./index.ts`. The cycle through index.ts is
 * still allowed for *type-only* imports — those erase at runtime —
 * but ES-module `extends` evaluates eagerly and choked on the
 * cycle when the base class lived in index.ts.
 */

import { truncateErrorBody } from "@muse/shared";

import {
  defaultRemoteModelCapabilities,
  fromOpenAIChatResponse,
  parseOpenAIStream,
  toOpenAIChatRequest
} from "./provider-wire.js";
import { parseJson } from "./provider-shared.js";
import type {
  ModelEvent,
  ModelInfo,
  ModelProvider,
  ModelRequest,
  ModelResponse,
  OpenAICompatibleProviderOptions
} from "./index.js";

export class ModelProviderError extends Error {
  readonly providerId: string;
  readonly retryable: boolean;

  constructor(providerId: string, message: string, retryable = false) {
    super(message);
    this.name = "ModelProviderError";
    this.providerId = providerId;
    this.retryable = retryable;
  }
}

/**
 * Classify an HTTP status from a provider as retryable.
 *
 *   - 5xx: server-side failure, almost always transient.
 *   - 429: Too Many Requests / rate limit. Every major LLM
 *     provider (OpenAI, Anthropic, Gemini, OpenRouter, Ollama)
 *     uses this status for token/RPS budgeting; retry-after
 *     backoff is the right response, not fail-fast.
 *   - 408: Request Timeout. The server gave up waiting for the
 *     request, so it was not processed — transient and safe to
 *     retry, exactly like 429/5xx. A reverse proxy / gateway in
 *     front of a local Qwen backend is the common source.
 *
 * Anything else (400, 401, 403, 404, 422 …) is the caller's
 * problem — bad key, bad model, malformed payload — and MUST
 * fail fast so the agent loop doesn't burn budget retrying a
 * permanent error. Documented in `.claude/rules/architecture.md`.
 *
 * Pure, side-effect-free — used by every adapter so the
 * classification stays consistent across providers.
 */
export function isRetryableHttpStatus(status: number): boolean {
  if (!Number.isFinite(status)) return false;
  if (status === 408 || status === 429) return true;
  return status >= 500 && status <= 599;
}

/**
 * Run a provider fetch and normalize a TRANSPORT-level rejection (no HTTP
 * status — ECONNREFUSED/ECONNRESET/ETIMEDOUT/DNS, surfaced by `fetch` as a raw
 * TypeError) into a typed retryable `ModelProviderError`. Without this the raw
 * TypeError escapes the adapter and downstream policy can't read `.retryable`
 * (architecture.md: "ModelProviderError.retryable is the source of truth") — so
 * the same blip gets classified inconsistently per layer. Shared by every
 * adapter (OpenAI-compatible / Ollama / Gemini / Anthropic) so transport-error
 * shaping has ONE source of truth. A connection failure is transient like a
 * 5xx, hence retryable; a loopback base gets the "is the server running?" hint.
 */
export async function fetchOrThrowAsProviderError(
  fetchImpl: typeof fetch,
  providerId: string,
  baseUrl: string,
  label: string,
  url: string,
  init: RequestInit
): Promise<Response> {
  try {
    return await fetchImpl(url, init);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    const isLoopback = /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?(?:\/|$)/iu.test(baseUrl);
    const hint = isLoopback
      ? " — is the local model server running at this address?"
      : " — endpoint unreachable; check the URL and network";
    throw new ModelProviderError(providerId, `${label} request to ${baseUrl} failed: ${detail}${hint}`, true);
  }
}

export class OpenAICompatibleProvider implements ModelProvider {
  readonly id: string;

  private readonly apiKey?: string;
  private readonly baseUrl: string;
  private readonly defaultModel?: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly headers: Readonly<Record<string, string>>;
  private readonly models: readonly string[];

  constructor(options: OpenAICompatibleProviderOptions) {
    this.id = options.id ?? "openai-compatible";
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl.replace(/\/+$/u, "");
    this.defaultModel = options.defaultModel;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.headers = options.headers ?? {};
    this.models = options.models ?? (options.defaultModel ? [options.defaultModel] : []);
  }

  async listModels(): Promise<readonly ModelInfo[]> {
    return this.models.map((modelId) => ({
      capabilities: defaultRemoteModelCapabilities(),
      displayName: modelId,
      modelId,
      providerId: this.id
    }));
  }

  async generate(request: ModelRequest): Promise<ModelResponse> {
    const response = await this.fetchOrThrow(`${this.baseUrl}/chat/completions`, {
      body: JSON.stringify(toOpenAIChatRequest(request, this.defaultModel)),
      headers: this.requestHeaders(),
      method: "POST"
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new ModelProviderError(
        this.id,
        `OpenAI-compatible request failed with ${response.status}: ${truncateErrorBody(body) || response.statusText}`,
        isRetryableHttpStatus(response.status)
      );
    }

    const rawBody = await response.text().catch(() => "");
    const payload = parseJson(rawBody);
    if (payload === undefined) {
      // A 200 with a non-JSON body is a transport anomaly (captive
      // portal / proxy HTML / truncated body) — surface it as a
      // retryable ModelProviderError so the .retryable contract
      // holds instead of a raw SyntaxError escaping the provider.
      throw new ModelProviderError(
        this.id,
        `OpenAI-compatible response was not valid JSON: ${truncateErrorBody(rawBody) || response.statusText}`,
        true
      );
    }
    return fromOpenAIChatResponse(this.id, request.model, payload);
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    let response: Response;
    try {
      response = await this.fetchOrThrow(`${this.baseUrl}/chat/completions`, {
        body: JSON.stringify({ ...toOpenAIChatRequest(request, this.defaultModel), stream: true }),
        headers: this.requestHeaders(),
        method: "POST"
      });
    } catch (cause) {
      yield {
        error: cause instanceof ModelProviderError
          ? cause
          : new ModelProviderError(this.id, cause instanceof Error ? cause.message : String(cause), true),
        type: "error"
      };
      return;
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      yield {
        error: new ModelProviderError(
          this.id,
          `OpenAI-compatible stream failed with ${response.status}: ${truncateErrorBody(body) || response.statusText}`,
          isRetryableHttpStatus(response.status)
        ),
        type: "error"
      };
      return;
    }

    if (!response.body) {
      try {
        const generated = await this.generate(request);
        yield { text: generated.output, type: "text-delta" };
        yield { response: generated, type: "done" };
      } catch (cause) {
        // The non-stream fallback can itself fail (server died
        // between attempts, retry endpoint 5xx). Surface it as the
        // same error EVENT the other two stream error paths yield —
        // never let a raw throw escape this generator and break a
        // `for await` consumer expecting the event contract.
        yield {
          error: cause instanceof ModelProviderError
            ? cause
            : new ModelProviderError(this.id, cause instanceof Error ? cause.message : String(cause), true),
          type: "error"
        };
      }
      return;
    }

    yield* parseOpenAIStream(this.id, request.model, response.body);
  }

  private async fetchOrThrow(url: string, init: RequestInit): Promise<Response> {
    return fetchOrThrowAsProviderError(this.fetchImpl, this.id, this.baseUrl, "OpenAI-compatible", url, init);
  }

  private requestHeaders(): Record<string, string> {
    return {
      "content-type": "application/json",
      ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
      ...this.headers
    };
  }
}
