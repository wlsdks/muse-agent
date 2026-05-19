import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resolveOllamaUrl } from "./ollama-url.js";

describe("resolveOllamaUrl", () => {
  beforeEach(() => {
    vi.stubEnv("OLLAMA_BASE_URL", "");
    const dir = mkdtempSync(join(tmpdir(), "muse-ollama-url-"));
    vi.stubEnv("MUSE_MODEL_KEYS_FILE", join(dir, "models.json"));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("falls back to the local default when nothing is configured", () => {
    expect(resolveOllamaUrl()).toBe("http://127.0.0.1:11434");
  });

  it("returns the env-configured URL when set", () => {
    vi.stubEnv("OLLAMA_BASE_URL", "http://ollama.lan:11434");
    expect(resolveOllamaUrl()).toBe("http://ollama.lan:11434");
  });

  it("strips trailing slashes so callers can append `/api/embeddings` cleanly", () => {
    vi.stubEnv("OLLAMA_BASE_URL", "http://x:11434/");
    expect(resolveOllamaUrl()).toBe("http://x:11434");
    vi.stubEnv("OLLAMA_BASE_URL", "http://x:11434///");
    expect(resolveOllamaUrl()).toBe("http://x:11434");
  });

  it("treats whitespace-only env as unset and uses the default", () => {
    vi.stubEnv("OLLAMA_BASE_URL", "   ");
    expect(resolveOllamaUrl()).toBe("http://127.0.0.1:11434");
  });
});
