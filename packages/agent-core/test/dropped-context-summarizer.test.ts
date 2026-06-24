import { describe, expect, it } from "vitest";

import type { ModelProvider, ModelRequest } from "@muse/model";
import type { ConversationMessage } from "@muse/memory";

import { createModelDroppedContextSummarizer } from "../src/index.js";

function fakeProvider(output: string, capture?: (req: ModelRequest) => void): ModelProvider {
  return {
    id: "fake",
    async listModels() { return []; },
    async generate(request: ModelRequest) {
      capture?.(request);
      return { id: "r", model: request.model, output };
    },
    async *stream() { /* unused */ }
  };
}

const dropped: ConversationMessage[] = [
  { content: "we agreed to ship Friday", role: "assistant" },
  { content: "what about the migration?", role: "user" }
];

describe("createModelDroppedContextSummarizer (CMP-2 production summarizer)", () => {
  it("returns the model's output as the summary", async () => {
    const summarize = createModelDroppedContextSummarizer(fakeProvider("Friday ship; migration open."), "ollama/gemma4:12b");
    expect(await summarize(dropped)).toBe("Friday ship; migration open.");
  });

  it("sends the dropped turns (role + content) to the configured model", async () => {
    let seen: ModelRequest | undefined;
    const summarize = createModelDroppedContextSummarizer(fakeProvider("ok", (r) => { seen = r; }), "ollama/gemma4:12b");
    await summarize(dropped);
    expect(seen?.model).toBe("ollama/gemma4:12b");
    const userMsg = seen?.messages.find((m) => m.role === "user");
    expect(userMsg?.content).toContain("we agreed to ship Friday");
    expect(userMsg?.content).toContain("what about the migration?");
    // a system instruction frames the summarization task
    expect(seen?.messages.some((m) => m.role === "system")).toBe(true);
  });

  it("propagates a provider error (fail-open handled upstream by summarizeDroppedContext)", async () => {
    const provider: ModelProvider = {
      id: "boom", async listModels() { return []; },
      async generate() { throw new Error("ollama down"); },
      async *stream() { /* unused */ }
    };
    const summarize = createModelDroppedContextSummarizer(provider, "m");
    await expect(summarize(dropped)).rejects.toThrow(/ollama down/);
  });
});
