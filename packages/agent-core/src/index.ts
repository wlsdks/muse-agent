import type { ModelMessage, ModelProvider, ModelResponse } from "@muse/model";
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

export interface AgentRuntimeOptions {
  readonly modelProvider: ModelProvider;
  readonly guards?: readonly GuardStage[];
  readonly hooks?: readonly HookStage[];
  readonly defaults?: {
    readonly maxOutputTokens?: number;
    readonly temperature?: number;
  };
}

export interface AgentRunResult {
  readonly runId: string;
  readonly response: ModelResponse;
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

export class AgentRuntime {
  private readonly modelProvider: ModelProvider;
  private readonly guards: readonly GuardStage[];
  private readonly hooks: readonly HookStage[];
  private readonly defaults: AgentRuntimeOptions["defaults"];

  constructor(options: AgentRuntimeOptions) {
    this.modelProvider = options.modelProvider;
    this.guards = options.guards ?? [];
    this.hooks = options.hooks ?? [];
    this.defaults = options.defaults;
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
      const response = await this.modelProvider.generate({
        maxOutputTokens: this.defaults?.maxOutputTokens,
        messages: input.messages,
        metadata: input.metadata,
        model: input.model,
        temperature: this.defaults?.temperature
      });

      await this.invokeHooks("afterComplete", context, response);
      return { response, runId: context.runId };
    } catch (error) {
      await this.invokeHooks("onError", context, error);
      throw error;
    }
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
