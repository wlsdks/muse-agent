import { afterEach, describe, expect, it, vi } from "vitest";

import { createRecallRerankFn, parseRerankReply, resolveRerankModel } from "./ask-note-retrieval.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("resolveRerankModel — default ON for local-model users, off for cloud, MUSE_RECALL_RERANK overrides", () => {
  it("unset (and the bare 'true') defaults to the resolved LOCAL default model", () => {
    expect(resolveRerankModel({})).toBe("gemma4:12b");
    expect(resolveRerankModel({ MUSE_RECALL_RERANK: "true" })).toBe("gemma4:12b");
  });

  it("a cloud default model disables reranking — the reranker never leaves the box", () => {
    expect(resolveRerankModel({ GEMINI_API_KEY: "ambient-key" })).toBeUndefined();
  });

  it("MUSE_LOCAL_ONLY forces local even with an ambient cloud key present", () => {
    expect(resolveRerankModel({ GEMINI_API_KEY: "ambient-key", MUSE_LOCAL_ONLY: "true" })).toBe("gemma4:12b");
  });

  it("false / 0 opt out", () => {
    expect(resolveRerankModel({ MUSE_RECALL_RERANK: "false" })).toBeUndefined();
    expect(resolveRerankModel({ MUSE_RECALL_RERANK: "0" })).toBeUndefined();
  });

  it("an explicit model name overrides the default choice, trimmed", () => {
    expect(resolveRerankModel({ MUSE_RECALL_RERANK: " qwen3:8b " })).toBe("qwen3:8b");
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

describe("createRecallRerankFn — bounded request timeout", () => {
  it("uses 4000ms by default, accepts the eval's explicit 2000ms, and fails closed on invalid values", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    vi.stubGlobal("fetch", vi.fn(async () => ({ json: async () => ({ response: "1" }), ok: true })));
    vi.stubEnv("MUSE_MODEL_KEYS_FILE", "/tmp/muse-rerank-timeout-models.json");
    vi.stubEnv("OLLAMA_BASE_URL", "http://127.0.0.1:11434");
    const env = { MUSE_RECALL_RERANK: "qwen3:8b" };

    await createRecallRerankFn(env)!("query", ["candidate"]);
    expect(timeout).toHaveBeenLastCalledWith(4000);
    await createRecallRerankFn(env, { timeoutMs: 2000 })!("query", ["candidate"]);
    expect(timeout).toHaveBeenLastCalledWith(2000);

    for (const timeoutMs of [0, -1, 4001, 1.5, Number.NaN]) {
      expect(createRecallRerankFn(env, { timeoutMs })).toBeUndefined();
    }
  });
});
