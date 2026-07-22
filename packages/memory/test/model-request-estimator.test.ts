import { describe, expect, it } from "vitest";

import {
  canonicalModelJson,
  estimateModelRequestTokens,
  ModelRequestEstimateError
} from "../src/index.js";

describe("model request token estimator", () => {
  it("canonicalizes JSON keys recursively without changing array order", () => {
    expect(canonicalModelJson({ z: 1, a: { y: true, b: [2, 1] } }))
      .toBe('{"a":{"b":[2,1],"y":true},"z":1}');
  });

  it("orders object keys by Unicode code point rather than UTF-16 code unit", () => {
    expect(canonicalModelJson({ "😀": 1, "\uE000": 2 })).toBe('{"":2,"😀":1}');
  });

  it("includes messages, tool linkage, tool definitions, response format, and inline attachments", () => {
    const plain = estimateModelRequestTokens({ messages: [{ content: "hello", role: "user" }] });
    const complete = estimateModelRequestTokens({
      messages: [
        { content: "hello", role: "user" },
        { content: "", role: "assistant", toolCalls: [{ arguments: { q: "muse" }, id: "call-1", name: "search" }] },
        { content: "found", name: "search", role: "tool", toolCallId: "call-1" },
        { attachments: [{ dataBase64: "aGVsbG8=", mimeType: "image/png" }], content: "look", role: "user" }
      ],
      responseFormat: { type: "object" },
      tools: [{ description: "Search", inputSchema: { properties: { q: { type: "string" } }, type: "object" }, name: "search", risk: "read" }]
    });
    expect(complete.messageTokens).toBeGreaterThan(plain.messageTokens);
    expect(complete.toolDefinitionTokens).toBeGreaterThan(0);
    expect(complete.responseFormatTokens).toBeGreaterThan(0);
    expect(complete.estimatedInputTokens)
      .toBe(complete.messageTokens + complete.toolDefinitionTokens + complete.responseFormatTokens);
  });

  it("fails closed for remote attachments, malformed base64, cycles, and non-finite JSON", () => {
    expect(() => estimateModelRequestTokens({
      messages: [{ attachments: [{ mimeType: "image/png", url: "https://private.invalid/image" }], content: "", role: "user" }]
    })).toThrow(ModelRequestEstimateError);
    expect(() => estimateModelRequestTokens({
      messages: [{ attachments: [{ dataBase64: "%%%", mimeType: "image/png" }], content: "", role: "user" }]
    })).toThrow(ModelRequestEstimateError);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => canonicalModelJson(cyclic)).toThrow(ModelRequestEstimateError);
    expect(() => canonicalModelJson({ bad: Number.POSITIVE_INFINITY })).toThrow(ModelRequestEstimateError);
  });

  it("fails closed beyond the canonical depth and serialized-size bounds", () => {
    let deep: Record<string, unknown> = {};
    const root = deep;
    for (let index = 0; index < 65; index++) {
      const next: Record<string, unknown> = {};
      deep.next = next;
      deep = next;
    }
    expect(() => canonicalModelJson(root)).toThrow(ModelRequestEstimateError);
    expect(() => canonicalModelJson("x".repeat(16 * 1024 * 1024))).toThrow(ModelRequestEstimateError);
  });

  it("saturates component and complete sums at Number.MAX_SAFE_INTEGER", () => {
    const estimate = estimateModelRequestTokens(
      {
        messages: [{ content: "secret", role: "user" }],
        responseFormat: { type: "object" },
        tools: [{ description: "tool", inputSchema: { type: "object" }, name: "read", risk: "read" }]
      },
      { estimate: () => Number.MAX_SAFE_INTEGER }
    );
    expect(estimate.messageTokens).toBe(Number.MAX_SAFE_INTEGER);
    expect(estimate.toolDefinitionTokens).toBe(Number.MAX_SAFE_INTEGER);
    expect(estimate.responseFormatTokens).toBe(Number.MAX_SAFE_INTEGER);
    expect(estimate.estimatedInputTokens).toBe(Number.MAX_SAFE_INTEGER);
  });
});
