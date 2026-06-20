import { afterEach, describe, expect, it, vi } from "vitest";

import { ModelProviderError, OllamaProvider, sanitizeOllamaToolSchema } from "../src/index.js";
import type { ModelEvent, ModelRequest } from "../src/index.js";

type FakeResponseInit = { ok?: boolean; status?: number; statusText?: string };

const lastBody = (): Record<string, unknown> => captured.body;
let captured: { url: string; body: Record<string, unknown> };

function jsonFetch(payload: unknown, init: FakeResponseInit = {}) {
  const { ok = true, status = 200, statusText = "OK" } = init;
  return async (url: string, reqInit: { body: string }) => {
    captured = { body: JSON.parse(reqInit.body), url };
    return {
      ok,
      status,
      statusText,
      text: async () => (typeof payload === "string" ? payload : JSON.stringify(payload))
    } as unknown as Response;
  };
}

const enc = new TextEncoder();
function streamFetch(chunks: readonly string[], init: { ok?: boolean; status?: number; hasBody?: boolean } = {}) {
  const { ok = true, status = 200, hasBody = true } = init;
  return async (url: string, reqInit: { body: string }) => {
    captured = { body: JSON.parse(reqInit.body), url };
    return {
      ok,
      status,
      statusText: "OK",
      text: async () => "stream error body",
      body: hasBody
        ? {
            getReader() {
              let i = 0;
              return {
                read: async () =>
                  i < chunks.length ? { done: false, value: enc.encode(chunks[i++]) } : { done: true, value: undefined }
              };
            }
          }
        : null
    } as unknown as Response;
  };
}

const collect = async (it: AsyncIterable<ModelEvent>): Promise<ModelEvent[]> => {
  const out: ModelEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
};

const userReq = (over: Partial<ModelRequest> = {}): ModelRequest => ({
  messages: [{ content: "hi", role: "user" }],
  model: "ollama/qwen3:8b",
  ...over
});

describe("OllamaProvider — keep_alive (model warmth) is tunable for an always-on companion", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("defaults to 30m", async () => {
    const p = new OllamaProvider({ fetch: jsonFetch({ message: { content: "ok" } }) });
    await p.generate(userReq());
    expect(lastBody().keep_alive).toBe("30m");
  });

  it("honours MUSE_OLLAMA_KEEP_ALIVE (e.g. '-1' = hold the model resident indefinitely)", async () => {
    vi.stubEnv("MUSE_OLLAMA_KEEP_ALIVE", "-1");
    const p = new OllamaProvider({ fetch: jsonFetch({ message: { content: "ok" } }) });
    await p.generate(userReq());
    expect(lastBody().keep_alive).toBe("-1");
  });
});

describe("OllamaProvider — native /api/chat request wire shape", () => {
  // Tool-protocol snapshot (CLAUDE.md "snapshot tool protocols when behavior
  // matters"): pin the EXACT native /api/chat body Muse sends Ollama for a
  // tool-using request. The local Qwen parses this wire shape, so an accidental
  // drift (a renamed field, a dropped `think:false`, a changed tools shape)
  // would silently break local tool-calling — caught here, not in production.
  it("emits the exact native request body for a tool-using request", async () => {
    const p = new OllamaProvider({ fetch: jsonFetch({ message: { content: "ok" } }) });
    await p.generate(
      userReq({
        maxOutputTokens: 50,
        messages: [{ content: "weather in Seoul?", role: "user" }],
        temperature: 0.4,
        tools: [{ description: "Get weather", inputSchema: { properties: { city: { type: "string" } }, required: ["city"], type: "object" }, name: "get_weather" }],
      }),
    );
    expect(lastBody()).toMatchInlineSnapshot(`
      {
        "keep_alive": "30m",
        "messages": [
          {
            "content": "weather in Seoul?",
            "role": "user",
          },
        ],
        "model": "qwen3:8b",
        "options": {
          "num_ctx": 32768,
          "num_predict": 50,
          "temperature": 0.4,
        },
        "stream": false,
        "think": false,
        "tools": [
          {
            "function": {
              "description": "Get weather",
              "name": "get_weather",
              "parameters": {
                "properties": {
                  "city": {
                    "type": "string",
                  },
                },
                "required": [
                  "city",
                ],
                "type": "object",
              },
            },
            "type": "function",
          },
        ],
      }
    `);
  });

  it("forwards an inline image attachment as the message's `images` (Ollama vision)", async () => {
    const p = new OllamaProvider({ fetch: jsonFetch({ message: { content: "a red square" } }) });
    await p.generate(
      userReq({
        model: "ollama/gemma4:12b",
        messages: [{
          content: "what's in this image?",
          role: "user",
          attachments: [{ mimeType: "image/png", dataBase64: "QkFTRTY0UE5H" }]
        }]
      }),
    );
    const msg = (lastBody().messages as Array<Record<string, unknown>>)[0]!;
    expect(msg.content).toBe("what's in this image?");
    expect(msg.images).toEqual(["QkFTRTY0UE5H"]); // base64, no data: prefix
  });

  it("does NOT add `images` when a message has no image attachment", async () => {
    const p = new OllamaProvider({ fetch: jsonFetch({ message: { content: "ok" } }) });
    await p.generate(userReq({ messages: [{ content: "hi", role: "user" }] }));
    const msg = (lastBody().messages as Array<Record<string, unknown>>)[0]!;
    expect("images" in msg).toBe(false);
  });

  it("targets /api/chat, strips the ollama/ model prefix, and sends think:false by default", async () => {
    const p = new OllamaProvider({ fetch: jsonFetch({ message: { content: "ok" } }) });
    await p.generate(userReq());
    expect(captured.url).toBe("http://127.0.0.1:11434/api/chat");
    expect(lastBody().model).toBe("qwen3:8b");
    expect(lastBody().think).toBe(false);
    expect(lastBody().stream).toBe(false);
  });

  it("sends think:true when native reasoning is requested", async () => {
    const p = new OllamaProvider({ fetch: jsonFetch({ message: { content: "ok" } }) });
    await p.generate(userReq({ reasoning: true }));
    expect(lastBody().think).toBe(true);
  });

  it("captures the native thinking channel into response.reasoning", async () => {
    const p = new OllamaProvider({ fetch: jsonFetch({ message: { content: "the answer", thinking: "let me think… step 1…" } }) });
    const res = await p.generate(userReq({ reasoning: true }));
    expect(res.output).toBe("the answer");
    expect(res.reasoning).toBe("let me think… step 1…");
  });

  it("defaults num_ctx to 32768 (matches localModelCapabilities maxInputTokens — a lower wire window silently truncates the prompt to done_reason:length) and omits optional fields when unset", async () => {
    const p = new OllamaProvider({ fetch: jsonFetch({ message: { content: "ok" } }) });
    await p.generate(userReq());
    expect(lastBody().options).toEqual({ num_ctx: 32768 });
    expect(lastBody()).not.toHaveProperty("format");
    expect(lastBody()).not.toHaveProperty("tools");
  });

  it("passes temperature, num_predict, format, and tools through when provided", async () => {
    const p = new OllamaProvider({ fetch: jsonFetch({ message: { content: "ok" } }) });
    await p.generate(
      userReq({
        maxOutputTokens: 50,
        responseFormat: { type: "object" },
        temperature: 0.4,
        tools: [{ description: "w", inputSchema: { type: "object" }, name: "get_weather" }]
      })
    );
    expect(lastBody().options).toEqual({ num_ctx: 32768, num_predict: 50, temperature: 0.4 });
    expect(lastBody().format).toEqual({ type: "object" });
    expect(lastBody().tools).toEqual([
      { function: { description: "w", name: "get_weather", parameters: { type: "object" } }, type: "function" }
    ]);
  });

  it("truncates a fractional numCtx and rejects a non-positive one (falls back to 32768)", async () => {
    const frac = new OllamaProvider({ fetch: jsonFetch({ message: { content: "ok" } }), numCtx: 16384.9 });
    await frac.generate(userReq());
    expect((lastBody().options as { num_ctx: number }).num_ctx).toBe(16384);

    const bad = new OllamaProvider({ fetch: jsonFetch({ message: { content: "ok" } }), numCtx: -5 });
    await bad.generate(userReq());
    expect((lastBody().options as { num_ctx: number }).num_ctx).toBe(32768);
  });

  it("maps assistant tool_calls and tool-role messages into the native shape", async () => {
    const p = new OllamaProvider({ fetch: jsonFetch({ message: { content: "ok" } }) });
    await p.generate(
      userReq({
        messages: [
          { content: "", role: "assistant", toolCalls: [{ arguments: { k: 1 }, id: "t1", name: "f" }] },
          { content: "result", role: "tool", toolCallId: "t1" }
        ]
      })
    );
    expect(lastBody().messages).toEqual([
      { content: "", role: "assistant", tool_calls: [{ function: { arguments: { k: 1 }, name: "f" }, id: "t1", type: "function" }] },
      { content: "result", role: "tool", tool_call_id: "t1" }
    ]);
  });
});

describe("OllamaProvider.generate — response parsing", () => {
  it("strips a leading <think> block and maps the model/id/usage", async () => {
    const p = new OllamaProvider({
      fetch: jsonFetch({ eval_count: 5, message: { content: "<think>reasoning</think>Hello" }, model: "qwen3:8b", prompt_eval_count: 10 })
    });
    const r = await p.generate(userReq());
    expect(r.output).toBe("Hello");
    expect(r.model).toBe("qwen3:8b");
    expect(r.id.startsWith("ollama-")).toBe(true);
    expect(r.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
  });

  it("omits usage when neither token count is present", async () => {
    const p = new OllamaProvider({ fetch: jsonFetch({ message: { content: "hi" } }) });
    expect((await p.generate(userReq())).usage).toBeUndefined();
  });

  it("falls back the model to 'unknown' when nothing supplies it", async () => {
    const p = new OllamaProvider({ fetch: jsonFetch({ message: { content: "hi" } }) });
    expect((await p.generate({ messages: [{ content: "x", role: "user" }] } as ModelRequest)).model).toBe("unknown");
  });

  it("parses tool calls — string args JSON-decoded, invalid string args -> {}, id/name fallbacks", async () => {
    const p = new OllamaProvider({
      fetch: jsonFetch({
        message: {
          content: "",
          tool_calls: [
            { function: { arguments: '{"city":"Seoul"}', name: "get_weather" }, id: "a" },
            { function: { arguments: "not json", name: "noargs" } },
            { function: { arguments: { already: "object" }, name: "obj" }, id: "c" }
          ]
        }
      })
    });
    const r = await p.generate(userReq());
    expect(r.toolCalls).toEqual([
      { arguments: { city: "Seoul" }, id: "a", name: "get_weather" },
      { arguments: {}, id: "tool-1", name: "noargs" },
      { arguments: { already: "object" }, id: "c", name: "obj" }
    ]);
  });

  it("coerces array tool args to an empty object", async () => {
    const p = new OllamaProvider({
      fetch: jsonFetch({ message: { content: "", tool_calls: [{ function: { arguments: [1, 2], name: "f" }, id: "a" }] } })
    });
    expect((await p.generate(userReq())).toolCalls?.[0]!.arguments).toEqual({});
  });

  it("leaves toolCalls undefined when the message has none", async () => {
    const p = new OllamaProvider({ fetch: jsonFetch({ message: { content: "hi" } }) });
    expect((await p.generate(userReq())).toolCalls).toBeUndefined();
  });
});

describe("OllamaProvider.generate — error handling (ModelProviderError with correct retryable)", () => {
  it("throws a non-retryable error with a pull hint on a 404 model-not-found", async () => {
    const p = new OllamaProvider({ fetch: jsonFetch("model 'foo' not found", { ok: false, status: 404, statusText: "Not Found" }) });
    await expect(p.generate(userReq({ model: "ollama/foo" }))).rejects.toMatchObject({ retryable: false });
    await expect(p.generate(userReq({ model: "ollama/foo" }))).rejects.toThrow(/ollama pull foo/);
  });

  it("throws a retryable error on a non-JSON 200 (transport anomaly)", async () => {
    const p = new OllamaProvider({ fetch: jsonFetch("<html>proxy</html>", { ok: true }) });
    await expect(p.generate(userReq())).rejects.toMatchObject({ retryable: true });
  });

  it("wraps a connection-level failure as a retryable error naming `ollama serve`", async () => {
    const p = new OllamaProvider({
      fetch: (async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch
    });
    const err = await p.generate(userReq()).catch((e) => e);
    expect(err).toBeInstanceOf(ModelProviderError);
    expect(err.retryable).toBe(true);
    expect(err.message).toMatch(/ollama serve/);
  });

  it("classifies retryability by HTTP status (429 retryable, 400 not)", async () => {
    const p429 = new OllamaProvider({ fetch: jsonFetch("rate limited", { ok: false, status: 429 }) });
    await expect(p429.generate(userReq())).rejects.toMatchObject({ retryable: true });
    const p400 = new OllamaProvider({ fetch: jsonFetch("bad request", { ok: false, status: 400 }) });
    await expect(p400.generate(userReq())).rejects.toMatchObject({ retryable: false });
  });
});

describe("OllamaProvider.stream — NDJSON event stream", () => {
  it("emits think-stripped text deltas, deduped tool-calls, and a final done with usage", async () => {
    const p = new OllamaProvider({
      fetch: streamFetch([
        JSON.stringify({ message: { content: "<think>hmm</think>Hel" } }) + "\n",
        JSON.stringify({ message: { content: "lo" } }) + "\n",
        JSON.stringify({ done: false, message: { tool_calls: [{ function: { arguments: '{"x":1}', name: "f" }, id: "a" }] } }) + "\n",
        JSON.stringify({ message: { tool_calls: [{ function: { arguments: '{"x":1}', name: "f" }, id: "a" }] } }) + "\n",
        // terminal line with NO trailing newline — exercises the flush path
        JSON.stringify({ done: true, eval_count: 3, model: "qwen3:8b", prompt_eval_count: 7 })
      ])
    });
    const ev = await collect(p.stream(userReq()));
    expect(ev.filter((e) => e.type === "text-delta").map((e) => (e as { text: string }).text)).toEqual(["Hel", "lo"]);
    const toolCalls = ev.filter((e) => e.type === "tool-call").map((e) => (e as { toolCall: unknown }).toolCall);
    expect(toolCalls).toEqual([{ arguments: { x: 1 }, id: "a", name: "f" }]);
    const done = ev.find((e) => e.type === "done") as { response: { output: string; model: string; usage: unknown; toolCalls: unknown } };
    expect(done.response.output).toBe("Hello");
    expect(done.response.model).toBe("qwen3:8b");
    expect(done.response.usage).toEqual({ inputTokens: 7, outputTokens: 3 });
    expect(done.response.toolCalls).toEqual([{ arguments: { x: 1 }, id: "a", name: "f" }]);
  });

  it("surfaces a mid-stream {error} NDJSON line as a retryable error event and stops", async () => {
    const p = new OllamaProvider({
      fetch: streamFetch([
        JSON.stringify({ message: { content: "partial" } }) + "\n",
        JSON.stringify({ error: "CUDA out of memory" }) + "\n",
        JSON.stringify({ done: true }) + "\n"
      ])
    });
    const ev = await collect(p.stream(userReq()));
    expect(ev.map((e) => e.type)).toEqual(["text-delta", "error"]);
    const err = (ev[1] as { error: ModelProviderError }).error;
    expect(err.retryable).toBe(true);
    expect(err.message).toMatch(/CUDA out of memory/);
  });

  it("yields a single error event (not a throw) on a non-ok response", async () => {
    const p = new OllamaProvider({ fetch: streamFetch([], { ok: false, status: 500 }) });
    const ev = await collect(p.stream(userReq()));
    expect(ev.map((e) => e.type)).toEqual(["error"]);
    expect((ev[0] as { error: ModelProviderError }).error.retryable).toBe(true);
  });

  it("yields an error event when the response carries no body", async () => {
    const p = new OllamaProvider({ fetch: streamFetch([], { hasBody: false, ok: true }) });
    const ev = await collect(p.stream(userReq()));
    expect(ev.map((e) => e.type)).toEqual(["error"]);
  });

  it("yields a retryable error event (not a throw) on a connection failure", async () => {
    const p = new OllamaProvider({
      fetch: (async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch
    });
    const ev = await collect(p.stream(userReq()));
    expect(ev.map((e) => e.type)).toEqual(["error"]);
    const err = (ev[0] as { error: ModelProviderError }).error;
    expect(err).toBeInstanceOf(ModelProviderError);
    expect(err.retryable).toBe(true);
  });
});

describe("logprobs plumbing (token-level confidence)", () => {
  it("generate: sends the logprobs flags and maps returned token logprobs", async () => {
    const provider = new OllamaProvider({
      defaultModel: "gemma4:12b",
      fetch: jsonFetch({
        logprobs: [{ logprob: -0.1, token: "<|channel>" }, { logprob: -0.2, token: "OK" }],
        message: { content: "OK" },
        model: "gemma4:12b"
      }) as never
    });
    const res = await provider.generate(userReq({ logprobs: true, topLogprobs: 3 }));
    expect(lastBody().logprobs).toBe(true);
    expect(lastBody().top_logprobs).toBe(3);
    expect(res.logprobs).toEqual([{ logprob: -0.1, token: "<|channel>" }, { logprob: -0.2, token: "OK" }]);
  });

  it("generate: without the flag nothing is sent and nothing is mapped", async () => {
    const provider = new OllamaProvider({
      defaultModel: "gemma4:12b",
      fetch: jsonFetch({ message: { content: "OK" }, model: "gemma4:12b" }) as never
    });
    const res = await provider.generate(userReq());
    expect(lastBody().logprobs).toBeUndefined();
    expect(res.logprobs).toBeUndefined();
  });

  it("stream: accumulates per-chunk logprobs into the done response", async () => {
    const chunks = [
      `${JSON.stringify({ logprobs: [{ logprob: -0.3, token: "Hel" }], message: { content: "Hel" }, model: "gemma4:12b" })}\n`,
      `${JSON.stringify({ done: true, logprobs: [{ logprob: -0.4, token: "lo" }], message: { content: "lo" }, model: "gemma4:12b" })}\n`
    ];
    const provider = new OllamaProvider({ defaultModel: "gemma4:12b", fetch: streamFetch(chunks) as never });
    const events = await collect(provider.stream(userReq({ logprobs: true })));
    const done = events.find((event) => event.type === "done");
    expect(done && done.type === "done" ? done.response.logprobs : undefined).toEqual([
      { logprob: -0.3, token: "Hel" },
      { logprob: -0.4, token: "lo" }
    ]);
  });
});

describe("sanitizeOllamaToolSchema — normalize JSON-Schema shapes llama.cpp's GBNF tool grammar rejects", () => {
  it("collapses a union `type` array to its non-null member", () => {
    expect(sanitizeOllamaToolSchema({ type: ["string", "null"] })).toEqual({ type: "string" });
    expect(sanitizeOllamaToolSchema({ type: ["null", "number"] })).toEqual({ type: "number" });
  });
  it("collapses a nullable anyOf/oneOf idiom to the sole non-null branch (keeping sibling description)", () => {
    expect(sanitizeOllamaToolSchema({ anyOf: [{ type: "number" }, { type: "null" }], description: "age" }))
      .toEqual({ type: "number", description: "age" });
    expect(sanitizeOllamaToolSchema({ oneOf: [{ type: "null" }, { type: "string" }] })).toEqual({ type: "string" });
  });
  it("keeps a genuine multi-branch anyOf (more than one non-null branch) but drops the null branch", () => {
    expect(sanitizeOllamaToolSchema({ anyOf: [{ type: "string" }, { type: "number" }, { type: "null" }] }))
      .toEqual({ anyOf: [{ type: "string" }, { type: "number" }] });
  });
  it("strips pure JSON-Schema metadata keywords ($schema / $id) the tool grammar ignores", () => {
    expect(sanitizeOllamaToolSchema({ $schema: "http://json-schema.org/draft-07/schema#", $id: "x", type: "object" }))
      .toEqual({ type: "object" });
  });
  it("recurses through properties + items, normalizing nested shapes", () => {
    const out = sanitizeOllamaToolSchema({
      type: "object",
      properties: {
        name: { type: ["string", "null"] },
        tags: { type: "array", items: { anyOf: [{ type: "string" }, { type: "null" }] } }
      },
      required: ["name"]
    });
    expect(out).toEqual({
      type: "object",
      properties: { name: { type: "string" }, tags: { type: "array", items: { type: "string" } } },
      required: ["name"]
    });
  });
  it("leaves a clean schema byte-equal (no gratuitous mutation)", () => {
    const clean = { type: "object", properties: { city: { type: "string" } }, required: ["city"] };
    expect(sanitizeOllamaToolSchema(clean)).toEqual(clean);
  });
  it("is wired into the native /api/chat tool projection (end-to-end, not just the pure fn)", async () => {
    const p = new OllamaProvider({ fetch: jsonFetch({ message: { content: "ok" } }) });
    await p.generate(
      userReq({
        tools: [{
          description: "set",
          inputSchema: { type: "object", properties: { when: { type: ["string", "null"] } }, required: [] },
          name: "set_reminder"
        }]
      })
    );
    const tools = lastBody().tools as Array<{ function: { parameters: unknown } }>;
    expect(tools[0]!.function.parameters).toEqual({ type: "object", properties: { when: { type: "string" } }, required: [] });
  });
});
