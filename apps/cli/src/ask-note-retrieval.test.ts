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

import { createRecallRerankFn, createWarmedRecallRerankFn, parseCorrectionPairReply, parsePairAwareRerankReply, parseRerankReply, resolveRerankModel, retrieveAndRankNotes } from "./ask-note-retrieval.js";

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
    const fetchMock = vi.fn(async () => {
      events.push("reranker-http");
      return { json: async () => ({ response: '{"pair":null}' }), ok: true };
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("MUSE_MODEL_KEYS_FILE", "/tmp/muse-rerank-warm-models.json");
    vi.stubEnv("OLLAMA_BASE_URL", "http://127.0.0.1:11434");

    const warmed = await createWarmedRecallRerankFn(
      { MUSE_RECALL_RERANK: "qwen3:8b" },
      { candidateTexts: ["current answer", "unrelated note"], query: "현재 답" }
    );

    expect(events).toEqual(["embedder-ready", "reranker-http"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(warmed?.warmup).toEqual({ httpAttempts: 1, order: [0, 1], outcome: "success" });
    expect(warmed?.rerankFn).toBeTypeOf("function");
  });

  it("makes one compact selector request and deterministically supplies identity order plus at most one pair", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => ({
      json: async () => ({ response: '{"pair":{"current":2,"stale":1}}' }),
      ok: true
    }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("MUSE_MODEL_KEYS_FILE", "/tmp/muse-rerank-structured-models.json");
    vi.stubEnv("OLLAMA_BASE_URL", "http://127.0.0.1:11434");

    const result = await createRecallRerankFn({ MUSE_RECALL_RERANK: "qwen3:8b" })!(
      "월세는 언제 보내나요?",
      ["The office rent changed.", "Pay rent on the 25th."]
    );

    expect(createRecallRerankFn({ MUSE_RECALL_RERANK: "qwen3:8b" })?.mode).toBe("correction-pair");
    expect(result).toEqual({ httpAttempts: 1, order: [0, 1], outcome: "success", pairHints: [{ current: 1, stale: 0 }] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const request = fetchMock.mock.calls[0]![1]!;
    const body = JSON.parse(request.body as string) as { format?: unknown; prompt?: string };
    expect(body.format).toBe("json");
    expect(body.prompt).toContain("월세는 언제 보내나요?");
    expect(body.prompt).toContain('{"pair":null}');
    expect(body.prompt).toContain('{"pair":{"current":2,"stale":1}}');
    expect(body.prompt).not.toContain('"ranking"');
    expect(body.prompt).not.toContain('"pairs"');
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
