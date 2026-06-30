import type { ModelMessage } from "@muse/model";
import { ToolRegistry, type MuseTool } from "@muse/tools";
import { describe, expect, it } from "vitest";

import { createAgentRuntime, parseToolPlan, ToolPlanStepBlockedError } from "../src/index.js";
import type { AgentRunContext, AgentRunInput } from "../src/index.js";

// PTC Phase 2 — the plan interpreter's executor seam wired to AgentRuntime's EXISTING gated
// single-tool path (executeToolCall: approval gate → arg coercion/validation → arg grounding →
// executor). These assert gated EXECUTION only — that every plan step goes through the same gates
// as a native call, and a blocked step aborts the plan with no partial downstream effect. They do
// NOT assert "fabrication ⇒ dropped" of the plan's PROJECTED result — that needs the grounding /
// citation wiring, which is Phase 3.

interface Effect {
  readonly tool: string;
  readonly args: Record<string, unknown>;
}

// A tool that RECORDS every execution into a shared sink (the "world state"), so a denied/aborted
// step is provable by the ABSENCE of its effect. Echoes its args back as the (string) output so a
// later step / the result projection can bind to it.
const recordingTool = (name: string, sink: Effect[], opts: { risk?: "read" | "write" | "execute" } = {}): MuseTool => ({
  definition: {
    description: `Records the call for ${name}.`,
    inputSchema: { properties: { text: { type: "string" } }, type: "object" },
    name,
    risk: opts.risk ?? "read"
  },
  execute: (args) => {
    sink.push({ args: args as Record<string, unknown>, tool: name });
    return JSON.stringify(args);
  }
});

const runtimeWith = (tools: readonly MuseTool[], gate?: AgentRunInput["toolApprovalGate"]) =>
  createAgentRuntime({
    modelProvider: {
      id: "noop",
      async generate() { throw new Error("model must not be called in the gated-plan path"); },
      async listModels() { return []; },
      // eslint-disable-next-line require-yield
      async *stream() { throw new Error("model must not be called in the gated-plan path"); }
    },
    toolRegistry: new ToolRegistry(tools),
    ...(gate ? { toolApprovalGate: gate } : {})
  });

const contextFor = (messages: readonly ModelMessage[], input: Partial<AgentRunInput> = {}): AgentRunContext => ({
  input: { messages, model: "provider/model", metadata: { localMode: true }, ...input },
  runId: "run-ptc",
  startedAt: new Date()
});

describe("PTC Phase 2 — gated plan execution (no gate bypass)", () => {
  it("DENY ⇒ no external effect: a denial of step 1 aborts the plan and step 2 NEVER runs", async () => {
    const effects: Effect[] = [];
    const runtime = runtimeWith(
      [recordingTool("step_one", effects, { risk: "execute" }), recordingTool("step_two", effects, { risk: "execute" })],
      ({ toolCall }) => (toolCall.name === "step_one" ? { allowed: false, reason: "step_one not trusted" } : { allowed: true })
    );
    const parsed = parseToolPlan({
      result: "$b",
      steps: [
        { args: { text: "go" }, as: "a", tool: "step_one" },
        { args: { text: "go" }, as: "b", tool: "step_two" }
      ]
    });
    if ("error" in parsed) throw new Error(parsed.error);

    await expect(runtime.executeToolPlanGated(parsed, contextFor([{ content: "go", role: "user" }]))).rejects.toBeInstanceOf(
      ToolPlanStepBlockedError
    );

    expect(effects).toEqual([]); // neither step executed — the denied step aborted before step_two
    expect(effects.some((e) => e.tool === "step_two")).toBe(false);
  });

  it("DENY of a WRITE/execute-risk step ⇒ that step's tool never executes (outbound-safety)", async () => {
    const effects: Effect[] = [];
    const runtime = runtimeWith(
      [recordingTool("send_message", effects, { risk: "execute" })],
      () => ({ allowed: false, reason: "outbound send requires confirmation" })
    );
    const parsed = parseToolPlan({ result: "$a", steps: [{ args: { text: "hi" }, as: "a", tool: "send_message" }] });
    if ("error" in parsed) throw new Error(parsed.error);

    await expect(runtime.executeToolPlanGated(parsed, contextFor([{ content: "hi", role: "user" }]))).rejects.toBeInstanceOf(
      ToolPlanStepBlockedError
    );
    expect(effects).toEqual([]); // the risky tool produced NO effect
  });

  it("arg-grounding still applies: an arg NOT in the user messages is DROPPED exactly as a native call", async () => {
    const effects: Effect[] = [];
    const groundedTool: MuseTool = {
      definition: {
        description: "Adds a calendar event.",
        groundedArgs: ["location"],
        inputSchema: { properties: { title: { type: "string" }, location: { type: "string" } }, type: "object" },
        name: "calendar_add",
        risk: "write"
      },
      execute: (args) => {
        effects.push({ args: args as Record<string, unknown>, tool: "calendar_add" });
        return "added";
      }
    };
    const runtime = runtimeWith([groundedTool]);
    const parsed = parseToolPlan({
      result: "$a",
      // "Cafe Roma" is fabricated — it is NOT in the user message, so the grounding gate must drop it.
      steps: [{ args: { title: "Lunch", location: "Cafe Roma" }, as: "a", tool: "calendar_add" }]
    });
    if ("error" in parsed) throw new Error(parsed.error);

    await runtime.executeToolPlanGated(parsed, contextFor([{ content: "add a Lunch event", role: "user" }]));

    expect(effects).toHaveLength(1);
    expect(effects[0]!.args).toEqual({ title: "Lunch" }); // ungrounded `location` dropped at the gate
    expect(effects[0]!.args).not.toHaveProperty("location");
  });

  it("1-step plan: a single-step plan executes the tool once through the gate (native-equivalent)", async () => {
    const effects: Effect[] = [];
    const gateSeen: string[] = [];
    const runtime = runtimeWith([recordingTool("note_add", effects)], ({ toolCall }) => {
      gateSeen.push(toolCall.name);
      return { allowed: true };
    });
    const parsed = parseToolPlan({ result: "$a", steps: [{ args: { text: "buy milk" }, as: "a", tool: "note_add" }] });
    if ("error" in parsed) throw new Error(parsed.error);

    const out = await runtime.executeToolPlanGated(parsed, contextFor([{ content: "note: buy milk", role: "user" }]));

    expect(gateSeen).toEqual(["note_add"]); // the gate was consulted once
    expect(effects).toEqual([{ args: { text: "buy milk" }, tool: "note_add" }]); // executed exactly once
    // The gated path neutralises tool output (injection-spotlighting), so the binding carries the
    // wrapped-but-faithful tool result — the projection returns that gated output.
    expect(String(out.result)).toContain(JSON.stringify({ text: "buy milk" }));
  });
});
