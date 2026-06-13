import { describe, expect, it } from "vitest";

import { resolveEmbedderBase } from "../src/embedder-base.js";

describe("resolveEmbedderBase — shared embedder base resolution (runtime guard ↔ doctor posture parity)", () => {
  it("unset OLLAMA_BASE_URL ⇒ loopback default", () => {
    expect(resolveEmbedderBase({})).toBe("http://127.0.0.1:11434");
  });

  it("empty / whitespace OLLAMA_BASE_URL ⇒ treated as unset (loopback default)", () => {
    expect(resolveEmbedderBase({ OLLAMA_BASE_URL: "" })).toBe("http://127.0.0.1:11434");
    expect(resolveEmbedderBase({ OLLAMA_BASE_URL: "   " })).toBe("http://127.0.0.1:11434");
  });

  it("strips trailing slashes", () => {
    expect(resolveEmbedderBase({ OLLAMA_BASE_URL: "http://192.168.1.50:11434/" })).toBe("http://192.168.1.50:11434");
    expect(resolveEmbedderBase({ OLLAMA_BASE_URL: "http://127.0.0.1:11434///" })).toBe("http://127.0.0.1:11434");
  });

  it("trims and passes through a remote base", () => {
    expect(resolveEmbedderBase({ OLLAMA_BASE_URL: "  http://192.168.1.50:11434  " })).toBe("http://192.168.1.50:11434");
  });
});
