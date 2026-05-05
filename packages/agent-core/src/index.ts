import {
  ModelProviderRegistry,
  parseModelName,
  type ModelMessage,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse
} from "@muse/model";
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
  private readonly guards: readonly GuardStage[];
  private readonly hooks: readonly HookStage[];
  private readonly outputGuards: readonly OutputGuardStage[];
  private readonly defaults: AgentRuntimeOptions["defaults"];

  constructor(options: AgentRuntimeOptions) {
    this.modelProvider = options.modelProvider;
    this.modelRegistry = options.modelRegistry;
    this.contextWindow = options.contextWindow;
    this.guards = options.guards ?? [];
    this.hooks = options.hooks ?? [];
    this.outputGuards = options.outputGuards ?? [];
    this.defaults = options.defaults;

    if (!this.modelProvider && !this.modelRegistry) {
      throw new ModelRoutingError("AgentRuntime requires either modelProvider or modelRegistry");
    }
  }

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    const context: AgentRunContext = {
      input,
      runId: input.runId ?? createRunId(),
      startedAt: new Date()
    };

    await this.evaluateGuards(context);
    await this.invokeHooks("beforeStart", context);

    try {
      const selected = this.resolveProvider(input.model);
      const preparedRequest = this.prepareModelRequest(input, selected.model);
      const response = await selected.provider.generate({
        ...preparedRequest.request,
        maxOutputTokens: this.defaults?.maxOutputTokens,
        temperature: this.defaults?.temperature
      });
      const guardedResponse = await this.applyOutputGuards(context, response);

      await this.invokeHooks("afterComplete", context, guardedResponse);
      return createRunResult(context.runId, guardedResponse, preparedRequest.contextWindow);
    } catch (error) {
      await this.invokeHooks("onError", context, error);
      throw error;
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

      try {
        decision = await guard.evaluate(context);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Guard failed closed";
        throw new GuardBlockedError(guard.id, message, "GUARD_ERROR");
      }

      if (!decision.allowed) {
        throw new GuardBlockedError(guard.id, decision.reason, decision.code);
      }
    }
  }

  private async applyOutputGuards(context: AgentRunContext, response: ModelResponse): Promise<ModelResponse> {
    let guarded = response;

    for (const stage of this.outputGuards) {
      let decision: OutputGuardDecision;

      try {
        decision = await stage.check(guarded.output, {
          input: context.input,
          response: guarded,
          runId: context.runId
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Output guard failed closed";
        throw new OutputGuardBlockedError(stage.id, message, "OUTPUT_GUARD_ERROR");
      }

      if (decision.action === "reject") {
        throw new OutputGuardBlockedError(stage.id, decision.reason, decision.code);
      }

      if (decision.action === "modify") {
        guarded = { ...guarded, output: decision.content };
      }
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
