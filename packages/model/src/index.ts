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

export function canUseNativeTools(model: ModelInfo): boolean {
  return model.capabilities.toolCalling && model.capabilities.structuredOutput;
}

export interface ModelSelectionCriteria {
  readonly provider?: string;
  readonly model?: string;
  readonly requires?: Partial<Record<keyof ModelCapabilities, boolean>>;
  readonly minInputTokens?: number;
  readonly minOutputTokens?: number;
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
    const provider = this.getProvider(criteria.provider ?? requestedModel);
    const models = await provider.listModels();
    const exactModel = requestedModel ? parseModelName(requestedModel).modelId : undefined;
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
    }
  }

  yield {
    response: {
      id: responseId,
      model,
      output
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
