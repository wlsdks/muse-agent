import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ToolExecutor, ToolRegistry, type MuseTool } from "@muse/tools";
import type { ModelResponse, ModelToolCall } from "@muse/model";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { executeModelLoop, type ModelLoopRunner } from "../src/model-loop.js";
import type { AgentRunContext } from "../src/types.js";
import { readNotesOrAbsent, readNotesOrEmpty } from "./note-store-test-helpers.js";

// τ-bench-style TERMINAL-STATE / task-completion eval (agent-eval gap B): rather
// than matching the trajectory, drive the REAL model loop + REAL ToolExecutor
// over a REAL state-mutating tool (contract-faithful: actual fs writes) and
// assert the WORLD STATE after the run — did the agent actually accomplish the
// goal, exactly once, and not mutate on failure / when it shouldn't.

let dir: string;
let noteFile: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), "terminal-state-"));
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

const context = (): AgentRunContext => ({
  input: { messages: [{ content: "save a note", role: "user" }], model: "m" },
  runId: "run-1",
  startedAt: new Date("2026-01-01T00:00:00Z"),
});
const request = (tool: MuseTool) => ({
  messages: [{ content: "save a note", role: "user" as const }],
  model: "m",
  tools: [{ description: tool.definition.description, inputSchema: tool.definition.inputSchema, name: tool.definition.name }],
});
const resp = (output: string, toolCalls: ModelToolCall[] = []): ModelResponse => ({ id: "x", model: "m", output, toolCalls });
const call = (id: string, args: Record<string, unknown>): ModelToolCall => ({ arguments: args, id, name: "save_note" });

// A runner backed by a REAL ToolExecutor over a real registry: the model turns
// are scripted, but executeToolCall runs the genuine tool-execution path.
const realRunner = (executor: ToolExecutor, turns: readonly ModelResponse[]): ModelLoopRunner => {
  let i = 0;
  return {
    executeToolCall: async (ctx, toolCall) => ({
      result: await executor.execute({ arguments: toolCall.arguments, context: { runId: ctx.runId }, id: toolCall.id, name: toolCall.name }),
      toolCall,
    }),
    generateWithTracing: async () => turns[Math.min(i++, turns.length - 1)]!,
    maxToolCalls: 5,
  } as unknown as ModelLoopRunner;
};

describe("terminal-state task completion (gap B — real loop + real ToolExecutor + real fs)", () => {
  it("accomplishes the goal: the note is persisted to the store and the run reports success", async () => {
    const tool = saveNoteTool();
    const executor = new ToolExecutor({ registry: new ToolRegistry([tool]) });
    const result = await executeModelLoop(
      realRunner(executor, [resp("", [call("t1", { text: "buy milk" })]), resp("Saved your note.")]),
      context(),
      {} as never,
      request(tool),
    );
    // assert the WORLD STATE, not the path
    expect(await readNotesOrAbsent(noteFile)).toEqual([{ text: "buy milk" }]);
    expect(result.finalResponse.output).toBe("Saved your note.");
    expect(result.toolsUsed).toEqual(["save_note"]);
    expect(result.toolResults[0]?.result.status).toBe("completed");
  });

  it("mutates exactly once under a repeated idempotency-keyed call (no duplicate side effect)", async () => {
    const tool = saveNoteTool();
    const executor = new ToolExecutor({ idempotencyStore: new Map(), registry: new ToolRegistry([tool]) });
    const result = await executeModelLoop(
      realRunner(executor, [
        resp("", [call("a", { idempotencyKey: "k1", text: "once" }), call("b", { idempotencyKey: "k1", text: "once" })]),
        resp("done"),
      ]),
      context(),
      {} as never,
      request(tool),
    );
    expect(result.toolResults.map((r) => r.result.status)).toEqual(["completed", "completed"]);
    // both calls report success, but the store holds exactly ONE note
    expect(await readNotesOrAbsent(noteFile)).toEqual([{ text: "once" }]);
  });

  it("does not mutate the store when the model answers directly (no tool call)", async () => {
    const tool = saveNoteTool();
    const executor = new ToolExecutor({ registry: new ToolRegistry([tool]) });
    const result = await executeModelLoop(realRunner(executor, [resp("Here's a note idea instead.")]), context(), {} as never, request(tool));
    expect(result.toolsUsed).toEqual([]);
    expect(await readNotesOrAbsent(noteFile)).toBe("absent");
  });

  it("leaves the store unmutated when the tool fails, yet the run still completes", async () => {
    const tool = throwingNoteTool();
    const executor = new ToolExecutor({ registry: new ToolRegistry([tool]) });
    const result = await executeModelLoop(
      realRunner(executor, [resp("", [call("t1", { text: "buy milk" })]), resp("I couldn't save that.")]),
      context(),
      {} as never,
      request(tool),
    );
    expect(result.toolResults[0]?.result.status).toBe("failed");
    expect(result.finalResponse.output).toBe("I couldn't save that.");
    expect(await readNotesOrAbsent(noteFile)).toBe("absent");
  });
});
