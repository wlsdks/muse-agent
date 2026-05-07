import type { ModelToolCall } from "@muse/model";
import type { ToolExecutionResult } from "@muse/tools";

/**
 * Tool-call deduplicator.
 *
 * Memoizes the result of completed tool calls keyed by `<name>:<canonical-args>`.
 * When a model emits the same call twice (verbatim), the second invocation
 * returns the previously-recorded `ToolExecutionResult` (with a fresh `id` /
 * `name`) instead of re-executing the tool. Non-completed results
 * (`blocked` / `failed`) are intentionally not memoized so the agent can
 * retry recoverable failures.
 *
 * Argument canonicalization is stable under key reordering: `{a,b}` and
 * `{b,a}` produce the same signature.
 */

export interface ToolCallDuplicate {
  readonly duplicate: true;
  readonly signature: string;
  readonly result: ToolExecutionResult;
}

export interface ToolCallNotDuplicate {
  readonly duplicate: false;
  readonly signature: string;
}

export type ToolCallDeduplicationDecision = ToolCallDuplicate | ToolCallNotDuplicate;

export class ToolCallDeduplicator {
  readonly #completedResults = new Map<string, ToolExecutionResult>();

  buildSignature(toolCall: ModelToolCall): string {
    return `${toolCall.name}:${stableJson(toolCall.arguments)}`;
  }

  check(toolCall: ModelToolCall): ToolCallDeduplicationDecision {
    const signature = this.buildSignature(toolCall);
    const result = this.#completedResults.get(signature);

    if (!result) {
      return { duplicate: false, signature };
    }

    return {
      duplicate: true,
      result: {
        ...result,
        id: toolCall.id,
        name: toolCall.name
      },
      signature
    };
  }

  record(toolCall: ModelToolCall, result: ToolExecutionResult): void {
    if (result.status !== "completed") {
      return;
    }

    this.#completedResults.set(this.buildSignature(toolCall), result);
  }
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }

  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}
