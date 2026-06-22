/**
 * OpenAI wire-format helpers — chat-completions request/response, the
 * `/v1/responses` API (request / response / SSE stream), the
 * chat-completions SSE stream, and OpenAI-flavoured tool-call /
 * content / usage parsing.
 *
 * The native Responses API stream is materially different from the
 * legacy chat-completions delta stream, so both parsers live here
 * side-by-side and share the small set of OpenAI-internal helpers
 * (delta accumulator, content reader, tool-call merger).
 */


import {
  ModelProviderError,
  parseModelName,
  type ModelEvent,
  type ModelMessage,
  type ModelRequest,
  type ModelResponse,
  type ModelToolCall,
  type ModelUsage,
  type WebSearchCitation
} from "./index.js";
import {
  createLeadingThinkStripper,
  isRecord,
  parseJson,
  sanitizeToolCallName,
  stripLeadingThinkBlock
} from "./provider-shared.js";
import { parseOpenAIToolCalls, parseOpenAIUsage, parseToolArguments, readOpenAIContent } from "./provider-openai-parse.js";

export function toOpenAIChatRequest(request: ModelRequest, defaultModel: string | undefined) {
  const modelId = parseModelName(request.model || defaultModel || "").modelId;
  return {
    max_tokens: request.maxOutputTokens,
    messages: request.messages.map(toOpenAIMessage),
    model: modelId,
    temperature: request.temperature,
    tools: request.tools?.map((tool) => ({
      function: {
        description: tool.description,
        name: tool.name,
        parameters: tool.inputSchema
      },
      type: "function"
    })),
    // Qwen3 emits chain-of-thought by default. The native Ollama
    // path kills it with `think:false`; on OpenAI-compatible
    // backends (vLLM / SGLang / LM Studio / OpenRouter) the
    // portable switch is the chat-template kwarg. Gated to qwen3
    // model ids so a strict server (real OpenAI/Azure) never sees
    // an unknown body key for non-Qwen models.
    ...(/qwen3/iu.test(modelId)
      ? { chat_template_kwargs: { enable_thinking: false } }
      : {})
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
  const output = stripLeadingThinkBlock(readOpenAIContent(message?.content));

  return {
    id: typeof payload.id === "string" ? payload.id : `${providerId}-response`,
    model: typeof payload.model === "string" ? payload.model : requestedModel,
    output,
    raw: payload,
    toolCalls: parseOpenAIToolCalls(message?.tool_calls),
    usage: parseOpenAIUsage(payload.usage)
  };
}

export function toOpenAIResponsesRequest(
  request: ModelRequest,
  defaultModel: string | undefined,
  policy: { enabled: boolean; maxUses: number }
) {
  const tools: Array<Record<string, unknown>> = [];

  for (const tool of request.tools ?? []) {
    tools.push({
      type: "function",
      name: tool.name,
      description: tool.description ?? "",
      parameters: tool.inputSchema
    });
  }

  if (policy.enabled) {
    tools.push({ type: "web_search" });
  }

  return {
    input: request.messages.map((m) => ({
      role: m.role,
      content: [{
        type: m.role === "assistant" ? "output_text" : "input_text",
        text: typeof m.content === "string" ? m.content : ""
      }]
    })),
    max_output_tokens: request.maxOutputTokens,
    model: parseModelName(request.model || defaultModel || "").modelId,
    temperature: request.temperature,
    tools
  };
}

export function fromOpenAIResponsesResponse(
  _providerId: string,
  requestedModel: string,
  payload: unknown
): ModelResponse {
  const obj = (payload ?? {}) as {
    id?: string;
    model?: string;
    output?: unknown[];
    usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number };
  };

  let text = "";
  const citations: WebSearchCitation[] = [];
  const toolCalls: ModelToolCall[] = [];

  for (const item of obj.output ?? []) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const it = item as { type?: string; content?: unknown[]; call_id?: string; name?: string; arguments?: string };

    if (it.type === "function_call") {
      // Function tool call output item: extract into ModelToolCall
      if (typeof it.name === "string" && typeof it.call_id === "string") {
        toolCalls.push({ id: it.call_id, name: sanitizeToolCallName(it.name), arguments: parseToolArguments(it.arguments) });
      }
      continue;
    }

    if (it.type !== "message") {
      continue;
    }

    for (const c of it.content ?? []) {
      if (!c || typeof c !== "object") {
        continue;
      }

      const block = c as { type?: string; text?: string; annotations?: unknown[] };

      if (block.type !== "output_text") {
        continue;
      }

      if (typeof block.text === "string") {
        text += block.text;
      }

      for (const a of block.annotations ?? []) {
        if (!a || typeof a !== "object") {
          continue;
        }

        const ann = a as { type?: string; url?: string; title?: string };

        if (ann.type === "url_citation" && typeof ann.url === "string" && typeof ann.title === "string") {
          citations.push({ url: ann.url, title: ann.title, providerRaw: a });
        }
      }
    }
  }

  return {
    citations,
    id: typeof obj.id === "string" ? obj.id : "",
    model: typeof obj.model === "string" ? obj.model : requestedModel,
    output: text,
    raw: payload,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    usage: obj.usage
      ? {
          inputTokens: typeof obj.usage.input_tokens === "number" ? obj.usage.input_tokens : 0,
          outputTokens: typeof obj.usage.output_tokens === "number" ? obj.usage.output_tokens : 0
        }
      : undefined
  };
}

export async function* parseOpenAIResponsesStream(
  _providerId: string,
  requestedModel: string,
  body: ReadableStream<Uint8Array>
): AsyncGenerator<ModelEvent> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let toolStarted = false;
  let textBuf = "";
  const citations: WebSearchCitation[] = [];
  const toolCalls: ModelToolCall[] = [];
  let finalUsage: ModelUsage | undefined;
  let finalId = "";
  let finalModel = requestedModel;

  async function* handleChunk(chunk: string): AsyncGenerator<ModelEvent> {
    const dataLine = chunk.split("\n").find((l) => l.startsWith("data:"))?.slice(5).trim();
    if (!dataLine || dataLine === "[DONE]") return;
    let evt: {
      type?: string;
      item?: { type?: string; call_id?: string; name?: string; arguments?: string };
      delta?: string;
      annotation?: { type?: string; url?: string; title?: string };
      response?: {
        id?: string;
        model?: string;
        usage?: { input_tokens?: number; output_tokens?: number };
      };
    };
    try { evt = JSON.parse(dataLine); } catch { return; }
    if (evt.type === "response.output_item.added" && evt.item?.type === "web_search_call" && !toolStarted) {
      toolStarted = true;
      yield { type: "tool-call-started", name: "web_search" };
    } else if (evt.type === "response.output_item.done" && evt.item?.type === "web_search_call") {
      yield { type: "tool-call-finished", name: "web_search" };
    } else if (evt.type === "response.output_item.done" && evt.item?.type === "function_call") {
      // Completed function tool call — emit the full tool-call event once arguments are finalised
      const item = evt.item;
      if (typeof item.name === "string" && typeof item.call_id === "string") {
        const toolCall: ModelToolCall = {
          id: item.call_id,
          name: sanitizeToolCallName(item.name),
          arguments: parseToolArguments(item.arguments)
        };
        toolCalls.push(toolCall);
        yield { type: "tool-call", toolCall };
      }
    } else if (evt.type === "response.output_text.delta" && typeof evt.delta === "string") {
      textBuf += evt.delta;
      yield { type: "text-delta", text: evt.delta };
    } else if (evt.type === "response.output_text.annotation.added" && evt.annotation?.type === "url_citation") {
      const a = evt.annotation;
      if (typeof a.url === "string" && typeof a.title === "string") {
        citations.push({ url: a.url, title: a.title, providerRaw: a });
      }
    } else if (evt.type === "response.completed" && evt.response) {
      finalId = evt.response.id ?? "";
      finalModel = evt.response.model ?? requestedModel;
      if (evt.response.usage) {
        finalUsage = {
          inputTokens: evt.response.usage.input_tokens ?? 0,
          outputTokens: evt.response.usage.output_tokens ?? 0
        };
      }
    }
  }

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, nl);
      buf = buf.slice(nl + 2);
      yield* handleChunk(chunk);
    }
  }

  // A compliant server ends each event with `\n\n`, but an OpenAI-compatible
  // backend may close right after the final event. Flush the decoder and
  // process the trailing buffer so the last delta / tool-call isn't dropped.
  buf += dec.decode();
  if (buf.length > 0) yield* handleChunk(buf);

  if (citations.length > 0) yield { type: "citations", items: citations };
  yield {
    type: "done",
    response: {
      citations,
      id: finalId,
      model: finalModel,
      output: textBuf,
      raw: undefined,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage: finalUsage
    }
  };
}

export async function* parseOpenAIStream(
  providerId: string,
  requestedModel: string,
  body: ReadableStream<Uint8Array>
): AsyncIterable<ModelEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const stripThink = createLeadingThinkStripper();
  let buffer = "";
  let output = "";
  let responseId = `${providerId}-stream`;
  let model = requestedModel;
  const streamedToolCalls = new Map<number, MutableOpenAIStreamToolCall>();
  let errored = false;

  async function* handleEvent(event: string): AsyncGenerator<ModelEvent> {
    const data = readSseData(event);

    if (!data || data === "[DONE]") {
      return;
    }

    const parsed = parseJson(data);

    if (!isRecord(parsed)) {
      return;
    }

    // A streaming error chunk (`{"error": {...}}`) emitted after the
    // 200 — OpenRouter / vLLM / OpenAI surface mid-generation failures
    // this way — would otherwise be read as a delta-less chunk and
    // silently dropped, ending the stream with a truncated/empty
    // answer and no error. Surface it and stop (mirrors the native
    // Ollama stream's mid-stream error handling).
    const streamError = readOpenAIStreamError(parsed);
    if (streamError !== undefined) {
      yield { error: new ModelProviderError(providerId, streamError, true), type: "error" };
      errored = true;
      return;
    }

    responseId = typeof parsed.id === "string" ? parsed.id : responseId;
    model = typeof parsed.model === "string" ? parsed.model : model;

    const delta = readOpenAIStreamDelta(parsed);

    if (delta.length > 0) {
      output += delta;
      const emit = stripThink(delta);
      if (emit.length > 0) {
        yield { text: emit, type: "text-delta" };
      }
    }

    for (const toolCall of readOpenAIStreamToolCallDeltas(parsed)) {
      mergeOpenAIStreamToolCall(streamedToolCalls, toolCall);
    }
  }

  while (true) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split(/\n\n/u);
    buffer = events.pop() ?? "";

    for (const event of events) {
      yield* handleEvent(event);
      if (errored) return;
    }
  }

  // A compliant server ends with `[DONE]\n\n`, but OpenAI-compatible local
  // backends (LM Studio, llama.cpp, …) may close the stream right after the
  // last event with no trailing blank line. Flush the decoder and process
  // the remaining buffer so that final delta / tool-call isn't dropped.
  buffer += decoder.decode();
  if (buffer.length > 0) {
    yield* handleEvent(buffer);
    if (errored) return;
  }

  const toolCalls = materializeOpenAIStreamToolCalls(streamedToolCalls);

  for (const toolCall of toolCalls) {
    yield { toolCall, type: "tool-call" };
  }

  yield {
    response: {
      id: responseId,
      model,
      output: stripLeadingThinkBlock(output),
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined
    },
    type: "done"
  };
}

function readOpenAIStreamError(payload: Record<string, unknown>): string | undefined {
  const err = payload.error;
  if (typeof err === "string") {
    return err.trim().length > 0 ? `OpenAI-compatible stream error: ${err.trim()}` : undefined;
  }
  if (isRecord(err)) {
    const message = typeof err.message === "string" && err.message.trim().length > 0
      ? err.message.trim()
      : JSON.stringify(err);
    return `OpenAI-compatible stream error: ${message}`;
  }
  return undefined;
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
        name: sanitizeToolCallName(value.name)
      }];
    });
}
