import { afterEach, describe, expect, it, vi } from "vitest";

import { applyAdHocGrounding } from "./ask-adhoc-grounding.js";

afterEach(() => {
  delete process.env.MUSE_LOCAL_ONLY;
});

describe("applyAdHocGrounding — local-only URL closure", () => {
  it("does not fetch, extract, or record URL provenance when local-only is enabled", async () => {
    const fetch = vi.fn(async () => new Response("<p>must not fetch</p>", { status: 200, headers: { "content-type": "text/html" } }));
    const stderr: string[] = [];
    const scored: Array<{ chunk: { chunkIndex: number; embedding: number[]; file: string; text: string }; file: string; score: number }> = [];
    const targets = new Map<string, string | null>();
    process.env.MUSE_LOCAL_ONLY = "true";
    await applyAdHocGrounding({
        adHocVerifyTargets: targets,
        fetchImpl: fetch as unknown as typeof globalThis.fetch,
        notesUnavailable: true,
        onStderr: (text) => { stderr.push(text); },
        options: { url: "https://example.test/report" },
        query: "summarize",
        scored
      });
    expect(stderr.join("")).toBe("muse: interactive public-web access is blocked by local-only.\n");
    expect(fetch).not.toHaveBeenCalled();
    expect(scored).toEqual([]);
    expect(targets.size).toBe(0);
  });

  it("records the helper-owned manual redirect finalUrl, never a hostile response.url", async () => {
    const calls: string[] = [];
    const stderr: string[] = [];
    const scored: Array<{ chunk: { chunkIndex: number; embedding: number[]; file: string; text: string }; file: string; score: number }> = [];
    const targets = new Map<string, string | null>();
    let turn = 0;
    const fetchImpl = (async (input) => {
      calls.push(String(input));
      turn += 1;
      if (turn === 1) return new Response("redirect", { status: 302, headers: { location: "/final" } });
      const final = new Response("<title>Final</title><p>Quarterly revenue reached 42.</p>", { status: 200, headers: { "content-type": "text/html" } });
      Object.defineProperty(final, "url", { value: "https://attacker.test/wrong" });
      return final;
    }) as typeof globalThis.fetch;
    await applyAdHocGrounding({
        adHocVerifyTargets: targets,
        fetchImpl,
        notesUnavailable: true,
        onStderr: (text) => { stderr.push(text); },
        options: { json: true, url: "https://93.184.216.34/start" },
        query: "what was quarterly revenue",
        scored
      });
    expect(calls).toEqual(["https://93.184.216.34/start", "https://93.184.216.34/final"]);
    expect([...targets.values()]).toEqual(["https://93.184.216.34/final"]);
    expect(scored.map((item) => item.chunk.text).join(" ")).toContain("revenue reached 42");
    expect(stderr.join("")).toBe("");
  });
});
