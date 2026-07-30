import type { ModelProvider, ModelRequest } from "@muse/model";
import { describe, expect, it, vi } from "vitest";

import { admitAuxiliaryModel } from "../src/autoconfigure-model-provider.js";
import { createCompactionAuxiliary } from "../src/compaction-auxiliary.js";

function provider(generate: (request: ModelRequest) => string): ModelProvider {
  return {
    generate: async (request) => ({
      id: "response",
      model: request.model,
      output: generate(request),
      toolCalls: []
    }),
    id: "test-provider",
    listModels: async () => []
  };
}

describe("compaction auxiliary admission", () => {
  it("keeps a cloud override on the local session provider with an explicit reason", async () => {
    const seen = vi.fn((_request: ModelRequest) => "short summary");
    const auxiliary = createCompactionAuxiliary(
      provider(seen),
      "ollama/gemma4:12b",
      {
        MUSE_AUX_COMPACTION_MODEL: "openai/gpt-4o",
        MUSE_LOCAL_ONLY: "true"
      }
    );

    expect(auxiliary.admission).toMatchObject({
      available: true,
      fallbackReason: "local-only-cloud-override-blocked",
      model: "ollama/gemma4:12b",
      route: "local"
    });
    await auxiliary.summarizer!([
      { content: "A long personal transcript that should become much shorter.", role: "user" }
    ]);
    expect(seen).toHaveBeenCalledOnce();
    expect(seen.mock.calls[0]?.[0].model).toBe("ollama/gemma4:12b");
  });

  it("does not construct or call a summarizer for incoherent local-only cloud session state", () => {
    const generate = vi.fn((_request: ModelRequest) => "must not run");
    const auxiliary = createCompactionAuxiliary(
      provider(generate),
      "openai/gpt-4o",
      { MUSE_LOCAL_ONLY: "true" }
    );

    expect(auxiliary).toEqual({
      admission: {
        available: false,
        reason: "local-only-no-local-model",
        route: "cloud",
        task: "compaction"
      }
    });
    expect(auxiliary.summarizer).toBeUndefined();
    expect(generate).not.toHaveBeenCalled();
  });

  it("uses an allowed same-provider auxiliary model", async () => {
    const seen = vi.fn((_request: ModelRequest) => "short summary");
    const auxiliary = createCompactionAuxiliary(
      provider(seen),
      "ollama/gemma4:12b",
      { MUSE_AUX_COMPACTION_MODEL: "ollama/qwen3:8b" }
    );

    expect(auxiliary.admission).toMatchObject({
      available: true,
      model: "ollama/qwen3:8b"
    });
    await auxiliary.summarizer!([
      { content: "A long transcript that should become much shorter.", role: "user" }
    ]);
    expect(seen.mock.calls[0]?.[0].model).toBe("ollama/qwen3:8b");
  });

  it("falls back instead of sending a different-provider model through the current adapter", () => {
    expect(admitAuxiliaryModel({
      env: { MUSE_AUX_JUDGE_MODEL: "gemini/gemini-2.0-flash" },
      sessionModel: "ollama/gemma4:12b",
      task: "judge"
    })).toMatchObject({
      available: true,
      fallbackReason: "provider-adapter-unavailable",
      model: "ollama/gemma4:12b",
      source: "session"
    });
  });
});
