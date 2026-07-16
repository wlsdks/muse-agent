import { describe, expect, it } from "vitest";

import { modelChip } from "./model-chip.js";

describe("modelChip", () => {
  it("classifies ollama as local", () => {
    expect(modelChip("ollama/gemma4:12b")).toEqual({ locality: "local", name: "gemma4:12b" });
  });

  it("classifies lmstudio and diagnostic as local", () => {
    expect(modelChip("lmstudio/qwen3:8b")?.locality).toBe("local");
    expect(modelChip("diagnostic/smoke")?.locality).toBe("local");
  });

  it("classifies known cloud providers as cloud", () => {
    expect(modelChip("anthropic/claude-opus-4-8")).toEqual({ locality: "cloud", name: "claude-opus-4-8" });
    expect(modelChip("openai/gpt-5")?.locality).toBe("cloud");
    expect(modelChip("gemini/gemini-2.5-pro")?.locality).toBe("cloud");
    expect(modelChip("openrouter/meta/llama-4")?.locality).toBe("cloud");
  });

  it("keeps the full model id after the first slash", () => {
    expect(modelChip("openrouter/meta/llama-4")?.name).toBe("meta/llama-4");
  });

  it("never guesses locality for an unknown provider", () => {
    expect(modelChip("openai-compatible/some-model")?.locality).toBe("unknown");
  });

  it("handles a bare model name without provider", () => {
    expect(modelChip("gemma4:12b")).toEqual({ locality: "unknown", name: "gemma4:12b" });
  });

  it("returns undefined for empty input", () => {
    expect(modelChip(undefined)).toBeUndefined();
    expect(modelChip("  ")).toBeUndefined();
  });
});
