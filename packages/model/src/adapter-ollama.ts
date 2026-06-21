/**
 * Ollama provider adapter — extends OpenAICompatibleProvider but
 * routes `generate` / `stream` through Ollama's native `/api/chat`
 * endpoint instead of the OpenAI-compat `/v1/chat/completions`
 * shim.
 *
 * Why the override exists at all: the /v1 endpoint does NOT honour
 * `think: false`, so Qwen 3.5+ reasoning models stream out their
 * chain-of-thought before the user-facing answer (134 s first-token
 * observed on qwen3.5:2b-q4_K_M; 0.2 s when the option lands). The
 * native /api/chat path is the only way to suppress reasoning.
 *
 * `listModels` stays on /v1 (super.listModels) because the OpenAI-
 * compat shape is closer to what `OpenAICompatibleProvider.listModels`
 * expects — only the capabilities get rewritten to `localModelCapabilities`.
 */

import { truncateErrorBody } from "@muse/shared";
import type { JsonObject } from "@muse/shared";

import { isWellFormedBase64 } from "./base64-image.js";
import {
  localModelCapabilities
} from "./provider-wire.js";
import { ModelProviderError, OpenAICompatibleProvider, isRetryableHttpStatus } from "./provider-base.js";
import { createLeadingThinkStripper, parseJson, recoverToolArgsJson, sanitizeToolCallName, stripLeadingThinkBlock } from "./provider-shared.js";
import type {
  ModelEvent,
  ModelInfo,
  ModelRequest,
  ModelResponse,
  ModelToolCall,
  OllamaProviderOptions,
  TokenLogprob
} from "./index.js";

// Matches localModelCapabilities().maxInputTokens: when the wire window is
// smaller than the capability the runtime budgets against, Ollama silently
// truncates the prompt and returns done_reason:"length" with an EMPTY answer
// (observed live: an 8K window ate the whole --with-tools prompt and left
// 1 output token). Override per-install with MUSE_OLLAMA_NUM_CTX.
export const DEFAULT_OLLAMA_NUM_CTX = 32_768;

export class OllamaProvider extends OpenAICompatibleProvider {
  private readonly nativeBaseUrl: string;
  private readonly nativeFetch: typeof globalThis.fetch;
  private readonly nativeDefaultModel?: string;
  private readonly numCtx: number;
  private readonly numBatch: number | undefined;
  private readonly numPredict: number | undefined;
  private static traceSeq = 0;

  constructor(options: OllamaProviderOptions = {}) {
    const baseUrl = options.baseUrl ?? "http://127.0.0.1:11434/v1";
    super({
      ...options,
      baseUrl,
      id: options.id ?? "ollama"
    });
    this.nativeDefaultModel = options.defaultModel;
    this.nativeBaseUrl = baseUrl.replace(/\/v1\/?$/, "");
    this.nativeFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.numCtx = options.numCtx !== undefined && Number.isFinite(options.numCtx) && options.numCtx > 0
      ? Math.trunc(options.numCtx)
      : DEFAULT_OLLAMA_NUM_CTX;
    // Unset/invalid → undefined → no `num_batch` on the wire → Ollama's
    // own default (512). Only a valid positive value opts in.
    this.numBatch = options.numBatch !== undefined && Number.isFinite(options.numBatch) && options.numBatch > 0
      ? Math.trunc(options.numBatch)
      : undefined;
    // DEFAULT generation cap for requests that don't set maxOutputTokens.
    // Unset/invalid → undefined → no cap → Ollama's unbounded default (-1).
    // The main agent runtime issues generates with `maxOutputTokens:
    // defaults?.maxOutputTokens`, which autoconfigure leaves unset — so the
    // foreground `muse ask`/`chat` path is unbounded and a looping small
    // model can run away. An opt-in ceiling bounds that latency. (Most
    // background/internal callers already pass an explicit cap and so win.)
    this.numPredict = options.numPredict !== undefined && Number.isFinite(options.numPredict) && options.numPredict > 0
      ? Math.trunc(options.numPredict)
      : undefined;
  }

  override async listModels(): Promise<readonly ModelInfo[]> {
    const models = await super.listModels();
    return models.map((model) => ({
      ...model,
      capabilities: localModelCapabilities()
    }));
  }

  override async generate(request: ModelRequest): Promise<ModelResponse> {
    const body = this.buildNativeChatBody(request, false);
    const resp = await this.nativeFetchOrThrow(`${this.nativeBaseUrl}/api/chat`, {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
      method: "POST"
    });
    if (!resp.ok) {
      throw await this.buildNativeError(request, resp, "/api/chat");
    }
    const rawBody = await resp.text().catch(() => "");
    const parsed = parseJson(rawBody);
    if (parsed === undefined) {
      // A non-JSON 200 is a transport anomaly (proxy/portal HTML,
      // truncated body from a local Ollama under load) — retryable
      // ModelProviderError, not a raw SyntaxError, so the .retryable
      // contract holds.
      throw new ModelProviderError(
        this.id,
        `Ollama /api/chat response was not valid JSON: ${truncateErrorBody(rawBody) || resp.statusText}`,
        true
      );
    }
    const json = parsed as OllamaNativeChatResponse;
    return {
      id: `${this.id}-${Date.now().toString()}`,
      model: json.model ?? request.model ?? this.nativeDefaultModel ?? "unknown",
      output: stripLeadingThinkBlock(json.message?.content ?? ""),
      raw: json,
      ...(json.message?.thinking ? { reasoning: json.message.thinking } : {}),
      ...(json.message?.tool_calls && json.message.tool_calls.length > 0
        ? {
            toolCalls: json.message.tool_calls.map((tc, i) => {
              const rawArgs = typeof tc.function?.arguments === "string"
                ? safeParseToolArgs(tc.function.arguments)
                : (tc.function?.arguments ?? {});
              const args: JsonObject = (rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs))
                ? rawArgs as JsonObject
                : {};
              return {
                arguments: args,
                id: tc.id ?? `tool-${i.toString()}`,
                name: sanitizeToolCallName(tc.function?.name)
              };
            })
          }
        : {}),
      ...(json.eval_count || json.prompt_eval_count
        ? {
            usage: {
              inputTokens: json.prompt_eval_count ?? 0,
              outputTokens: json.eval_count ?? 0
            }
          }
        : {}),
      ...(json.logprobs && json.logprobs.length > 0 ? { logprobs: mapTokenLogprobs(json.logprobs) } : {})
    };
  }

  override async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    const body = this.buildNativeChatBody(request, true);
    let resp: Response;
    try {
      resp = await this.nativeFetchOrThrow(`${this.nativeBaseUrl}/api/chat`, {
        body: JSON.stringify(body),
        headers: { "content-type": "application/json" },
        method: "POST"
      });
    } catch (cause) {
      yield {
        error: cause instanceof ModelProviderError
          ? cause
          : new ModelProviderError(this.id, cause instanceof Error ? cause.message : String(cause), true),
        type: "error"
      };
      return;
    }
    if (!resp.ok || !resp.body) {
      yield {
        error: await this.buildNativeError(request, resp, "stream"),
        type: "error"
      };
      return;
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    const stripThink = createLeadingThinkStripper();
    const providerId = this.id;
    let buf = "";
    let output = "";
    let reasoning = "";
    let lastJson: OllamaNativeChatResponse | undefined;
    const collectedLogprobs: TokenLogprob[] = [];
    let streamError: ModelProviderError | undefined;
    const streamedToolCalls: ModelToolCall[] = [];
    const seenToolKeys = new Set<string>();
    let toolFallbackIndex = 0;

    const handleLine = function* (line: string): Generator<ModelEvent> {
      let parsed: OllamaNativeChatResponse;
      try {
        parsed = JSON.parse(line) as OllamaNativeChatResponse;
      } catch { return; }
      // Once Ollama has sent 200 + headers, a mid-generation failure
      // (OOM, context overflow, model eviction under load) arrives as
      // an `{"error": "..."}` NDJSON line, not an HTTP status. Without
      // this it parses to a message-less chunk and is silently dropped,
      // leaving the user a truncated answer with no error. Surface it.
      if (typeof parsed.error === "string" && parsed.error.trim().length > 0) {
        streamError = new ModelProviderError(providerId, `Ollama /api/chat stream error: ${parsed.error}`, true);
        yield { error: streamError, type: "error" };
        return;
      }
      lastJson = parsed;
      if (parsed.logprobs && parsed.logprobs.length > 0) {
        collectedLogprobs.push(...mapTokenLogprobs(parsed.logprobs));
      }
      // Native reasoning streams in a SEPARATE `thinking` channel — surface it
      // as reasoning-delta so a UI can show a live "thinking" process distinct
      // from the answer.
      const thinkingDelta = parsed.message?.thinking ?? "";
      if (thinkingDelta) {
        reasoning += thinkingDelta;
        yield { text: thinkingDelta, type: "reasoning-delta" };
      }
      const delta = parsed.message?.content ?? "";
      if (delta) {
        output += delta;
        const emit = stripThink(delta);
        if (emit.length > 0) {
          yield { text: emit, type: "text-delta" };
        }
      }
      // Ollama streams tool_calls in a chunk that may be `done:false`
      // (qwen3 does exactly this), with no tool_calls on the terminal
      // `done:true` line — so capture them from ANY chunk, deduped,
      // and carry them into the final response too.
      if (parsed.message?.tool_calls && parsed.message.tool_calls.length > 0) {
        for (const tc of parsed.message.tool_calls) {
          const rawArgs = typeof tc.function?.arguments === "string"
            ? safeParseToolArgs(tc.function.arguments)
            : (tc.function?.arguments ?? {});
          const args: JsonObject = (rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs))
            ? rawArgs as JsonObject
            : {};
          const name = sanitizeToolCallName(tc.function?.name);
          const id = tc.id ?? `tool-${(toolFallbackIndex++).toString()}`;
          const key = tc.id ?? `${name}:${JSON.stringify(args)}`;
          if (seenToolKeys.has(key)) continue;
          seenToolKeys.add(key);
          const toolCall: ModelToolCall = { arguments: args, id, name };
          streamedToolCalls.push(toolCall);
          yield { toolCall, type: "tool-call" };
        }
      }
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      for (;;) {
        const i = buf.indexOf("\n");
        if (i === -1) break;
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        yield* handleLine(line);
        if (streamError) return;
      }
    }

    // Drain the decoder and any unterminated final line. Ollama's
    // native NDJSON is not guaranteed to end with a newline, and the
    // terminal `done:true` chunk carries the token usage (and can
    // carry the last content / tool_calls) — without this flush a
    // missing trailing "\n" silently drops the whole final message.
    buf += decoder.decode();
    for (const raw of buf.split("\n")) {
      const line = raw.trim();
      if (line) yield* handleLine(line);
      if (streamError) return;
    }

    const final: ModelResponse = {
      id: `${this.id}-${Date.now().toString()}`,
      model: lastJson?.model ?? request.model ?? this.nativeDefaultModel ?? "unknown",
      output: stripLeadingThinkBlock(output),
      raw: lastJson,
      ...(reasoning ? { reasoning } : {}),
      ...(streamedToolCalls.length > 0 ? { toolCalls: streamedToolCalls } : {}),
      ...(lastJson?.eval_count || lastJson?.prompt_eval_count
        ? {
            usage: {
              inputTokens: lastJson.prompt_eval_count ?? 0,
              outputTokens: lastJson.eval_count ?? 0
            }
          }
        : {}),
      ...(collectedLogprobs.length > 0 ? { logprobs: collectedLogprobs } : {})
    };
    yield { response: final, type: "done" };
  }

  private async nativeFetchOrThrow(url: string, init: RequestInit): Promise<Response> {
    // Opt-in latency trace (MUSE_MODEL_TRACE=1): one line per chat call with a
    // sequence id + start/end + duration, so a turn's call pattern (how many,
    // sequential vs overlapping) is visible without a profiler.
    const trace = process.env.MUSE_MODEL_TRACE === "1";
    let id = 0;
    let t0 = 0;
    if (trace) {
      id = ++OllamaProvider.traceSeq;
      t0 = Date.now();
      let model = "";
      try { model = (JSON.parse(String(init.body)) as { model?: string }).model ?? ""; } catch { /* ignore */ }
      process.stderr.write(`[modeltrace] #${id.toString()} START t=${new Date(t0).toISOString()} model=${model}\n`);
    }
    try {
      const response = await this.nativeFetch(url, init);
      if (trace) process.stderr.write(`[modeltrace] #${id.toString()} END   +${(Date.now() - t0).toString()}ms\n`);
      return response;
    } catch (cause) {
      if (trace) process.stderr.write(`[modeltrace] #${id.toString()} ERR   +${(Date.now() - t0).toString()}ms\n`);
      // fetch() rejects with no HTTP status on a connection-level
      // failure — Ollama not running, restarting, or evicting a
      // cold-loaded model. Transient like a 5xx, so retryable
      // rather than a hard agent failure.
      const detail = cause instanceof Error ? cause.message : String(cause);
      throw new ModelProviderError(
        this.id,
        `Ollama request to ${this.nativeBaseUrl}/api/chat failed: ${detail} — is Ollama running? (\`ollama serve\`)`,
        true
      );
    }
  }

  private async buildNativeError(
    request: ModelRequest,
    resp: { status: number; statusText: string; text(): Promise<string> },
    label: string
  ): Promise<ModelProviderError> {
    const bodyText = (await resp.text().catch(() => "")) || resp.statusText;
    let message = `Ollama ${label} failed with ${resp.status.toString()}: ${bodyText}`;
    // Name the exact fix for the canonical first-run footgun
    // (model not pulled), mirroring the embed-model hints.
    if (resp.status === 404 && /not found/iu.test(bodyText)) {
      const model = (request.model ?? this.nativeDefaultModel ?? "").replace(/^ollama\//u, "");
      if (model.length > 0) {
        message += ` — run \`ollama pull ${model}\` (or check the model name).`;
      }
    }
    return new ModelProviderError(this.id, message, isRetryableHttpStatus(resp.status));
  }

  private buildNativeChatBody(request: ModelRequest, stream: boolean): Record<string, unknown> {
    const modelName = (request.model ?? this.nativeDefaultModel ?? "").replace(/^ollama\//, "");
    return {
      messages: request.messages.map((msg) => {
        // Multimodal: forward inline image attachments as Ollama's per-message
        // `images: [base64]` (no data: prefix) so a local vision model (gemma4)
        // can SEE them. URL-only refs / non-image types are skipped — Ollama
        // needs inline bytes. Tool messages never carry images.
        const images = msg.role === "tool"
          ? []
          : (msg.attachments ?? [])
              .filter((a) => a.mimeType.startsWith("image/") && typeof a.dataBase64 === "string" && isWellFormedBase64(a.dataBase64))
              .map((a) => a.dataBase64 as string);
        return {
          ...(msg.role === "tool"
            ? { content: msg.content, role: "tool", tool_call_id: msg.toolCallId }
            : { content: msg.content, role: msg.role }),
          ...(images.length > 0 ? { images } : {}),
          ...(msg.toolCalls && msg.toolCalls.length > 0 ? {
            tool_calls: msg.toolCalls.map((tc) => ({
              function: { arguments: tc.arguments, name: tc.name },
              id: tc.id,
              type: "function"
            }))
          } : {})
        };
      }),
      model: modelName,
      options: {
        // Ollama defaults num_ctx low (2048–4096) and silently
        // truncates anything over it — Muse's prompt (persona +
        // memory + RAG + tasks + calendar) routinely exceeds that.
        num_ctx: this.numCtx,
        ...(this.numBatch !== undefined ? { num_batch: this.numBatch } : {}),
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        // An explicit per-request maxOutputTokens always wins; otherwise the
        // opt-in provider default caps an unbounded generate; else omitted.
        ...(request.maxOutputTokens !== undefined
          ? { num_predict: request.maxOutputTokens }
          : this.numPredict !== undefined
            ? { num_predict: this.numPredict }
            : {})
      },
      stream,
      // Keep the model resident between turns so each request doesn't pay the
      // multi-second (cold: tens of seconds) reload, and so it's less likely to
      // be evicted mid-session (an eviction surfaces as a failed turn). Default
      // 30m; an ALWAYS-ON companion can hold it warm longer via
      // MUSE_OLLAMA_KEEP_ALIVE ("2h", "-1" = indefinite, "0" = unload now) —
      // trading RAM for instant responses after an idle gap. Local-first speed.
      keep_alive: process.env.MUSE_OLLAMA_KEEP_ALIVE?.trim() || "30m",
      // Native reasoning is OFF by default (fast, deterministic, reliable tool
      // calls) and opt-in per request: when `reasoning` is set, Qwen emits its
      // chain-of-thought in a SEPARATE `thinking` channel (captured below), not
      // mixed into the answer.
      think: request.reasoning ?? false,
      // Native structured output: Ollama's `format` takes a JSON Schema and
      // constrains decoding to it — guaranteed schema-valid JSON, not
      // parse-and-hope. Sent only when the caller requested it.
      ...(request.responseFormat ? { format: request.responseFormat } : {}),
      // Observational token logprobs (Ollama ≥0.30.6) — never alters decoding.
      ...(request.logprobs ? { logprobs: true, ...(request.topLogprobs ? { top_logprobs: request.topLogprobs } : {}) } : {}),
      ...(request.tools && request.tools.length > 0
        ? {
            tools: request.tools.map((t) => ({
              function: { description: t.description, name: t.name, parameters: t.inputSchema ? sanitizeOllamaToolSchema(t.inputSchema) : {} },
              type: "function"
            }))
          }
        : {})
    };
  }
}

const MAX_OLLAMA_SCHEMA_DEPTH = 64;
const OLLAMA_SCHEMA_STRIP = new Set(["$schema", "$id"]);

const isNullTypeSchema = (branch: unknown): boolean =>
  !!branch && typeof branch === "object" && !Array.isArray(branch) && (branch as Record<string, unknown>).type === "null";

/**
 * Normalize a tool input-schema into the subset llama.cpp's GBNF grammar
 * converter (the engine behind Ollama's native tool calling) accepts. Two
 * shapes break that grammar and silently drop the whole tool: a UNION `type`
 * array (`["string","null"]`) and the nullable `anyOf`/`oneOf` idiom
 * (`[{type:X},{type:null}]`). Both collapse to the plain non-null type — the
 * "optional" semantics are already carried by `required`. Pure JSON-Schema
 * metadata keywords (`$schema`/`$id`) that the grammar ignores are dropped.
 * Recursive with depth + cycle guards; a clean schema returns structurally
 * equal. This is the Ollama analog of `sanitizeGeminiSchema`.
 */
export function sanitizeOllamaToolSchema(schema: unknown): unknown {
  return sanitizeOllamaSchemaInner(schema, 0, new WeakSet<object>());
}

function sanitizeOllamaSchemaInner(schema: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (!schema || typeof schema !== "object") {
    return schema;
  }
  if (depth > MAX_OLLAMA_SCHEMA_DEPTH || seen.has(schema)) {
    return {};
  }
  seen.add(schema);

  if (Array.isArray(schema)) {
    return schema.map((entry) => sanitizeOllamaSchemaInner(entry, depth + 1, seen));
  }

  const obj = schema as Record<string, unknown>;

  // Nullable anyOf/oneOf idiom: exactly one non-null branch ⇒ collapse to it,
  // merging any sibling keywords (description, etc.); the branch wins on conflict.
  for (const unionKey of ["anyOf", "oneOf"] as const) {
    const branches = obj[unionKey];
    if (Array.isArray(branches)) {
      const nonNull = branches.filter((branch) => !isNullTypeSchema(branch));
      if (nonNull.length === 1 && nonNull[0] && typeof nonNull[0] === "object") {
        const { [unionKey]: _dropped, ...siblings } = obj;
        return sanitizeOllamaSchemaInner({ ...siblings, ...(nonNull[0] as Record<string, unknown>) }, depth, seen);
      }
    }
  }

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (OLLAMA_SCHEMA_STRIP.has(key)) {
      continue;
    }
    if (key === "type" && Array.isArray(value)) {
      const nonNull = value.filter((entry) => entry !== "null");
      result[key] = nonNull[0] ?? value[0];
      continue;
    }
    if (key === "properties" && value && typeof value === "object") {
      const nested: Record<string, unknown> = {};
      for (const [propertyKey, propertyValue] of Object.entries(value as Record<string, unknown>)) {
        nested[propertyKey] = sanitizeOllamaSchemaInner(propertyValue, depth + 1, seen);
      }
      result[key] = nested;
      continue;
    }
    if (key === "anyOf" || key === "oneOf") {
      const kept = Array.isArray(value) ? value.filter((branch) => !isNullTypeSchema(branch)) : value;
      result[key] = Array.isArray(kept)
        ? kept.map((entry) => sanitizeOllamaSchemaInner(entry, depth + 1, seen))
        : sanitizeOllamaSchemaInner(kept, depth + 1, seen);
      continue;
    }
    if (key === "items" || key === "allOf") {
      result[key] = Array.isArray(value)
        ? value.map((entry) => sanitizeOllamaSchemaInner(entry, depth + 1, seen))
        : sanitizeOllamaSchemaInner(value, depth + 1, seen);
      continue;
    }
    result[key] = value;
  }
  return result;
}

function mapTokenLogprobs(
  entries: readonly { readonly token?: string; readonly logprob?: number }[]
): TokenLogprob[] {
  return entries
    .filter((entry) => typeof entry.token === "string" && typeof entry.logprob === "number")
    .map((entry) => ({ logprob: entry.logprob as number, token: entry.token as string }));
}

interface OllamaNativeChatResponse {
  readonly model?: string;
  readonly message?: {
    readonly role?: string;
    readonly content?: string;
    readonly thinking?: string;
    readonly tool_calls?: readonly {
      readonly id?: string;
      readonly function?: { readonly name?: string; readonly arguments?: unknown };
    }[];
  };
  readonly eval_count?: number;
  readonly prompt_eval_count?: number;
  readonly done?: boolean;
  readonly error?: string;
  readonly logprobs?: readonly { readonly token?: string; readonly logprob?: number }[];
}

function safeParseToolArgs(raw: string): unknown {
  try { return JSON.parse(raw); } catch { return recoverToolArgsJson(raw) ?? {}; }
}
