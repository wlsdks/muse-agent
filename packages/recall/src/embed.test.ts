import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_EMBED_TIMEOUT_MS, cosineSimilarity, embed } from "./embed.js";

const opts = (fetchImpl: typeof globalThis.fetch) => ({
  fetchImpl,
  baseUrlResolver: () => "http://o.test"
});

const okJson = (body: unknown): typeof globalThis.fetch =>
  (async () => new Response(JSON.stringify(body), { status: 200 })) as typeof globalThis.fetch;

describe("cosineSimilarity", () => {
  it("returns 1 for identical vectors and 0 for orthogonal ones", () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBe(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
  });

  it("returns 0 on length mismatch, empty, or zero-norm vectors", () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2])).toBe(0);
    expect(cosineSimilarity([], [])).toBe(0);
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });

  it("returns 0 (not NaN) when either vector contains a NaN element", () => {
    expect(cosineSimilarity([Number.NaN, 1, 0], [1, 0, 0])).toBe(0);
    expect(cosineSimilarity([1, 0, 0], [Number.NaN, 0, 0])).toBe(0);
  });
});

describe("embed", () => {
  it("returns the embedding vector on a well-formed response", async () => {
    const vec = await embed("hi", "nomic-embed-text", opts(okJson({ embedding: [0.1, -0.2, 0.3] })));
    expect(vec).toEqual([0.1, -0.2, 0.3]);
  });

  it("throws with the status + body on a non-2xx response", async () => {
    const fetchImpl = (async () =>
      new Response("model not found", { status: 404 })) as typeof globalThis.fetch;
    await expect(embed("hi", "bad-model", opts(fetchImpl))).rejects.toThrow(/embeddings 404.*model not found/u);
  });

  it("rejects a missing / non-array embedding field", async () => {
    await expect(embed("hi", "m", opts(okJson({})))).rejects.toThrow(/valid numeric 'embedding' vector/u);
    await expect(embed("hi", "m", opts(okJson({ embedding: "nope" })))).rejects.toThrow(/valid numeric/u);
  });

  it("rejects an empty embedding vector instead of silently corrupting ranking", async () => {
    await expect(embed("hi", "m", opts(okJson({ embedding: [] })))).rejects.toThrow(/valid numeric/u);
  });

  it("rejects an embedding containing non-finite / non-number elements", async () => {
    await expect(embed("hi", "m", opts(okJson({ embedding: [0.1, null, 0.3] })))).rejects.toThrow(/valid numeric/u);
    await expect(embed("hi", "m", opts(okJson({ embedding: [0.1, "x", 0.3] })))).rejects.toThrow(/valid numeric/u);
  });

  it("times out a never-resolving Ollama embeddings call instead of hanging every RAG caller (muse ask / notes reindex / recall) forever — pre-fix the fetch had no AbortSignal and a cold-model load could wedge the CLI indefinitely", async () => {
    const neverResolves: typeof globalThis.fetch = (_input, init) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = (init as { signal?: AbortSignal } | undefined)?.signal;
        signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    };
    await expect(
      embed("hi", "m", { ...opts(neverResolves), timeoutMs: 10 })
    ).rejects.toThrow(/timed out after 10ms/u);
  });

  it("passes the AbortSignal through to fetchImpl so the upstream connection is actively cancelled, not just abandoned", async () => {
    let receivedSignal: AbortSignal | undefined;
    const captureSignal: typeof globalThis.fetch = (_input, init) => {
      receivedSignal = (init as { signal?: AbortSignal } | undefined)?.signal;
      return new Promise<Response>((_resolve, reject) => {
        receivedSignal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    };
    await expect(
      embed("hi", "m", { ...opts(captureSignal), timeoutMs: 5 })
    ).rejects.toThrow(/timed out/u);
    expect(receivedSignal).toBeInstanceOf(AbortSignal);
    expect(receivedSignal?.aborted).toBe(true);
  });

  it("returns the vector and clears the timer on a successful fetch — no leaked timer keeping the event loop alive", async () => {
    const result = await embed("hi", "m", { ...opts(okJson({ embedding: [0.5, 0.5] })), timeoutMs: 5_000 });
    expect(result).toEqual([0.5, 0.5]);
  });

  it("exports a sensible 30-second default — callers that don't pass timeoutMs still inherit the cap", () => {
    expect(DEFAULT_EMBED_TIMEOUT_MS).toBe(30_000);
  });
});

describe("embed — MUSE_LOCAL_ONLY cloud-egress guard", () => {
  const prev = process.env.MUSE_LOCAL_ONLY;
  const previousOllamaBaseUrl = process.env.OLLAMA_BASE_URL;
  afterEach(() => {
    if (prev === undefined) delete process.env.MUSE_LOCAL_ONLY;
    else process.env.MUSE_LOCAL_ONLY = prev;
    if (previousOllamaBaseUrl === undefined) delete process.env.OLLAMA_BASE_URL;
    else process.env.OLLAMA_BASE_URL = previousOllamaBaseUrl;
  });

  it("throws (no fetch) when local-only is on and the resolved host is REMOTE — personal text never leaves the box", async () => {
    process.env.MUSE_LOCAL_ONLY = "true";
    let called = false;
    const spyFetch: typeof globalThis.fetch = async (...args) => { called = true; return okJson({ embedding: [1] })(...args); };
    await expect(
      embed("my private note", "m", { fetchImpl: spyFetch, baseUrlResolver: () => "http://192.168.1.50:11434" })
    ).rejects.toThrow(/local-only|cloud provider/u);
    expect(called).toBe(false);
  });

  it("allows a LOOPBACK host under local-only (on-box embedding is fine)", async () => {
    process.env.MUSE_LOCAL_ONLY = "true";
    const result = await embed("x", "m", { ...opts(okJson({ embedding: [0.5] })), baseUrlResolver: () => "http://127.0.0.1:11434" });
    expect(result).toEqual([0.5]);
  });

  it("allows a REMOTE host when local-only is off (cloud/remote allowed by default)", async () => {
    process.env.MUSE_LOCAL_ONLY = "false";
    const result = await embed("x", "m", { ...opts(okJson({ embedding: [0.5] })), baseUrlResolver: () => "http://192.168.1.50:11434" });
    expect(result).toEqual([0.5]);
  });

  it("treats requireLocalOnly as one-way: explicit true tightens transport and an unsafe false cannot weaken ambient local-only", async () => {
    let calls = 0;
    const fetchImpl: typeof globalThis.fetch = async (...args) => {
      calls += 1;
      return okJson({ embedding: [0.5] })(...args);
    };
    process.env.MUSE_LOCAL_ONLY = "false";
    await expect(embed("private", "m", {
      baseUrlResolver: () => "http://192.168.1.50:11434",
      fetchImpl,
      requireLocalOnly: true
    })).rejects.toThrow(/local-only|cloud provider/u);
    process.env.MUSE_LOCAL_ONLY = "true";
    await expect(embed("private", "m", {
      baseUrlResolver: () => "http://192.168.1.50:11434",
      fetchImpl,
      // Runtime input can be untyped JS; false must remain powerless.
      ...( { requireLocalOnly: false } as unknown as { requireLocalOnly?: true })
    })).rejects.toThrow(/local-only|cloud provider/u);
    expect(calls).toBe(0);
  });

  it("canonicalizes actual local-only embedding fetches to numeric loopback and refuses ambiguous bases before fetch", async () => {
    process.env.MUSE_LOCAL_ONLY = "true";
    delete process.env.OLLAMA_BASE_URL;
    const urls: string[] = [];
    const captureFetch: typeof globalThis.fetch = async (input) => {
      urls.push(String(input));
      return new Response(JSON.stringify({ embedding: [0.5] }), { status: 200 });
    };

    await expect(embed("default Ollama", "m", { fetchImpl: captureFetch })).resolves.toEqual([0.5]);
    await expect(embed("explicit localhost", "m", {
      baseUrlResolver: () => "http://localhost:11435",
      fetchImpl: captureFetch
    })).resolves.toEqual([0.5]);
    expect(urls).toEqual([
      "http://127.0.0.1:11434/api/embeddings",
      "http://127.0.0.1:11435/api/embeddings"
    ]);

    for (const baseUrl of [
      "http://0.0.0.0:11434",
      "http://foo.localhost:11434",
      "http://user:pass@localhost:11434",
      "https://localhost:11434",
      "http://192.168.1.50:11434",
      "not a URL"
    ]) {
      await expect(embed("private", "m", { baseUrlResolver: () => baseUrl, fetchImpl: captureFetch }), baseUrl)
        .rejects.toThrow(/local-only|local only|MUSE_LOCAL_ONLY/u);
    }
    expect(urls).toHaveLength(2);
  });
});
