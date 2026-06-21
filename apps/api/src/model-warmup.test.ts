import type { ModelProvider, ModelRequest } from "@muse/model";
import { describe, expect, it } from "vitest";

import { warmUpModelIfConfigured } from "./model-warmup.js";

function captureProvider(sink: { request?: ModelRequest; calls: number }): ModelProvider {
  return {
    id: "capture",
    async generate(request) {
      sink.calls += 1;
      sink.request = request;
      return { id: "r", model: request.model, output: "ok" };
    },
    async listModels() {
      return [];
    },
    async *stream() {}
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("warmUpModelIfConfigured", () => {
  it("fires a tiny generate on the default model when MUSE_WARMUP_MODEL is set", async () => {
    const sink: { request?: ModelRequest; calls: number } = { calls: 0 };
    warmUpModelIfConfigured(
      { MUSE_WARMUP_MODEL: "1" },
      { defaultModel: "ollama/gemma4:12b", modelProvider: captureProvider(sink) }
    );
    await flush();
    expect(sink.calls).toBe(1);
    expect(sink.request?.model).toBe("ollama/gemma4:12b");
    expect(sink.request?.maxOutputTokens).toBe(1); // minimal load, not a real generation
  });

  it("does NOTHING by default (warmup unset → byte-identical startup, no model call)", async () => {
    const sink: { request?: ModelRequest; calls: number } = { calls: 0 };
    warmUpModelIfConfigured(
      {},
      { defaultModel: "ollama/gemma4:12b", modelProvider: captureProvider(sink) }
    );
    await flush();
    expect(sink.calls).toBe(0);
  });

  it("does nothing when no provider or no default model is configured (guard)", async () => {
    const sink: { request?: ModelRequest; calls: number } = { calls: 0 };
    warmUpModelIfConfigured({ MUSE_WARMUP_MODEL: "1" }, { defaultModel: "m" }); // no provider
    warmUpModelIfConfigured({ MUSE_WARMUP_MODEL: "1" }, { modelProvider: captureProvider(sink) }); // no model
    await flush();
    expect(sink.calls).toBe(0);
  });

  it("is FAIL-SOFT — a throwing provider never throws out of warmUpModelIfConfigured (server start must not break)", async () => {
    const thrower: ModelProvider = {
      id: "boom",
      generate: () => { throw new Error("ollama not up"); },
      async listModels() { return []; },
      async *stream() {}
    };
    expect(() => warmUpModelIfConfigured({ MUSE_WARMUP_MODEL: "1" }, { defaultModel: "m", modelProvider: thrower })).not.toThrow();
    await flush(); // the rejected warmup promise is swallowed, no unhandled rejection
  });

  it("is FAIL-SOFT for an ASYNC rejection too (the .catch swallows a rejected generate, no unhandled rejection)", async () => {
    const rejecter: ModelProvider = {
      id: "reject",
      generate: () => Promise.reject(new Error("ollama 500")),
      async listModels() { return []; },
      async *stream() {}
    };
    let unhandled = false;
    const onUnhandled = () => { unhandled = true; };
    process.on("unhandledRejection", onUnhandled);
    try {
      warmUpModelIfConfigured({ MUSE_WARMUP_MODEL: "1" }, { defaultModel: "m", modelProvider: rejecter });
      await flush();
      await flush();
      expect(unhandled).toBe(false);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
