/**
 * Cross-provider helpers — pure parsers, JSON shape guards, and the
 * baseline capability factories. Everything here is reused by 2+ of
 * the per-provider files (anthropic / gemini / openai); provider-
 * specific wire transforms stay in their respective files.
 */

import type { JsonObject, JsonValue as _JsonValue } from "@muse/shared";

import type { ModelCapabilities, ModelEvent, ModelResponse } from "./index.js";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function isJsonObject(value: unknown): value is JsonObject {
  if (!isRecord(value)) {
    return false;
  }

  return Object.values(value).every(isJsonValue);
}

export function isJsonValue(value: unknown): boolean {
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

export function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

export function readFiniteNumber(value: unknown, key: string): number | undefined {
  return isRecord(value) && typeof value[key] === "number" && Number.isFinite(value[key])
    ? value[key]
    : undefined;
}

export function defaultRemoteModelCapabilities(): ModelCapabilities {
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

export function localModelCapabilities(): ModelCapabilities {
  return {
    ...defaultRemoteModelCapabilities(),
    cost: "free",
    latencyProfile: "interactive",
    local: true,
    maxInputTokens: 32_768,
    maxOutputTokens: 8_192,
    promptCaching: false,
    reasoning: false,
    vision: false
  };
}

/**
 * Replays a non-stream ModelResponse as a sequence of ModelEvent values
 * so delegate-to-generate stream() wrappers (Anthropic, Gemini) emit
 * the same tool-call-started/finished + citations triplet that the
 * native OpenAI Responses SSE parser produces. Without this,
 * Anthropic/Gemini clients silently drop the web_search status +
 * citation events the API surface relays to UI clients.
 */
export async function* synthesizeStreamEventsFromResponse(
  response: ModelResponse
): AsyncGenerator<ModelEvent> {
  if (response.output.length > 0) {
    yield { text: response.output, type: "text-delta" };
  }
  for (const toolCall of response.toolCalls ?? []) {
    yield { toolCall, type: "tool-call" };
  }
  const citations = response.citations ?? [];
  if (citations.length > 0) {
    yield { name: "web_search", type: "tool-call-started" };
    yield { count: citations.length, name: "web_search", type: "tool-call-finished" };
    yield { items: citations, type: "citations" };
  }
  yield { response, type: "done" };
}
