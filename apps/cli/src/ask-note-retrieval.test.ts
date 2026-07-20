import { afterEach, describe, expect, it, vi } from "vitest";

const { retrieveCore } = vi.hoisted(() => ({
  retrieveCore: vi.fn(async () => ({
    notesUnavailable: false,
    preGapScored: [],
    queryVec: undefined,
    scored: [],
    splitClauses: [],
    subqueryEmbeddings: []
  }))
}));

vi.mock("@muse/recall", async (importOriginal) => ({
  ...await importOriginal<typeof import("@muse/recall")>(),
  retrieveAndRankNotes: retrieveCore
}));
vi.mock("./embed.js", () => ({ embed: vi.fn() }));

import { createRecallRerankFn, createWarmedRecallRerankFn, parseCorrectionCurrentReply, parseCorrectionPairReply, parseCorrectionStaleReply, parsePairAwareRerankReply, parseRerankReply, resolveRerankModel, retrieveAndRankNotes } from "./ask-note-retrieval.js";

afterEach(() => {
  retrieveCore.mockClear();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("retrieveAndRankNotes — production conflict-aware default", () => {
  const params = {
    embedModel: "test-embed",
    indexFiles: [],
    json: true,
    notesDir: "/tmp/notes",
    onStderr: () => {},
    query: "what changed",
    rerankFn: undefined,
    scope: undefined,
    topK: 3
  } as const;

  it("enables conflict-aware selection when omitted while preserving the explicit diagnostic opt-out", async () => {
    await retrieveAndRankNotes(params);
    expect(retrieveCore).toHaveBeenLastCalledWith(expect.objectContaining({ conflictAwareSelection: true }));

    await retrieveAndRankNotes({ ...params, conflictAwareSelection: false });
    expect(retrieveCore).toHaveBeenLastCalledWith(expect.objectContaining({ conflictAwareSelection: false }));
  });
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

describe("parseRerankReply — strict, bounded best-first zero-based indices", () => {
  it("parses each correction stage's exact integer/null shape within its local 1-based range", () => {
    expect(parseCorrectionCurrentReply('{"current":10}', 10)).toEqual({ current: 9 });
    expect(parseCorrectionCurrentReply('{"current":null}', 10)).toEqual({ current: null });
    expect(parseCorrectionStaleReply('{"stale":1}', 10)).toEqual({ stale: 0 });
    expect(parseCorrectionStaleReply('{"stale":null}', 10)).toEqual({ stale: null });

    for (const reply of ['{"current":0}', '{"current":11}', '{"current":1,"unknown":true}', '{"stale":1}', 'current 1']) {
      expect(parseCorrectionCurrentReply(reply, 10)).toBeUndefined();
    }
    for (const reply of ['{"stale":0}', '{"stale":11}', '{"stale":1,"unknown":true}', '{"current":1}', 'stale 1']) {
      expect(parseCorrectionStaleReply(reply, 10)).toBeUndefined();
    }
  });

  it("parses only one exact correction pair or explicit null from 1-based to 0-based indices", () => {
    expect(parseCorrectionPairReply('{"pair":{"current":20,"stale":19}}', 20)).toEqual({ pair: { current: 19, stale: 18 } });
    expect(parseCorrectionPairReply('{"pair":null}', 20)).toEqual({ pair: null });
  });

  it("rejects ranking, pair arrays, unknown keys, prose, out-of-range, and same-index correction replies", () => {
    for (const reply of [
      '{"ranking":[1]}',
      '{"pairs":[]}',
      '{"pair":null,"unknown":true}',
      '{"pair":{"current":2,"stale":1,"unknown":true}}',
      '{"pair":{"current":21,"stale":1}}',
      '{"pair":{"current":0,"stale":1}}',
      '{"pair":{"current":2,"stale":2}}',
      '[{"current":2,"stale":1}]',
      "document 2 is current"
    ]) expect(parseCorrectionPairReply(reply, 20)).toBeUndefined();
  });

  it("keeps the maximum 20-candidate valid selector reply structurally below the 64-token output cap", () => {
    const maximumReply = '{"pair":{"current":20,"stale":19}}';
    expect(new TextEncoder().encode(maximumReply).byteLength).toBeLessThan(64);
    expect(parseCorrectionPairReply(maximumReply, 20)).toEqual({ pair: { current: 19, stale: 18 } });
  });

  it("parses a closed 1-based correction pair hint alongside the complete ranking", () => {
    expect(parsePairAwareRerankReply(
      '{"ranking":[3,1,2],"pairs":[{"current":3,"stale":1}]}',
      3
    )).toEqual({ order: [2, 0, 1], pairHints: [{ current: 2, stale: 0 }] });
  });

  it("ignores malformed pair hints without changing a valid ranking", () => {
    expect(parsePairAwareRerankReply(
      '{"ranking":[2,1],"pairs":[{"current":3,"stale":1},{"current":1,"stale":1},{"current":2,"stale":1,"unknown":true}]}',
      2
    )).toEqual({ order: [1, 0] });
  });

  it("rejects structured JSON with unknown top-level keys", () => {
    expect(parsePairAwareRerankReply('{"ranking":[1],"pairs":[],"unknown":true}', 1)).toBeUndefined();
  });

  it("accepts JSON or an all-numeric fallback and deduplicates within the candidate range", () => {
    expect(parseRerankReply('{"ranking":[2,2,99,1]}', 3)).toEqual([1, 0]);
    expect(parseRerankReply("[2]", 3)).toEqual([1]);
    expect(parseRerankReply("2, 4, 1", 4)).toEqual([1, 3, 0]);
  });

  it("rejects prose, malformed JSON, empty output, and wholly out-of-range output", () => {
    expect(parseRerankReply("I choose document 2", 3)).toBeUndefined();
    expect(parseRerankReply('{"ranking":', 3)).toBeUndefined();
    expect(parseRerankReply("", 3)).toBeUndefined();
    expect(parseRerankReply("[99]", 3)).toBeUndefined();
  });
});

describe("createRecallRerankFn — bounded request timeout", () => {
  it("offers an explicit post-embedder warm seam without changing normal construction", async () => {
    const events = ["embedder-ready"];
    let call = 0;
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => {
      events.push("reranker-http");
      return { json: async () => ({ response: call++ === 0 ? '{"current":1}' : '{"stale":1}' }), ok: true };
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("MUSE_MODEL_KEYS_FILE", "/tmp/muse-rerank-warm-models.json");
    vi.stubEnv("OLLAMA_BASE_URL", "http://127.0.0.1:11434");

    const warmed = await createWarmedRecallRerankFn(
      { MUSE_RECALL_RERANK: "qwen3:8b" },
      { candidateTexts: ["current answer", "This used to be the answer; no longer current."], query: "현재 답" }
    );

    expect(events).toEqual(["embedder-ready", "reranker-http", "reranker-http"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(warmed?.warmup).toEqual({ httpAttempts: 2, order: [0, 1], outcome: "success", pairHints: [{ current: 0, stale: 1 }] });
    expect(warmed?.rerankFn).toBeTypeOf("function");
    const warmBody = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string) as { prompt?: string };
    expect(warmBody.prompt).toContain('{"current":null}');
    const staleBody = JSON.parse(fetchMock.mock.calls[1]![1]!.body as string) as { prompt?: string };
    expect(staleBody.prompt).toContain('{"stale":null}');
  });

  it("selects current then its stale counterpart in two closed prompts and returns identity order plus one pair", async () => {
    let call = 0;
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => ({
      json: async () => ({ response: call++ === 0 ? '{"current":2}' : '{"stale":1}' }),
      ok: true
    }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("MUSE_MODEL_KEYS_FILE", "/tmp/muse-rerank-structured-models.json");
    vi.stubEnv("OLLAMA_BASE_URL", "http://127.0.0.1:11434");

    const result = await createRecallRerankFn({ MUSE_RECALL_RERANK: "qwen3:8b" })!(
      "월세는 언제 보내나요?",
      [
        ...Array.from({ length: 10 }, (_value, index) => `Current candidate ${index + 1}`),
        ...Array.from({ length: 10 }, (_value, index) => `This used to be stale candidate ${index + 11}; no longer current.`)
      ]
    );

    expect(createRecallRerankFn({ MUSE_RECALL_RERANK: "qwen3:8b" })?.mode).toBe("correction-pair");
    expect(result).toEqual({ httpAttempts: 2, order: Array.from({ length: 20 }, (_value, index) => index), outcome: "success", pairHints: [{ current: 1, stale: 10 }] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const first = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string) as { format?: unknown; prompt?: string };
    const second = JSON.parse(fetchMock.mock.calls[1]![1]!.body as string) as { format?: unknown; prompt?: string };
    expect(first.format).toBe("json");
    expect(first.prompt).toContain("월세는 언제 보내나요?");
    expect(first.prompt).toContain('{"current":null}');
    expect(first.prompt).toContain('{"current":1}');
    expect(first.prompt).toContain("Current candidate 1");
    expect(first.prompt).not.toContain("stale candidate 11");
    expect(first.prompt).not.toContain('"ranking"');
    expect(first.prompt).not.toContain('"pair"');
    expect(second.format).toBe("json");
    expect(second.prompt).toContain("월세는 언제 보내나요?");
    expect(second.prompt).toContain("SELECTED CURRENT DOCUMENT:\nCurrent candidate 2");
    expect(second.prompt).toContain('{"stale":null}');
    expect(second.prompt).toContain('{"stale":1}');
    expect(second.prompt).toContain("stale candidate 11");
    expect(second.prompt).not.toContain("Current candidate 1");
    expect(second.prompt).not.toContain('"ranking"');
    expect(second.prompt).not.toContain('"pair"');
  });

  it("stops after a stage-1 null and preserves identity order without a pair", async () => {
    const fetchMock = vi.fn(async () => ({ json: async () => ({ response: '{"current":null}' }), ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("MUSE_MODEL_KEYS_FILE", "/tmp/muse-rerank-null-models.json");
    vi.stubEnv("OLLAMA_BASE_URL", "http://127.0.0.1:11434");

    const result = await createRecallRerankFn({ MUSE_RECALL_RERANK: "qwen3:8b" })!(
      "query",
      ["current answer", "This used to be the answer; no longer current."]
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ httpAttempts: 1, order: [0, 1], outcome: "success" });
  });

  it("shares one absolute deadline and does not count an HTTP attempt after the budget is exhausted", async () => {
    vi.spyOn(Date, "now")
      .mockReturnValueOnce(1_000)
      .mockReturnValueOnce(1_000)
      .mockReturnValueOnce(3_000);
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const fetchMock = vi.fn(async () => ({ json: async () => ({ response: '{"current":1}' }), ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("MUSE_MODEL_KEYS_FILE", "/tmp/muse-rerank-deadline-models.json");
    vi.stubEnv("OLLAMA_BASE_URL", "http://127.0.0.1:11434");

    const result = await createRecallRerankFn(
      { MUSE_RECALL_RERANK: "qwen3:8b" },
      { timeoutMs: 2_000 }
    )!("query", ["current answer", "This used to be the answer; no longer current."]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(timeout).toHaveBeenCalledTimes(1);
    expect(timeout).toHaveBeenCalledWith(2_000);
    expect(result).toEqual({ httpAttempts: 1, outcome: "timeout" });
  });

  it("gives stage 2 only the remaining portion of the shared deadline", async () => {
    vi.spyOn(Date, "now")
      .mockReturnValueOnce(1_000)
      .mockReturnValueOnce(1_000)
      .mockReturnValueOnce(2_500);
    const timeout = vi.spyOn(AbortSignal, "timeout");
    let call = 0;
    vi.stubGlobal("fetch", vi.fn(async () => ({
      json: async () => ({ response: call++ === 0 ? '{"current":1}' : '{"stale":1}' }),
      ok: true
    })));
    vi.stubEnv("MUSE_MODEL_KEYS_FILE", "/tmp/muse-rerank-remaining-models.json");
    vi.stubEnv("OLLAMA_BASE_URL", "http://127.0.0.1:11434");

    const result = await createRecallRerankFn(
      { MUSE_RECALL_RERANK: "qwen3:8b" },
      { timeoutMs: 2_000 }
    )!("query", ["current answer", "This used to be the answer; no longer current."]);

    expect(timeout.mock.calls.map(([value]) => value)).toEqual([2_000, 500]);
    expect(result).toEqual({ httpAttempts: 2, order: [0, 1], outcome: "success", pairHints: [{ current: 0, stale: 1 }] });
  });

  it("fails open without a pair on stage-2 null and reports stage-2 invalid after exactly two attempts", async () => {
    vi.stubEnv("MUSE_MODEL_KEYS_FILE", "/tmp/muse-rerank-stage2-models.json");
    vi.stubEnv("OLLAMA_BASE_URL", "http://127.0.0.1:11434");
    const run = async (secondReply: string) => {
      let call = 0;
      const fetchMock = vi.fn(async () => ({
        json: async () => ({ response: call++ === 0 ? '{"current":1}' : secondReply }),
        ok: true
      }));
      vi.stubGlobal("fetch", fetchMock);
      const result = await createRecallRerankFn({ MUSE_RECALL_RERANK: "qwen3:8b" })!(
        "query",
        ["current answer", "This used to be the answer; no longer current."]
      );
      return { calls: fetchMock.mock.calls.length, result };
    };

    await expect(run('{"stale":null}')).resolves.toEqual({
      calls: 2,
      result: { httpAttempts: 2, order: [0, 1], outcome: "success" }
    });
    await expect(run('{"stale":1,"unknown":true}')).resolves.toEqual({
      calls: 2,
      result: { httpAttempts: 2, outcome: "invalid" }
    });
  });

  it("classifies timeout, empty, and invalid replies without retrying", async () => {
    vi.stubEnv("MUSE_MODEL_KEYS_FILE", "/tmp/muse-rerank-outcomes-models.json");
    vi.stubEnv("OLLAMA_BASE_URL", "http://127.0.0.1:11434");
    const rerank = createRecallRerankFn({ MUSE_RECALL_RERANK: "qwen3:8b" })!;

    const timeoutFetch = vi.fn(async () => { throw new DOMException("timed out", "TimeoutError"); });
    vi.stubGlobal("fetch", timeoutFetch);
    await expect(rerank("query", ["candidate"])).resolves.toEqual({ httpAttempts: 1, outcome: "timeout" });
    expect(timeoutFetch).toHaveBeenCalledTimes(1);

    const emptyFetch = vi.fn(async () => ({ json: async () => ({ response: "" }), ok: true }));
    vi.stubGlobal("fetch", emptyFetch);
    await expect(rerank("query", ["candidate"])).resolves.toEqual({ httpAttempts: 1, outcome: "empty" });
    expect(emptyFetch).toHaveBeenCalledTimes(1);

    const invalidFetch = vi.fn(async () => ({ json: async () => ({ response: "document 1" }), ok: true }));
    vi.stubGlobal("fetch", invalidFetch);
    await expect(rerank("query", ["candidate"])).resolves.toEqual({ httpAttempts: 1, outcome: "invalid" });
    expect(invalidFetch).toHaveBeenCalledTimes(1);
  });

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
