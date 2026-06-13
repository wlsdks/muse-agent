import type { ModelProvider, ModelRequest, ModelResponse, ModelTool } from "@muse/model";
import { describe, expect, it, vi } from "vitest";

import { executePlanExecuteLoop, type PlanExecuteRunner } from "../src/plan-execute-loop.js";
import { PlanValidationFailedError } from "../src/plan-execute.js";
import type { ExecutedToolResult } from "../src/runtime-internals.js";
import type { AgentRunContext } from "../src/types.js";

const provider = { id: "fake" } as unknown as ModelProvider;

const sendMessageTool: ModelTool = {
  name: "send_message",
  description: "send a message to a recipient",
  risk: "write",
  inputSchema: {
    type: "object",
    properties: {
      to: { type: "string" },
      body: { type: "string" }
    },
    required: ["to", "body"]
  }
};

const readTool: ModelTool = {
  name: "get_inbox",
  description: "read inbox",
  risk: "read",
  inputSchema: { type: "object", properties: { folder: { type: "string" } }, required: [] }
};

const context = (): AgentRunContext => ({
  runId: "run-precond",
  startedAt: new Date("2026-01-01T00:00:00Z"),
  input: { model: "m", messages: [{ role: "user", content: "send it" }], metadata: {} }
});

const resp = (output: string): ModelResponse => ({ id: "x", model: "m", output });

/**
 * Runner that records every executeToolCall invocation into `writes[]`.
 * generateWithTracing is scripted: call 0 = plan, call 1 = synthesis/repair,
 * call 2 = synthesis after repair.
 */
function makeRunner(
  writes: Array<{ name: string; arguments: Record<string, unknown> }>,
  turns: ModelResponse[],
  _tools: readonly ModelTool[]
): PlanExecuteRunner {
  let turn = 0;
  return {
    maxToolCalls: 5,
    generateWithTracing: async (): Promise<ModelResponse> =>
      turns[Math.min(turn++, turns.length - 1)]!,
    executeToolCall: vi.fn(async (_ctx: AgentRunContext, toolCall: { id: string; name: string; arguments: Record<string, unknown> }): Promise<ExecutedToolResult> => {
      writes.push({ name: toolCall.name, arguments: toolCall.arguments });
      return {
        result: { id: toolCall.id, name: toolCall.name, output: "done", status: "completed" },
        toolCall
      };
    })
  };
}

const writeRequest = (tools: readonly ModelTool[]): ModelRequest => ({
  model: "m",
  messages: [{ role: "system", content: "sys" }, { role: "user", content: "send it" }],
  tools: tools as ModelTool[]
});

describe("write-precondition gate — assembled path (ISR-LLM arXiv:2308.13724)", () => {
  /**
   * REAL-REVERT baseline: WITHOUT toolRisks wiring (simulated by using an
   * empty toolRisks map via no risk field on tools), the placeholder write sails
   * through validation and the tool IS called (writes[] has one entry).
   *
   * We simulate "no wiring" by providing tools with risk:"read" so the
   * toolRisks map maps send_message → "read", making the precondition check
   * treat it as exempt. This is the clearest way to show what happens without
   * the gate: the bad write commits.
   */
  it("REAL-REVERT baseline: without risk:write wiring, placeholder write IS executed (writes[] has it)", async () => {
    const writes: Array<{ name: string; arguments: Record<string, unknown> }> = [];
    const unprotectedTool: ModelTool = { ...sendMessageTool, risk: "read" };
    const planJson = JSON.stringify([
      { tool: "send_message", args: { to: "<recipient>", body: "hi" }, description: "send" }
    ]);
    const r = makeRunner(writes, [resp(planJson), resp("Done.")], [unprotectedTool]);
    await executePlanExecuteLoop(r, context(), provider, writeRequest([unprotectedTool]));
    // Without risk:write, the placeholder write is admitted — writes[] is populated.
    expect(writes).toHaveLength(1);
    expect(writes[0]?.arguments).toMatchObject({ to: "<recipient>" });
  });

  /**
   * WITH the slice: risk:"write" + placeholder arg → validatePlan invalid →
   * after the one repair round, PlanValidationFailedError thrown AND writes[] is EMPTY.
   * The repair plan also has a placeholder so the gate fires again and throws.
   */
  it("WITH risk:write wiring: placeholder write is rejected, PlanValidationFailedError thrown, writes[] is EMPTY", async () => {
    const writes: Array<{ name: string; arguments: Record<string, unknown> }> = [];
    const planJson = JSON.stringify([
      { tool: "send_message", args: { to: "<recipient>", body: "hi" }, description: "send" }
    ]);
    // The repair plan also has a placeholder so it fails again and throws.
    const repairedPlanJson = JSON.stringify([
      { tool: "send_message", args: { to: "<recipient>", body: "hi" }, description: "send repaired" }
    ]);
    const r = makeRunner(writes, [resp(planJson), resp(repairedPlanJson), resp("Done.")], [sendMessageTool]);
    await expect(
      executePlanExecuteLoop(r, context(), provider, writeRequest([sendMessageTool]))
    ).rejects.toBeInstanceOf(PlanValidationFailedError);
    // No partial side-effect: the tool was NEVER executed.
    expect(writes).toHaveLength(0);
  });

  it("WITH risk:write wiring: error message identifies the placeholder arg", async () => {
    const writes: Array<{ name: string; arguments: Record<string, unknown> }> = [];
    const planJson = JSON.stringify([
      { tool: "send_message", args: { to: "<recipient>", body: "hi" }, description: "send" }
    ]);
    const repairedPlanJson = JSON.stringify([
      { tool: "send_message", args: { to: "<recipient>", body: "hi" }, description: "repaired" }
    ]);
    const r = makeRunner(writes, [resp(planJson), resp(repairedPlanJson), resp("Done.")], [sendMessageTool]);
    const err = await executePlanExecuteLoop(r, context(), provider, writeRequest([sendMessageTool])).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlanValidationFailedError);
    const pvfe = err as PlanValidationFailedError;
    expect(pvfe.errors.some((e) => e.reason.includes("placeholder"))).toBe(true);
    expect(pvfe.errors.some((e) => e.reason.includes("'to'"))).toBe(true);
  });

  /**
   * Negative / floor test: reads are NEVER over-rejected.
   * A read step with a placeholder arg executes normally (writes[] has it).
   */
  it("negative: read step with placeholder arg '<id>' executes — reads EXEMPT (no over-reject)", async () => {
    const writes: Array<{ name: string; arguments: Record<string, unknown> }> = [];
    const planJson = JSON.stringify([
      { tool: "get_inbox", args: { folder: "<id>" }, description: "read inbox" }
    ]);
    const r = makeRunner(writes, [resp(planJson), resp("Inbox read.")], [readTool]);
    const result = await executePlanExecuteLoop(r, context(), provider, writeRequest([readTool]));
    expect(result.finalResponse.output).toBe("Inbox read.");
    // The read step executed despite the placeholder arg — reads are exempt.
    expect(writes).toHaveLength(1);
  });

  /**
   * Negative / floor test: a write step with a REAL arg is NOT rejected.
   */
  it("negative: write step with real arg 'alice@x.com' executes (no false rejection)", async () => {
    const writes: Array<{ name: string; arguments: Record<string, unknown> }> = [];
    const planJson = JSON.stringify([
      { tool: "send_message", args: { to: "alice@x.com", body: "hello" }, description: "send" }
    ]);
    const r = makeRunner(writes, [resp(planJson), resp("Sent.")], [sendMessageTool]);
    const result = await executePlanExecuteLoop(r, context(), provider, writeRequest([sendMessageTool]));
    expect(result.finalResponse.output).toBe("Sent.");
    expect(writes).toHaveLength(1);
    expect(writes[0]?.arguments).toMatchObject({ to: "alice@x.com" });
  });

  /**
   * Negative / floor test: a write step with body "send the TODO list" is NOT
   * rejected — whole-value-anchored grammar, contains-but-not-exactly.
   */
  it("negative: write body 'send the TODO list' executes (whole-value-anchored — contains but not exactly)", async () => {
    const writes: Array<{ name: string; arguments: Record<string, unknown> }> = [];
    const planJson = JSON.stringify([
      { tool: "send_message", args: { to: "alice@x.com", body: "send the TODO list" }, description: "send" }
    ]);
    const r = makeRunner(writes, [resp(planJson), resp("Sent.")], [sendMessageTool]);
    const result = await executePlanExecuteLoop(r, context(), provider, writeRequest([sendMessageTool]));
    expect(result.finalResponse.output).toBe("Sent.");
    expect(writes).toHaveLength(1);
  });
});
