import type { ModelToolCall } from "@muse/model";
import type { ToolExecutionResult } from "@muse/tools";
import { isRecord } from "@muse/shared";

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
 *
 * Read-invalidation-on-write: when a mutating (write/execute) tool completes,
 * all previously memoized READ entries are deleted so a subsequent identical
 * read re-executes against fresh state instead of returning a stale result.
 * Write entries are not invalidated by other writes — anti-double-execution
 * is preserved for write/execute tools.
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

interface MemoEntry {
  readonly result: ToolExecutionResult;
  readonly mutating: boolean;
}

const DEFAULT_MAX_DEDUP_ENTRIES = 256;

export class ToolCallDeduplicator {
  readonly #completedResults = new Map<string, MemoEntry>();
  readonly #maxEntries: number;

  constructor(maxEntries: number = DEFAULT_MAX_DEDUP_ENTRIES) {
    // Finite-guard the bound: a non-finite cap would make the
    // `size > maxEntries` check always false and silently restore
    // the unbounded behaviour this cap exists to prevent.
    this.#maxEntries = Number.isFinite(maxEntries) && maxEntries > 0
      ? Math.trunc(maxEntries)
      : DEFAULT_MAX_DEDUP_ENTRIES;
  }

  buildSignature(toolCall: ModelToolCall): string {
    return `${toolCall.name}:${stableJson(toolCall.arguments)}`;
  }

  check(toolCall: ModelToolCall): ToolCallDeduplicationDecision {
    const signature = this.buildSignature(toolCall);
    const entry = this.#completedResults.get(signature);

    if (!entry) {
      return { duplicate: false, signature };
    }

    return {
      duplicate: true,
      result: {
        ...entry.result,
        id: toolCall.id,
        name: toolCall.name
      },
      signature
    };
  }

  record(toolCall: ModelToolCall, result: ToolExecutionResult, mutating = false): void {
    if (result.status !== "completed") {
      return;
    }

    if (mutating) {
      // Invalidate stale read entries so a subsequent identical read re-executes
      // against the state that the write just changed. Write entries are left
      // intact — anti-double-execution for write/execute tools is preserved.
      for (const [key, entry] of this.#completedResults) {
        if (!entry.mutating) {
          this.#completedResults.delete(key);
        }
      }
    }

    this.#completedResults.set(this.buildSignature(toolCall), { mutating, result });
    if (this.#completedResults.size > this.#maxEntries) {
      // Oldest-first (insertion-order) eviction so a long tool loop
      // can't pin unbounded memory in full tool outputs; an evicted
      // repeat just re-executes, which is correct, only unmemoized.
      const oldest = this.#completedResults.keys().next().value;
      if (oldest !== undefined) {
        this.#completedResults.delete(oldest);
      }
    }
  }
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }

  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}
