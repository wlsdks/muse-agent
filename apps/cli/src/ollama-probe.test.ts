import { describe, expect, it, vi } from "vitest";

import { probeOllamaLoadedModels } from "./ollama-probe.js";

describe("probeOllamaLoadedModels", () => {
  it("uses only local GET /api/ps and parses bounded loaded-model fields", async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({ models: [{
      context_length: 8192,
      expires_at: "2026-07-22T08:00:00.000Z",
      name: "qwen3:8b",
      size: 5_000_000_000,
      size_vram: 4_000_000_000
    }] }), { status: 200 }));
    const result = await probeOllamaLoadedModels("http://127.0.0.1:11434", { fetchImpl });

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("http://127.0.0.1:11434/api/ps");
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({ method: "GET" });
    expect(result).toMatchObject({
      models: [{ contextLength: 8192, expiresAt: "2026-07-22T08:00:00.000Z", name: "qwen3:8b", size: 5_000_000_000, sizeVram: 4_000_000_000 }],
      reachable: true
    });
  });

  it("fails closed before fetch for a configured non-loopback host", async () => {
    const fetchImpl = vi.fn();
    await expect(probeOllamaLoadedModels("https://ollama.example.com", { fetchImpl })).resolves.toEqual({
      models: [], reachable: false, reason: "non-local-url"
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
