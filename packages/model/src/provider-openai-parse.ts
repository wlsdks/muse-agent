/**
 * Pure parsers for OpenAI-shaped response fields (content text, tool calls, tool
 * arguments, usage). Shared by the chat/responses parsers AND the SSE-stream
 * materializer. Split out of provider-openai.ts.
 */

import type { JsonObject } from "@muse/shared";

import type { ModelToolCall, ModelUsage } from "./index.js";
import { isJsonObject, isRecord, readFiniteNumber } from "./provider-shared.js";

export function readOpenAIContent(value: unknown): string {
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

export function parseOpenAIToolCalls(value: unknown): readonly ModelToolCall[] | undefined {
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

export function parseToolArguments(value: unknown): JsonObject {
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

export function parseOpenAIUsage(value: unknown): ModelUsage | undefined {
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
