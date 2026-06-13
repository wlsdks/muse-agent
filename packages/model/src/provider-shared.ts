/**
 * Cross-provider helpers — pure parsers, JSON shape guards, and the
 * baseline capability factories. Everything here is reused by 2+ of
 * the per-provider files (anthropic / gemini / openai); provider-
 * specific wire transforms stay in their respective files.
 */

import type { JsonObject, JsonValue as _JsonValue } from "@muse/shared";

import type { ModelCapabilities, ModelEvent, ModelResponse } from "./index.js";

import { isRecord } from "@muse/shared";
export { isRecord };

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

/**
 * Defense-in-depth for reasoning=false: a Qwen3-class model
 * whose upstream think-suppression switch was ignored (older
 * Ollama, an OpenAI-compatible server that drops
 * chat_template_kwargs) leaks a leading `<think>…</think>`
 * block before the real answer. Strip exactly one such leading
 * block. Anchored at the start with optional whitespace and
 * non-greedy to the FIRST `</think>`, so a legitimate `<think>`
 * later in prose/code is never touched.
 *
 * A leading `<think>` with NO closing tag is 100% leaked
 * reasoning — there is no answer after it to preserve — so it
 * returns "". Leaving it intact would dump raw chain-of-thought
 * to the user (violating reasoning=false) and disagree with the
 * streaming counterpart, which already yields "" here. A
 * *closed* block followed by a truncated answer is unaffected:
 * the regex matches the closed block and the partial answer is
 * preserved.
 */
export function stripLeadingThinkBlock(text: string): string {
  const match = /^\s*<think>[\s\S]*?<\/think>\s*/u.exec(text);
  if (match) return text.slice(match[0].length);
  if (/^\s*<think>/u.test(text)) return "";
  return text;
}

const OPEN_TAG = "<think>";
const CLOSE_TAG = "</think>";

/**
 * Streaming counterpart of `stripLeadingThinkBlock`. The
 * non-stream regex can't run on a token stream, so this is a
 * tiny state machine: feed each text delta, get back only the
 * portion safe to emit. It suppresses a single leading
 * `<think>…</think>` (handling tags split across chunk
 * boundaries) and then passes everything through verbatim —
 * a later `<think>` in prose/code is untouched, same contract
 * as the non-stream helper. Buffering is bounded (≤ tag length
 * while deciding / closing).
 */
export function createLeadingThinkStripper(): (delta: string) => string {
  let mode: "scan" | "in" | "trim" | "pass" = "scan";
  let buf = "";
  return (delta: string): string => {
    if (mode === "pass") return delta;

    // After the close tag, swallow whitespace until the first
    // real char — the close + following blank line often span
    // separate chunks, so the non-stream `\s*` can't be matched
    // in one pass.
    if (mode === "trim") {
      const trimmed = delta.replace(/^\s+/u, "");
      if (trimmed.length === 0) return "";
      mode = "pass";
      return trimmed;
    }

    buf += delta;

    if (mode === "scan") {
      const lead = buf.replace(/^\s+/u, "");
      if (lead.length === 0) return "";
      if (lead.length < OPEN_TAG.length && OPEN_TAG.startsWith(lead)) {
        return "";
      }
      if (lead.startsWith(OPEN_TAG)) {
        mode = "in";
        buf = lead.slice(OPEN_TAG.length);
      } else {
        mode = "pass";
        const out = buf;
        buf = "";
        return out;
      }
    }

    if (mode === "in") {
      const close = buf.indexOf(CLOSE_TAG);
      if (close === -1) {
        // Drop think content; keep only a tail that might be a
        // split close tag.
        buf = buf.slice(Math.max(0, buf.length - (CLOSE_TAG.length - 1)));
        return "";
      }
      const after = buf.slice(close + CLOSE_TAG.length);
      buf = "";
      const trimmed = after.replace(/^\s+/u, "");
      if (trimmed.length > 0) {
        mode = "pass";
        return trimmed;
      }
      mode = "trim";
      return "";
    }

    return "";
  };
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
