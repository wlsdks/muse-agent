/**
 * Provider wire-format helpers extracted from packages/model/src/index.ts.
 *
 * Three buckets of pure transformers + supporting utilities:
 *   - OpenAI-compatible: toOpenAIChatRequest / fromOpenAIChatResponse /
 *     parseOpenAIStream + the SSE delta accumulator helpers.
 *   - Anthropic: toAnthropicRequest / toAnthropicMessage / toAnthropicTool /
 *     fromAnthropicResponse + parseAnthropicUsage.
 *   - Gemini: toGeminiRequest / sanitizeGeminiSchema / toGeminiContent /
 *     fromGeminiResponse + parseGeminiUsage.
 *
 * Also owns the `*ModelCapabilities()` factories used by the provider
 * classes and the diagnostic-provider deterministic-output helpers
 * (`estimateDiagnosticTokens` / `renderDiagnosticOutput`).
 */

import type { JsonObject } from "@muse/shared";

import {
  ModelProviderError,
  parseModelName,
  type ModelCapabilities,
  type ModelEvent,
  type ModelMessage,
  type ModelRequest,
  type ModelResponse,
  type ModelTool,
  type ModelToolCall,
  type ModelUsage
} from "./index.js";

export function toOpenAIChatRequest(request: ModelRequest, defaultModel: string | undefined) {
  return {
    max_tokens: request.maxOutputTokens,
    messages: request.messages.map(toOpenAIMessage),
    model: parseModelName(request.model || defaultModel || "").modelId,
    temperature: request.temperature,
    tools: request.tools?.map((tool) => ({
      function: {
        description: tool.description,
        name: tool.name,
        parameters: tool.inputSchema
      },
      type: "function"
    }))
  };
}

export function toAnthropicRequest(request: ModelRequest, defaultModel: string | undefined) {
  const system = request.messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n\n");

  return {
    max_tokens: request.maxOutputTokens ?? 4096,
    messages: request.messages
      .filter((message) => message.role !== "system")
      .map(toAnthropicMessage),
    model: parseModelName(request.model || defaultModel || "").modelId,
    ...(system.length > 0 ? { system } : {}),
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    ...(request.tools && request.tools.length > 0 ? { tools: request.tools.map(toAnthropicTool) } : {})
  };
}

function toAnthropicMessage(message: ModelMessage) {
  if (message.role === "tool") {
    return {
      content: [{
        content: message.content,
        tool_use_id: message.toolCallId,
        type: "tool_result"
      }],
      role: "user"
    };
  }

  if (message.role === "assistant" && message.toolCalls && message.toolCalls.length > 0) {
    return {
      content: [
        ...(message.content ? [{ text: message.content, type: "text" }] : []),
        ...message.toolCalls.map((toolCall) => ({
          id: toolCall.id,
          input: toolCall.arguments,
          name: toolCall.name,
          type: "tool_use"
        }))
      ],
      role: "assistant"
    };
  }

  return {
    content: message.content,
    role: message.role === "assistant" ? "assistant" : "user"
  };
}

function toAnthropicTool(tool: ModelTool) {
  return {
    description: tool.description,
    input_schema: tool.inputSchema,
    name: tool.name
  };
}

export function fromAnthropicResponse(providerId: string, requestedModel: string, payload: unknown): ModelResponse {
  if (!isRecord(payload)) {
    throw new ModelProviderError(providerId, "Anthropic response was not an object");
  }

  const content = Array.isArray(payload.content) ? payload.content : [];
  const output = content
    .map((part) => isRecord(part) && part.type === "text" && typeof part.text === "string" ? part.text : "")
    .join("");
  const toolCalls = content.flatMap((part, index): ModelToolCall[] => {
    if (!isRecord(part) || part.type !== "tool_use" || typeof part.name !== "string") {
      return [];
    }

    return [{
      arguments: isJsonObject(part.input) ? part.input : {},
      id: typeof part.id === "string" ? part.id : `tool_call_${index}`,
      name: part.name
    }];
  });

  return {
    id: typeof payload.id === "string" ? payload.id : `${providerId}-response`,
    model: typeof payload.model === "string" ? payload.model : requestedModel,
    output,
    raw: payload,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    usage: parseAnthropicUsage(payload.usage)
  };
}

export function toGeminiRequest(request: ModelRequest) {
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
    ...(request.tools && request.tools.length > 0
      ? {
        tools: [{
          functionDeclarations: request.tools.map((tool) => ({
            description: tool.description,
            name: tool.name,
            parameters: sanitizeGeminiSchema(tool.inputSchema)
          }))
        }]
      }
      : {}),
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
export function sanitizeGeminiSchema(schema: unknown): unknown {
  if (!schema || typeof schema !== "object") {
    return schema;
  }

  if (Array.isArray(schema)) {
    return schema.map((entry) => sanitizeGeminiSchema(entry));
  }

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
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    if (stripped.has(key)) {
      continue;
    }
    if (key === "properties" && value && typeof value === "object") {
      const nested: Record<string, unknown> = {};
      for (const [propertyKey, propertyValue] of Object.entries(value as Record<string, unknown>)) {
        nested[propertyKey] = sanitizeGeminiSchema(propertyValue);
      }
      result[key] = nested;
      continue;
    }
    if (key === "items" || key === "oneOf" || key === "anyOf" || key === "allOf") {
      result[key] = Array.isArray(value)
        ? value.map((entry) => sanitizeGeminiSchema(entry))
        : sanitizeGeminiSchema(value);
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

  return {
    id: typeof payload.responseId === "string" ? payload.responseId : `${providerId}-response`,
    model,
    output,
    raw: payload,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    usage: parseGeminiUsage(payload.usageMetadata)
  };
}

function toOpenAIMessage(message: ModelMessage) {
  if (message.role === "assistant" && message.toolCalls && message.toolCalls.length > 0) {
    return {
      content: message.content,
      role: message.role,
      tool_calls: message.toolCalls.map((toolCall) => ({
        function: {
          arguments: JSON.stringify(toolCall.arguments),
          name: toolCall.name
        },
        id: toolCall.id,
        type: "function"
      }))
    };
  }

  if (message.role === "tool") {
    return {
      content: message.content,
      role: message.role,
      tool_call_id: message.toolCallId
    };
  }

  // Vision-capable provider: user message can carry multipart
  // content with image parts. OpenAI Chat Completions accepts
  // `{ type: "image_url", image_url: { url } }` for hosted refs
  // and `{ type: "image_url", image_url: { url: "data:<mime>;base64,<b64>" } }`
  // for inline bytes. Build the multipart array only when at least
  // one attachment is present; otherwise keep the simple string
  // content shape so unaffected calls aren't rewritten.
  if (message.role === "user" && message.attachments && message.attachments.length > 0) {
    const parts: Array<Record<string, unknown>> = [];
    if (message.content && message.content.length > 0) {
      parts.push({ text: message.content, type: "text" });
    }
    for (const attachment of message.attachments) {
      const url = attachment.url
        ?? (attachment.dataBase64 ? `data:${attachment.mimeType};base64,${attachment.dataBase64}` : undefined);
      if (!url) continue;
      parts.push({ image_url: { url }, type: "image_url" });
    }
    return {
      content: parts,
      name: message.name,
      role: message.role
    };
  }

  return {
    content: message.content,
    name: message.name,
    role: message.role
  };
}

export function fromOpenAIChatResponse(providerId: string, requestedModel: string, payload: unknown): ModelResponse {
  if (!isRecord(payload)) {
    throw new ModelProviderError(providerId, "OpenAI-compatible response was not an object");
  }

  const choice = Array.isArray(payload.choices) && isRecord(payload.choices[0]) ? payload.choices[0] : undefined;
  const message = isRecord(choice?.message) ? choice.message : undefined;
  const output = readOpenAIContent(message?.content);

  return {
    id: typeof payload.id === "string" ? payload.id : `${providerId}-response`,
    model: typeof payload.model === "string" ? payload.model : requestedModel,
    output,
    raw: payload,
    toolCalls: parseOpenAIToolCalls(message?.tool_calls),
    usage: parseOpenAIUsage(payload.usage)
  };
}

export async function* parseOpenAIStream(
  providerId: string,
  requestedModel: string,
  body: ReadableStream<Uint8Array>
): AsyncIterable<ModelEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let output = "";
  let responseId = `${providerId}-stream`;
  let model = requestedModel;
  const streamedToolCalls = new Map<number, MutableOpenAIStreamToolCall>();

  while (true) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split(/\n\n/u);
    buffer = events.pop() ?? "";

    for (const event of events) {
      const data = readSseData(event);

      if (!data || data === "[DONE]") {
        continue;
      }

      const parsed = parseJson(data);

      if (!isRecord(parsed)) {
        continue;
      }

      responseId = typeof parsed.id === "string" ? parsed.id : responseId;
      model = typeof parsed.model === "string" ? parsed.model : model;

      const delta = readOpenAIStreamDelta(parsed);

      if (delta.length > 0) {
        output += delta;
        yield { text: delta, type: "text-delta" };
      }

      for (const toolCall of readOpenAIStreamToolCallDeltas(parsed)) {
        mergeOpenAIStreamToolCall(streamedToolCalls, toolCall);
      }
    }
  }

  const toolCalls = materializeOpenAIStreamToolCalls(streamedToolCalls);

  for (const toolCall of toolCalls) {
    yield { toolCall, type: "tool-call" };
  }

  yield {
    response: {
      id: responseId,
      model,
      output,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined
    },
    type: "done"
  };
}

function readSseData(event: string): string | undefined {
  const lines = event
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trim());

  return lines.length > 0 ? lines.join("\n") : undefined;
}

function readOpenAIStreamDelta(payload: Record<string, unknown>): string {
  const choice = Array.isArray(payload.choices) && isRecord(payload.choices[0]) ? payload.choices[0] : undefined;
  const delta = isRecord(choice?.delta) ? choice.delta : undefined;
  return readOpenAIContent(delta?.content);
}

interface OpenAIStreamToolCallDelta {
  readonly index: number;
  readonly id?: string;
  readonly name?: string;
  readonly argumentsChunk?: string;
}

interface MutableOpenAIStreamToolCall {
  id?: string;
  name?: string;
  argumentsText: string;
}

function readOpenAIStreamToolCallDeltas(payload: Record<string, unknown>): readonly OpenAIStreamToolCallDelta[] {
  const choice = Array.isArray(payload.choices) && isRecord(payload.choices[0]) ? payload.choices[0] : undefined;
  const delta = isRecord(choice?.delta) ? choice.delta : undefined;
  const toolCalls = Array.isArray(delta?.tool_calls) ? delta.tool_calls : [];

  return toolCalls.flatMap((entry, fallbackIndex) => {
    if (!isRecord(entry)) {
      return [];
    }

    const fn = isRecord(entry.function) ? entry.function : {};
    return [{
      argumentsChunk: typeof fn.arguments === "string" ? fn.arguments : undefined,
      id: typeof entry.id === "string" ? entry.id : undefined,
      index: typeof entry.index === "number" ? entry.index : fallbackIndex,
      name: typeof fn.name === "string" ? fn.name : undefined
    }];
  });
}

function mergeOpenAIStreamToolCall(
  target: Map<number, MutableOpenAIStreamToolCall>,
  delta: OpenAIStreamToolCallDelta
): void {
  const current = target.get(delta.index) ?? { argumentsText: "" };

  target.set(delta.index, {
    argumentsText: current.argumentsText + (delta.argumentsChunk ?? ""),
    id: delta.id ?? current.id,
    name: delta.name ?? current.name
  });
}

function materializeOpenAIStreamToolCalls(
  source: ReadonlyMap<number, MutableOpenAIStreamToolCall>
): readonly ModelToolCall[] {
  return [...source.entries()]
    .sort(([left], [right]) => left - right)
    .flatMap(([index, value]) => {
      if (!value.name) {
        return [];
      }

      return [{
        arguments: parseToolArguments(value.argumentsText),
        id: value.id ?? `tool_call_${index}`,
        name: value.name
      }];
    });
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function readOpenAIContent(value: unknown): string {
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

function parseOpenAIToolCalls(value: unknown): readonly ModelToolCall[] | undefined {
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

function parseToolArguments(value: unknown): JsonObject {
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

function parseOpenAIUsage(value: unknown): ModelUsage | undefined {
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

function parseAnthropicUsage(value: unknown): ModelUsage | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  return {
    cachedInputTokens: readFiniteNumber(value, "cache_read_input_tokens"),
    inputTokens: readFiniteNumber(value, "input_tokens"),
    outputTokens: readFiniteNumber(value, "output_tokens")
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

function readFiniteNumber(value: unknown, key: string): number | undefined {
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

export function diagnosticModelCapabilities(): ModelCapabilities {
  return {
    ...localModelCapabilities(),
    maxInputTokens: 32_000,
    maxOutputTokens: 4_096,
    structuredOutput: true,
    toolCalling: false
  };
}

export function estimateDiagnosticTokens(content: string): number {
  return Math.max(1, Math.ceil(content.length / 4));
}

/**
 * Shapes the diagnostic provider's deterministic output. The default behavior
 * is "Diagnostic response: <user prompt>", but a structural mode hint in the
 * system messages lets smoke tests exercise plan-execute without a real LLM:
 *
 *   - planning prompts (built by `buildPlanningSystemPrompt`) → emit a JSON
 *     plan. If `time_now` is listed in `[Available Tools]` the diagnostic
 *     emits a one-step plan calling it (so the smoke can assert the
 *     plan_step_executing + plan_step_result events); otherwise it emits an
 *     empty plan that falls through to the direct-answer synthesis path.
 *
 * Anything else falls through to the legacy "Diagnostic response: …" shape.
 */
export function renderDiagnosticOutput(messages: readonly { readonly role: string; readonly content: string }[], userPrompt: string): string {
  const systemPrompt = messages.find((message) => message.role === "system")?.content ?? "";
  if (isDiagnosticPlanningPrompt(systemPrompt)) {
    if (planningPromptListsTool(systemPrompt, "time_now")) {
      return JSON.stringify([
        { args: {}, description: "Diagnostic plan-execute step (time_now)", tool: "time_now" }
      ]);
    }
    return "[]";
  }
  return `Diagnostic response: ${userPrompt}`.trimEnd();
}

function isDiagnosticPlanningPrompt(systemPrompt: string): boolean {
  return systemPrompt.includes("[Role]")
    && systemPrompt.includes("[Output Format]")
    && systemPrompt.includes("[Available Tools]");
}

function planningPromptListsTool(systemPrompt: string, toolName: string): boolean {
  // Tools are rendered by renderToolDescriptionsForPlanning as `- <name>: <description>`.
  return new RegExp(`(^|\\n)\\s*-\\s*${escapeRegex(toolName)}\\s*:`, "u").test(systemPrompt);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

export function anthropicModelCapabilities(modelId: string): ModelCapabilities {
  return {
    ...defaultRemoteModelCapabilities(),
    cost: "medium",
    latencyProfile: "balanced",
    maxInputTokens: 200_000,
    promptCaching: true,
    reasoning: modelId.includes("opus") || modelId.includes("sonnet"),
    structuredOutput: false
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isJsonObject(value: unknown): value is JsonObject {
  if (!isRecord(value)) {
    return false;
  }

  return Object.values(value).every(isJsonValue);
}

function isJsonValue(value: unknown): boolean {
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
