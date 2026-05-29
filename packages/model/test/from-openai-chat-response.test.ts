import { describe, expect, it } from "vitest";

import { fromOpenAIChatResponse } from "../src/provider-openai.js";

const parse = (payload: unknown) => fromOpenAIChatResponse("ollama", "requested-model", payload);
const withMessage = (message: unknown, extra: Record<string, unknown> = {}) => ({
  id: "resp-1",
  model: "qwen3:8b",
  choices: [{ message }],
  ...extra,
});

describe("fromOpenAIChatResponse", () => {
  it("throws a ModelProviderError when the payload is not an object", () => {
    expect(() => parse("nope")).toThrow(/not an object/);
    expect(() => parse(null)).toThrow(/not an object/);
  });

  it("extracts plain string content", () => {
    expect(parse(withMessage({ role: "assistant", content: "Hello world" })).output).toBe("Hello world");
  });

  it("strips a leading <think> reasoning block (qwen)", () => {
    expect(parse(withMessage({ role: "assistant", content: "<think>reasoning</think>Final answer" })).output).toBe(
      "Final answer",
    );
  });

  it("joins an array content (multimodal text parts)", () => {
    expect(
      parse(withMessage({ role: "assistant", content: [{ type: "text", text: "part A" }, { type: "text", text: " part B" }] })).output,
    ).toBe("part A part B");
  });

  it("treats null / missing content / missing message as empty output", () => {
    expect(parse(withMessage({ role: "assistant", content: null })).output).toBe("");
    expect(parse(withMessage(undefined)).output).toBe("");
    expect(parse({ id: "x", model: "m", choices: [] }).output).toBe("");
  });

  it("parses tool calls, JSON-decoding their arguments and ordering them", () => {
    const result = parse(
      withMessage({
        role: "assistant",
        content: "",
        tool_calls: [
          { id: "a", type: "function", function: { name: "f1", arguments: "{}" } },
          { id: "b", type: "function", function: { name: "f2", arguments: '{"k":2}' } },
        ],
      }),
    );
    expect(result.toolCalls).toEqual([
      { id: "a", name: "f1", arguments: {} },
      { id: "b", name: "f2", arguments: { k: 2 } },
    ]);
  });

  it("falls back to empty arguments when a tool call's arguments are not valid JSON", () => {
    const result = parse(
      withMessage({ role: "assistant", content: "", tool_calls: [{ id: "t", type: "function", function: { name: "f", arguments: "not json" } }] }),
    );
    expect(result.toolCalls).toEqual([{ id: "t", name: "f", arguments: {} }]);
  });

  it("leaves toolCalls undefined when the message has none", () => {
    expect(parse(withMessage({ role: "assistant", content: "hi" })).toolCalls).toBeUndefined();
  });

  it("maps usage tokens, and is undefined when usage is absent", () => {
    expect(parse(withMessage({ role: "assistant", content: "hi" }, { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })).usage).toEqual({
      inputTokens: 10,
      outputTokens: 5,
    });
    expect(parse(withMessage({ role: "assistant", content: "hi" })).usage).toBeUndefined();
  });

  it("falls back the id to <providerId>-response and the model to the requested model, preserving raw", () => {
    const result = parse({ choices: [{ message: { role: "assistant", content: "hi" } }] });
    expect(result.id).toBe("ollama-response");
    expect(result.model).toBe("requested-model");
    const withIds = parse(withMessage({ role: "assistant", content: "hi" }));
    expect(withIds.id).toBe("resp-1");
    expect(withIds.model).toBe("qwen3:8b");
    expect((withIds.raw as { id: string }).id).toBe("resp-1");
  });
});
