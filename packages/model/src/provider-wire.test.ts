import { describe, expect, it } from "vitest";

import anthropicFixture from "../__fixtures__/web-search/anthropic-messages.json" with { type: "json" };
import geminiFixture from "../__fixtures__/web-search/gemini-generate-content.json" with { type: "json" };
import openaiFixture from "../__fixtures__/web-search/openai-responses.json" with { type: "json" };

import {
  fromAnthropicResponse,
  fromGeminiResponse,
  fromOpenAIResponsesResponse,
  parseOpenAIResponsesStream,
  synthesizeStreamEventsFromResponse,
  toAnthropicRequest,
  toGeminiRequest,
  toOpenAIResponsesRequest
} from "./provider-wire.js";

async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of stream) out.push(item);
  return out;
}

describe("toOpenAIResponsesRequest", () => {
  const base = {
    model: "openai/gpt-4o",
    messages: [
      { role: "user" as const, content: "hello" }
    ]
  };

  it("emits a Responses-shaped payload with model + input + tools", () => {
    const out = toOpenAIResponsesRequest(base, "gpt-4o", { enabled: false, maxUses: 5 });
    expect(out.model).toBe("gpt-4o");
    expect(Array.isArray(out.input)).toBe(true);
    expect(out.input[0]).toEqual({
      role: "user",
      content: [{ type: "input_text", text: "hello" }]
    });
    expect(out.tools ?? []).toEqual([]);
  });

  it("emits output_text for assistant turns and input_text for user/system (Responses API input shape)", () => {
    const out = toOpenAIResponsesRequest(
      {
        model: "openai/gpt-4o",
        messages: [
          { role: "system" as const, content: "be brief" },
          { role: "user" as const, content: "hi" },
          { role: "assistant" as const, content: "hello back" },
          { role: "user" as const, content: "ok" }
        ]
      },
      "gpt-4o",
      { enabled: false, maxUses: 5 }
    );
    expect(out.input.map((item: { role: string; content: Array<{ type: string }> }) => ({
      role: item.role,
      type: item.content[0]?.type
    }))).toEqual([
      { role: "system", type: "input_text" },
      { role: "user", type: "input_text" },
      { role: "assistant", type: "output_text" },
      { role: "user", type: "input_text" }
    ]);
  });

  it("injects { type:'web_search' } when policy enabled", () => {
    const out = toOpenAIResponsesRequest(base, "gpt-4o", { enabled: true, maxUses: 5 });
    expect(out.tools).toEqual([{ type: "web_search" }]);
  });

  it("emits caller-supplied function tools in the flat Responses shape alongside web_search", () => {
    const request = {
      ...base,
      tools: [{ name: "get_time", description: "", inputSchema: { type: "object" }, risk: "read" as const }]
    };
    const out = toOpenAIResponsesRequest(request, "gpt-4o", { enabled: true, maxUses: 5 });
    expect(out.tools).toEqual([
      { type: "function", name: "get_time", description: "", parameters: { type: "object" } },
      { type: "web_search" }
    ]);
  });
});

describe("fromOpenAIResponsesResponse", () => {
  it("extracts output text and citations from annotations", () => {
    const r = fromOpenAIResponsesResponse("openai", "gpt-4o", openaiFixture);
    expect(r.output).toContain("Reports today highlight");
    expect(r.citations).toHaveLength(2);
    expect(r.citations?.[0]).toMatchObject({
      url: "https://example.com/news/a",
      title: "Example News A"
    });
    expect(r.usage?.inputTokens).toBe(12);
    expect(r.usage?.outputTokens).toBe(34);
  });

  it("returns empty citations array when no annotations are present", () => {
    const payload = {
      id: "x",
      model: "gpt-4o",
      output: [{ type: "message", id: "m1", role: "assistant", content: [{ type: "output_text", text: "hi", annotations: [] }] }]
    };
    const r = fromOpenAIResponsesResponse("openai", "gpt-4o", payload);
    expect(r.citations).toEqual([]);
  });
});

describe("toAnthropicRequest web_search injection", () => {
  const base = { model: "anthropic/claude-3-5-sonnet-20241022", messages: [{ role: "user" as const, content: "x" }] };

  it("appends web_search_20250305 tool when enabled", () => {
    const out = toAnthropicRequest(base, "claude-3-5-sonnet-20241022", { enabled: true, maxUses: 3 });
    const tool = (out.tools ?? []).find((t: { type?: string }) => t.type === "web_search_20250305");
    expect(tool).toBeDefined();
    expect(tool).toMatchObject({ type: "web_search_20250305", name: "web_search", max_uses: 3 });
  });

  it("does not append when disabled", () => {
    const out = toAnthropicRequest(base, "claude-3-5-sonnet-20241022", { enabled: false, maxUses: 5 });
    expect((out.tools ?? []).some((t: { type?: string }) => t.type === "web_search_20250305")).toBe(false);
  });
});

describe("fromAnthropicResponse extracts citations", () => {
  it("parses web_search_tool_result citations and drops encrypted_content", () => {
    const r = fromAnthropicResponse("anthropic", "claude-3-5-sonnet-20241022", anthropicFixture);
    expect(r.citations).toHaveLength(2);
    expect(r.citations?.[0]).toMatchObject({ url: "https://example.com/news/a", title: "Example News A" });
    expect(JSON.stringify(r.citations?.[0]?.providerRaw)).not.toContain("OPAQUE_BLOB");
  });

  it("output text is the concatenation of text blocks", () => {
    const r = fromAnthropicResponse("anthropic", "claude-3-5-sonnet-20241022", anthropicFixture);
    expect(r.output).toContain("Reports today highlight");
  });
});

describe("parseOpenAIResponsesStream", () => {
  function asStream(lines: string[]): ReadableStream<Uint8Array> {
    const enc = new TextEncoder();
    return new ReadableStream({
      start(controller) {
        for (const line of lines) controller.enqueue(enc.encode(line));
        controller.close();
      }
    });
  }

  it("emits text-delta, tool-call-started/finished, citations, done", async () => {
    const sse = [
      "data: {\"type\":\"response.output_item.added\",\"item\":{\"type\":\"web_search_call\",\"id\":\"ws1\"}}\n\n",
      "data: {\"type\":\"response.output_text.delta\",\"delta\":\"Hello \"}\n\n",
      "data: {\"type\":\"response.output_text.delta\",\"delta\":\"world\"}\n\n",
      "data: {\"type\":\"response.output_item.done\",\"item\":{\"type\":\"web_search_call\",\"id\":\"ws1\"}}\n\n",
      "data: {\"type\":\"response.output_text.annotation.added\",\"annotation\":{\"type\":\"url_citation\",\"url\":\"https://x.test\",\"title\":\"X\"}}\n\n",
      "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"r1\",\"model\":\"gpt-4o\",\"usage\":{\"input_tokens\":1,\"output_tokens\":2,\"total_tokens\":3}}}\n\n",
      "data: [DONE]\n\n"
    ];
    const events: unknown[] = [];
    for await (const ev of parseOpenAIResponsesStream("openai", "gpt-4o", asStream(sse))) {
      events.push(ev);
    }
    const types = events.map((e) => (e as { type: string }).type);
    expect(types).toContain("tool-call-started");
    expect(types).toContain("tool-call-finished");
    expect(types).toContain("citations");
    expect(types).toContain("text-delta");
    expect(types).toContain("done");
  });
});

describe("toGeminiRequest web_search injection", () => {
  it("uses googleSearchRetrieval for gemini-1.5*", () => {
    const out = toGeminiRequest(
      { model: "gemini/gemini-1.5-flash", messages: [{ role: "user" as const, content: "x" }] },
      { enabled: true, maxUses: 5 }
    );
    expect(out.tools).toEqual(expect.arrayContaining([{ googleSearchRetrieval: {} }]));
  });

  it("uses googleSearch for gemini-2.0+", () => {
    const out = toGeminiRequest(
      { model: "gemini/gemini-2.0-flash", messages: [{ role: "user" as const, content: "x" }] },
      { enabled: true, maxUses: 5 }
    );
    expect(out.tools).toEqual(expect.arrayContaining([{ googleSearch: {} }]));
  });

  it("does not inject when disabled", () => {
    const out = toGeminiRequest(
      { model: "gemini/gemini-2.0-flash", messages: [{ role: "user" as const, content: "x" }] },
      { enabled: false, maxUses: 5 }
    );
    expect(out.tools ?? []).not.toEqual(expect.arrayContaining([{ googleSearch: {} }]));
  });

  it("skips googleSearch when caller-supplied function tools are present (Gemini API rejects the combination)", () => {
    const out = toGeminiRequest(
      {
        model: "gemini/gemini-2.0-flash",
        messages: [{ role: "user" as const, content: "x" }],
        tools: [{ name: "muse_now", description: "current time", inputSchema: { type: "object" }, risk: "read" }]
      },
      { enabled: true, maxUses: 5 }
    );
    expect(out.tools ?? []).not.toEqual(expect.arrayContaining([{ googleSearch: {} }]));
  });
});

describe("fromGeminiResponse extracts grounding citations", () => {
  it("parses groundingChunks into citations[]", () => {
    const r = fromGeminiResponse("gemini", "gemini-2.0-flash", geminiFixture);
    expect(r.citations).toHaveLength(2);
    expect(r.citations?.[0]).toMatchObject({
      url: "https://example.com/news/a",
      title: "Example News A"
    });
  });

  it("returns empty citations when groundingMetadata absent", () => {
    const r = fromGeminiResponse("gemini", "gemini-2.0-flash", {
      candidates: [{ content: { role: "model", parts: [{ text: "x" }] }, finishReason: "STOP" }]
    });
    expect(r.citations).toEqual([]);
  });
});

describe("synthesizeStreamEventsFromResponse", () => {
  it("emits text-delta then done for a plain response (no tools, no citations)", async () => {
    const events = await collect(synthesizeStreamEventsFromResponse({
      id: "r1", model: "m", output: "hi"
    }));
    expect(events.map((e) => e.type)).toEqual(["text-delta", "done"]);
  });

  it("emits tool-call events for function tool calls before done", async () => {
    const events = await collect(synthesizeStreamEventsFromResponse({
      id: "r1", model: "m", output: "hi",
      toolCalls: [{ id: "t1", name: "x", arguments: {} }]
    }));
    expect(events.map((e) => e.type)).toEqual(["text-delta", "tool-call", "done"]);
  });

  it("synthesizes tool-call-started + finished + citations when response has citations", async () => {
    const events = await collect(synthesizeStreamEventsFromResponse({
      id: "r1", model: "m", output: "hi",
      citations: [
        { url: "https://a.test", title: "A" },
        { url: "https://b.test", title: "B" }
      ]
    }));
    expect(events.map((e) => e.type)).toEqual([
      "text-delta",
      "tool-call-started",
      "tool-call-finished",
      "citations",
      "done"
    ]);
    const finished = events.find((e) => e.type === "tool-call-finished") as { count?: number } | undefined;
    expect(finished?.count).toBe(2);
  });

  it("does not emit synthetic web_search events when citations array is empty", async () => {
    const events = await collect(synthesizeStreamEventsFromResponse({
      id: "r1", model: "m", output: "hi", citations: []
    }));
    expect(events.map((e) => e.type)).toEqual(["text-delta", "done"]);
  });

  it("skips text-delta when output is empty", async () => {
    const events = await collect(synthesizeStreamEventsFromResponse({
      id: "r1", model: "m", output: ""
    }));
    expect(events.map((e) => e.type)).toEqual(["done"]);
  });
});
