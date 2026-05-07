import type { AgentSpecResolution } from "@muse/agent-specs";
import type { ModelMessage, ModelProvider, ModelResponse, ModelToolCall } from "@muse/model";
import type { JsonObject } from "@muse/shared";
import type { ToolExecutionResult } from "@muse/tools";

/**
 * Public runtime interface types for `@muse/agent-core` submodules to share.
 *
 * Kept minimal — only the types that are imported by more than one of the
 * extracted submodules (guards, response-filters, hooks, runtime). Anything
 * that lives entirely inside a single submodule (e.g. `PlanStep`) stays in
 * that submodule.
 */

export type Awaitable<T> = T | Promise<T>;

export interface AgentRunInput {
  readonly model: string;
  readonly messages: readonly ModelMessage[];
  readonly runId?: string;
  readonly metadata?: JsonObject;
}

export interface AgentRunContext {
  readonly runId: string;
  readonly input: AgentRunInput;
  readonly startedAt: Date;
  readonly agentSpec?: AgentSpecResolution;
}

export type GuardDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: string; readonly code?: string };

export interface GuardStage {
  readonly id: string;
  evaluate(context: AgentRunContext): Awaitable<GuardDecision>;
}

export interface LlmClassificationInputGuardOptions {
  readonly provider: ModelProvider;
  readonly model: string;
  readonly systemPrompt?: string;
  readonly maxOutputTokens?: number;
}

export interface HookStage {
  readonly id: string;
  beforeStart?(context: AgentRunContext): Awaitable<void>;
  beforeTool?(context: AgentRunContext, toolCall: ModelToolCall): Awaitable<void>;
  afterTool?(context: AgentRunContext, toolCall: ModelToolCall, result: ToolExecutionResult): Awaitable<void>;
  afterComplete?(context: AgentRunContext, response: ModelResponse): Awaitable<void>;
  onError?(context: AgentRunContext, error: unknown): Awaitable<void>;
}

export type OutputGuardDecision =
  | { readonly action: "allow" }
  | { readonly action: "modify"; readonly content: string; readonly reason: string }
  | { readonly action: "reject"; readonly reason: string; readonly code?: string };

export interface OutputGuardContext {
  readonly runId: string;
  readonly input: AgentRunInput;
  readonly response: ModelResponse;
}

export interface OutputGuardStage {
  readonly id: string;
  check(content: string, context: OutputGuardContext): Awaitable<OutputGuardDecision>;
}

export interface VerifiedSource {
  readonly title: string;
  readonly url: string;
  readonly toolName?: string;
}

export interface ResponseFilterContext {
  readonly runId: string;
  readonly input: AgentRunInput;
  readonly response: ModelResponse;
  readonly toolInsights?: readonly string[];
  readonly toolsUsed?: readonly string[];
  readonly verifiedSources?: readonly VerifiedSource[];
}

export interface ResponseFilterStage {
  readonly id: string;
  apply(response: ModelResponse, context: ResponseFilterContext): Awaitable<ModelResponse>;
}
