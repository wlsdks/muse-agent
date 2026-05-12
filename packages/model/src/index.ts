import type { JsonObject } from "@muse/shared";

import {
  anthropicModelCapabilities,
  defaultRemoteModelCapabilities,
  diagnosticModelCapabilities,
  estimateDiagnosticTokens,
  fromAnthropicResponse,
  fromGeminiResponse,
  fromOpenAIChatResponse,
  fromOpenAIResponsesResponse,
  geminiModelCapabilities,
  localModelCapabilities,
  parseOpenAIResponsesStream,
  parseOpenAIStream,
  renderDiagnosticOutput,
  synthesizeStreamEventsFromResponse,
  toAnthropicRequest,
  toGeminiRequest,
  toOpenAIChatRequest,
  toOpenAIResponsesRequest
} from "./provider-wire.js";

export { sanitizeGeminiSchema } from "./provider-wire.js";

export type ModelRole = "system" | "user" | "assistant" | "tool";

export interface ModelMessageAttachment {
  /** MIME type, e.g. "image/png", "application/pdf". */
  readonly mimeType: string;
  /**
   * Either base64-encoded inline bytes OR a URL the provider can
   * fetch. Exactly one of the two should be set; providers that
   * support inline data (Gemini) prefer `dataBase64`, providers
   * that prefer URL refs (OpenAI image_url) prefer `url`.
   */
  readonly dataBase64?: string;
  readonly url?: string;
}

export interface ModelMessage {
  readonly role: ModelRole;
  readonly content: string;
  readonly name?: string;
  readonly toolCallId?: string;
  readonly toolCalls?: readonly ModelToolCall[];
  /**
   * Optional binary attachments for vision-capable models. Provider
   * adapters that support inline data (Gemini) send via
   * `dataBase64` + `mimeType`; adapters that prefer URL refs (OpenAI
   * vision) send via `url`. Adapters that don't support binary
   * input silently ignore the field and ship only `content`.
   */
  readonly attachments?: readonly ModelMessageAttachment[];
}

export interface ModelCapabilities {
  readonly streaming: boolean;
  readonly toolCalling: boolean;
  readonly structuredOutput: boolean;
  readonly vision: boolean;
  readonly reasoning: boolean;
  readonly promptCaching: boolean;
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
  readonly local: boolean;
  readonly cost: "free" | "low" | "medium" | "high" | "unknown";
  readonly latencyProfile: "interactive" | "balanced" | "batch" | "unknown";
}

export interface ModelInfo {
  readonly providerId: string;
  readonly modelId: string;
  readonly displayName?: string;
  readonly capabilities: ModelCapabilities;
}

export interface ModelTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonObject;
  readonly risk: "read" | "write" | "execute";
}

export interface ModelToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: JsonObject;
}

export interface ModelUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly reasoningTokens?: number;
  readonly cachedInputTokens?: number;
}

export interface ModelRequest {
  readonly model: string;
  readonly messages: readonly ModelMessage[];
  readonly tools?: readonly ModelTool[];
  readonly temperature?: number;
  readonly maxOutputTokens?: number;
  readonly metadata?: JsonObject;
}

export interface WebSearchCitation {
  readonly url: string;
  readonly title: string;
  readonly snippet?: string;
  readonly providerRaw?: unknown;
}

export interface ModelResponse {
  readonly id: string;
  readonly model: string;
  readonly output: string;
  readonly toolCalls?: readonly ModelToolCall[];
  readonly usage?: ModelUsage;
  readonly citations?: readonly WebSearchCitation[];
  readonly raw?: unknown;
}

export type ModelEvent =
  | { readonly type: "text-delta"; readonly text: string }
  | { readonly type: "tool-call"; readonly toolCall: ModelToolCall }
  | { readonly type: "tool-call-started"; readonly name: string }
  | { readonly type: "tool-call-finished"; readonly name: string; readonly count?: number }
  | { readonly type: "citations"; readonly items: readonly WebSearchCitation[] }
  | { readonly type: "done"; readonly response: ModelResponse }
  | { readonly type: "error"; readonly error: ModelProviderError };

export interface ModelProvider {
  readonly id: string;
  listModels(): Promise<readonly ModelInfo[]>;
  generate(request: ModelRequest): Promise<ModelResponse>;
  stream(request: ModelRequest): AsyncIterable<ModelEvent>;
}

export interface OpenAICompatibleProviderOptions {
  readonly id?: string;
  readonly apiKey?: string;
  readonly baseUrl: string;
  readonly defaultModel?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly headers?: Readonly<Record<string, string>>;
  readonly models?: readonly string[];
}

export interface OpenAIProviderOptions extends Omit<OpenAICompatibleProviderOptions, "baseUrl" | "id"> {
  readonly baseUrl?: string;
  readonly id?: string;
}

export interface OpenRouterProviderOptions extends Omit<OpenAICompatibleProviderOptions, "baseUrl" | "id"> {
  readonly appName?: string;
  readonly baseUrl?: string;
  readonly id?: string;
  readonly siteUrl?: string;
}

export interface OllamaProviderOptions extends Omit<OpenAICompatibleProviderOptions, "apiKey" | "baseUrl" | "id"> {
  readonly baseUrl?: string;
  readonly id?: string;
}

export interface AnthropicProviderOptions {
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly defaultModel?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly headers?: Readonly<Record<string, string>>;
  readonly id?: string;
  readonly models?: readonly string[];
  readonly version?: string;
}

export interface GeminiProviderOptions {
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly defaultModel?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly headers?: Readonly<Record<string, string>>;
  readonly id?: string;
  readonly models?: readonly string[];
}

export interface DiagnosticModelProviderOptions {
  readonly defaultModel?: string;
  readonly id?: string;
  readonly models?: readonly string[];
}

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
    const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
      body: JSON.stringify(toOpenAIChatRequest(request, this.defaultModel)),
      headers: this.requestHeaders(),
      method: "POST"
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new ModelProviderError(
        this.id,
        `OpenAI-compatible request failed with ${response.status}: ${body || response.statusText}`,
        response.status >= 500
      );
    }

    const payload = await response.json();
    return fromOpenAIChatResponse(this.id, request.model, payload);
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
      body: JSON.stringify({ ...toOpenAIChatRequest(request, this.defaultModel), stream: true }),
      headers: this.requestHeaders(),
      method: "POST"
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      yield {
        error: new ModelProviderError(
          this.id,
          `OpenAI-compatible stream failed with ${response.status}: ${body || response.statusText}`,
          response.status >= 500
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

    yield* parseOpenAIStream(this.id, request.model, response.body);
  }

  private requestHeaders(): Record<string, string> {
    return {
      "content-type": "application/json",
      ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
      ...this.headers
    };
  }
}

export class DiagnosticModelProvider implements ModelProvider {
  readonly id: string;
  private readonly defaultModel?: string;
  private readonly models: readonly string[];

  constructor(options: DiagnosticModelProviderOptions = {}) {
    this.id = options.id ?? "diagnostic";
    this.defaultModel = options.defaultModel;
    this.models = options.models ?? [parseModelName(options.defaultModel ?? "diagnostic/smoke").modelId ?? "smoke"];
  }

  async listModels(): Promise<readonly ModelInfo[]> {
    return this.models.map((modelId) => ({
      capabilities: diagnosticModelCapabilities(),
      displayName: `Diagnostic ${modelId}`,
      modelId,
      providerId: this.id
    }));
  }

  async generate(request: ModelRequest): Promise<ModelResponse> {
    const latestUserMessage = [...request.messages].reverse().find((message) => message.role === "user");
    const output = renderDiagnosticOutput(request.messages, latestUserMessage?.content ?? "");

    return {
      id: "diagnostic-response",
      model: request.model || this.defaultModel || `${this.id}/${this.models[0] ?? "smoke"}`,
      output,
      usage: {
        inputTokens: estimateDiagnosticTokens(request.messages.map((message) => message.content).join(" ")),
        outputTokens: estimateDiagnosticTokens(output)
      }
    };
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    const response = await this.generate(request);

    if (response.output.length > 0) {
      yield { text: response.output, type: "text-delta" };
    }

    yield { response, type: "done" };
  }
}

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
        `OpenAI Responses API error: ${response.status}: ${errBody || response.statusText}`,
        response.status >= 500
      );
    }

    const payload = await response.json();
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
          `OpenAI Responses API stream error: ${response.status}: ${errBody || response.statusText}`,
          response.status >= 500
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

export class OllamaProvider extends OpenAICompatibleProvider {
  private readonly nativeBaseUrl: string;
  private readonly nativeFetch: typeof globalThis.fetch;
  private readonly nativeDefaultModel?: string;

  constructor(options: OllamaProviderOptions = {}) {
    const baseUrl = options.baseUrl ?? "http://127.0.0.1:11434/v1";
    super({
      ...options,
      baseUrl,
      id: options.id ?? "ollama"
    });
    this.nativeDefaultModel = options.defaultModel;
    // The /v1 endpoint runs the OpenAI-compat shim. It DOES NOT honour
    // `think: false`, so Qwen 3.5+ reasoning models stream out their
    // chain-of-thought before the user-facing answer (134 s first-token
    // observed on qwen3.5:2b-q4_K_M; 0.2 s when the option lands).
    // We keep the /v1 inheritance for listModels + tool-call shape
    // compatibility, but route generate/stream through Ollama's native
    // /api/chat where `think: false` is honoured.
    this.nativeBaseUrl = baseUrl.replace(/\/v1\/?$/, "");
    this.nativeFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  override async listModels(): Promise<readonly ModelInfo[]> {
    const models = await super.listModels();
    return models.map((model) => ({
      ...model,
      capabilities: localModelCapabilities()
    }));
  }

  override async generate(request: ModelRequest): Promise<ModelResponse> {
    const body = this.buildNativeChatBody(request, false);
    const resp = await this.nativeFetch(`${this.nativeBaseUrl}/api/chat`, {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
      method: "POST"
    });
    if (!resp.ok) {
      throw new ModelProviderError(
        this.id,
        `Ollama /api/chat failed with ${resp.status.toString()}: ${(await resp.text().catch(() => "")) || resp.statusText}`,
        resp.status >= 500
      );
    }
    const json = await resp.json() as OllamaNativeChatResponse;
    return {
      id: `${this.id}-${Date.now().toString()}`,
      model: json.model ?? request.model ?? this.nativeDefaultModel ?? "unknown",
      output: json.message?.content ?? "",
      raw: json,
      ...(json.message?.tool_calls && json.message.tool_calls.length > 0
        ? {
            toolCalls: json.message.tool_calls.map((tc, i) => {
              const rawArgs = typeof tc.function?.arguments === "string"
                ? safeParseToolArgs(tc.function.arguments)
                : (tc.function?.arguments ?? {});
              const args: JsonObject = (rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs))
                ? rawArgs as JsonObject
                : {};
              return {
                arguments: args,
                id: tc.id ?? `tool-${i.toString()}`,
                name: tc.function?.name ?? "unknown"
              };
            })
          }
        : {}),
      ...(json.eval_count || json.prompt_eval_count
        ? {
            usage: {
              inputTokens: json.prompt_eval_count ?? 0,
              outputTokens: json.eval_count ?? 0
            }
          }
        : {})
    };
  }

  override async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    const body = this.buildNativeChatBody(request, true);
    const resp = await this.nativeFetch(`${this.nativeBaseUrl}/api/chat`, {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
      method: "POST"
    });
    if (!resp.ok || !resp.body) {
      yield {
        error: new ModelProviderError(
          this.id,
          `Ollama stream failed with ${resp.status.toString()}: ${(await resp.text().catch(() => "")) || resp.statusText}`,
          resp.status >= 500
        ),
        type: "error"
      };
      return;
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let output = "";
    let lastJson: OllamaNativeChatResponse | undefined;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      for (;;) {
        const i = buf.indexOf("\n");
        if (i === -1) break;
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let parsed: OllamaNativeChatResponse;
        try {
          parsed = JSON.parse(line) as OllamaNativeChatResponse;
        } catch { continue; }
        lastJson = parsed;
        const delta = parsed.message?.content ?? "";
        if (delta) {
          output += delta;
          yield { text: delta, type: "text-delta" };
        }
        // Tool calls usually arrive in the terminal NDJSON line (done:true).
        // Emit them as tool-call events so the agent runtime treats them
        // the same way it does for OpenAI-compat / Anthropic.
        if (parsed.done && parsed.message?.tool_calls && parsed.message.tool_calls.length > 0) {
          for (let i = 0; i < parsed.message.tool_calls.length; i += 1) {
            const tc = parsed.message.tool_calls[i]!;
            const rawArgs = typeof tc.function?.arguments === "string"
              ? safeParseToolArgs(tc.function.arguments)
              : (tc.function?.arguments ?? {});
            const args: JsonObject = (rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs))
              ? rawArgs as JsonObject
              : {};
            yield {
              toolCall: {
                arguments: args,
                id: tc.id ?? `tool-${i.toString()}`,
                name: tc.function?.name ?? "unknown"
              },
              type: "tool-call"
            };
          }
        }
      }
    }

    const final: ModelResponse = {
      id: `${this.id}-${Date.now().toString()}`,
      model: lastJson?.model ?? request.model ?? this.nativeDefaultModel ?? "unknown",
      output,
      raw: lastJson,
      ...(lastJson?.message?.tool_calls && lastJson.message.tool_calls.length > 0
        ? {
            toolCalls: lastJson.message.tool_calls.map((tc, i) => {
              const rawArgs = typeof tc.function?.arguments === "string"
                ? safeParseToolArgs(tc.function.arguments)
                : (tc.function?.arguments ?? {});
              const args: JsonObject = (rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs))
                ? rawArgs as JsonObject
                : {};
              return {
                arguments: args,
                id: tc.id ?? `tool-${i.toString()}`,
                name: tc.function?.name ?? "unknown"
              };
            })
          }
        : {}),
      ...(lastJson?.eval_count || lastJson?.prompt_eval_count
        ? {
            usage: {
              inputTokens: lastJson.prompt_eval_count ?? 0,
              outputTokens: lastJson.eval_count ?? 0
            }
          }
        : {})
    };
    yield { response: final, type: "done" };
  }

  private buildNativeChatBody(request: ModelRequest, stream: boolean): Record<string, unknown> {
    const modelName = (request.model ?? this.nativeDefaultModel ?? "").replace(/^ollama\//, "");
    return {
      messages: request.messages.map((msg) => ({
        ...(msg.role === "tool"
          ? { content: msg.content, role: "tool", tool_call_id: msg.toolCallId }
          : { content: msg.content, role: msg.role }),
        ...(msg.toolCalls && msg.toolCalls.length > 0 ? {
          tool_calls: msg.toolCalls.map((tc) => ({
            function: { arguments: tc.arguments, name: tc.name },
            id: tc.id,
            type: "function"
          }))
        } : {})
      })),
      model: modelName,
      options: {
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        ...(request.maxOutputTokens !== undefined ? { num_predict: request.maxOutputTokens } : {})
      },
      stream,
      // The point of this whole override: kill the chain-of-thought
      // emission for Qwen 3.5+ thinking models. Non-thinking models
      // ignore the field; cost is zero.
      think: false,
      ...(request.tools && request.tools.length > 0
        ? {
            tools: request.tools.map((t) => ({
              function: { description: t.description, name: t.name, parameters: t.inputSchema ?? {} },
              type: "function"
            }))
          }
        : {})
    };
  }
}

interface OllamaNativeChatResponse {
  readonly model?: string;
  readonly message?: {
    readonly role?: string;
    readonly content?: string;
    readonly tool_calls?: readonly {
      readonly id?: string;
      readonly function?: { readonly name?: string; readonly arguments?: unknown };
    }[];
  };
  readonly eval_count?: number;
  readonly prompt_eval_count?: number;
  readonly done?: boolean;
}

function safeParseToolArgs(raw: string): unknown {
  try { return JSON.parse(raw); } catch { return {}; }
}

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

    const response = await this.fetchImpl(url.toString(), {
      body: JSON.stringify(toGeminiRequest(request, policy)),
      headers: {
        "content-type": "application/json",
        ...this.headers
      },
      method: "POST"
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new ModelProviderError(
        this.id,
        `Gemini request failed with ${response.status}: ${body || response.statusText}`,
        response.status >= 500
      );
    }

    return fromGeminiResponse(this.id, model, await response.json());
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    const response = await this.generate(request);
    yield* synthesizeStreamEventsFromResponse(response);
  }
}

export function canUseNativeTools(model: ModelInfo): boolean {
  return model.capabilities.toolCalling && model.capabilities.structuredOutput;
}

export interface ModelSelectionCriteria {
  readonly provider?: string;
  readonly model?: string;
  readonly requires?: Partial<Record<keyof ModelCapabilities, boolean>>;
  readonly minInputTokens?: number;
  readonly minOutputTokens?: number;
  readonly prefer?: {
    readonly cost?: "lowest";
    readonly latencyProfile?: ModelCapabilities["latencyProfile"];
  };
}

export interface SelectedModel {
  readonly provider: ModelProvider;
  readonly model: ModelInfo;
}

export class ModelProviderRegistry {
  private readonly providers = new Map<string, ModelProvider>();
  private readonly defaultProviderId: string;

  constructor(providers: Iterable<ModelProvider>, defaultProviderId: string) {
    for (const provider of providers) {
      this.providers.set(provider.id, provider);
    }

    if (!this.providers.has(defaultProviderId)) {
      throw new ModelProviderError("registry", `Default provider is not registered: ${defaultProviderId}`);
    }

    this.defaultProviderId = defaultProviderId;
  }

  availableProviders(): readonly string[] {
    return [...this.providers.keys()].sort();
  }

  defaultProvider(): string {
    return this.defaultProviderId;
  }

  getProvider(providerOrModel?: string): ModelProvider {
    const requested = providerOrModel?.trim();
    const providerId = requested ? this.resolveKnownProvider(requested) : this.defaultProviderId;

    if (!providerId) {
      throw new ModelProviderError(
        "registry",
        `Unknown model provider: ${requested}. Available providers: ${this.availableProviders().join(", ")}`
      );
    }

    return this.providers.get(providerId) ?? this.failUnknownProvider(providerId);
  }

  async selectModel(criteria: ModelSelectionCriteria = {}): Promise<SelectedModel> {
    const requestedModel = criteria.model?.trim();
    const exactModel = requestedModel ? parseModelName(requestedModel).modelId : undefined;
    const pinnedProvider = criteria.provider ?? requestedModel;

    if (pinnedProvider || exactModel) {
      const provider = this.getProvider(pinnedProvider);
      const models = await provider.listModels();
      const selected = models.find((model) => {
        if (exactModel && model.modelId !== exactModel) {
          return false;
        }

        return modelMatchesCapabilities(model, criteria);
      });

      if (!selected) {
        throw new ModelProviderError(provider.id, `No compatible model found for provider '${provider.id}'`);
      }

      return { model: selected, provider };
    }

    const candidates: SelectedModel[] = [];

    for (const provider of this.providers.values()) {
      for (const model of await provider.listModels()) {
        if (modelMatchesCapabilities(model, criteria)) {
          candidates.push({ model, provider });
        }
      }
    }

    const selected = candidates.sort(compareSelectedModels(criteria))[0];

    if (!selected) {
      throw new ModelProviderError("registry", "No compatible model found");
    }

    return selected;
  }

  private resolveKnownProvider(nameOrModel: string): string | undefined {
    const parsed = parseModelName(nameOrModel);

    if (parsed.providerId && this.providers.has(parsed.providerId)) {
      return parsed.providerId;
    }

    if (this.providers.has(nameOrModel)) {
      return nameOrModel;
    }

    const prefixMatch = Object.entries(modelPrefixToProvider).find(([prefix]) =>
      parsed.modelId.toLowerCase().startsWith(prefix)
    );

    if (prefixMatch && this.providers.has(prefixMatch[1])) {
      return prefixMatch[1];
    }

    return undefined;
  }

  private failUnknownProvider(providerId: string): never {
    throw new ModelProviderError(
      "registry",
      `Unknown model provider: ${providerId}. Available providers: ${this.availableProviders().join(", ")}`
    );
  }
}

export function parseModelName(value: string): { readonly providerId?: string; readonly modelId: string } {
  const [providerId, ...rest] = value.split("/");

  if (providerId && rest.length > 0) {
    return {
      modelId: rest.join("/"),
      providerId
    };
  }

  return { modelId: value };
}

export function knownModelPrefixes(): Readonly<Record<string, string>> {
  return { ...modelPrefixToProvider };
}

const modelPrefixToProvider: Readonly<Record<string, string>> = {
  "abab": "minimax",
  "chatglm": "zhipuai",
  "claude-": "anthropic",
  "codestral-": "mistral",
  "deepseek": "deepseek",
  "gemini-": "gemini",
  "gemini/": "gemini",
  "gemma": "ollama",
  "glm-": "zhipuai",
  "gpt-": "openai",
  "llama": "ollama",
  "llama-": "ollama",
  "llama3": "ollama",
  "mistral-": "mistral",
  "mixtral": "ollama",
  "moonshot-": "moonshot",
  "o1-": "openai",
  "o3-": "openai",
  "o4-": "openai",
  "phi": "ollama",
  "pixtral-": "mistral",
  "qwen": "ollama",
  "starcoder": "ollama"
};

function modelMatchesCapabilities(model: ModelInfo, criteria: ModelSelectionCriteria): boolean {
  if (criteria.minInputTokens && model.capabilities.maxInputTokens < criteria.minInputTokens) {
    return false;
  }

  if (criteria.minOutputTokens && model.capabilities.maxOutputTokens < criteria.minOutputTokens) {
    return false;
  }

  for (const [key, expected] of Object.entries(criteria.requires ?? {})) {
    if (expected !== undefined && model.capabilities[key as keyof ModelCapabilities] !== expected) {
      return false;
    }
  }

  return true;
}

function compareSelectedModels(criteria: ModelSelectionCriteria): (left: SelectedModel, right: SelectedModel) => number {
  return (left, right) => {
    if (criteria.prefer?.latencyProfile) {
      const leftLatency = left.model.capabilities.latencyProfile === criteria.prefer.latencyProfile ? 0 : 1;
      const rightLatency = right.model.capabilities.latencyProfile === criteria.prefer.latencyProfile ? 0 : 1;

      if (leftLatency !== rightLatency) {
        return leftLatency - rightLatency;
      }
    }

    if (criteria.prefer?.cost === "lowest") {
      const costDelta = costRank(left.model.capabilities.cost) - costRank(right.model.capabilities.cost);

      if (costDelta !== 0) {
        return costDelta;
      }
    }

    return left.provider.id.localeCompare(right.provider.id) || left.model.modelId.localeCompare(right.model.modelId);
  };
}

function costRank(cost: ModelCapabilities["cost"]): number {
  return ({ free: 0, low: 1, medium: 2, high: 3, unknown: 4 })[cost];
}

export {
  decideWebSearchPolicy,
  type DecideWebSearchPolicyArgs,
  type WebSearchPolicy,
  type WebSearchSettings
} from "./web-search-policy.js";
