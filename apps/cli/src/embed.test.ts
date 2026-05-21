import { describe, expect, it } from "vitest";

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
