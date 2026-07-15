import { describe, expect, it } from "vitest";

import { parseRerankReply, resolveRerankModel } from "./ask-note-retrieval.js";

describe("resolveRerankModel — MUSE_RECALL_RERANK names the Ollama reranker model", () => {
  it("off for unset / empty / false / 0 / the bare 'true' placeholder", () => {
    expect(resolveRerankModel({})).toBeUndefined();
    expect(resolveRerankModel({ MUSE_RECALL_RERANK: "" })).toBeUndefined();
    expect(resolveRerankModel({ MUSE_RECALL_RERANK: "false" })).toBeUndefined();
    expect(resolveRerankModel({ MUSE_RECALL_RERANK: "0" })).toBeUndefined();
    expect(resolveRerankModel({ MUSE_RECALL_RERANK: "true" })).toBeUndefined();
  });

  it("any other value is the model name, trimmed", () => {
    expect(resolveRerankModel({ MUSE_RECALL_RERANK: " qwen3:8b " })).toBe("qwen3:8b");
    expect(resolveRerankModel({ MUSE_RECALL_RERANK: "gemma4:12b" })).toBe("gemma4:12b");
  });
});

describe("parseRerankReply — tolerant extraction of best-first zero-based indices", () => {
  it("parses bare, bracketed, and comma-separated replies (measured gemma4 emits '[2]', qwen3 emits '2')", () => {
    expect(parseRerankReply("2")).toEqual([1]);
    expect(parseRerankReply("[2]")).toEqual([1]);
    expect(parseRerankReply("2, 4, 1")).toEqual([1, 3, 0]);
  });

  it("no digits → undefined (caller fails open)", () => {
    expect(parseRerankReply("I cannot decide")).toBeUndefined();
    expect(parseRerankReply("")).toBeUndefined();
  });
});
