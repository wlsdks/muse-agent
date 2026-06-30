import type { ModelProvider, ModelRequest, ModelResponse } from "@muse/model";
import { ToolRegistry } from "@muse/tools";
import { describe, expect, it } from "vitest";

import { RUN_TOOL_PLAN_EXEMPLAR_BANK, createAgentRuntime, type ToolExemplar } from "../src/index.js";

function answer(text: string): ModelResponse {
  return { id: "answer", model: "m", output: text };
}

function capturingProvider(onGenerate: (request: ModelRequest) => void): ModelProvider {
  return {
    id: "seq",
    async generate(request) {
      onGenerate(request);
      return answer("done");
    },
    async listModels() { return []; },
    async *stream() {}
  };
}

function toolRegistry() {
  return new ToolRegistry([
    {
      definition: { description: "Search notes", inputSchema: { type: "object" }, name: "notes_search", risk: "read" as const },
      execute: async () => ({ hits: [] })
    }
  ]);
}

function systemText(request: ModelRequest): string {
  return request.messages.filter((message) => message.role === "system").map((message) => message.content).join("\n\n");
}

async function assembleSystemPrompt(args: {
  readonly prompt: string;
  readonly bank?: readonly ToolExemplar[];
  readonly withTools?: boolean;
}): Promise<string> {
  const requests: ModelRequest[] = [];
  const runtime = createAgentRuntime({
    modelProvider: capturingProvider((request) => requests.push(request)),
    ...(args.withTools === false ? {} : { toolRegistry: toolRegistry() }),
    ...(args.bank ? { toolExemplarBank: args.bank } : {})
  });
  await runtime.run({
    messages: [{ content: args.prompt, role: "user" }],
    metadata: { userId: "stark" },
    model: "provider/model",
    runId: `te-${Math.random().toString(36).slice(2)}`
  });
  expect(requests.length).toBeGreaterThan(0);
  return systemText(requests[0]!);
}

describe("PTC production wiring — tool-exemplar few-shot reaches the live prompt", () => {
  it("injects a run_tool_plan exemplar for a multi-step query when tools are exposed", async () => {
    const system = await assembleSystemPrompt({
      bank: RUN_TOOL_PLAN_EXEMPLAR_BANK,
      prompt: "check today's date and then count the days remaining until my trip"
    });
    expect(system).toContain("run_tool_plan");
    // the rendered section header is present (behavioral, not config-only)
    expect(system.toLowerCase()).toContain("past requests and the tool that correctly handled each");
  });

  it("preserves restraint: a single-call query surfaces a native / no-tool exemplar", async () => {
    const system = await assembleSystemPrompt({
      bank: RUN_TOOL_PLAN_EXEMPLAR_BANK,
      prompt: "what time is it right now"
    });
    // the exemplar block exists and includes at least one NON-run_tool_plan line,
    // so the wiring doesn't bias the model toward over-firing run_tool_plan.
    expect(system.toLowerCase()).toContain("past requests and the tool that correctly handled each");
    const sectionLines = system.split("\n").filter((line) => line.trimStart().startsWith("- \""));
    expect(sectionLines.some((line) => line.includes("time_now") || line.includes("no tool"))).toBe(true);
  });

  it("fail-open: an empty bank produces no section and no throw", async () => {
    const system = await assembleSystemPrompt({ bank: [], prompt: "list my notes then summarize them" });
    expect(system.toLowerCase()).not.toContain("past requests and the tool that correctly handled each");
  });

  it("fail-open: a zero-overlap query produces no section", async () => {
    const system = await assembleSystemPrompt({
      bank: RUN_TOOL_PLAN_EXEMPLAR_BANK,
      prompt: "xyzzy qwerty zzz"
    });
    expect(system.toLowerCase()).not.toContain("past requests and the tool that correctly handled each");
  });

  it("no section when no tools are exposed (only fires for a tool-selection turn)", async () => {
    const system = await assembleSystemPrompt({
      bank: RUN_TOOL_PLAN_EXEMPLAR_BANK,
      prompt: "check today's date and then count the days remaining until my trip",
      withTools: false
    });
    expect(system.toLowerCase()).not.toContain("past requests and the tool that correctly handled each");
  });

  it("no section when no bank is configured (disabled cleanly)", async () => {
    const system = await assembleSystemPrompt({
      prompt: "check today's date and then count the days remaining until my trip"
    });
    expect(system.toLowerCase()).not.toContain("past requests and the tool that correctly handled each");
  });
});
