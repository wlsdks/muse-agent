import type { ModelMessage, ModelProvider, ModelRequest, ModelResponse, ModelToolCall } from "@muse/model";
import { describe, expect, it } from "vitest";

import { InMemoryContextReferenceStore } from "@muse/memory";

import { executeModelLoop, type ModelLoopRunner } from "../src/model-loop.js";
import type { ExecutedToolResult } from "../src/runtime-internals.js";
import type { AgentRunContext } from "../src/types.js";

const provider = {} as unknown as ModelProvider;
const tool = { name: "knowledge_search", description: "searches", inputSchema: { type: "object" as const } };

const context = (): AgentRunContext => ({
  runId: "run-mask",
  startedAt: new Date("2026-01-01T00:00:00Z"),
  input: { model: "m", messages: [{ role: "user", content: "do a multi-step task" }] }
});
const request = (): ModelRequest => ({
  model: "m",
  messages: [{ role: "user", content: "do a multi-step task" }],
  tools: [tool]
});
const call = (id: string, name: string): ModelToolCall => ({ id, name, arguments: {} });
const resp = (output: string, toolCalls: ModelToolCall[] = []): ModelResponse => ({ id: "x", model: "m", output, toolCalls });

function toolContentChars(messages: readonly ModelMessage[]): number {
  return messages.filter((m) => m.role === "tool").reduce((sum, m) => sum + m.content.length, 0);
}

function pairingValid(messages: readonly ModelMessage[]): boolean {
  const announced = new Set<string>();
  for (const m of messages) {
    if (m.role === "assistant" && m.toolCalls) {
      for (const c of m.toolCalls) {
        announced.add(c.id);
      }
    }
  }
  return messages
    .filter((m) => m.role === "tool")
    .every((m) => m.toolCallId !== undefined && announced.has(m.toolCallId));
}

describe("executeModelLoop stale-observation masking", () => {
  it("masks turn-1 observation once stale, keeps the latest full, preserves pairing & recoverability", async () => {
    const seenRequests: ModelMessage[][] = [];
    const store = new InMemoryContextReferenceStore();
    const turn1Output = "A".repeat(5000);
    const turn2Output = "B".repeat(4000);
    let turn = 0;

    const loop = {
      maxToolCalls: 5,
      maxToolOutputChars: 0,
      contextReferenceStore: store,
      generateWithTracing: async (_ctx: AgentRunContext, _p: unknown, req: ModelRequest): Promise<ModelResponse> => {
        seenRequests.push([...req.messages]);
        turn += 1;
        if (turn === 1) return resp("", [call("c1", "knowledge_search")]);
        if (turn === 2) return resp("", [call("c2", "knowledge_search")]);
        return resp("final answer");
      },
      executeToolCall: async (_ctx: AgentRunContext, toolCall: ModelToolCall): Promise<ExecutedToolResult> => ({
        result: {
          id: toolCall.id,
          name: toolCall.name,
          output: toolCall.id === "c1" ? turn1Output : turn2Output,
          status: "ok"
        },
        toolCall
      })
    } as unknown as ModelLoopRunner;

    await executeModelLoop(loop, context(), provider, request());

    expect(seenRequests).toHaveLength(3);
    const turn2Req = seenRequests[1]!;
    const turn3Req = seenRequests[2]!;

    // (1) total role:"tool" content shrank turn-3 vs turn-2 (turn-1 obs masked once stale)
    expect(toolContentChars(turn3Req)).toBeLessThan(toolContentChars(turn2Req));

    // (2) the masked placeholder carries ref=<id> AND the original turn-1 output is recoverable
    const maskedTurn1 = turn3Req.find((m) => m.role === "tool" && m.content.includes("[observation masked:"));
    expect(maskedTurn1).toBeDefined();
    const ref = maskedTurn1!.content.match(/ref=([0-9a-f]+)/)?.[1];
    expect(ref).toBeDefined();
    expect(store.get(ref!)?.content).toBe(turn1Output);

    // (3) the turn-2 observation is still FULL in the turn-3 request (latest kept)
    const fullTurn2 = turn3Req.find((m) => m.role === "tool" && m.content === turn2Output);
    expect(fullTurn2).toBeDefined();

    // (4) message pairing valid — every remaining role:"tool" has its assistant toolCall
    expect(pairingValid(turn3Req)).toBe(true);
    expect(turn3Req.filter((m) => m.role === "tool")).toHaveLength(2);
  });
});
