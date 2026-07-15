import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DiagnosticModelProvider } from "@muse/model";
import type { ModelProvider, ModelRequest } from "@muse/model";
import { ToolExecutor, ToolRegistry, type MuseTool } from "@muse/tools";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { executePlanExecuteLoop, type PlanExecuteRunner } from "../src/plan-execute-loop.js";
import type { AgentRunContext } from "../src/types.js";
import { readNotesOrAbsent, readNotesOrEmpty } from "./note-store-test-helpers.js";

// τ-bench-style TERMINAL-STATE eval on the FULL plan-execute assembly (agent-eval
// gap B remaining). The earlier gap-B test scripted the tool-loop's model turns;
// here the REAL DiagnosticModelProvider GENERATES the plan from the real planning
// prompt (steered by a `DIAGNOSTIC_PLAN=` directive), the REAL ToolExecutor runs a
// real state-mutating tool, and we assert the WORLD STATE — proving plan
// generation → validation → execution → synthesis composes end-to-end and that a
// rejected/failed plan mutates NOTHING.

let dir: string;
let noteFile: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), "plan-terminal-"));
  noteFile = join(dir, "notes.json");
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const saveNoteTool = (): MuseTool => ({
  definition: {
    description: "Persist a note to the user's store.",
    inputSchema: { properties: { text: { type: "string" } }, required: ["text"], type: "object" },
    name: "save_note",
    risk: "write",
  },
  execute: async (args) => {
    const prior = await readNotesOrEmpty(noteFile);
    prior.push({ text: String((args as { text: unknown }).text) });
    await fs.writeFile(noteFile, JSON.stringify(prior));
    return `saved: ${String((args as { text: unknown }).text)}`;
  },
});
const throwingNoteTool = (): MuseTool => ({
  definition: { description: "Persist a note.", inputSchema: { type: "object" }, name: "save_note", risk: "write" },
  execute: () => { throw new Error("disk full"); },
});

// The directive is the trailing segment of the user prompt; the steerable
// diagnostic emits exactly these steps when it sees a planning prompt.
const steer = (steps: readonly { tool: string; args: Record<string, unknown>; description: string }[]): string =>
  `save my notes\n\nDIAGNOSTIC_PLAN=${JSON.stringify(steps)}`;

const context = (prompt: string): AgentRunContext => ({
  input: { messages: [{ content: prompt, role: "user" }], model: "diagnostic/smoke", metadata: {} },
  runId: "run-1",
  startedAt: new Date("2026-01-01T00:00:00Z"),
});
const request = (prompt: string, tool: MuseTool): ModelRequest => ({
  messages: [
    { content: "You are Muse.", role: "system" },
    { content: prompt, role: "user" },
  ],
  model: "diagnostic/smoke",
  tools: [{ description: tool.definition.description, inputSchema: tool.definition.inputSchema, name: tool.definition.name }],
});

// A PlanExecuteRunner whose generateWithTracing delegates to the REAL diagnostic
// provider (so plan generation + synthesis are genuine) and whose executeToolCall
// runs the REAL ToolExecutor over the real tool.
const realRunner = (provider: ModelProvider, executor: ToolExecutor): PlanExecuteRunner => ({
  executeToolCall: async (ctx, toolCall) => ({
    result: await executor.execute({ arguments: toolCall.arguments, context: { runId: ctx.runId }, id: toolCall.id, name: toolCall.name }),
    toolCall,
  }),
  generateWithTracing: async (_ctx, prov, req) => prov.generate(req),
  maxToolCalls: 5,
});

describe("plan-execute terminal state (gap B — real diagnostic plans, real ToolExecutor mutates)", () => {
  const provider = new DiagnosticModelProvider({ defaultModel: "diagnostic/smoke" });

  it("accomplishes the goal: the diagnostic-planned step runs the real tool and the note is persisted", async () => {
    const tool = saveNoteTool();
    const executor = new ToolExecutor({ registry: new ToolRegistry([tool]) });
    const prompt = steer([{ tool: "save_note", args: { text: "buy milk" }, description: "save the note" }]);
    const result = await executePlanExecuteLoop(realRunner(provider, executor), context(prompt), provider, request(prompt, tool));

    expect(await readNotesOrAbsent(noteFile)).toEqual([{ text: "buy milk" }]); // WORLD STATE, not trajectory
    expect(result.toolsUsed).toEqual(["save_note"]);
    expect(result.toolResults[0]?.result.status).toBe("completed");
    expect(result.finalResponse.output.length).toBeGreaterThan(0); // real synthesis answered
  });

  it("runs a multi-step plan in order — both notes land in plan order", async () => {
    const tool = saveNoteTool();
    const executor = new ToolExecutor({ registry: new ToolRegistry([tool]) });
    const prompt = steer([
      { tool: "save_note", args: { text: "first" }, description: "one" },
      { tool: "save_note", args: { text: "second" }, description: "two" },
    ]);
    const result = await executePlanExecuteLoop(realRunner(provider, executor), context(prompt), provider, request(prompt, tool));

    expect(await readNotesOrAbsent(noteFile)).toEqual([{ text: "first" }, { text: "second" }]);
    expect(result.toolResults).toHaveLength(2);
  });

  it("mutates NOTHING and throws PLAN_ALL_STEPS_FAILED when the only planned step fails", async () => {
    const tool = throwingNoteTool();
    const executor = new ToolExecutor({ registry: new ToolRegistry([tool]) });
    const prompt = steer([{ tool: "save_note", args: { text: "x" }, description: "save" }]);
    await expect(
      executePlanExecuteLoop(realRunner(provider, executor), context(prompt), provider, request(prompt, tool)),
    ).rejects.toMatchObject({ code: "PLAN_ALL_STEPS_FAILED" });
    expect(await readNotesOrAbsent(noteFile)).toBe("absent"); // failed tool left no side effect
  });

  it("rejects a directive naming an unavailable tool at validation — no tool runs, no mutation", async () => {
    const tool = saveNoteTool();
    const executor = new ToolExecutor({ registry: new ToolRegistry([tool]) });
    // The steerable diagnostic does NOT filter; the assembly's validatePlan must reject it.
    // With ISR-LLM repair: the invalid plan triggers one repair round; the diagnostic
    // provider returns "[]" (empty plan) which is valid → direct answer, no tools run.
    const prompt = steer([{ tool: "launch_missiles", args: {}, description: "no" }]);
    const result = await executePlanExecuteLoop(realRunner(provider, executor), context(prompt), provider, request(prompt, tool));
    // No save_note was called — the invalid tool never reached execution.
    expect(result.toolResults).toHaveLength(0);
    expect(await readNotesOrAbsent(noteFile)).toBe("absent");
  });

  it("an empty-plan directive falls through to a direct answer and mutates nothing", async () => {
    const tool = saveNoteTool();
    const executor = new ToolExecutor({ registry: new ToolRegistry([tool]) });
    const prompt = "just chat with me\n\nDIAGNOSTIC_PLAN=[]";
    const result = await executePlanExecuteLoop(realRunner(provider, executor), context(prompt), provider, request(prompt, tool));

    expect(result.toolResults).toHaveLength(0);
    expect(result.finalResponse.output.length).toBeGreaterThan(0);
    expect(await readNotesOrAbsent(noteFile)).toBe("absent");
  });
});
