/**
 * OpenAI Responses API (`/v1/responses`) wire-format helpers — request
 * builder, response parser, and SSE stream parser. Split out of
 * provider-openai.ts because the native Responses event shape is
 * materially different from the legacy chat-completions delta stream.
 */

import {
  parseModelName,
  type ModelEvent,
  type ModelRequest,
  type ModelResponse,
  type ModelToolCall,
  type ModelUsage,
  type WebSearchCitation
} from "./index.js";
import { isRecord, sanitizeToolCallName } from "./provider-shared.js";
import { parseToolArguments } from "./provider-openai-parse.js";

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
  const obj = isRecord(payload) ? payload : {};

  let text = "";
  const citations: WebSearchCitation[] = [];
  const toolCalls: ModelToolCall[] = [];

  for (const item of Array.isArray(obj.output) ? obj.output : []) {
    if (!isRecord(item)) {
      continue;
    }

    if (item.type === "function_call") {
      // Function tool call output item: extract into ModelToolCall
      if (typeof item.name === "string" && typeof item.call_id === "string") {
        toolCalls.push({ id: item.call_id, name: sanitizeToolCallName(item.name), arguments: parseToolArguments(item.arguments) });
      }
      continue;
    }

    if (item.type !== "message") {
      continue;
    }

    for (const c of Array.isArray(item.content) ? item.content : []) {
      if (!isRecord(c)) {
        continue;
      }

      if (c.type !== "output_text") {
        continue;
      }

      if (typeof c.text === "string") {
        text += c.text;
      }

      for (const a of Array.isArray(c.annotations) ? c.annotations : []) {
        if (!isRecord(a)) {
          continue;
        }

        if (a.type === "url_citation" && typeof a.url === "string" && typeof a.title === "string") {
          citations.push({ url: a.url, title: a.title, providerRaw: a });
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
    usage: isRecord(obj.usage)
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
