import { type ModelProvider, type ModelRequest, type TokenLogprob } from "@muse/model";
import { describe, expect, it } from "vitest";

import { createAgentRuntime, summarizeTokenConfidence } from "../src/index.js";

const SAMPLE_LOGPROBS: TokenLogprob[] = [
  { logprob: -0.2, token: "Paris" },
  { logprob: -0.4, token: "." }
];

/**
 * Capture the ModelRequest the runtime sends + return logprobs so the round-trip
 * (AgentRunInput.logprobs → ModelRequest.logprobs → AgentRunResult.response.logprobs)
 * can be graded end to end — the prerequisite for confidence-gated cascade on an
 * agent run (summarizeTokenConfidence is the ready consumer).
 */
function captureProvider(sink: { request?: ModelRequest }): ModelProvider {
  return {
    id: "capture",
    async generate(request) {
      sink.request = request;
      return { id: "r", logprobs: SAMPLE_LOGPROBS, model: request.model, output: "Paris." };
    },
    async listModels() {
      return [];
    },
    async *stream() {}
  };
}

describe("agent runtime — opt-in logprobs round-trip", () => {
  it("forwards input.logprobs to the ModelRequest and returns them in the result", async () => {
    const sink: { request?: ModelRequest } = {};
    const runtime = createAgentRuntime({ modelProvider: captureProvider(sink) });

    const result = await runtime.run({
      logprobs: true,
      messages: [{ content: "capital of France?", role: "user" }],
      model: "capture/model",
      runId: "lp-1"
    });

    expect(sink.request?.logprobs).toBe(true);
    expect(result.response.logprobs).toEqual(SAMPLE_LOGPROBS);
    // the whole point: confidence is now scorable on an agent run
    expect(summarizeTokenConfidence(result.response.logprobs ?? [])?.meanLogprob).toBeCloseTo(-0.3, 5);
  });

  it("forwards topLogprobs alongside logprobs when requested", async () => {
    const sink: { request?: ModelRequest } = {};
    const runtime = createAgentRuntime({ modelProvider: captureProvider(sink) });

    await runtime.run({
      logprobs: true,
      messages: [{ content: "hi", role: "user" }],
      model: "capture/model",
      runId: "lp-2",
      topLogprobs: 5
    });

    expect(sink.request?.logprobs).toBe(true);
    expect(sink.request?.topLogprobs).toBe(5);
  });

  it("does NOT add logprobs to the ModelRequest by default (byte-identical wire)", async () => {
    const sink: { request?: ModelRequest } = {};
    const runtime = createAgentRuntime({ modelProvider: captureProvider(sink) });

    await runtime.run({
      messages: [{ content: "hi", role: "user" }],
      model: "capture/model",
      runId: "lp-3"
    });

    expect(sink.request).not.toHaveProperty("logprobs");
    expect(sink.request).not.toHaveProperty("topLogprobs");
  });
});
