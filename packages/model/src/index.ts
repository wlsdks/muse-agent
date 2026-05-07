import type { JsonObject } from "@muse/shared";

export type ModelRole = "system" | "user" | "assistant" | "tool";

export interface ModelMessage {
  readonly role: ModelRole;
  readonly content: string;
  readonly name?: string;
  readonly toolCallId?: string;
  readonly toolCalls?: readonly ModelToolCall[];
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
  "starcoder": "ollama",
  "text-embedding-": "openai"
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

function toOpenAIChatRequest(request: ModelRequest, defaultModel: string | undefined) {
  return {
    max_tokens: request.maxOutputTokens,
    messages: request.messages.map(toOpenAIMessage),
    model: parseModelName(request.model || defaultModel || "").modelId,
    temperature: request.temperature,
    tools: request.tools?.map((tool) => ({
      function: {
        description: tool.description,
        name: tool.name,
        parameters: tool.inputSchema
      },
      type: "function"
    }))
  };
}

function toAnthropicRequest(request: ModelRequest, defaultModel: string | undefined) {
  const system = request.messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n\n");

  return {
    max_tokens: request.maxOutputTokens ?? 4096,
    messages: request.messages
      .filter((message) => message.role !== "system")
      .map(toAnthropicMessage),
    model: parseModelName(request.model || defaultModel || "").modelId,
    ...(system.length > 0 ? { system } : {}),
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    ...(request.tools && request.tools.length > 0 ? { tools: request.tools.map(toAnthropicTool) } : {})
  };
}

function toAnthropicMessage(message: ModelMessage) {
  if (message.role === "tool") {
    return {
      content: [{
        content: message.content,
        tool_use_id: message.toolCallId,
        type: "tool_result"
      }],
      role: "user"
    };
  }

  if (message.role === "assistant" && message.toolCalls && message.toolCalls.length > 0) {
    return {
      content: [
        ...(message.content ? [{ text: message.content, type: "text" }] : []),
        ...message.toolCalls.map((toolCall) => ({
          id: toolCall.id,
          input: toolCall.arguments,
          name: toolCall.name,
          type: "tool_use"
        }))
      ],
      role: "assistant"
    };
  }

  return {
    content: message.content,
    role: message.role === "assistant" ? "assistant" : "user"
  };
}

function toAnthropicTool(tool: ModelTool) {
  return {
    description: tool.description,
    input_schema: tool.inputSchema,
    name: tool.name
  };
}

function fromAnthropicResponse(providerId: string, requestedModel: string, payload: unknown): ModelResponse {
  if (!isRecord(payload)) {
    throw new ModelProviderError(providerId, "Anthropic response was not an object");
  }

  const content = Array.isArray(payload.content) ? payload.content : [];
  const output = content
    .map((part) => isRecord(part) && part.type === "text" && typeof part.text === "string" ? part.text : "")
    .join("");
  const toolCalls = content.flatMap((part, index): ModelToolCall[] => {
    if (!isRecord(part) || part.type !== "tool_use" || typeof part.name !== "string") {
      return [];
    }

    return [{
      arguments: isJsonObject(part.input) ? part.input : {},
      id: typeof part.id === "string" ? part.id : `tool_call_${index}`,
      name: part.name
    }];
  });

  return {
    id: typeof payload.id === "string" ? payload.id : `${providerId}-response`,
    model: typeof payload.model === "string" ? payload.model : requestedModel,
    output,
    raw: payload,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    usage: parseAnthropicUsage(payload.usage)
  };
}

function toGeminiRequest(request: ModelRequest) {
  return {
    contents: request.messages
      .filter((message) => message.role !== "system")
      .map(toGeminiContent),
    ...(request.maxOutputTokens || request.temperature !== undefined
      ? {
        generationConfig: {
          maxOutputTokens: request.maxOutputTokens,
          temperature: request.temperature
        }
      }
      : {}),
    ...(request.tools && request.tools.length > 0
      ? {
        tools: [{
          functionDeclarations: request.tools.map((tool) => ({
            description: tool.description,
            name: tool.name,
            parameters: sanitizeGeminiSchema(tool.inputSchema)
          }))
        }]
      }
      : {}),
    ...(request.messages.some((message) => message.role === "system")
      ? {
        systemInstruction: {
          parts: request.messages
            .filter((message) => message.role === "system")
            .map((message) => ({ text: message.content }))
        }
      }
      : {})
  };
}

/**
 * Strips JSON Schema keywords Gemini's tool-calling API rejects.
 *
 * Gemini accepts a narrow OpenAPI 3.0 subset and 400's on `additionalProperties`,
 * `$schema`, `$id`, `$ref`, `definitions`, `default` (sometimes), and the
 * combinator forms `oneOf`/`anyOf`/`allOf` at the parameters root. The stripped
 * schema is recursive — `properties.{key}` and `items` are sanitised in turn.
 */
export function sanitizeGeminiSchema(schema: unknown): unknown {
  if (!schema || typeof schema !== "object") {
    return schema;
  }

  if (Array.isArray(schema)) {
    return schema.map((entry) => sanitizeGeminiSchema(entry));
  }

  const stripped = new Set([
    "$schema",
    "$id",
    "$ref",
    "additionalProperties",
    "definitions",
    "patternProperties",
    "unevaluatedProperties",
    "exclusiveMinimum",
    "exclusiveMaximum"
  ]);

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    if (stripped.has(key)) {
      continue;
    }
    if (key === "properties" && value && typeof value === "object") {
      const nested: Record<string, unknown> = {};
      for (const [propertyKey, propertyValue] of Object.entries(value as Record<string, unknown>)) {
        nested[propertyKey] = sanitizeGeminiSchema(propertyValue);
      }
      result[key] = nested;
      continue;
    }
    if (key === "items" || key === "oneOf" || key === "anyOf" || key === "allOf") {
      result[key] = Array.isArray(value)
        ? value.map((entry) => sanitizeGeminiSchema(entry))
        : sanitizeGeminiSchema(value);
      continue;
    }
    result[key] = value;
  }

  return result;
}

function toGeminiContent(message: ModelMessage) {
  if (message.role === "tool") {
    return {
      parts: [{
        functionResponse: {
          name: message.name ?? message.toolCallId ?? "tool",
          response: { output: message.content }
        }
      }],
      role: "function"
    };
  }

  if (message.role === "assistant" && message.toolCalls && message.toolCalls.length > 0) {
    return {
      parts: [
        ...(message.content ? [{ text: message.content }] : []),
        ...message.toolCalls.map((toolCall) => ({
          functionCall: {
            args: toolCall.arguments,
            name: toolCall.name
          }
        }))
      ],
      role: "model"
    };
  }

  return {
    parts: [{ text: message.content }],
    role: message.role === "assistant" ? "model" : "user"
  };
}

function fromGeminiResponse(providerId: string, model: string, payload: unknown): ModelResponse {
  if (!isRecord(payload)) {
    throw new ModelProviderError(providerId, "Gemini response was not an object");
  }

  const candidate = Array.isArray(payload.candidates) && isRecord(payload.candidates[0]) ? payload.candidates[0] : undefined;
  const content = isRecord(candidate?.content) ? candidate.content : {};
  const parts = Array.isArray(content.parts) ? content.parts : [];
  const output = parts
    .map((part) => isRecord(part) && typeof part.text === "string" ? part.text : "")
    .join("");
  const toolCalls = parts.flatMap((part, index): ModelToolCall[] => {
    if (!isRecord(part) || !isRecord(part.functionCall) || typeof part.functionCall.name !== "string") {
      return [];
    }

    return [{
      arguments: isJsonObject(part.functionCall.args) ? part.functionCall.args : {},
      id: `gemini_tool_call_${index}`,
      name: part.functionCall.name
    }];
  });

  return {
    id: typeof payload.responseId === "string" ? payload.responseId : `${providerId}-response`,
    model,
    output,
    raw: payload,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    usage: parseGeminiUsage(payload.usageMetadata)
  };
}

function toOpenAIMessage(message: ModelMessage) {
  if (message.role === "assistant" && message.toolCalls && message.toolCalls.length > 0) {
    return {
      content: message.content,
      role: message.role,
      tool_calls: message.toolCalls.map((toolCall) => ({
        function: {
          arguments: JSON.stringify(toolCall.arguments),
          name: toolCall.name
        },
        id: toolCall.id,
        type: "function"
      }))
    };
  }

  if (message.role === "tool") {
    return {
      content: message.content,
      role: message.role,
      tool_call_id: message.toolCallId
    };
  }

  return {
    content: message.content,
    name: message.name,
    role: message.role
  };
}

function fromOpenAIChatResponse(providerId: string, requestedModel: string, payload: unknown): ModelResponse {
  if (!isRecord(payload)) {
    throw new ModelProviderError(providerId, "OpenAI-compatible response was not an object");
  }

  const choice = Array.isArray(payload.choices) && isRecord(payload.choices[0]) ? payload.choices[0] : undefined;
  const message = isRecord(choice?.message) ? choice.message : undefined;
  const output = readOpenAIContent(message?.content);

  return {
    id: typeof payload.id === "string" ? payload.id : `${providerId}-response`,
    model: typeof payload.model === "string" ? payload.model : requestedModel,
    output,
    raw: payload,
    toolCalls: parseOpenAIToolCalls(message?.tool_calls),
    usage: parseOpenAIUsage(payload.usage)
  };
}

async function* parseOpenAIStream(
  providerId: string,
  requestedModel: string,
  body: ReadableStream<Uint8Array>
): AsyncIterable<ModelEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let output = "";
  let responseId = `${providerId}-stream`;
  let model = requestedModel;
  const streamedToolCalls = new Map<number, MutableOpenAIStreamToolCall>();

  while (true) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split(/\n\n/u);
    buffer = events.pop() ?? "";

    for (const event of events) {
      const data = readSseData(event);

      if (!data || data === "[DONE]") {
        continue;
      }

      const parsed = parseJson(data);

      if (!isRecord(parsed)) {
        continue;
      }

      responseId = typeof parsed.id === "string" ? parsed.id : responseId;
      model = typeof parsed.model === "string" ? parsed.model : model;

      const delta = readOpenAIStreamDelta(parsed);

      if (delta.length > 0) {
        output += delta;
        yield { text: delta, type: "text-delta" };
      }

      for (const toolCall of readOpenAIStreamToolCallDeltas(parsed)) {
        mergeOpenAIStreamToolCall(streamedToolCalls, toolCall);
      }
    }
  }

  const toolCalls = materializeOpenAIStreamToolCalls(streamedToolCalls);

  for (const toolCall of toolCalls) {
    yield { toolCall, type: "tool-call" };
  }

  yield {
    response: {
      id: responseId,
      model,
      output,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined
    },
    type: "done"
  };
}

function readSseData(event: string): string | undefined {
  const lines = event
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trim());

  return lines.length > 0 ? lines.join("\n") : undefined;
}

function readOpenAIStreamDelta(payload: Record<string, unknown>): string {
  const choice = Array.isArray(payload.choices) && isRecord(payload.choices[0]) ? payload.choices[0] : undefined;
  const delta = isRecord(choice?.delta) ? choice.delta : undefined;
  return readOpenAIContent(delta?.content);
}

interface OpenAIStreamToolCallDelta {
  readonly index: number;
  readonly id?: string;
  readonly name?: string;
  readonly argumentsChunk?: string;
}

interface MutableOpenAIStreamToolCall {
  id?: string;
  name?: string;
  argumentsText: string;
}

function readOpenAIStreamToolCallDeltas(payload: Record<string, unknown>): readonly OpenAIStreamToolCallDelta[] {
  const choice = Array.isArray(payload.choices) && isRecord(payload.choices[0]) ? payload.choices[0] : undefined;
  const delta = isRecord(choice?.delta) ? choice.delta : undefined;
  const toolCalls = Array.isArray(delta?.tool_calls) ? delta.tool_calls : [];

  return toolCalls.flatMap((entry, fallbackIndex) => {
    if (!isRecord(entry)) {
      return [];
    }

    const fn = isRecord(entry.function) ? entry.function : {};
    return [{
      argumentsChunk: typeof fn.arguments === "string" ? fn.arguments : undefined,
      id: typeof entry.id === "string" ? entry.id : undefined,
      index: typeof entry.index === "number" ? entry.index : fallbackIndex,
      name: typeof fn.name === "string" ? fn.name : undefined
    }];
  });
}

function mergeOpenAIStreamToolCall(
  target: Map<number, MutableOpenAIStreamToolCall>,
  delta: OpenAIStreamToolCallDelta
): void {
  const current = target.get(delta.index) ?? { argumentsText: "" };

  target.set(delta.index, {
    argumentsText: current.argumentsText + (delta.argumentsChunk ?? ""),
    id: delta.id ?? current.id,
    name: delta.name ?? current.name
  });
}

function materializeOpenAIStreamToolCalls(
  source: ReadonlyMap<number, MutableOpenAIStreamToolCall>
): readonly ModelToolCall[] {
  return [...source.entries()]
    .sort(([left], [right]) => left - right)
    .flatMap(([index, value]) => {
      if (!value.name) {
        return [];
      }

      return [{
        arguments: parseToolArguments(value.argumentsText),
        id: value.id ?? `tool_call_${index}`,
        name: value.name
      }];
    });
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function readOpenAIContent(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    return value
      .map((entry) => isRecord(entry) && typeof entry.text === "string" ? entry.text : "")
      .filter((entry) => entry.length > 0)
      .join("");
  }

  return "";
}

function parseOpenAIToolCalls(value: unknown): readonly ModelToolCall[] | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    return undefined;
  }

  return value.flatMap((entry, index) => {
    if (!isRecord(entry) || !isRecord(entry.function) || typeof entry.function.name !== "string") {
      return [];
    }

    return [{
      arguments: parseToolArguments(entry.function.arguments),
      id: typeof entry.id === "string" ? entry.id : `tool_call_${index}`,
      name: entry.function.name
    }];
  });
}

function parseToolArguments(value: unknown): JsonObject {
  if (isJsonObject(value)) {
    return value;
  }

  if (typeof value !== "string" || value.trim().length === 0) {
    return {};
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return isJsonObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function parseOpenAIUsage(value: unknown): ModelUsage | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  return {
    cachedInputTokens: readFiniteNumber(value.prompt_tokens_details, "cached_tokens"),
    inputTokens: readFiniteNumber(value, "prompt_tokens"),
    outputTokens: readFiniteNumber(value, "completion_tokens"),
    reasoningTokens: readFiniteNumber(value.completion_tokens_details, "reasoning_tokens")
  };
}

function parseAnthropicUsage(value: unknown): ModelUsage | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  return {
    cachedInputTokens: readFiniteNumber(value, "cache_read_input_tokens"),
    inputTokens: readFiniteNumber(value, "input_tokens"),
    outputTokens: readFiniteNumber(value, "output_tokens")
  };
}

function parseGeminiUsage(value: unknown): ModelUsage | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  return {
    inputTokens: readFiniteNumber(value, "promptTokenCount"),
    outputTokens: readFiniteNumber(value, "candidatesTokenCount")
  };
}

function readFiniteNumber(value: unknown, key: string): number | undefined {
  return isRecord(value) && typeof value[key] === "number" && Number.isFinite(value[key])
    ? value[key]
    : undefined;
}

function defaultRemoteModelCapabilities(): ModelCapabilities {
  return {
    cost: "unknown",
    latencyProfile: "unknown",
    local: false,
    maxInputTokens: 128_000,
    maxOutputTokens: 16_384,
    promptCaching: false,
    reasoning: true,
    streaming: true,
    structuredOutput: true,
    toolCalling: true,
    vision: true
  };
}

function localModelCapabilities(): ModelCapabilities {
  return {
    ...defaultRemoteModelCapabilities(),
    cost: "free",
    latencyProfile: "interactive",
    local: true,
    maxInputTokens: 32_768,
    maxOutputTokens: 8_192,
    promptCaching: false,
    reasoning: false,
    vision: false
  };
}

function diagnosticModelCapabilities(): ModelCapabilities {
  return {
    ...localModelCapabilities(),
    maxInputTokens: 32_000,
    maxOutputTokens: 4_096,
    structuredOutput: true,
    toolCalling: false
  };
}

function estimateDiagnosticTokens(content: string): number {
  return Math.max(1, Math.ceil(content.length / 4));
}

/**
 * Shapes the diagnostic provider's deterministic output. The default behavior
 * is "Diagnostic response: <user prompt>", but a structural mode hint in the
 * system messages lets smoke tests exercise plan-execute without a real LLM:
 *
 *   - planning prompts (built by `buildPlanningSystemPrompt`) → emit a JSON
 *     plan. If `time_now` is listed in `[Available Tools]` the diagnostic
 *     emits a one-step plan calling it (so the smoke can assert the
 *     plan_step_executing + plan_step_result events); otherwise it emits an
 *     empty plan that falls through to the direct-answer synthesis path.
 *
 * Anything else falls through to the legacy "Diagnostic response: …" shape.
 */
function renderDiagnosticOutput(messages: readonly { readonly role: string; readonly content: string }[], userPrompt: string): string {
  const systemPrompt = messages.find((message) => message.role === "system")?.content ?? "";
  if (isDiagnosticPlanningPrompt(systemPrompt)) {
    if (planningPromptListsTool(systemPrompt, "time_now")) {
      return JSON.stringify([
        { args: {}, description: "Diagnostic plan-execute step (time_now)", tool: "time_now" }
      ]);
    }
    return "[]";
  }
  return `Diagnostic response: ${userPrompt}`.trimEnd();
}

function isDiagnosticPlanningPrompt(systemPrompt: string): boolean {
  return systemPrompt.includes("[Role]")
    && systemPrompt.includes("[Output Format]")
    && systemPrompt.includes("[Available Tools]");
}

function planningPromptListsTool(systemPrompt: string, toolName: string): boolean {
  // Tools are rendered by renderToolDescriptionsForPlanning as `- <name>: <description>`.
  return new RegExp(`(^|\\n)\\s*-\\s*${escapeRegex(toolName)}\\s*:`, "u").test(systemPrompt);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function anthropicModelCapabilities(modelId: string): ModelCapabilities {
  return {
    ...defaultRemoteModelCapabilities(),
    cost: "medium",
    latencyProfile: "balanced",
    maxInputTokens: 200_000,
    promptCaching: true,
    reasoning: modelId.includes("opus") || modelId.includes("sonnet"),
    structuredOutput: false
  };
}

function geminiModelCapabilities(modelId: string): ModelCapabilities {
  return {
    ...defaultRemoteModelCapabilities(),
    cost: modelId.includes("flash") ? "low" : "medium",
    latencyProfile: modelId.includes("flash") ? "interactive" : "balanced",
    maxInputTokens: modelId.includes("1.5") || modelId.includes("2.") ? 1_000_000 : 128_000,
    promptCaching: true,
    reasoning: modelId.includes("pro")
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isJsonObject(value: unknown): value is JsonObject {
  if (!isRecord(value)) {
    return false;
  }

  return Object.values(value).every(isJsonValue);
}

function isJsonValue(value: unknown): boolean {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return true;
  }

  if (typeof value === "number") {
    return Number.isFinite(value);
  }

  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }

  return isRecord(value) && Object.values(value).every(isJsonValue);
}
