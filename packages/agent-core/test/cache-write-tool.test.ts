import { InMemoryResponseCache } from "@muse/cache";
import type { ModelProvider, ModelResponse } from "@muse/model";
import { ToolRegistry } from "@muse/tools";
import { describe, expect, it } from "vitest";

import { createAgentRuntime } from "../src/index.js";

// Each RUN consumes two responses: the tool call, then the final answer.
function sequenceProvider(responses: readonly ModelResponse[]): ModelProvider {
  let index = 0;
  return {
    async generate() {
      const response = responses[Math.min(index, responses.length - 1)]!;
      index += 1;
      return response;
    },
    id: "test",
    async listModels() {
      return [];
    },
    async *stream() {
      yield { response: { id: "r", model: "test-model", output: "done" }, type: "done" as const };
    }
  };
}

const toolTurn: ModelResponse = {
  id: "tool-turn",
  model: "test-model",
  output: "",
  toolCalls: [{ arguments: { item: "status" }, id: "t-1", name: "add_item" }]
};
const finalTurn: ModelResponse = { id: "final-turn", model: "test-model", output: "done — added it" };

function registryWith(risk: "read" | "write", onRun: () => void): ToolRegistry {
  return new ToolRegistry([
    {
      definition: {
        description: "Add an item. Use when the user asks to add something.",
        inputSchema: { properties: { item: { type: "string" } }, type: "object" },
        name: "add_item",
        risk
      },
      execute: async () => {
        onRun();
        return { ok: true };
      }
    }
  ]);
}

const input = { messages: [{ content: "add the status item", role: "user" as const }], metadata: { localMode: true }, model: "test-model" };

describe("response cache never replays a run that ACTED (audit finding 1)", () => {
  it("a write-tool run is NOT cached — the identical follow-up request executes again", async () => {
    let runs = 0;
    const runtime = createAgentRuntime({
      modelProvider: sequenceProvider([toolTurn, finalTurn, toolTurn, finalTurn]),
      responseCache: new InMemoryResponseCache(),
      toolExposurePolicy: { select: (tools) => ({ blocked: [], tools: [...tools] }) },
      toolRegistry: registryWith("write", () => { runs += 1; })
    });
    const first = await runtime.run(input);
    expect(first.toolsUsed).toContain("add_item");
    expect(runs).toBe(1);
    const second = await runtime.run(input);
    expect(runs).toBe(2);
    expect(second.fromCache).not.toBe(true);
  });

  it("a read-tool run IS still cached (the performance feature survives)", async () => {
    let runs = 0;
    const runtime = createAgentRuntime({
      modelProvider: sequenceProvider([toolTurn, finalTurn, toolTurn, finalTurn]),
      responseCache: new InMemoryResponseCache(),
      toolExposurePolicy: { select: (tools) => ({ blocked: [], tools: [...tools] }) },
      toolRegistry: registryWith("read", () => { runs += 1; })
    });
    await runtime.run(input);
    expect(runs).toBe(1);
    const second = await runtime.run(input);
    expect(runs).toBe(1);
    expect(second.fromCache).toBe(true);
  });
});
