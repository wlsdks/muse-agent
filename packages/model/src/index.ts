import type { JsonObject } from "@muse/shared";

export type ModelRole = "system" | "user" | "assistant" | "tool";

export interface ModelMessage {
  readonly role: ModelRole;
  readonly content: string;
  readonly name?: string;
  readonly toolCallId?: string;
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

export function canUseNativeTools(model: ModelInfo): boolean {
  return model.capabilities.toolCalling && model.capabilities.structuredOutput;
}
