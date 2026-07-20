/**
 * The leak this pins is not hypothetical: `composeSurfacePrompt` sets
 * `includeCacheBoundary: true` for EVERY surface (compose.ts), so every
 * composed system prompt carries `<!-- MUSE_CACHE_BOUNDARY -->`. Nothing
 * consumes it yet, so without a strip at the provider boundary the raw
 * marker reaches the model on every turn.
 *
 * These assert the request the PROVIDER actually received, not that the
 * helper works in isolation — the sanitizer existed before and was correct,
 * but deleting its wiring (e96a73cae) is what let the marker through.
 */

import { describe, expect, it } from "vitest";

import { composeSurfacePrompt, MUSE_CACHE_BOUNDARY_MARKER } from "@muse/prompts";
import type { ModelProvider, ModelRequest, ModelResponse } from "@muse/model";
import { InMemoryAgentMetrics, InMemoryMuseTracer } from "@muse/observability";

import { invokeModel } from "../src/model-invocation.js";

function capturingProvider(seen: ModelRequest[]): ModelProvider {
  return {
    id: "test-provider",
    listModels: async () => [],
    generate: async (request: ModelRequest): Promise<ModelResponse> => {
      seen.push(request);
      return { model: request.model, output: "ok" };
    },
    stream: async function* () {}
  };
}

function invokeArgs(seen: ModelRequest[], messages: ModelRequest["messages"]) {
  return {
    metrics: new InMemoryAgentMetrics(),
    provider: capturingProvider(seen),
    request: { messages, model: "test/model" },
    runId: "run-cache-boundary",
    tracer: new InMemoryMuseTracer()
  };
}

describe("cache-boundary marker never reaches the provider", () => {
  it("a real composed surface prompt carries the marker (the leak source)", () => {
    expect(composeSurfacePrompt("chat", { retrievedContext: "R" })).toContain(MUSE_CACHE_BOUNDARY_MARKER);
  });

  it("invokeModel strips it from the request the provider receives", async () => {
    const seen: ModelRequest[] = [];
    const systemPrompt = composeSurfacePrompt("chat", { retrievedContext: "R" });

    await invokeModel(invokeArgs(seen, [
      { content: systemPrompt, role: "system" },
      { content: "hi", role: "user" }
    ]));

    expect(seen).toHaveLength(1);
    for (const message of seen[0]!.messages) {
      expect(message.content).not.toContain(MUSE_CACHE_BOUNDARY_MARKER);
    }
  });

  it("stripping preserves the surrounding text — only the marker goes", async () => {
    const seen: ModelRequest[] = [];
    const systemPrompt = composeSurfacePrompt("chat", { retrievedContext: "UNIQUE_DYNAMIC_TOKEN" });

    await invokeModel(invokeArgs(seen, [{ content: systemPrompt, role: "system" }]));

    const delivered = seen[0]!.messages[0]!.content;
    expect(delivered).toContain("UNIQUE_DYNAMIC_TOKEN");
    expect(delivered).not.toContain(MUSE_CACHE_BOUNDARY_MARKER);
    expect(delivered).not.toContain("\n\n\n");
  });
});
