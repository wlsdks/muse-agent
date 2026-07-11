/**
 * Cross-provider helpers — pure parsers, JSON shape guards, and the
 * baseline capability factories. Everything here is reused by 2+ of
 * the per-provider files (anthropic / gemini / openai); provider-
 * specific wire transforms stay in their respective files.
 */

import type { JsonObject } from "@muse/shared";

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
 * A thinking-capable local model (gemma4/qwen) sometimes bleeds harmony/chat-
 * template channel markers (`<|channel|>`, `<|"|>`) into a tool-call NAME. A real
 * tool name is a clean identifier, so cut at the first such marker and strip
 * control / zero-width chars — this RECOVERS an otherwise-valid name corrupted by
 * a trailing leaked token (`run_command<|channel|>` → `run_command`, which then
 * resolves in the registry instead of failing as tool-not-found). A clean name is
 * unchanged. Shared by the Ollama native adapter and the OpenAI-compatible
 * tool-call parsers (the `/v1/chat/completions` path backs LM Studio / OpenRouter
 * / Ollama-compat, where the same local models run).
 */
export function sanitizeToolCallName(raw: string | undefined): string {
  if (typeof raw !== "string" || raw.length === 0) {
    return "unknown";
  }
  const cut = raw.split(/<\|/u)[0] ?? raw;
  let cleaned = cut.replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028\u2029\ufeff]/gu, "").trim();
  // Repair tool-NAME malformations a small local model emits (sibling of recoverToolArgsJson): surrounding
  // quotes, a trailing call-paren `evaluate()`, an echoed OpenAI-style `functions.` prefix — each
  // otherwise fails to match a registered tool and DROPS the call.
  cleaned = cleaned.replace(/^["'`](.*)["'`]$/u, "$1").replace(/\s*\([^)]*\)\s*$/u, "").replace(/^functions\./u, "").trim();
  return cleaned.length > 0 ? cleaned : "unknown";
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Attempts to locate a valid JSON object embedded in noise (e.g. model preamble,
 * markdown fences). Only LOCATES — never rewrites token contents. Returns the
 * parsed object or undefined if no recoverable object is found. Shared by the
 * Ollama native and OpenAI-compatible tool-call arg parsers so a local model
 * whose `arguments` string carries a recoverable surface defect does not have
 * ALL its tool args silently dropped.
 */
/**
 * Replace UNPAIRED UTF-16 surrogate code units with U+FFFD. A byte-level
 * local model (e.g. some quantised reasoning models) can emit a lone high
 * or low surrogate; it survives JSON.parse but corrupts the downstream
 * UTF-8 encoding (a fetch body / a provider re-send) or is rejected by the
 * next provider. Pairing-aware: a real emoji (a valid high+low pair) is
 * left untouched. Byte-identical when the text has no surrogate at all.
 */
export function sanitizeLoneSurrogates(text: string): string {
  if (!/[\uD800-\uDFFF]/.test(text)) return text;
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += text[i]! + text[i + 1]!;
        i++;
        continue;
      }
      out += "\uFFFD";
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      out += "\uFFFD";
      continue;
    }
    out += text[i];
  }
  return out;
}

/** Walk a parsed JSON value, scrubbing lone surrogates from every string key + value. */
function sanitizeSurrogatesDeep(value: unknown): unknown {
  if (typeof value === "string") return sanitizeLoneSurrogates(value);
  if (Array.isArray(value)) return value.map(sanitizeSurrogatesDeep);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[sanitizeLoneSurrogates(k)] = sanitizeSurrogatesDeep(v);
    }
    return out;
  }
  return value;
}

export function recoverToolArgsJson(raw: string): Record<string, unknown> | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;

  const fenceMatch = /```(?:json)?\s*\n([\s\S]*?)\n\s*```/.exec(trimmed);
  if (fenceMatch) {
    try {
      const parsed = JSON.parse(fenceMatch[1]!);
      if (isPlainObject(parsed)) return sanitizeSurrogatesDeep(parsed) as Record<string, unknown>;
    } catch { /* fall through */ }
  }

  const firstBrace = trimmed.indexOf("{");
  if (firstBrace === -1) return undefined;

  let depth = 0;
  let inString = false;
  let lastClose = -1;
  for (let i = firstBrace; i < trimmed.length; i++) {
    const ch = trimmed[i]!;
    if (inString) {
      if (ch === "\\" ) { i++; continue; }
      if (ch === "\"") inString = false;
    } else {
      if (ch === "\"") { inString = true; continue; }
      if (ch === "{") { depth++; continue; }
      if (ch === "}") {
        depth--;
        if (depth === 0) { lastClose = i; break; }
      }
    }
  }

  if (lastClose === -1) return undefined;

  const candidate = trimmed.slice(firstBrace, lastClose + 1);
  try {
    const parsed = JSON.parse(candidate);
    if (isPlainObject(parsed)) return sanitizeSurrogatesDeep(parsed) as Record<string, unknown>;
  } catch { /* fall through */ }

  // Last resort: repair the malformations a small local model commonly emits (trailing commas,
  // single/curly quotes, unquoted keys), then RE-PARSE — a repair that yields invalid JSON is
  // ignored, so this can only recover a real call, never produce a wrong value.
  try {
    const repaired = JSON.parse(repairLooseJson(candidate));
    if (isPlainObject(repaired)) return sanitizeSurrogatesDeep(repaired) as Record<string, unknown>;
  } catch { /* fall through */ }

  return undefined;
}

/**
 * Best-effort repair of the JSON malformations a small local model commonly emits in tool-call
 * arguments. Deterministic + applied ONLY after strict JSON.parse fails, and the caller re-parses
 * the result (so a repair producing invalid JSON is discarded — never a silent wrong value):
 *  - curly/smart quotes → straight;
 *  - an all-single-quoted object (no `"` present) → double-quoted;
 *  - trailing commas before `}` / `]`;
 *  - unquoted identifier keys (`{city:` → `{"city":`).
 */
function repairLooseJson(text: string): string {
  let s = text
    .replace(/[“”]/gu, "\"")
    .replace(/[‘’]/gu, "'");
  if (!s.includes("\"") && s.includes("'")) s = s.replace(/'/gu, "\"");
  s = s.replace(/,(\s*[}\]])/gu, "$1");
  s = s.replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/gu, "$1\"$2\":");
  return s;
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
