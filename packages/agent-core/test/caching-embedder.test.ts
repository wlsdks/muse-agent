import { describe, expect, it, vi } from "vitest";

import { createCachingEmbedder } from "../src/index.js";

describe("createCachingEmbedder", () => {
  it("embeds each distinct text once and returns the cached vector on repeat", async () => {
    const spy = vi.fn(async (text: string) => [text.length]);
    const embed = createCachingEmbedder(spy);

    expect(await embed("alpha")).toEqual([5]);
    expect(await embed("alpha")).toEqual([5]); // cache hit
    expect(await embed("bb")).toEqual([2]);
    expect(await embed("alpha")).toEqual([5]); // still cached

    expect(spy).toHaveBeenCalledTimes(2); // "alpha" + "bb" only
  });

  it("dedupes concurrent calls for the same text into one embed", async () => {
    const spy = vi.fn(async (text: string) => [text.length]);
    const embed = createCachingEmbedder(spy);
    await Promise.all([embed("x"), embed("x"), embed("x")]);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("evicts oldest beyond maxEntries (FIFO)", async () => {
    const spy = vi.fn(async (text: string) => [text.length]);
    const embed = createCachingEmbedder(spy, { maxEntries: 2 });
    await embed("a");
    await embed("b");
    await embed("c"); // "a" evicted
    await embed("a"); // recomputed
    expect(spy).toHaveBeenCalledTimes(4); // a, b, c, a-again
  });

  it("does NOT cache a failed embed — a later call retries", async () => {
    let calls = 0;
    const embed = createCachingEmbedder(async (text: string) => {
      calls += 1;
      if (calls === 1) throw new Error("ollama down");
      return [text.length];
    });
    await expect(embed("q")).rejects.toThrow("ollama down");
    expect(await embed("q")).toEqual([1]); // retried, not cached failure
    expect(calls).toBe(2);
  });
});
