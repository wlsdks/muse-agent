import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const { retrieveCore } = vi.hoisted(() => ({
  retrieveCore: vi.fn(async (raw?: unknown): Promise<Record<string, unknown>> => {
    const params = raw as { readonly prepareRerankFn?: () => Promise<unknown> } | undefined;
    await params?.prepareRerankFn?.();
    return {
      notesUnavailable: false,
      preGapScored: [],
      queryVec: undefined,
      scored: [],
      splitClauses: [],
      subqueryEmbeddings: []
    };
  })
}));

vi.mock("@muse/recall", async (importOriginal) => ({
  ...await importOriginal<typeof import("@muse/recall")>(),
  retrieveAndRankNotes: retrieveCore
}));

import { captureTemporalClaimContext, createRecallRerankFn, createWarmedRecallRerankFn, parseCorrectionPairReply, parsePairAwareRerankReply, parseRerankReply, resolveRerankModel, retrieveAndRankNotes } from "./ask-note-retrieval.js";

const eligibleIndexFiles = () => [{
  chunks: [
    { chunkIndex: 0, embedding: [1, 0], file: "current.md", text: "I now use the office gym." },
    { chunkIndex: 1, embedding: [0.9, 0.1], file: "other.md", text: "A current unrelated note." },
    { chunkIndex: 2, embedding: [0.8, 0.2], file: "old.md", text: "I used to use the home gym, but not anymore." },
    { chunkIndex: 3, embedding: [0.7, 0.3], file: "extra.md", text: "Another note." }
  ],
  mtimeMs: 1,
  path: fileURLToPath(import.meta.url)
}];

let isolatedHome = "";

function isolatedRerankEnv(values: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    HOME: isolatedHome,
    MUSE_MODEL_KEYS_FILE: join(isolatedHome, "models.json"),
    ...values
  };
}

beforeAll(async () => {
  isolatedHome = await mkdtemp(join(tmpdir(), "muse-recall-preload-test-"));
});

afterAll(async () => {
  await rm(isolatedHome, { force: true, recursive: true });
});

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
    scope: undefined,
    topK: 3
  } as const;

  it("enables conflict-aware selection when omitted while preserving the explicit diagnostic opt-out", async () => {
    const runtime = { env: isolatedRerankEnv({ MUSE_RECALL_RERANK: "qwen3:8b", OLLAMA_BASE_URL: "http://127.0.0.1:22445" }) };
    await retrieveAndRankNotes(params, runtime);
    expect(retrieveCore).toHaveBeenLastCalledWith(expect.objectContaining({
      conflictAwareSelection: true,
      temporalClaimAuthority: expect.objectContaining({
        chunkerVersion: "muse.notes.chunk-text.v1",
        schema: "muse.temporal-claim-snapshot-authority.v1",
        storeRevision: 0,
        storeState: "absent"
      })
    }));

    await retrieveAndRankNotes({ ...params, conflictAwareSelection: false }, runtime);
    expect(retrieveCore).toHaveBeenLastCalledWith(expect.objectContaining({ conflictAwareSelection: false }));
  });

  it("represents an unsafe auto-audit as explicit unavailable authority", async () => {
    const context = await captureTemporalClaimContext({
      HOME: isolatedHome,
      MUSE_NOTE_RELATIONS_FILE: join(isolatedHome, "outside", "relations.json")
    });
    expect(context).toEqual({
      authority: {
        chunkerVersion: "muse.notes.chunk-text.v1", graphDigest: null, indexDigest: null,
        rawStoreDigest: null, schema: "muse.temporal-claim-snapshot-authority.v1",
        sourceProvenanceDigest: null, storeRevision: 0, storeState: "unavailable"
      }
    });
  });

  it("preloads the bound local reranker before an eligible first retrieval with the exact empty Ollama request", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const fetchFn = vi.fn(async () => ({
      json: async () => ({ done: true, done_reason: "load", model: "qwen3:8b", response: "" }),
      ok: true
    })) as unknown as typeof fetch;
    const indexFiles = eligibleIndexFiles();

    await retrieveAndRankNotes(
      { ...params, indexFiles },
      {
        env: isolatedRerankEnv({ MUSE_RECALL_RERANK: "qwen3:8b", OLLAMA_BASE_URL: "http://127.0.0.1:22445/" }),
        fetchFn
      }
    );

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn).toHaveBeenCalledWith("http://127.0.0.1:22445/api/generate", expect.objectContaining({
      body: JSON.stringify({ keep_alive: "5m", model: "qwen3:8b", stream: false }),
      headers: { "content-type": "application/json" },
      method: "POST"
    }));
    expect(timeout).toHaveBeenCalledWith(30_000);
    expect(retrieveCore).toHaveBeenLastCalledWith(expect.objectContaining({ prepareRerankFn: expect.any(Function) }));
  });

  it("fails open to deterministic retrieval after one invalid preload without issuing a selector retry", async () => {
    const fetchFn = vi.fn(async () => ({
      json: async () => ({ done: true, done_reason: "stop", model: "qwen3:8b", response: "" }),
      ok: true
    })) as unknown as typeof fetch;
    const indexFiles = eligibleIndexFiles();

    await retrieveAndRankNotes(
      { ...params, indexFiles },
      { env: isolatedRerankEnv({ MUSE_RECALL_RERANK: "qwen3:8b", OLLAMA_BASE_URL: "http://127.0.0.1:22445" }), fetchFn }
    );

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(retrieveCore).toHaveBeenLastCalledWith(expect.not.objectContaining({ rerankFn: expect.anything() }));
  });

  it("accepts preload success only for the exact load completion identity with an empty response", async () => {
    const invalidReplies: readonly unknown[] = [
      { done: false, done_reason: "load", model: "qwen3:8b", response: "" },
      { done: true, done_reason: "stop", model: "qwen3:8b", response: "" },
      { done: true, done_reason: "load", model: "other:latest", response: "" },
      { done: true, done_reason: "load", model: "qwen3:8b", response: "generated text" },
      ["not", "an", "object"]
    ];

    for (const reply of invalidReplies) {
      const fetchMock = vi.fn(async () => ({ json: async () => reply, ok: true }));
      await retrieveAndRankNotes(
        { ...params, indexFiles: eligibleIndexFiles() },
        {
          env: isolatedRerankEnv({ MUSE_RECALL_RERANK: "qwen3:8b", OLLAMA_BASE_URL: "http://127.0.0.1:22445" }),
          fetchFn: fetchMock as unknown as typeof fetch
        }
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(retrieveCore).toHaveBeenLastCalledWith(expect.not.objectContaining({ rerankFn: expect.anything() }));
    }
  });

  it("does not retry preload after timeout, HTTP error, or malformed JSON", async () => {
    const behaviors: ReadonlyArray<() => Promise<unknown>> = [
      async () => { throw new DOMException("timed out", "TimeoutError"); },
      async () => ({ json: async () => ({ shouldNotBeRead: true }), ok: false }),
      async () => ({ json: async () => { throw new SyntaxError("bad JSON"); }, ok: true })
    ];

    for (const behavior of behaviors) {
      const fetchMock = vi.fn(behavior);
      await retrieveAndRankNotes(
        { ...params, indexFiles: eligibleIndexFiles() },
        {
          env: isolatedRerankEnv({ MUSE_RECALL_RERANK: "qwen3:8b", OLLAMA_BASE_URL: "http://127.0.0.1:22445" }),
          fetchFn: fetchMock as unknown as typeof fetch
        }
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(retrieveCore).toHaveBeenLastCalledWith(expect.not.objectContaining({ rerankFn: expect.anything() }));
    }
  });

  it("does not preload when conflict-aware selection is explicitly disabled", async () => {
    const fetchFn = vi.fn(async () => { throw new Error("ineligible preload must not issue HTTP"); }) as unknown as typeof fetch;
    const indexFiles = eligibleIndexFiles();

    await retrieveAndRankNotes(
      { ...params, conflictAwareSelection: false, indexFiles },
      { env: isolatedRerankEnv({ MUSE_RECALL_RERANK: "qwen3:8b", OLLAMA_BASE_URL: "http://127.0.0.1:22445" }), fetchFn }
    );

    expect(fetchFn).not.toHaveBeenCalled();
    expect(retrieveCore).toHaveBeenLastCalledWith(expect.not.objectContaining({ rerankFn: expect.anything() }));
  });

  it("does not preload unless the corpus exceeds topK and contains both stale and non-stale chunks", async () => {
    const fetchMock = vi.fn(async () => { throw new Error("ineligible preload must not issue HTTP"); });
    const fetchFn = fetchMock as unknown as typeof fetch;
    const chunk = (chunkIndex: number, text: string) => ({ chunkIndex, embedding: [1, 0], file: `${chunkIndex.toString()}.md`, text });
    const cases = [
      [chunk(0, "current"), chunk(1, "current"), chunk(2, "used to be old, not anymore")],
      [chunk(0, "current"), chunk(1, "current"), chunk(2, "current"), chunk(3, "current")],
      [chunk(0, "used to be old, not anymore"), chunk(1, "used to be old, not anymore"), chunk(2, "used to be old, not anymore"), chunk(3, "used to be old, not anymore")]
    ];

    for (const chunks of cases) {
      await retrieveAndRankNotes(
        { ...params, indexFiles: [{ chunks, path: "notes.md" }] },
        { env: isolatedRerankEnv({ MUSE_RECALL_RERANK: "qwen3:8b", OLLAMA_BASE_URL: "http://127.0.0.1:22445" }), fetchFn }
      );
    }

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not preload for deleted or out-of-scope index entries that the selector cannot see", async () => {
    const fetchMock = vi.fn(async () => { throw new Error("ineligible preload must not issue HTTP"); });
    const fetchFn = fetchMock as unknown as typeof fetch;
    const livePath = fileURLToPath(import.meta.url);

    await retrieveAndRankNotes(
      { ...params, indexFiles: eligibleIndexFiles().map((file) => ({ ...file, path: "/definitely-missing/muse-note.md" })) },
      { env: isolatedRerankEnv({ MUSE_RECALL_RERANK: "qwen3:8b", OLLAMA_BASE_URL: "http://127.0.0.1:22445" }), fetchFn }
    );
    await retrieveAndRankNotes(
      { ...params, indexFiles: eligibleIndexFiles(), notesDir: dirname(livePath), scope: "work" },
      { env: isolatedRerankEnv({ MUSE_RECALL_RERANK: "qwen3:8b", OLLAMA_BASE_URL: "http://127.0.0.1:22445" }), fetchFn }
    );

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("routes preload, embedding, and selector through one injected transport and returns the snapshot-bound reranker", async () => {
    const seenBodies: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string) as Record<string, unknown>;
      seenBodies.push(body);
      if (String(input).endsWith("/api/embeddings")) {
        return { json: async () => ({ embedding: [1, 0] }), ok: true };
      }
      if (!("prompt" in body)) {
        return { json: async () => ({ done: true, done_reason: "load", model: "qwen3:8b", response: "" }), ok: true };
      }
      return { json: async () => ({ response: '{"pair":null}' }), ok: true };
    });
    const fetchFn = fetchMock as unknown as typeof fetch;
    let coreRerankFn: ((query: string, candidates: readonly string[]) => Promise<unknown>) | undefined;
    let coreEnv: NodeJS.ProcessEnv | undefined;
    retrieveCore.mockImplementationOnce(async (raw?: unknown) => {
      const coreParams = raw as {
        readonly embedFn: (text: string, model: string) => Promise<number[]>;
        readonly env?: NodeJS.ProcessEnv;
        readonly prepareRerankFn?: () => Promise<((query: string, candidates: readonly string[]) => Promise<unknown>) | undefined>;
        readonly rerankFn?: (query: string, candidates: readonly string[]) => Promise<unknown>;
      };
      coreRerankFn = coreParams.rerankFn ?? await coreParams.prepareRerankFn?.();
      coreEnv = coreParams.env;
      await coreParams.embedFn("private query", "nomic-embed-text-v2-moe");
      await coreRerankFn?.("private query", ["current", "used to be old, not anymore"]);
      return {
        notesUnavailable: false,
        preGapScored: [],
        queryVec: [1, 0],
        scored: [],
        snapshot: { identity: { test: "snapshot" }, rerankFn: coreRerankFn, result: { scored: [] } },
        splitClauses: [],
        subqueryEmbeddings: []
      };
    });
    const indexFiles = eligibleIndexFiles();
    const runtimeEnv = isolatedRerankEnv({ MUSE_RECALL_RERANK: "qwen3:8b", OLLAMA_BASE_URL: "http://127.0.0.1:22445" });

    const result = await retrieveAndRankNotes(
      { ...params, indexFiles, snapshotIdentity: { indexBuiltAtIso: "2026-07-21T00:00:00.000Z", notesIndexFile: "/trial/notes-index.json" } },
      { env: runtimeEnv, fetchFn }
    );

    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
      "http://127.0.0.1:22445/api/generate",
      "http://127.0.0.1:22445/api/embeddings",
      "http://127.0.0.1:22445/api/generate"
    ]);
    expect(seenBodies[0]).toEqual({ keep_alive: "5m", model: "qwen3:8b", stream: false });
    expect(seenBodies[1]).toEqual(expect.objectContaining({ model: "nomic-embed-text-v2-moe" }));
    expect(seenBodies[2]).toEqual(expect.objectContaining({ model: "qwen3:8b", prompt: expect.any(String) }));
    expect(result.snapshot?.rerankFn).toBe(coreRerankFn);
    expect(coreEnv).toEqual(runtimeEnv);
    expect(coreEnv).not.toBe(runtimeEnv);
    expect(Object.isFrozen(coreEnv)).toBe(true);
  });
});

describe("resolveRerankModel — default ON for local-model users, off for cloud, MUSE_RECALL_RERANK overrides", () => {
  it("unset (and the bare 'true') defaults to the resolved LOCAL default model", () => {
    expect(resolveRerankModel(isolatedRerankEnv())).toBe("gemma4:12b");
    expect(resolveRerankModel(isolatedRerankEnv({ MUSE_RECALL_RERANK: "true" }))).toBe("gemma4:12b");
  });

  it("a cloud default model disables reranking — the reranker never leaves the box", () => {
    expect(resolveRerankModel(isolatedRerankEnv({ GEMINI_API_KEY: "ambient-key" }))).toBeUndefined();
  });

  it("MUSE_LOCAL_ONLY forces local even with an ambient cloud key present", () => {
    expect(resolveRerankModel(isolatedRerankEnv({ GEMINI_API_KEY: "ambient-key", MUSE_LOCAL_ONLY: "true" }))).toBe("gemma4:12b");
  });

  it("false / 0 opt out", () => {
    expect(resolveRerankModel(isolatedRerankEnv({ MUSE_RECALL_RERANK: "false" }))).toBeUndefined();
    expect(resolveRerankModel(isolatedRerankEnv({ MUSE_RECALL_RERANK: "0" }))).toBeUndefined();
  });

  it("an explicit model name overrides the default choice, trimmed", () => {
    expect(resolveRerankModel(isolatedRerankEnv({ MUSE_RECALL_RERANK: " qwen3:8b " }))).toBe("qwen3:8b");
  });
});

describe("parseRerankReply — strict, bounded best-first zero-based indices", () => {
  it("parses only one exact correction pair or explicit null from 1-based to 0-based indices", () => {
    expect(parseCorrectionPairReply('{"pair":{"current":20,"stale":19}}', 20)).toEqual({ pair: { current: 19, stale: 18 } });
    expect(parseCorrectionPairReply('{"pair":null}', 20)).toEqual({ pair: null });
  });

  it("accepts only an exact allowed correction tuple while preserving explicit null", () => {
    const allowed = [{ current: 1, stale: 7 }, { current: 3, stale: 9 }];
    expect(parseCorrectionPairReply('{"pair":{"current":2,"stale":8}}', 12, allowed))
      .toEqual({ pair: { current: 1, stale: 7 } });
    expect(parseCorrectionPairReply('{"pair":{"current":2,"stale":10}}', 12, allowed)).toBeUndefined();
    expect(parseCorrectionPairReply('{"pair":null}', 12, allowed)).toEqual({ pair: null });
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
  it("binds model and URL to one immutable env snapshot instead of ambient or later mutations", async () => {
    const fetchFn = vi.fn(async () => ({ json: async () => ({ response: '{"pair":null}' }), ok: true })) as unknown as typeof fetch;
    const env = isolatedRerankEnv({ MUSE_RECALL_RERANK: "qwen3:8b", OLLAMA_BASE_URL: "http://127.0.0.1:22445/" });
    const rerank = createRecallRerankFn(env, { fetchFn })!;

    env.MUSE_RECALL_RERANK = "mutated:latest";
    env.OLLAMA_BASE_URL = "http://127.0.0.1:33556";
    await rerank("query", ["current"]);

    expect(fetchFn).toHaveBeenCalledWith("http://127.0.0.1:22445/api/generate", expect.objectContaining({
      body: expect.stringContaining('"model":"qwen3:8b"')
    }));
  });

  it("offers an explicit post-embedder warm seam without changing normal construction", async () => {
    const events = ["embedder-ready"];
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => {
      events.push("reranker-http");
      return { json: async () => ({ response: '{"pair":null}' }), ok: true };
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("MUSE_MODEL_KEYS_FILE", "/tmp/muse-rerank-warm-models.json");
    vi.stubEnv("OLLAMA_BASE_URL", "http://127.0.0.1:11434");

    const warmed = await createWarmedRecallRerankFn(
      isolatedRerankEnv({ MUSE_RECALL_RERANK: "qwen3:8b", OLLAMA_BASE_URL: "http://127.0.0.1:11434" }),
      { candidateTexts: ["current answer", "unrelated note"], query: "현재 답" }
    );

    expect(events).toEqual(["embedder-ready", "reranker-http"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(warmed?.warmup).toEqual({ httpAttempts: 1, order: [0, 1], outcome: "success" });
    expect(warmed?.rerankFn).toBeTypeOf("function");
    const warmBody = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string) as { prompt?: string };
    expect(warmBody.prompt).toContain('Return ONLY the exact JSON shape {"pair":null}');
    expect(warmBody.prompt).toContain('NO ALLOWED PAIR CARDS. Return exactly {"pair":null}.');
    expect(warmBody.prompt).not.toContain("PAIR CARD 1");
    expect(warmBody.prompt).not.toContain('{"pair":{"current":');
  });

  it("makes one compact selector request and deterministically supplies identity order plus at most one pair", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => ({
      json: async () => ({ response: '{"pair":{"current":2,"stale":8}}' }),
      ok: true
    }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("MUSE_MODEL_KEYS_FILE", "/tmp/muse-rerank-structured-models.json");
    vi.stubEnv("OLLAMA_BASE_URL", "http://127.0.0.1:11434");

    const selectorEnv = isolatedRerankEnv({ MUSE_RECALL_RERANK: "qwen3:8b", OLLAMA_BASE_URL: "http://127.0.0.1:11434" });
    const allowedCorrectionPairs = [
      { current: 5, stale: 11 },
      { current: 1, stale: 7 },
      { current: 4, stale: 10 },
      { current: 0, stale: 6 },
      { current: 3, stale: 9 },
      { current: 2, stale: 8 }
    ];
    const result = await createRecallRerankFn(selectorEnv)!(
      "월세는 언제 보내나요?",
      [
        ...Array.from({ length: 6 }, (_value, index) => `Current candidate ${index + 1}`),
        ...Array.from({ length: 6 }, (_value, index) => `This used to be stale candidate ${index + 7}; no longer current.`)
      ],
      { allowedCorrectionPairs }
    );

    expect(createRecallRerankFn(selectorEnv)?.mode).toBe("correction-pair");
    expect(result).toEqual({ httpAttempts: 1, order: Array.from({ length: 12 }, (_value, index) => index), outcome: "success", pairHints: [{ current: 1, stale: 7 }] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const request = fetchMock.mock.calls[0]![1]!;
    const body = JSON.parse(request.body as string) as { format?: unknown; prompt?: string };
    expect(body.format).toBe("json");
    expect(body.prompt).toContain("월세는 언제 보내나요?");
    expect(body.prompt).toContain('{"pair":null}');
    expect(body.prompt).toContain("pair must be null or an object with exactly the integer keys current and stale");
    expect(body.prompt).not.toContain('{"pair":{"current":1,"stale":7}}');
    expect(body.prompt).not.toContain('{"current":1,"stale":8}');
    expect(body.prompt).not.toContain('{"pair":{"current":2,"stale":1}}');
    expect(body.prompt).not.toContain('"ranking"');
    expect(body.prompt).not.toContain('"pairs"');
    expect(body.prompt?.match(/Choose the pair that most directly answers the query/gu)).toHaveLength(2);
    expect(body.prompt).toContain("Ignore correction pairs about any other topic");
    expect(body.prompt).toContain("never combine the current text from one card with the stale text from another");
    expect(body.prompt).toContain("stale must contain an explicit old or superseded marker; current must not");
    expect(body.prompt).toContain('If uncertain, same-index, or either field would be null, return exactly {"pair":null}');
    const cards = Array.from({ length: 6 }, (_value, index) => [
      `PAIR CARD ${(index + 1).toString()}`,
      `exact tuple: {"current":${(index + 1).toString()},"stale":${(index + 7).toString()}}`,
      `current text [${(index + 1).toString()}]: Current candidate ${index + 1}`,
      `stale text [${(index + 7).toString()}]: This used to be stale candidate ${index + 7}; no longer current.`
    ].join("\n"));
    expect(body.prompt?.match(/PAIR CARD \d+/gu)).toHaveLength(6);
    for (const card of cards) expect(body.prompt).toContain(card);
    const cardPositions = cards.map((card) => body.prompt?.indexOf(card) ?? -1);
    expect(cardPositions).toEqual([...cardPositions].sort((left, right) => left - right));
    expect(body.prompt).not.toContain("CURRENT / NON-STALE CANDIDATES");
    expect(body.prompt).not.toContain("EXPLICIT-STALE CANDIDATES");
  });

  it("rejects a model-invented cross-pair and malformed allowed-pair context without retry", async () => {
    const fetchMock = vi.fn(async () => ({
      json: async () => ({ response: '{"pair":{"current":1,"stale":4}}' }),
      ok: true
    }));
    const rerank = createRecallRerankFn(
      isolatedRerankEnv({ MUSE_RECALL_RERANK: "qwen3:8b", OLLAMA_BASE_URL: "http://127.0.0.1:11434" }),
      { fetchFn: fetchMock as unknown as typeof fetch }
    )!;
    const texts = ["current one", "current two", "used to be stale one; no longer current", "used to be stale two; no longer current"];

    await expect(rerank("query", texts, {
      allowedCorrectionPairs: [{ current: 0, stale: 2 }, { current: 1, stale: 3 }]
    })).resolves.toEqual({ httpAttempts: 1, outcome: "invalid" });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await expect(rerank("query", texts, {
      allowedCorrectionPairs: Array.from({ length: 7 }, (_value, index) => ({ current: index % 2, stale: 2 + index % 2 }))
    })).resolves.toEqual({ httpAttempts: 0, outcome: "invalid" });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await expect(rerank("query", [
      "current one",
      "used to be stale one; no longer current",
      "current tail"
    ], {
      allowedCorrectionPairs: [{ current: 0, stale: 2 }]
    })).resolves.toEqual({ httpAttempts: 0, outcome: "invalid" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("classifies timeout, empty, and invalid replies without retrying", async () => {
    vi.stubEnv("MUSE_MODEL_KEYS_FILE", "/tmp/muse-rerank-outcomes-models.json");
    vi.stubEnv("OLLAMA_BASE_URL", "http://127.0.0.1:11434");
    const rerank = createRecallRerankFn(isolatedRerankEnv({ MUSE_RECALL_RERANK: "qwen3:8b", OLLAMA_BASE_URL: "http://127.0.0.1:11434" }))!;

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
    const env = isolatedRerankEnv({ MUSE_RECALL_RERANK: "qwen3:8b", OLLAMA_BASE_URL: "http://127.0.0.1:11434" });

    await createRecallRerankFn(env)!("query", ["candidate"]);
    expect(timeout).toHaveBeenLastCalledWith(4000);
    await createRecallRerankFn(env, { timeoutMs: 2000 })!("query", ["candidate"]);
    expect(timeout).toHaveBeenLastCalledWith(2000);

    for (const timeoutMs of [0, -1, 4001, 1.5, Number.NaN]) {
      expect(createRecallRerankFn(env, { timeoutMs })).toBeUndefined();
    }
  });
});
