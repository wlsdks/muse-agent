import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DiagnosticModelProvider } from "@muse/model";
import { InMemoryAgentRunHistoryStore } from "@muse/runtime-state";
import { ToolRegistry, type MuseTool } from "@muse/tools";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createAgentRuntime } from "../src/index.js";
import type { AgentRuntimeStreamEvent } from "../src/agent-runtime-types.js";
import { readNotesOrAbsent, readNotesOrEmpty } from "./note-store-test-helpers.js";

// Full agent-run e2e through AgentRuntime in plan_execute mode (backlog P2). Unlike
// the plan-execute-trajectory unit test (which drives streamPlanExecute directly),
// this exercises the WHOLE runtime — prepareInvocation (guards/prompt layers) →
// plan-execute streaming → finalizeInvocation (output filters, run-record persist)
// — driven by the REAL steerable DiagnosticModelProvider + a REAL fs-mutating tool,
// asserting the runtime stream-event sequence AND the terminal world state.

let dir: string;
let noteFile: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), "agent-pe-e2e-"));
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
    risk: "read", // read-risk so no approval gate is involved — this e2e is about the run composition
  },
  execute: async (args) => {
    const prior = await readNotesOrEmpty(noteFile);
    prior.push({ text: String((args as { text: unknown }).text) });
    await fs.writeFile(noteFile, JSON.stringify(prior));
    return `saved: ${String((args as { text: unknown }).text)}`;
  },
});

const steer = (text: string): string =>
  `save my note\n\nDIAGNOSTIC_PLAN=[{"tool":"save_note","args":{"text":"${text}"},"description":"save the note"}]`;

describe("agent run e2e — plan_execute through AgentRuntime (real diagnostic + real tool)", () => {
  it("stream(): emits the full runtime trajectory and the real tool mutates the store", async () => {
    const history = new InMemoryAgentRunHistoryStore();
    const runtime = createAgentRuntime({
      historyStore: history,
      maxToolCalls: 3,
      modelProvider: new DiagnosticModelProvider({ defaultModel: "diagnostic/smoke" }),
      toolRegistry: new ToolRegistry([saveNoteTool()]),
    });

    const events: AgentRuntimeStreamEvent[] = [];
    for await (const event of runtime.stream({
      messages: [{ content: steer("buy milk"), role: "user" }],
      metadata: { agentMode: "plan_execute" },
      model: "diagnostic/smoke",
      runId: "run-pe-stream",
    })) {
      events.push(event);
    }

    expect(events.map((e) => e.type)).toEqual([
      "plan-generated",
      "plan-step-executing",
      "plan-step-result",
      "synthesis-started",
      "text-delta",
      "done",
    ]);
    const generated = events[0] as Extract<AgentRuntimeStreamEvent, { type: "plan-generated" }>;
    expect(generated.plan.map((s) => s.tool)).toEqual(["save_note"]); // adherence anchor
    const stepResult = events.find((e) => e.type === "plan-step-result") as Extract<AgentRuntimeStreamEvent, { type: "plan-step-result" }>;
    expect(stepResult.success).toBe(true);
    const doneEvent = events.at(-1) as Extract<AgentRuntimeStreamEvent, { type: "done" }>;
    expect(doneEvent.response.output.length).toBeGreaterThan(0);

    expect(await readNotesOrAbsent(noteFile)).toEqual([{ text: "buy milk" }]); // terminal WORLD STATE
  });

  it("run(): the blocking variant accomplishes the same goal and persists a completed run record", async () => {
    const history = new InMemoryAgentRunHistoryStore();
    const runtime = createAgentRuntime({
      historyStore: history,
      maxToolCalls: 3,
      modelProvider: new DiagnosticModelProvider({ defaultModel: "diagnostic/smoke" }),
      toolRegistry: new ToolRegistry([saveNoteTool()]),
    });

    const result = await runtime.run({
      messages: [{ content: steer("call mom"), role: "user" }],
      metadata: { agentMode: "plan_execute" },
      model: "diagnostic/smoke",
      runId: "run-pe-block",
    });

    expect(result.response.output.length).toBeGreaterThan(0);
    expect(await readNotesOrAbsent(noteFile)).toEqual([{ text: "call mom" }]);
    const record = await history.findRun("run-pe-block");
    expect(record?.status).toBe("completed");
  });
});
