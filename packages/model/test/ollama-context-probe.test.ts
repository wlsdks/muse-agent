import { describe, expect, it, vi } from "vitest";

import { OllamaProvider, extractOllamaContextLength, probeOllamaContextWindow } from "../src/index.js";
import type { ModelRequest } from "../src/index.js";

const userReq = (over: Partial<ModelRequest> = {}): ModelRequest => ({
  messages: [{ content: "hi", role: "user" }],
  model: "ollama/gemma4:12b",
  ...over
});

// A fetch fake that routes by URL: /api/show returns the given show payload,
// everything else (i.e. /api/chat) returns a trivial chat response and records
// the last chat body. This mirrors the contract-faithful two-endpoint shape.
function routedFetch(show: { ok?: boolean; status?: number; payload: unknown }) {
  const state: { chatBody: Record<string, unknown> | undefined; showCalls: number } = {
    chatBody: undefined,
    showCalls: 0
  };
  const fetchImpl = (async (url: string, init: { body: string }) => {
    if (url.endsWith("/api/show")) {
      state.showCalls += 1;
      return {
        ok: show.ok ?? true,
        status: show.status ?? 200,
        statusText: "OK",
        text: async () => (typeof show.payload === "string" ? show.payload : JSON.stringify(show.payload))
      } as unknown as Response;
    }
    state.chatBody = JSON.parse(init.body) as Record<string, unknown>;
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => JSON.stringify({ message: { content: "ok" } })
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, state };
}

const numCtxOf = (body: Record<string, unknown> | undefined): unknown =>
  (body?.options as Record<string, unknown> | undefined)?.num_ctx;

describe("extractOllamaContextLength", () => {
  it("reads the architecture-prefixed context_length (real gemma4 shape)", () => {
    expect(extractOllamaContextLength({ "gemma4.context_length": 262_144, "general.architecture": "gemma4" })).toBe(262_144);
  });

  it("falls back to any *.context_length key when architecture is absent", () => {
    expect(extractOllamaContextLength({ "qwen3.context_length": 40_960 })).toBe(40_960);
  });

  it("truncates a fractional value", () => {
    expect(extractOllamaContextLength({ "general.architecture": "x", "x.context_length": 4096.9 })).toBe(4096);
  });

  it("returns undefined for missing / non-numeric / non-object shapes", () => {
    expect(extractOllamaContextLength(undefined)).toBeUndefined();
    expect(extractOllamaContextLength({})).toBeUndefined();
    expect(extractOllamaContextLength({ "x.context_length": "big" })).toBeUndefined();
    expect(extractOllamaContextLength({ "x.context_length": -5 })).toBeUndefined();
    expect(extractOllamaContextLength([])).toBeUndefined();
  });
});

describe("probeOllamaContextWindow", () => {
  it("returns the model's native context length from a mocked /api/show", async () => {
    const { fetchImpl } = routedFetch({ payload: { model_info: { "gemma4.context_length": 262_144, "general.architecture": "gemma4" } } });
    expect(await probeOllamaContextWindow("http://127.0.0.1:11434/v1", "gemma4:12b", fetchImpl)).toBe(262_144);
  });

  it("posts {name} to <base>/api/show, stripping any /v1 suffix and ollama/ prefix", async () => {
    let seenUrl = "";
    let seenBody: Record<string, unknown> = {};
    const fetchImpl = (async (url: string, init: { body: string }) => {
      seenUrl = url;
      seenBody = JSON.parse(init.body) as Record<string, unknown>;
      return { ok: true, status: 200, statusText: "OK", text: async () => JSON.stringify({ model_info: { "gemma4.context_length": 100 } }) } as unknown as Response;
    }) as unknown as typeof fetch;
    await probeOllamaContextWindow("http://127.0.0.1:11434/v1", "ollama/gemma4:12b", fetchImpl);
    expect(seenUrl).toBe("http://127.0.0.1:11434/api/show");
    expect(seenBody).toEqual({ name: "gemma4:12b" });
  });

  it("fails soft (undefined) on a non-200 response", async () => {
    const { fetchImpl } = routedFetch({ ok: false, payload: "not found", status: 404 });
    expect(await probeOllamaContextWindow("http://127.0.0.1:11434", "missing", fetchImpl)).toBeUndefined();
  });

  it("fails soft (undefined) on a non-JSON body", async () => {
    const { fetchImpl } = routedFetch({ payload: "<html>proxy</html>" });
    expect(await probeOllamaContextWindow("http://127.0.0.1:11434", "gemma4:12b", fetchImpl)).toBeUndefined();
  });

  it("fails soft (undefined) on a thrown fetch (does not propagate)", async () => {
    const fetchImpl = (async () => {
      throw new Error("connection refused");
    }) as unknown as typeof fetch;
    await expect(probeOllamaContextWindow("http://127.0.0.1:11434", "gemma4:12b", fetchImpl)).resolves.toBeUndefined();
  });

  it("returns undefined for an empty model name", async () => {
    const fetchImpl = vi.fn();
    expect(await probeOllamaContextWindow("http://127.0.0.1:11434", "  ", fetchImpl as unknown as typeof fetch)).toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("OllamaProvider — context-probe enrichment (opt-in)", () => {
  it("does NOT probe and does NOT change num_ctx when the flag is off (default)", async () => {
    const { fetchImpl, state } = routedFetch({ payload: { model_info: { "gemma4.context_length": 4096 } } });
    const p = new OllamaProvider({ fetch: fetchImpl, numCtx: 32_768 });
    await p.generate(userReq());
    expect(state.showCalls).toBe(0);
    expect(numCtxOf(state.chatBody)).toBe(32_768);
  });

  it("clamps num_ctx DOWN to the live window when configured larger", async () => {
    const warn = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const { fetchImpl, state } = routedFetch({ payload: { model_info: { "gemma4.context_length": 8192, "general.architecture": "gemma4" } } });
    const p = new OllamaProvider({ fetch: fetchImpl, numCtx: 32_768, probeContextWindow: true });
    await p.generate(userReq());
    expect(state.showCalls).toBe(1);
    expect(numCtxOf(state.chatBody)).toBe(8192);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("clamping to 8192"));
    warn.mockRestore();
  });

  it("leaves num_ctx unchanged when the live window is larger or equal", async () => {
    const { fetchImpl, state } = routedFetch({ payload: { model_info: { "gemma4.context_length": 262_144 } } });
    const p = new OllamaProvider({ fetch: fetchImpl, numCtx: 32_768, probeContextWindow: true });
    await p.generate(userReq());
    expect(numCtxOf(state.chatBody)).toBe(32_768);
  });

  it("leaves num_ctx unchanged (no behaviour change) when the probe fails soft", async () => {
    const { fetchImpl, state } = routedFetch({ ok: false, payload: "boom", status: 500 });
    const p = new OllamaProvider({ fetch: fetchImpl, numCtx: 32_768, probeContextWindow: true });
    await p.generate(userReq());
    expect(numCtxOf(state.chatBody)).toBe(32_768);
  });

  it("probes once per model and caches (second generate makes no new /api/show call)", async () => {
    const { fetchImpl, state } = routedFetch({ payload: { model_info: { "gemma4.context_length": 8192 } } });
    const warn = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const p = new OllamaProvider({ fetch: fetchImpl, numCtx: 32_768, probeContextWindow: true });
    await p.generate(userReq());
    await p.generate(userReq());
    expect(state.showCalls).toBe(1);
    // The clamp warning fires only once across both calls.
    expect(warn.mock.calls.filter((c) => String(c[0]).includes("clamping"))).toHaveLength(1);
    warn.mockRestore();
  });

  it("keeps a shared probe alive when one caller aborts while another stream waits", async () => {
    let resolveShow!: (response: Response) => void;
    const show = new Promise<Response>((resolve) => { resolveShow = resolve; });
    const chatBodies: Record<string, unknown>[] = [];
    let showCalls = 0;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      if (url.endsWith("/api/show")) {
        showCalls += 1;
        return show;
      }
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      chatBodies.push(body);
      return body.stream === true
        ? new Response(`${JSON.stringify({ done: true, message: { content: "ok" }, model: "gemma4:12b" })}\n`)
        : new Response(JSON.stringify({ message: { content: "ok" } }));
    }) as typeof fetch;
    const provider = new OllamaProvider({ fetch: fetchImpl, numCtx: 32_768, probeContextWindow: true });
    const controller = new AbortController();
    const cancelled = provider.generate(userReq({ signal: controller.signal }));
    const iterator = provider.stream(userReq())[Symbol.asyncIterator]();
    const streamed = iterator.next();
    await vi.waitFor(() => expect(showCalls).toBe(1));
    controller.abort("private");
    resolveShow(new Response(JSON.stringify({ model_info: { "gemma4.context_length": 8192 } })));

    await expect(cancelled).rejects.toMatchObject({ retryable: false });
    await expect(streamed).resolves.toMatchObject({ done: false, value: { type: "text-delta" } });
    await expect(iterator.next()).resolves.toMatchObject({ done: false, value: { type: "done" } });
    expect(chatBodies).toHaveLength(1);
    expect(numCtxOf(chatBodies[0])).toBe(8192);
    await provider.generate(userReq());
    expect(showCalls).toBe(1);
  });
});
