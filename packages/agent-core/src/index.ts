import {
  ModelProviderRegistry,
  parseModelName,
  type ModelMessage,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse
} from "@muse/model";
import {
  createNoOpAgentMetrics,
  createNoOpMuseTracer,
  type AgentMetrics,
  type MuseTracer,
  type SpanHandle
} from "@muse/observability";
import { trimConversationMessages, type ConversationTrimOptions } from "@muse/memory";
import { detectSystemPromptLeakage, findInjectionPatterns, maskPii } from "@muse/policy";
import { createRunId, type JsonObject } from "@muse/shared";

type Awaitable<T> = T | Promise<T>;

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
}

export type GuardDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: string; readonly code?: string };

export interface GuardStage {
  readonly id: string;
  evaluate(context: AgentRunContext): Awaitable<GuardDecision>;
}

export interface HookStage {
  readonly id: string;
  beforeStart?(context: AgentRunContext): Awaitable<void>;
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

export interface AgentRuntimeOptions {
  readonly modelProvider?: ModelProvider;
  readonly modelRegistry?: ModelProviderRegistry;
  readonly contextWindow?: ConversationTrimOptions;
  readonly metrics?: AgentMetrics;
  readonly tracer?: MuseTracer;
  readonly guards?: readonly GuardStage[];
  readonly hooks?: readonly HookStage[];
  readonly outputGuards?: readonly OutputGuardStage[];
  readonly defaults?: {
    readonly maxOutputTokens?: number;
    readonly temperature?: number;
  };
}

export interface AgentRunResult {
  readonly runId: string;
  readonly response: ModelResponse;
  readonly contextWindow?: AgentContextWindowReport;
}

export interface AgentContextWindowReport {
  readonly budgetTokens: number;
  readonly estimatedTokens: number;
  readonly removedCount: number;
  readonly summaryInserted: boolean;
}

export class GuardBlockedError extends Error {
  readonly guardId: string;
  readonly code?: string;

  constructor(guardId: string, reason: string, code?: string) {
    super(reason);
    this.name = "GuardBlockedError";
    this.guardId = guardId;
    this.code = code;
  }
}

export class OutputGuardBlockedError extends Error {
  readonly stageId: string;
  readonly code?: string;

  constructor(stageId: string, reason: string, code?: string) {
    super(reason);
    this.name = "OutputGuardBlockedError";
    this.stageId = stageId;
    this.code = code;
  }
}

export class ModelRoutingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelRoutingError";
  }
}

export class AgentRuntime {
  private readonly modelProvider?: ModelProvider;
  private readonly modelRegistry?: ModelProviderRegistry;
  private readonly contextWindow?: ConversationTrimOptions;
  private readonly metrics: AgentMetrics;
  private readonly tracer: MuseTracer;
  private readonly guards: readonly GuardStage[];
  private readonly hooks: readonly HookStage[];
  private readonly outputGuards: readonly OutputGuardStage[];
  private readonly defaults: AgentRuntimeOptions["defaults"];

  constructor(options: AgentRuntimeOptions) {
    this.modelProvider = options.modelProvider;
    this.modelRegistry = options.modelRegistry;
    this.contextWindow = options.contextWindow;
    this.metrics = options.metrics ?? createNoOpAgentMetrics();
    this.tracer = options.tracer ?? createNoOpMuseTracer();
    this.guards = options.guards ?? [];
    this.hooks = options.hooks ?? [];
    this.outputGuards = options.outputGuards ?? [];
    this.defaults = options.defaults;

    if (!this.modelProvider && !this.modelRegistry) {
      throw new ModelRoutingError("AgentRuntime requires either modelProvider or modelRegistry");
    }
  }

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    const startedAtMs = Date.now();
    const context: AgentRunContext = {
      input,
      runId: input.runId ?? createRunId(),
      startedAt: new Date()
    };
    const runSpan = this.tracer.startSpan("muse.agent.run", {
      "model.requested": input.model,
      "run.id": context.runId
    });

    try {
      await this.evaluateGuards(context);
      await this.invokeHooks("beforeStart", context);

      const selected = this.resolveProvider(input.model);
      runSpan.setAttribute("model.selected", selected.model);

      const preparedRequest = this.prepareModelRequest(input, selected.model);
      recordContextWindowSpanAttributes(runSpan, preparedRequest.contextWindow);

      const response = await this.generateWithTracing(context, selected.provider, {
        ...preparedRequest.request,
        maxOutputTokens: this.defaults?.maxOutputTokens,
        temperature: this.defaults?.temperature
      });
      const guardedResponse = await this.applyOutputGuards(context, response);

      await this.invokeHooks("afterComplete", context, guardedResponse);
      this.recordAgentRun(context, guardedResponse.model, "completed", startedAtMs);
      return createRunResult(context.runId, guardedResponse, preparedRequest.contextWindow);
    } catch (error) {
      runSpan.setError(error);
      this.recordAgentRun(context, input.model, "failed", startedAtMs);
      await this.invokeHooks("onError", context, error);
      throw error;
    } finally {
      runSpan.end();
    }
  }

  private resolveProvider(model: string): { readonly provider: ModelProvider; readonly model: string } {
    if (this.modelRegistry) {
      return {
        model: parseModelName(model).modelId,
        provider: this.modelRegistry.getProvider(model)
      };
    }

    return {
      model,
      provider: this.modelProvider ?? failMissingProvider()
    };
  }

  private prepareModelRequest(
    input: AgentRunInput,
    model: string
  ): {
    readonly contextWindow?: AgentContextWindowReport;
    readonly request: Pick<ModelRequest, "messages" | "metadata" | "model">;
  } {
    if (!this.contextWindow) {
      return {
        request: {
          messages: input.messages,
          metadata: input.metadata,
          model
        }
      };
    }

    const trimResult = trimConversationMessages(input.messages, this.contextWindow);

    return {
      contextWindow: {
        budgetTokens: trimResult.budgetTokens,
        estimatedTokens: trimResult.estimatedTokens,
        removedCount: trimResult.removedCount,
        summaryInserted: trimResult.summaryInserted
      },
      request: {
        messages: trimResult.messages,
        metadata: input.metadata,
        model
      }
    };
  }

  private async evaluateGuards(context: AgentRunContext): Promise<void> {
    for (const guard of this.guards) {
      let decision: GuardDecision;
      const span = this.tracer.startSpan("muse.guard.evaluate", {
        "guard.id": guard.id,
        "run.id": context.runId
      });

      try {
        decision = await guard.evaluate(context);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Guard failed closed";
        span.setError(error);
        span.setAttribute("guard.allowed", false);
        span.setAttribute("guard.reason", message);
        span.end();
        this.metrics.recordGuardRejection(guard.id, message, context.input.metadata);
        throw new GuardBlockedError(guard.id, message, "GUARD_ERROR");
      }

      if (!decision.allowed) {
        span.setAttribute("guard.allowed", false);
        span.setAttribute("guard.reason", decision.reason);
        span.end();
        this.metrics.recordGuardRejection(guard.id, decision.reason, context.input.metadata);
        throw new GuardBlockedError(guard.id, decision.reason, decision.code);
      }

      span.setAttribute("guard.allowed", true);
      span.end();
    }
  }

  private async generateWithTracing(
    context: AgentRunContext,
    provider: ModelProvider,
    request: ModelRequest
  ): Promise<ModelResponse> {
    const span = this.tracer.startSpan("muse.model.generate", {
      "model.id": request.model,
      "provider.id": provider.id,
      "run.id": context.runId
    });

    try {
      const response = await provider.generate(request);
      recordUsageSpanAttributes(span, response);

      if (response.usage) {
        this.metrics.recordTokenUsage(response.usage, context.input.metadata);
      }

      return response;
    } catch (error) {
      span.setError(error);
      throw error;
    } finally {
      span.end();
    }
  }

  private async applyOutputGuards(context: AgentRunContext, response: ModelResponse): Promise<ModelResponse> {
    let guarded = response;

    for (const stage of this.outputGuards) {
      let decision: OutputGuardDecision;
      const span = this.tracer.startSpan("muse.output_guard.check", {
        "output_guard.id": stage.id,
        "run.id": context.runId
      });

      try {
        decision = await stage.check(guarded.output, {
          input: context.input,
          response: guarded,
          runId: context.runId
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Output guard failed closed";
        span.setError(error);
        span.setAttribute("output_guard.action", "rejected");
        span.setAttribute("output_guard.reason", message);
        span.end();
        this.metrics.recordOutputGuardAction(stage.id, "rejected", message, context.input.metadata);
        throw new OutputGuardBlockedError(stage.id, message, "OUTPUT_GUARD_ERROR");
      }

      if (decision.action === "reject") {
        span.setAttribute("output_guard.action", "rejected");
        span.setAttribute("output_guard.reason", decision.reason);
        span.end();
        this.metrics.recordOutputGuardAction(stage.id, "rejected", decision.reason, context.input.metadata);
        throw new OutputGuardBlockedError(stage.id, decision.reason, decision.code);
      }

      if (decision.action === "modify") {
        span.setAttribute("output_guard.action", "modified");
        span.setAttribute("output_guard.reason", decision.reason);
        span.end();
        this.metrics.recordOutputGuardAction(stage.id, "modified", decision.reason, context.input.metadata);
        guarded = { ...guarded, output: decision.content };
        continue;
      }

      span.setAttribute("output_guard.action", "allowed");
      span.end();
      this.metrics.recordOutputGuardAction(stage.id, "allowed", "", context.input.metadata);
    }

    return guarded;
  }

  private async invokeHooks(name: "beforeStart", context: AgentRunContext): Promise<void>;
  private async invokeHooks(
    name: "afterComplete",
    context: AgentRunContext,
    response: ModelResponse
  ): Promise<void>;
  private async invokeHooks(name: "onError", context: AgentRunContext, error: unknown): Promise<void>;
  private async invokeHooks(name: keyof HookStage, context: AgentRunContext, value?: unknown): Promise<void> {
    for (const hook of this.hooks) {
      try {
        if (name === "beforeStart") {
          await hook.beforeStart?.(context);
        } else if (name === "afterComplete") {
          await hook.afterComplete?.(context, value as ModelResponse);
        } else if (name === "onError") {
          await hook.onError?.(context, value);
        }
      } catch {
        // Hooks are extension points and must fail open.
      }
    }
  }

  private recordAgentRun(
    context: AgentRunContext,
    model: string,
    status: "completed" | "failed",
    startedAtMs: number
  ): void {
    this.metrics.recordAgentRun({
      durationMs: Date.now() - startedAtMs,
      metadata: context.input.metadata,
      model,
      runId: context.runId,
      status
    });
  }
}

export function createAgentRuntime(options: AgentRuntimeOptions): AgentRuntime {
  return new AgentRuntime(options);
}

function createRunResult(
  runId: string,
  response: ModelResponse,
  contextWindow: AgentContextWindowReport | undefined
): AgentRunResult {
  if (!contextWindow) {
    return { response, runId };
  }

  return { contextWindow, response, runId };
}

function recordContextWindowSpanAttributes(
  span: SpanHandle,
  contextWindow: AgentContextWindowReport | undefined
): void {
  if (!contextWindow) {
    return;
  }

  span.setAttribute("context.budget_tokens", contextWindow.budgetTokens);
  span.setAttribute("context.estimated_tokens", contextWindow.estimatedTokens);
  span.setAttribute("context.removed_count", contextWindow.removedCount);
  span.setAttribute("context.summary_inserted", contextWindow.summaryInserted);
}

function recordUsageSpanAttributes(span: SpanHandle, response: ModelResponse): void {
  if (!response.usage) {
    return;
  }

  const usage = response.usage;

  if (usage.inputTokens !== undefined) {
    span.setAttribute("usage.input_tokens", usage.inputTokens);
  }

  if (usage.outputTokens !== undefined) {
    span.setAttribute("usage.output_tokens", usage.outputTokens);
  }

  if (usage.reasoningTokens !== undefined) {
    span.setAttribute("usage.reasoning_tokens", usage.reasoningTokens);
  }
}

export function createInjectionInputGuard(): GuardStage {
  return {
    evaluate: (context) => {
      const findings = findInjectionPatterns(joinMessages(context.input.messages));

      if (findings.length === 0) {
        return { allowed: true };
      }

      return {
        allowed: false,
        code: "INJECTION_DETECTED",
        reason: `Input guard detected injection patterns: ${findings.map((finding) => finding.name).join(", ")}`
      };
    },
    id: "injection-input-guard"
  };
}

export function createPiiInputGuard(): GuardStage {
  return {
    evaluate: (context) => {
      const result = maskPii(joinMessages(context.input.messages));

      if (result.findings.length === 0) {
        return { allowed: true };
      }

      return {
        allowed: false,
        code: "PII_DETECTED",
        reason: `Input guard detected private identifiers: ${result.findings.map((finding) => finding.name).join(", ")}`
      };
    },
    id: "pii-input-guard"
  };
}

export function createPiiMaskingOutputGuard(): OutputGuardStage {
  return {
    check: (content) => {
      const result = maskPii(content);

      if (result.findings.length === 0) {
        return { action: "allow" };
      }

      return {
        action: "modify",
        content: result.text,
        reason: `Output guard masked private identifiers: ${result.findings.map((finding) => finding.name).join(", ")}`
      };
    },
    id: "pii-output-mask"
  };
}

export function createSystemPromptLeakageOutputGuard(options: {
  readonly canaryTokens?: readonly string[];
} = {}): OutputGuardStage {
  return {
    check: (content) => {
      const findings = detectSystemPromptLeakage(content, {
        canaryTokens: options.canaryTokens
      });

      if (findings.length === 0) {
        return { action: "allow" };
      }

      return {
        action: "reject",
        code: "SYSTEM_PROMPT_LEAKAGE",
        reason: `Output guard detected system prompt leakage: ${findings.map((finding) => finding.name).join(", ")}`
      };
    },
    id: "system-prompt-leakage-output-guard"
  };
}

function joinMessages(messages: readonly ModelMessage[]): string {
  return messages
    .filter((message) => message.role === "user" || message.role === "system")
    .map((message) => message.content)
    .join("\n");
}

function failMissingProvider(): never {
  throw new ModelRoutingError("AgentRuntime model provider is unavailable");
}
