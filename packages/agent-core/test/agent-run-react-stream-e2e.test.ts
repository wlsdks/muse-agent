import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ModelProvider, ModelRequest, ModelResponse } from "@muse/model";
import { ToolRegistry, type MuseTool } from "@muse/tools";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createAgentRuntime } from "../src/index.js";
import type { AgentRuntimeStreamEvent } from "../src/agent-runtime-types.js";

// Full agent-run e2e — the default (react) tool-loop through AgentRuntime.stream()
// (backlog P2). The existing streaming react test asserts the happy-path event
// sequence with a pure-compute tool; these add the two matrix cells it skips: a
// REAL fs-mutating tool (terminal world state) and TOOL-ERROR RECOVERY — a tool
// that throws mid-stream must surface a failed tool-result, let the model
// synthesise a graceful answer, complete the run (not crash), and mutate NOTHING.

let dir: string;
let noteFile: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), "agent-react-e2e-"));
  noteFile = join(dir, "notes.json");
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const readNotes = async (): Promise<readonly { text: string }[] | "absent"> =>
  fs.readFile(noteFile, "utf8").then((raw) => JSON.parse(raw) as { text: string }[]).catch(() => "absent" as const);

const saveNoteTool = (opts: { throws?: boolean } = {}): MuseTool => ({
  definition: {
    description: "Persist a note to the user's store.",
    inputSchema: { properties: { text: { type: "string" } }, required: ["text"], type: "object" },
    name: "save_note",
    risk: "read",
  },
  execute: async (args) => {
    if (opts.throws) throw new Error("disk full");
    const prior = await fs.readFile(noteFile, "utf8").then((r) => JSON.parse(r) as { text: string }[]).catch(() => []);
    prior.push({ text: String((args as { text: unknown }).text) });
    await fs.writeFile(noteFile, JSON.stringify(prior));
    return `saved: ${String((args as { text: unknown }).text)}`;
  },
});

// A streaming provider that replays one scripted ModelResponse per turn as a
// text-delta? + tool-calls + done sequence (the shape AgentRuntime consumes).
const streamingProvider = (turns: readonly ModelResponse[]): ModelProvider => {
  let i = 0;
  return {
    id: "stream-fake",
    async generate() { throw new Error("generate should not be called in stream mode"); },
    async listModels() { return []; },
    async *stream(request: ModelRequest) {
      const turn = turns[Math.min(i++, turns.length - 1)]!;
      if (turn.output.length > 0) yield { text: turn.output, type: "text-delta" };
      for (const toolCall of turn.toolCalls ?? []) yield { toolCall, type: "tool-call" };
      yield { response: { ...turn, model: request.model }, type: "done" };
    },
  } as ModelProvider;
};

const collect = async (gen: AsyncIterable<AgentRuntimeStreamEvent>): Promise<AgentRuntimeStreamEvent[]> => {
  const events: AgentRuntimeStreamEvent[] = [];
  for await (const event of gen) events.push(event);
  return events;
};

describe("agent run e2e — react tool-loop through AgentRuntime.stream() (real tool)", () => {
  it("streams tool-call → tool-result → text-delta → done and the real tool mutates the store", async () => {
    const runtime = createAgentRuntime({
      maxToolCalls: 2,
      modelProvider: streamingProvider([
        { id: "t", model: "m", output: "", toolCalls: [{ arguments: { text: "buy milk" }, id: "tc1", name: "save_note" }] },
        { id: "f", model: "m", output: "Saved your note." },
      ]),
      toolRegistry: new ToolRegistry([saveNoteTool()]),
    });

    const events = await collect(runtime.stream({
      messages: [{ content: "save: buy milk", role: "user" }],
      model: "provider/model",
      runId: "run-react-ok",
    }));

    expect(events.map((e) => e.type)).toEqual(["tool-call", "tool-result", "text-delta", "done"]);
    const doneEvent = events.at(-1) as Extract<AgentRuntimeStreamEvent, { type: "done" }>;
    expect(doneEvent.response.output).toBe("Saved your note.");
    expect(await readNotes()).toEqual([{ text: "buy milk" }]); // terminal WORLD STATE
  });

  it("TOOL-ERROR RECOVERY: a throwing tool surfaces a tool-result, the run still completes, and nothing is mutated", async () => {
    const runtime = createAgentRuntime({
      maxToolCalls: 2,
      modelProvider: streamingProvider([
        { id: "t", model: "m", output: "", toolCalls: [{ arguments: { text: "buy milk" }, id: "tc1", name: "save_note" }] },
        { id: "f", model: "m", output: "I couldn't save that — the disk is full." },
      ]),
      toolRegistry: new ToolRegistry([saveNoteTool({ throws: true })]),
    });

    const events = await collect(runtime.stream({
      messages: [{ content: "save: buy milk", role: "user" }],
      model: "provider/model",
      runId: "run-react-fail",
    }));

    // the tool-result span is still emitted (the failure is observable, not swallowed)
    expect(events.some((e) => e.type === "tool-result")).toBe(true);
    const doneEvent = events.at(-1) as Extract<AgentRuntimeStreamEvent, { type: "done" }>;
    expect(doneEvent.type).toBe("done"); // run completed, did not crash
    expect(doneEvent.response.output).toBe("I couldn't save that — the disk is full.");
    expect(await readNotes()).toBe("absent"); // failed tool left NO side effect
  });
});
