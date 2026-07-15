/**
 * Anthropic wire-format helpers — request/response/usage transformers
 * and the per-model capability factory.
 *
 * Pure functions: no network, no SDK. The Anthropic provider adapter
 * elsewhere uses these to build the HTTP body and parse the response.
 */

import {
  ModelProviderError,
  parseModelName,
  type ModelCapabilities,
  type ModelMessage,
  type ModelRequest,
  type ModelResponse,
  type ModelTool,
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

export function toAnthropicRequest(
  request: ModelRequest,
  defaultModel: string | undefined,
  policy: { enabled: boolean; maxUses: number } = { enabled: false, maxUses: 5 }
) {
  const system = request.messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n\n");

  const tools: Array<Record<string, unknown>> = request.tools && request.tools.length > 0
    ? request.tools.map(toAnthropicTool)
    : [];

  if (policy.enabled) {
    tools.push({ type: "web_search_20250305", name: "web_search", max_uses: policy.maxUses });
  }

  return {
    max_tokens: request.maxOutputTokens ?? 4096,
    messages: request.messages
      .filter((message) => message.role !== "system")
      .map(toAnthropicMessage),
    model: parseModelName(request.model || defaultModel || "").modelId,
    ...(system.length > 0 ? { system } : {}),
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    ...(tools.length > 0 ? { tools } : {})
  };
}

export function toAnthropicMessage(message: ModelMessage) {
  // Vision: serialize user-message image attachments into Anthropic image
  // blocks (base64 source, or a url source). Without this branch the
  // attachments are silently dropped (the reason vision was declared false).
  if (message.role === "user" && message.attachments && message.attachments.length > 0) {
    const content: Array<Record<string, unknown>> = [];
    if (message.content && message.content.length > 0) {
      content.push({ text: message.content, type: "text" });
    }
    for (const attachment of message.attachments) {
      if (attachment.dataBase64) {
        content.push({ source: { data: attachment.dataBase64, media_type: attachment.mimeType, type: "base64" }, type: "image" });
      } else if (attachment.url) {
        content.push({ source: { type: "url", url: attachment.url }, type: "image" });
      }
    }
    return { content, role: "user" };
  }

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

  const seenUrls = new Set<string>();
  const citations: WebSearchCitation[] = [];

  for (const block of content) {
    if (!isRecord(block)) continue;

    // web_search_tool_result blocks contain the actual search results
    if (block.type === "web_search_tool_result" && Array.isArray(block.content)) {
      for (const result of block.content) {
        if (!isRecord(result) || result.type !== "web_search_result") continue;
        const url = typeof result.url === "string" ? result.url : undefined;
        const title = typeof result.title === "string" ? result.title : "";
        if (!url || seenUrls.has(url)) continue;
        seenUrls.add(url);
        citations.push({ url, title, providerRaw: stripEncryptedContent(result) });
      }
    }

    // text blocks may carry inline citation references
    if (block.type === "text" && Array.isArray(block.citations)) {
      for (const cite of block.citations) {
        if (!isRecord(cite) || cite.type !== "web_search_result_location") continue;
        const url = typeof cite.url === "string" ? cite.url : undefined;
        const title = typeof cite.title === "string" ? cite.title : "";
        if (!url || seenUrls.has(url)) continue;
        seenUrls.add(url);
        citations.push({ url, title, providerRaw: cite });
      }
    }
  }

  return {
    citations,
    id: typeof payload.id === "string" ? payload.id : `${providerId}-response`,
    model: typeof payload.model === "string" ? payload.model : requestedModel,
    output,
    raw: payload,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    usage: parseAnthropicUsage(payload.usage)
  };
}

function stripEncryptedContent(r: unknown): Record<string, unknown> {
  if (!isRecord(r)) {
    return {};
  }
  const { encrypted_content: _encrypted, ...rest } = r;
  return rest;
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

export function anthropicModelCapabilities(modelId: string): ModelCapabilities {
  return {
    ...defaultRemoteModelCapabilities(),
    cost: "medium",
    latencyProfile: "balanced",
    maxInputTokens: 200_000,
    promptCaching: true,
    reasoning: modelId.includes("opus") || modelId.includes("sonnet"),
    structuredOutput: false
    // vision: inherited true from defaultRemoteModelCapabilities — now
    // honoured, since toAnthropicMessage serializes image attachments into
    // Anthropic image blocks (base64 / url source).
  };
}
