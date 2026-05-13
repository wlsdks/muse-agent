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

import type { JsonObject } from "@muse/shared";

import {
  localModelCapabilities
} from "./provider-wire.js";
import { ModelProviderError, OpenAICompatibleProvider } from "./provider-base.js";
import type {
  ModelEvent,
  ModelInfo,
  ModelRequest,
  ModelResponse,
  OllamaProviderOptions
} from "./index.js";

export class OllamaProvider extends OpenAICompatibleProvider {
  private readonly nativeBaseUrl: string;
  private readonly nativeFetch: typeof globalThis.fetch;
  private readonly nativeDefaultModel?: string;

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
    const resp = await this.nativeFetch(`${this.nativeBaseUrl}/api/chat`, {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
      method: "POST"
    });
    if (!resp.ok) {
      throw new ModelProviderError(
        this.id,
        `Ollama /api/chat failed with ${resp.status.toString()}: ${(await resp.text().catch(() => "")) || resp.statusText}`,
        resp.status >= 500
      );
    }
    const json = await resp.json() as OllamaNativeChatResponse;
    return {
      id: `${this.id}-${Date.now().toString()}`,
      model: json.model ?? request.model ?? this.nativeDefaultModel ?? "unknown",
      output: json.message?.content ?? "",
      raw: json,
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
                name: tc.function?.name ?? "unknown"
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
        : {})
    };
  }

  override async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    const body = this.buildNativeChatBody(request, true);
    const resp = await this.nativeFetch(`${this.nativeBaseUrl}/api/chat`, {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
      method: "POST"
    });
    if (!resp.ok || !resp.body) {
      yield {
        error: new ModelProviderError(
          this.id,
          `Ollama stream failed with ${resp.status.toString()}: ${(await resp.text().catch(() => "")) || resp.statusText}`,
          resp.status >= 500
        ),
        type: "error"
      };
      return;
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let output = "";
    let lastJson: OllamaNativeChatResponse | undefined;
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
        let parsed: OllamaNativeChatResponse;
        try {
          parsed = JSON.parse(line) as OllamaNativeChatResponse;
        } catch { continue; }
        lastJson = parsed;
        const delta = parsed.message?.content ?? "";
        if (delta) {
          output += delta;
          yield { text: delta, type: "text-delta" };
        }
        // Tool calls usually arrive in the terminal NDJSON line (done:true).
        // Emit them as tool-call events so the agent runtime treats them
        // the same way it does for OpenAI-compat / Anthropic.
        if (parsed.done && parsed.message?.tool_calls && parsed.message.tool_calls.length > 0) {
          for (let i = 0; i < parsed.message.tool_calls.length; i += 1) {
            const tc = parsed.message.tool_calls[i]!;
            const rawArgs = typeof tc.function?.arguments === "string"
              ? safeParseToolArgs(tc.function.arguments)
              : (tc.function?.arguments ?? {});
            const args: JsonObject = (rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs))
              ? rawArgs as JsonObject
              : {};
            yield {
              toolCall: {
                arguments: args,
                id: tc.id ?? `tool-${i.toString()}`,
                name: tc.function?.name ?? "unknown"
              },
              type: "tool-call"
            };
          }
        }
      }
    }

    const final: ModelResponse = {
      id: `${this.id}-${Date.now().toString()}`,
      model: lastJson?.model ?? request.model ?? this.nativeDefaultModel ?? "unknown",
      output,
      raw: lastJson,
      ...(lastJson?.message?.tool_calls && lastJson.message.tool_calls.length > 0
        ? {
            toolCalls: lastJson.message.tool_calls.map((tc, i) => {
              const rawArgs = typeof tc.function?.arguments === "string"
                ? safeParseToolArgs(tc.function.arguments)
                : (tc.function?.arguments ?? {});
              const args: JsonObject = (rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs))
                ? rawArgs as JsonObject
                : {};
              return {
                arguments: args,
                id: tc.id ?? `tool-${i.toString()}`,
                name: tc.function?.name ?? "unknown"
              };
            })
          }
        : {}),
      ...(lastJson?.eval_count || lastJson?.prompt_eval_count
        ? {
            usage: {
              inputTokens: lastJson.prompt_eval_count ?? 0,
              outputTokens: lastJson.eval_count ?? 0
            }
          }
        : {})
    };
    yield { response: final, type: "done" };
  }

  private buildNativeChatBody(request: ModelRequest, stream: boolean): Record<string, unknown> {
    const modelName = (request.model ?? this.nativeDefaultModel ?? "").replace(/^ollama\//, "");
    return {
      messages: request.messages.map((msg) => ({
        ...(msg.role === "tool"
          ? { content: msg.content, role: "tool", tool_call_id: msg.toolCallId }
          : { content: msg.content, role: msg.role }),
        ...(msg.toolCalls && msg.toolCalls.length > 0 ? {
          tool_calls: msg.toolCalls.map((tc) => ({
            function: { arguments: tc.arguments, name: tc.name },
            id: tc.id,
            type: "function"
          }))
        } : {})
      })),
      model: modelName,
      options: {
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        ...(request.maxOutputTokens !== undefined ? { num_predict: request.maxOutputTokens } : {})
      },
      stream,
      // The point of this whole override: kill the chain-of-thought
      // emission for Qwen 3.5+ thinking models. Non-thinking models
      // ignore the field; cost is zero.
      think: false,
      ...(request.tools && request.tools.length > 0
        ? {
            tools: request.tools.map((t) => ({
              function: { description: t.description, name: t.name, parameters: t.inputSchema ?? {} },
              type: "function"
            }))
          }
        : {})
    };
  }
}

interface OllamaNativeChatResponse {
  readonly model?: string;
  readonly message?: {
    readonly role?: string;
    readonly content?: string;
    readonly tool_calls?: readonly {
      readonly id?: string;
      readonly function?: { readonly name?: string; readonly arguments?: unknown };
    }[];
  };
  readonly eval_count?: number;
  readonly prompt_eval_count?: number;
  readonly done?: boolean;
}

function safeParseToolArgs(raw: string): unknown {
  try { return JSON.parse(raw); } catch { return {}; }
}
