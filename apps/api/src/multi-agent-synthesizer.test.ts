import type { ModelProvider } from "@muse/model";
import { describe, expect, it } from "vitest";

import { createWorkerSynthesizer } from "./multi-agent-workers.js";

// Direct coverage for createWorkerSynthesizer (untested) — the swarm fan-in that
// folds each worker's output into one synthesized answer. No model → no
// synthesizer (the caller falls back); with a model it labels each part by
// workerId, calls the synthesis prompt, and trims the result.

describe("createWorkerSynthesizer", () => {
  it("returns undefined when no model provider is configured", () => {
    expect(createWorkerSynthesizer(undefined, "m")).toBeUndefined();
  });

  it("joins each worker part under its id, calls the synthesis prompt at temp 0.3, and trims the output", async () => {
    let captured: { messages: { role: string; content: string }[]; model: string; temperature: number } | undefined;
    const provider = { generate: async (req: typeof captured) => { captured = req; return { output: "  synthesized answer  " }; } } as unknown as ModelProvider;

    const synth = createWorkerSynthesizer(provider, "qwen");
    expect(typeof synth).toBe("function");
    const out = await synth!([{ output: "a", workerId: "phone" }, { output: "b", workerId: "laptop" }]);

    expect(out).toBe("synthesized answer"); // trimmed
    expect(captured?.messages[1]?.content).toBe("### phone\na\n\n### laptop\nb"); // labeled by workerId
    expect(captured?.messages[0]?.role).toBe("system");
    expect(captured?.model).toBe("qwen");
    expect(captured?.temperature).toBe(0.3);
  });

  it("returns an empty string when the model yields no output", async () => {
    const provider = { generate: async () => ({}) } as unknown as ModelProvider;
    const synth = createWorkerSynthesizer(provider, "m");
    expect(await synth!([{ output: "y", workerId: "x" }])).toBe("");
  });
});
