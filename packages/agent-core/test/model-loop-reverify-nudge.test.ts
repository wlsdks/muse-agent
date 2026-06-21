import type { ModelMessage, ModelProvider, ModelRequest, ModelResponse, ModelToolCall } from "@muse/model";
import { describe, expect, it } from "vitest";

import { executeModelLoop, type ModelLoopRunner } from "../src/model-loop.js";
import { REVERIFY_NUDGE } from "../src/reverify-nudge.js";
import type { ExecutedToolResult } from "../src/runtime-internals.js";
import type { AgentRunContext } from "../src/types.js";

// Re-verification nudge: when the model finishes after editing a file but never
// re-ran a verifying command, the loop injects REVERIFY_NUDGE ONCE and gives it
// another turn to re-run — instead of letting it declare done unverified. These
// drive the loop with a SCRIPTED provider so the wiring's BEHAVIOUR is graded
// (the nudge is actually injected and re-prompts), not just the helper in
// isolation. Revert anchor: neutralise consumeNudge → the nudge tests go RED.

const provider = {} as unknown as ModelProvider;
const editTool = { name: "file_edit", description: "edit", inputSchema: { type: "object" as const }, risk: "write" as const };
const runTool = { name: "run_command", description: "run", inputSchema: { type: "object" as const }, risk: "execute" as const };

const call = (turn: number, name: string): ModelToolCall => ({ id: `t${turn.toString()}`, name, arguments: { n: turn } });

/**
 * Drive the loop through a fixed SCRIPT of turns. Each entry is the tool name to
 * call that turn, or "" to finish (no tool call). `seen` captures the messages
 * the provider received each turn so a test can assert the nudge was injected.
 */
function scriptedRunner(opts: {
  script: readonly string[];
  seen: ModelMessage[][];
}): ModelLoopRunner {
  let turn = 0;
  return {
    maxToolCalls: 20,
    generateWithTracing: async (_ctx: AgentRunContext, _p: ModelProvider, req: ModelRequest): Promise<ModelResponse> => {
      opts.seen.push([...req.messages]);
      const step = opts.script[turn] ?? "";
      turn += 1;
      if (!step) {
        return { id: `fin${turn.toString()}`, model: "m", output: "done", toolCalls: [] };
      }
      return { id: `x${turn.toString()}`, model: "m", output: "acting", toolCalls: [call(turn, step)] };
    },
    executeToolCall: async (_ctx, toolCall): Promise<ExecutedToolResult> => ({
      result: { id: toolCall.id, name: toolCall.name, output: `${toolCall.name} ok`, status: "completed" },
      toolCall
    })
  } as unknown as ModelLoopRunner;
}


const ctx = (): AgentRunContext => ({
  runId: "run-reverify",
  startedAt: new Date("2026-01-01T00:00:00Z"),
  input: { model: "m", messages: [{ role: "user", content: "fix and run the test" }] }
});
const req = (userMessage: string): ModelRequest => ({
  model: "m",
  messages: [{ role: "user", content: userMessage }],
  tools: [editTool, runTool]
});

const sawNudge = (seen: ModelMessage[][]): boolean =>
  seen.some((messages) => messages.some((m) => typeof m.content === "string" && m.content.includes(REVERIFY_NUDGE)));

describe("executeModelLoop — re-verification nudge", () => {
  it("injects the nudge and re-prompts when the model finishes after an unverified edit", async () => {
    const seen: ModelMessage[][] = [];
    // edit, then finish (unverified) → loop must nudge + continue; then the model re-runs, then finishes.
    await executeModelLoop(
      scriptedRunner({ script: ["file_edit", "", "run_command", ""], seen }),
      ctx(),
      provider,
      req("fix the bug and run the test to verify")
    );
    expect(sawNudge(seen)).toBe(true);
    // The turn AFTER the first finish (turn index 2) is where the nudge must appear.
    expect(seen[2]?.some((m) => typeof m.content === "string" && m.content.includes(REVERIFY_NUDGE))).toBe(true);
  });

  it("does NOT nudge when the model re-ran a verifying command after the edit", async () => {
    const seen: ModelMessage[][] = [];
    // edit, run (verifies), finish → no pending unverified edit → no nudge.
    await executeModelLoop(
      scriptedRunner({ script: ["file_edit", "run_command", ""], seen }),
      ctx(),
      provider,
      req("fix the bug and run the test to verify")
    );
    expect(sawNudge(seen)).toBe(false);
  });

  it("fires at most ONCE (no infinite loop if the model keeps finishing without re-running)", async () => {
    const seen: ModelMessage[][] = [];
    // edit, finish, finish-again → nudge fires once at the first finish, returns at the second.
    const result = await executeModelLoop(
      scriptedRunner({ script: ["file_edit", "", ""], seen }),
      ctx(),
      provider,
      req("fix the bug and run the test to verify")
    );
    expect(sawNudge(seen)).toBe(true);
    // 3 turns: edit, finish(→nudge), finish(→return). One-shot, terminates.
    expect(seen.length).toBe(3);
    expect(result.finalResponse.toolCalls ?? []).toHaveLength(0);
  });

  it("does NOT nudge when the task has no run/verify intent", async () => {
    const seen: ModelMessage[][] = [];
    await executeModelLoop(
      scriptedRunner({ script: ["file_edit", ""], seen }),
      ctx(),
      provider,
      req("rename this variable across the file")
    );
    expect(sawNudge(seen)).toBe(false);
  });
});
