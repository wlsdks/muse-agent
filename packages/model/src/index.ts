import type { JsonObject } from "@muse/shared";

import { ModelProviderError } from "./provider-base.js";

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
  /**
   * Optional free-text argument names that must be GROUNDED in the user's
   * utterance — the runtime drops any such arg the model fabricated (an 8B
   * invents a calendar `location`/`notes` the user never said). Muse-side
   * metadata like `risk`; never serialized into the provider request (providers
   * read only `inputSchema`).
   */
  readonly groundedArgs?: readonly string[];
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
  /**
   * JSON Schema the model output MUST conform to — native structured output
   * (constrained decoding), not parse-and-hope. Adapters of providers that
   * declare `structuredOutput` translate it to the wire format (Ollama
   * `format`, OpenAI `response_format: json_schema`); providers without the
   * capability ignore it and the caller falls back to a parser + validator.
   */
  readonly responseFormat?: JsonObject;
  /**
   * Ask the model to reason natively first (e.g. Qwen via Ollama `think: true`),
   * exposing its chain-of-thought in a SEPARATE channel (`ModelResponse.reasoning`
   * / `reasoning-delta` stream events) instead of mixed into the answer. Off by
   * default — enable only for user-facing generation where the reasoning improves
   * the answer and can be shown as a live "thinking" process; keep it off for the
   * fast deterministic internal calls (tool routing, rubric scoring).
   */
  readonly reasoning?: boolean;
  /**
   * Request per-token log-probabilities (Ollama ≥0.30.6 native API). Cheap and
   * observational-only — feeds deterministic confidence scoring; never alters
   * decoding. Providers without the capability ignore it.
   */
  readonly logprobs?: boolean;
  /** Number of alternative tokens per position (Ollama `top_logprobs`, 0-20). */
  readonly topLogprobs?: number;
}

export interface TokenLogprob {
  readonly token: string;
  readonly logprob: number;
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
  /** Native reasoning trace (Qwen `thinking`), present only when `reasoning` was requested. */
  readonly reasoning?: string;
  /** Per-token log-probabilities, present only when `logprobs` was requested. */
  readonly logprobs?: readonly TokenLogprob[];
  readonly raw?: unknown;
}

export type ModelEvent =
  | { readonly type: "text-delta"; readonly text: string }
  | { readonly type: "reasoning-delta"; readonly text: string }
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
  /**
   * Ollama's `num_ctx`. Ollama defaults this low (2048–4096),
   * which silently truncates Muse's rich prompt (persona +
   * memory + RAG + tasks + calendar). Defaults to 8192 here;
   * the autoconfigure layer maps `MUSE_OLLAMA_NUM_CTX`.
   */
  readonly numCtx?: number;
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

export { ModelProviderError, OpenAICompatibleProvider, isRetryableHttpStatus } from "./provider-base.js";
export { createLeadingThinkStripper, stripLeadingThinkBlock } from "./provider-shared.js";
export { DiagnosticModelProvider } from "./adapter-diagnostic.js";
export { OpenAIProvider, OpenRouterProvider } from "./adapter-openai.js";
export { DEFAULT_OLLAMA_NUM_CTX, OllamaProvider, sanitizeOllamaToolSchema } from "./adapter-ollama.js";
export { AnthropicProvider } from "./adapter-anthropic.js";
export { GeminiProvider } from "./adapter-gemini.js";

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

export {
  classifyProviderLocality,
  isLoopbackUrl,
  LocalOnlyViolationError,
  type ProviderLocality
} from "./local-only-policy.js";

export {
  evaluateWebEgressPosture,
  isWebEgressAllowed,
  type WebEgressPosture
} from "./web-egress-policy.js";
