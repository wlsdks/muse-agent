import { LocalOnlyViolationError } from "@muse/model";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createOllamaEmbedder } from "../src/context-engineering-builders.js";

const ORIGINAL_ENV = { ...process.env };

function resetEnv(): void {
  for (const key of ["OLLAMA_BASE_URL", "MUSE_LOCAL_ONLY"]) {
    delete process.env[key];
  }
  if (ORIGINAL_ENV.OLLAMA_BASE_URL !== undefined) process.env.OLLAMA_BASE_URL = ORIGINAL_ENV.OLLAMA_BASE_URL;
  if (ORIGINAL_ENV.MUSE_LOCAL_ONLY !== undefined) process.env.MUSE_LOCAL_ONLY = ORIGINAL_ENV.MUSE_LOCAL_ONLY;
}

describe("createOllamaEmbedder — MUSE_LOCAL_ONLY fail-close on remote OLLAMA_BASE_URL", () => {
  afterEach(() => {
    resetEnv();
    vi.restoreAllMocks();
  });

  it("refuses LOUD when local-only (default) and OLLAMA_BASE_URL is a remote host — private text never POSTs", async () => {
    process.env.OLLAMA_BASE_URL = "http://192.168.1.50:11434";
    delete process.env.MUSE_LOCAL_ONLY; // default ON

    const fetchSpy = vi.spyOn(globalThis, "fetch");

    // Fail-close at construction: the embedder must throw before any caller
    // can hand it private note/memory text. A lazy embedder that only throws
    // on first call still risks an unguarded call site POSTing first.
    expect(() => createOllamaEmbedder("nomic-embed-text-v2-moe")).toThrow(LocalOnlyViolationError);

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses an explicit MUSE_LOCAL_ONLY=true with a remote host", () => {
    process.env.OLLAMA_BASE_URL = "https://ollama.example.com";
    process.env.MUSE_LOCAL_ONLY = "true";
    expect(() => createOllamaEmbedder("nomic-embed-text-v2-moe")).toThrow(LocalOnlyViolationError);
  });

  it("allows a loopback OLLAMA_BASE_URL under local-only", async () => {
    process.env.OLLAMA_BASE_URL = "http://127.0.0.1:11434";
    delete process.env.MUSE_LOCAL_ONLY;
    const embed = createOllamaEmbedder("nomic-embed-text-v2-moe");

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ embedding: [0.1, 0.2] }), { status: 200 })
    );
    const vec = await embed("hello");
    expect(vec).toEqual([0.1, 0.2]);
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it("allows the default (unset) base URL under local-only — built-in 127.0.0.1", () => {
    delete process.env.OLLAMA_BASE_URL;
    delete process.env.MUSE_LOCAL_ONLY;
    expect(() => createOllamaEmbedder("nomic-embed-text-v2-moe")).not.toThrow();
  });

  it("allows localhost by name under local-only", () => {
    process.env.OLLAMA_BASE_URL = "http://localhost:11434";
    delete process.env.MUSE_LOCAL_ONLY;
    expect(() => createOllamaEmbedder("nomic-embed-text-v2-moe")).not.toThrow();
  });

  it("permits a remote host when local-only is explicitly opted OUT (MUSE_LOCAL_ONLY=false)", async () => {
    process.env.OLLAMA_BASE_URL = "http://192.168.1.50:11434";
    process.env.MUSE_LOCAL_ONLY = "false";
    const embed = createOllamaEmbedder("nomic-embed-text-v2-moe");

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ embedding: [0.3] }), { status: 200 })
    );
    const vec = await embed("hello");
    expect(vec).toEqual([0.3]);
    expect(fetchSpy).toHaveBeenCalledOnce();
    const calledUrl = fetchSpy.mock.calls[0]?.[0];
    expect(String(calledUrl)).toContain("192.168.1.50");
  });
});
