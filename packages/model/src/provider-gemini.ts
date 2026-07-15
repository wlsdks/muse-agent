/**
 * Gemini wire-format helpers — request/response/usage transformers
 * + the JSON-Schema sanitiser that strips OpenAPI-3.0-incompatible
 * keywords Gemini's tool API 400s on (`additionalProperties`, `$ref`,
 * `definitions`, etc.) — and the per-model capability factory.
 */

import {
  ModelProviderError,
  parseModelName,
  type ModelCapabilities,
  type ModelMessage,
  type ModelRequest,
  type ModelResponse,
  type ModelToolCall,
  type ModelUsage,
  type WebSearchCitation
} from "./index.js";
import {
  defaultRemoteModelCapabilities,
  isJsonObject,
  isRecord,
  readFiniteNumber
} from "./provider-shared.js";

export function toGeminiRequest(
  request: ModelRequest,
  policy: { enabled: boolean; maxUses: number } = { enabled: false, maxUses: 5 }
) {
  // Build the tools array: function declarations first, then search tool when enabled.
  const tools: unknown[] = request.tools && request.tools.length > 0
    ? [{
      functionDeclarations: request.tools.map((tool) => ({
        description: tool.description,
        name: tool.name,
        parameters: sanitizeGeminiSchema(tool.inputSchema)
      }))
    }]
    : [];

  // Gemini API rejects requests that combine built-in grounding tools with
  // function declarations. When the caller registers function tools, those
  // win and grounding is skipped — users who want web grounding on Gemini
  // need to issue the request without function tools.
  const hasFunctionTools = (request.tools?.length ?? 0) > 0;
  if (policy.enabled && !hasFunctionTools) {
    const { modelId } = parseModelName(request.model || "");
    if (modelId.startsWith("gemini-1.5")) {
      tools.push({ googleSearchRetrieval: {} });
    } else {
      tools.push({ googleSearch: {} });
    }
  }

  return {
    contents: buildGeminiContents(request.messages),
    ...(request.maxOutputTokens || request.temperature !== undefined
      ? {
        generationConfig: {
          maxOutputTokens: request.maxOutputTokens,
          temperature: request.temperature
        }
      }
      : {}),
    ...(tools.length > 0 ? { tools } : {}),
    ...(request.messages.some((message) => message.role === "system")
      ? {
        systemInstruction: {
          parts: request.messages
            .filter((message) => message.role === "system")
            .map((message) => ({ text: message.content }))
        }
      }
      : {})
  };
}

/**
 * Strips JSON Schema keywords Gemini's tool-calling API rejects.
 *
 * Gemini accepts a narrow OpenAPI 3.0 subset and 400's on `additionalProperties`,
 * `$schema`, `$id`, `$ref`, `definitions`, `default` (sometimes), and the
 * combinator forms `oneOf`/`anyOf`/`allOf` at the parameters root. The stripped
 * schema is recursive — `properties.{key}` and `items` are sanitised in turn.
 */
// A tool schema is an in-memory object that may be deeply nested or even
// self-referential (recursive types expanded into a cyclic object). The
// recursion below would otherwise blow the call stack (RangeError) on
// either, poisoning the whole generate request. Cap depth and detect
// cycles, returning a harmless empty schema past the limit.
const MAX_SCHEMA_DEPTH = 100;

export function sanitizeGeminiSchema(schema: unknown): unknown {
  return sanitizeGeminiSchemaInner(schema, 0, new WeakSet<object>());
}

function sanitizeGeminiSchemaInner(schema: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (!schema || typeof schema !== "object") {
    return schema;
  }
  if (Array.isArray(schema)) {
    return schema.map((entry) => sanitizeGeminiSchemaInner(entry, depth + 1, seen));
  }
  if (!isRecord(schema)) {
    return schema;
  }

  if (depth > MAX_SCHEMA_DEPTH || seen.has(schema)) {
    return {};
  }
  const obj = schema;
  seen.add(obj);

  const stripped = new Set([
    "$schema",
    "$id",
    "$ref",
    "additionalProperties",
    "definitions",
    "patternProperties",
    "unevaluatedProperties",
    "exclusiveMinimum",
    "exclusiveMaximum"
  ]);

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (stripped.has(key)) {
      continue;
    }
    if (key === "properties" && isRecord(value)) {
      const nested: Record<string, unknown> = {};
      for (const [propertyKey, propertyValue] of Object.entries(value)) {
        nested[propertyKey] = sanitizeGeminiSchemaInner(propertyValue, depth + 1, seen);
      }
      result[key] = nested;
      continue;
    }
    if (key === "items" || key === "oneOf" || key === "anyOf" || key === "allOf") {
      result[key] = Array.isArray(value)
        ? value.map((entry) => sanitizeGeminiSchemaInner(entry, depth + 1, seen))
        : sanitizeGeminiSchemaInner(value, depth + 1, seen);
      continue;
    }
    result[key] = value;
  }

  return result;
}

function buildGeminiContents(messages: readonly ModelMessage[]) {
  const contents: Array<{ role: string; parts: unknown[] }> = [];
  let pendingToolParts: unknown[] | null = null;

  const flushToolParts = () => {
    if (pendingToolParts && pendingToolParts.length > 0) {
      contents.push({ parts: pendingToolParts, role: "function" });
    }
    pendingToolParts = null;
  };

  for (const message of messages) {
    if (message.role === "system") {
      continue;
    }
    if (message.role === "tool") {
      pendingToolParts ??= [];
      pendingToolParts.push({
        functionResponse: {
          name: message.name ?? message.toolCallId ?? "tool",
          response: { output: message.content }
        }
      });
      continue;
    }
    flushToolParts();
    contents.push(toGeminiContent(message));
  }
  flushToolParts();

  return contents;
}

function toGeminiContent(message: ModelMessage): { role: string; parts: unknown[] } {
  if (message.role === "assistant" && message.toolCalls && message.toolCalls.length > 0) {
    return {
      parts: [
        ...(message.content ? [{ text: message.content }] : []),
        ...message.toolCalls.map((toolCall) => ({
          functionCall: {
            args: toolCall.arguments,
            name: toolCall.name
          }
        }))
      ],
      role: "model"
    };
  }

  // Vision-capable Gemini accepts `inlineData: { mimeType, data }`
  // (base64) and `fileData: { mimeType, fileUri }` parts alongside
  // text. Add image parts only when the message carries attachments —
  // otherwise keep the legacy single-text-part shape so the request
  // payload stays compact for the common case.
  const attachments = message.attachments ?? [];
  if (attachments.length > 0) {
    const parts: Array<Record<string, unknown>> = [];
    if (message.content && message.content.length > 0) {
      parts.push({ text: message.content });
    }
    for (const attachment of attachments) {
      if (attachment.dataBase64) {
        parts.push({ inlineData: { data: attachment.dataBase64, mimeType: attachment.mimeType } });
      } else if (attachment.url) {
        parts.push({ fileData: { fileUri: attachment.url, mimeType: attachment.mimeType } });
      }
    }
    return {
      parts,
      role: message.role === "assistant" ? "model" : "user"
    };
  }

  return {
    parts: [{ text: message.content }],
    role: message.role === "assistant" ? "model" : "user"
  };
}

export function fromGeminiResponse(providerId: string, model: string, payload: unknown): ModelResponse {
  if (!isRecord(payload)) {
    throw new ModelProviderError(providerId, "Gemini response was not an object");
  }

  const candidate = Array.isArray(payload.candidates) && isRecord(payload.candidates[0]) ? payload.candidates[0] : undefined;
  const content = isRecord(candidate?.content) ? candidate.content : {};
  const parts = Array.isArray(content.parts) ? content.parts : [];
  const output = parts
    .map((part) => isRecord(part) && typeof part.text === "string" ? part.text : "")
    .join("");
  const toolCalls = parts.flatMap((part, index): ModelToolCall[] => {
    if (!isRecord(part) || !isRecord(part.functionCall) || typeof part.functionCall.name !== "string") {
      return [];
    }

    return [{
      arguments: isJsonObject(part.functionCall.args) ? part.functionCall.args : {},
      id: `gemini_tool_call_${index}`,
      name: part.functionCall.name
    }];
  });

  // groundingMetadata lives on the candidate, not the top-level payload.
  const groundingMetadata = isRecord(candidate?.groundingMetadata) ? candidate.groundingMetadata : undefined;
  const groundingChunks = Array.isArray(groundingMetadata?.groundingChunks) ? groundingMetadata.groundingChunks : [];
  const citations: WebSearchCitation[] = [];
  for (const chunk of groundingChunks) {
    if (isJsonObject(chunk) && isRecord(chunk.web) && chunk.web.uri && chunk.web.title) {
      citations.push({
        url: chunk.web.uri,
        title: chunk.web.title,
        providerRaw: chunk
      });
    }
  }

  return {
    citations,
    id: typeof payload.responseId === "string" ? payload.responseId : `${providerId}-response`,
    model,
    output,
    raw: payload,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    usage: parseGeminiUsage(payload.usageMetadata)
  };
}

function parseGeminiUsage(value: unknown): ModelUsage | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  return {
    inputTokens: readFiniteNumber(value, "promptTokenCount"),
    outputTokens: readFiniteNumber(value, "candidatesTokenCount")
  };
}

export function geminiModelCapabilities(modelId: string): ModelCapabilities {
  return {
    ...defaultRemoteModelCapabilities(),
    cost: modelId.includes("flash") ? "low" : "medium",
    latencyProfile: modelId.includes("flash") ? "interactive" : "balanced",
    maxInputTokens: modelId.includes("1.5") || modelId.includes("2.") ? 1_000_000 : 128_000,
    promptCaching: true,
    reasoning: modelId.includes("pro")
  };
}
