import type { JsonObject } from "@muse/shared";

import {
  anthropicModelCapabilities,
  defaultRemoteModelCapabilities,
  diagnosticModelCapabilities,
  estimateDiagnosticTokens,
  fromAnthropicResponse,
  fromGeminiResponse,
  fromOpenAIChatResponse,
  geminiModelCapabilities,
  localModelCapabilities,
  parseOpenAIStream,
  renderDiagnosticOutput,
  toAnthropicRequest,
  toGeminiRequest,
  toOpenAIChatRequest
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

export interface ModelResponse {
  readonly id: string;
  readonly model: string;
  readonly output: string;
  readonly toolCalls?: readonly ModelToolCall[];
  readonly usage?: ModelUsage;
  readonly raw?: unknown;
}

export type ModelEvent =
  | { readonly type: "text-delta"; readonly text: string }
  | { readonly type: "tool-call"; readonly toolCall: ModelToolCall }
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
  constructor(options: OpenAIProviderOptions = {}) {
    super({
      ...options,
      baseUrl: options.baseUrl ?? "https://api.openai.com/v1",
      id: options.id ?? "openai"
    });
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
  constructor(options: OllamaProviderOptions = {}) {
    super({
      ...options,
      baseUrl: options.baseUrl ?? "http://127.0.0.1:11434/v1",
      id: options.id ?? "ollama"
    });
  }

  override async listModels(): Promise<readonly ModelInfo[]> {
    const models = await super.listModels();
    return models.map((model) => ({
      ...model,
      capabilities: localModelCapabilities()
    }));
  }
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
    const response = await this.fetchImpl(`${this.baseUrl}/messages`, {
      body: JSON.stringify(toAnthropicRequest(request, this.defaultModel)),
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

    if (response.output.length > 0) {
      yield { text: response.output, type: "text-delta" };
    }

    for (const toolCall of response.toolCalls ?? []) {
      yield { toolCall, type: "tool-call" };
    }

    yield { response, type: "done" };
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

    const response = await this.fetchImpl(url.toString(), {
      body: JSON.stringify(toGeminiRequest(request)),
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

    if (response.output.length > 0) {
      yield { text: response.output, type: "text-delta" };
    }

    for (const toolCall of response.toolCalls ?? []) {
      yield { toolCall, type: "tool-call" };
    }

    yield { response, type: "done" };
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
  "deepseek": "ollama",
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
