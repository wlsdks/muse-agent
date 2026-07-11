import type { ModelProvider, ModelResponse, ModelToolCall } from "@muse/model";
import { ToolRegistry, createRunToolPlanTool, type MuseTool } from "@muse/tools";
import { describe, expect, it } from "vitest";

import { createAgentRuntime, verifyGrounding, type KnowledgeMatch } from "../src/index.js";
import type { AgentRunInput } from "../src/index.js";

// PTC Phase 3 — the `run_tool_plan` tool exposed to the model, intercepted in AgentRuntime's single
// tool chokepoint (executeToolCall) and driven through the Phase 2 gated path. These run the REAL
// model loop (a scripted fake provider emits the run_tool_plan call) so the interception, gating,
// grounding-source wiring, and the fail-close error paths are all exercised end to end — not the
// executeToolPlanGated seam in isolation (that is tool-plan-gated.test.ts).

interface Effect {
  readonly tool: string;
  readonly args: Record<string, unknown>;
}

/** A tool that records each call and returns a chosen plain-string output (so a later step / the
 *  result projection binds to a clean value, and the projected result is clean grounding evidence). */
const tool = (
  name: string,
  sink: Effect[],
  output: (args: Record<string, unknown>) => string,
  risk: "read" | "write" | "execute" = "read"
): MuseTool => ({
  definition: {
    description: `Test tool ${name} for PTC.`,
    inputSchema: { properties: { value: { type: "string" } }, type: "object" },
    name,
    risk
  },
  execute: (args) => {
    sink.push({ args: args as Record<string, unknown>, tool: name });
    return output(args as Record<string, unknown>);
  }
});

/** A scripted provider: each model turn returns the next response in the list (tool call, then the
 *  final answer). generate must be called — the model loop drives the whole turn sequence. */
const sequenceProvider = (turns: readonly ModelResponse[]): ModelProvider => {
  let i = 0;
  return {
    id: "test",
    async generate(request) {
      const r = turns[Math.min(i, turns.length - 1)]!;
      i += 1;
      return { ...r, model: request.model };
    },
    async listModels() { return []; },
    async *stream() {}
  };
};

const planCall = (plan: unknown): ModelToolCall => ({ arguments: plan as Record<string, unknown>, id: "tc-plan", name: "run_tool_plan" });
const turn = (output: string, toolCalls: ModelToolCall[] = []): ModelResponse => ({ id: "x", model: "m", output, toolCalls });

const runInput = (prompt: string, tools: readonly string[], extra: Partial<AgentRunInput> = {}): AgentRunInput => ({
  messages: [{ content: prompt, role: "user" }],
  metadata: { allowedToolNames: [...tools, "run_tool_plan"], localMode: true, maxTools: 20 },
  model: "provider/model",
  runId: "run-ptc3",
  ...extra
});

const registry = (tools: readonly MuseTool[]) => new ToolRegistry([createRunToolPlanTool(), ...tools]);

// afterTool hook capture — lets a test read the run_tool_plan result without a private seam.
const capture = () => {
  const seen: { id: string; name: string; status?: string; output?: unknown }[] = [];
  return {
    seen,
    hook: { afterTool: (_c: unknown, tc: { id: string; name: string }, r: unknown) => {
      const res = r as { status?: string; output?: unknown };
      seen.push({ id: tc.id, name: tc.name, output: res.output, status: res.status });
    }, id: "cap" }
  };
};

describe("PTC Phase 3 — run_tool_plan tool, intercepted + grounded", () => {
  it("executes a MULTI-STEP plan through the gate and returns the projected result as a completed tool result", async () => {
    const effects: Effect[] = [];
    const gateSeen: string[] = [];
    const cap = capture();
    const runtime = createAgentRuntime({
      hooks: [cap.hook as never],
      modelProvider: sequenceProvider([
        turn("planning", [planCall({
          result: "$b",
          steps: [
            { args: { value: "seed" }, as: "a", tool: "lookup" },
            { args: { value: "$a" }, as: "b", tool: "passthrough" }
          ]
        })]),
        turn("final answer")
      ]),
      toolApprovalGate: ({ toolCall }) => { gateSeen.push(toolCall.name); return { allowed: true }; },
      toolRegistry: registry([
        tool("lookup", effects, () => "Paris is the capital of France"),
        tool("passthrough", effects, (a) => String(a["value"]))
      ])
    });

    const result = await runtime.run(runInput("make a plan to chain lookups", ["lookup", "passthrough"]));

    expect(result.response.output).toBe("final answer");
    // Both steps executed, IN ORDER, each through the per-step approval gate (gating ran per step).
    expect(effects.map((e) => e.tool)).toEqual(["lookup", "passthrough"]);
    expect(gateSeen).toEqual(["lookup", "passthrough"]);
    // The projected result ($b = passthrough echoing $a) is the ONLY value returned to the model,
    // as a COMPLETED run_tool_plan tool result.
    const planResult = cap.seen.find((e) => e.name === "run_tool_plan");
    expect(planResult?.status).toBe("completed");
    expect(String(planResult?.output)).toContain("Paris is the capital of France");
    // …and it is a citable grounding source (the fabrication=0 wiring).
    expect(result.groundingSources?.some((s) => s.source === "run_tool_plan" && s.text.includes("Paris"))).toBe(true);
    // run_tool_plan counted as ONE model-loop tool call (the 2-step plan was one inference).
    expect(result.toolsUsed).toEqual(["run_tool_plan"]);
  });

  it("budget lock: a 3-step plan runs all 3 steps but costs exactly ONE tool-call budget slot", async () => {
    const effects: Effect[] = [];
    const runtime = createAgentRuntime({
      modelProvider: sequenceProvider([
        turn("planning", [planCall({
          result: "$c",
          steps: [
            { args: { value: "seed" }, as: "a", tool: "a" },
            { args: { value: "$a" }, as: "b", tool: "b" },
            { args: { value: "$b" }, as: "c", tool: "c" }
          ]
        })]),
        turn("final answer")
      ]),
      toolRegistry: registry([
        tool("a", effects, (args) => `${String(args["value"])}-a`),
        tool("b", effects, (args) => `${String(args["value"])}-b`),
        tool("c", effects, (args) => `${String(args["value"])}-c`)
      ])
    });

    const result = await runtime.run(runInput("chain a, b, then c", ["a", "b", "c"]));

    // The plan actually did N work — all 3 steps ran, in order.
    expect(effects.map((e) => e.tool)).toEqual(["a", "b", "c"]);
    // …yet the run's tool-call budget only saw ONE call: run_tool_plan itself. The step tools never
    // re-enter the model loop's toolCallCount, so they must not appear in toolsUsed.
    expect(result.toolsUsed).toEqual(["run_tool_plan"]);
  });

  it("fabrication ⇒ dropped: the REAL grounding gate flags a claim the PTC result does not support, keeps a supported one", async () => {
    const effects: Effect[] = [];
    const runtime = createAgentRuntime({
      modelProvider: sequenceProvider([
        turn("planning", [planCall({
          result: "$b",
          steps: [
            { args: { value: "seed" }, as: "a", tool: "lookup" },
            { args: { value: "$a" }, as: "b", tool: "passthrough" }
          ]
        })]),
        turn("answer")
      ]),
      toolRegistry: registry([
        tool("lookup", effects, () => "Paris is the capital of France"),
        tool("passthrough", effects, (a) => String(a["value"]))
      ])
    });

    const result = await runtime.run(runInput("plan to find the capital of France", ["lookup", "passthrough"]));

    // The PTC result is the citable evidence — convert the REAL grounding sources the run produced
    // into the gate's match shape (confident retrieval) and judge two candidate final answers.
    const matches: KnowledgeMatch[] = (result.groundingSources ?? []).map((s) => ({ cosine: 1, score: 1, source: s.source, text: s.text }));
    expect(matches.length).toBeGreaterThan(0);

    const supported = verifyGrounding("Paris is the capital of France.", matches, "what is the capital of France");
    expect(supported.verdict).toBe("grounded");

    // A claim NOT in the PTC result (Berlin / a population figure) is dropped by code.
    const fabricated = verifyGrounding(
      "Berlin is the capital and the population is eighty million residents today indeed.",
      matches,
      "what is the capital of France"
    );
    expect(fabricated.verdict).toBe("ungrounded");
  });

  it("nested run_tool_plan is rejected at parse (no infinite recursion)", async () => {
    const effects: Effect[] = [];
    const cap = capture();
    const runtime = createAgentRuntime({
      hooks: [cap.hook as never],
      modelProvider: sequenceProvider([
        turn("planning", [planCall({
          result: "$a",
          steps: [{ args: { value: "x" }, as: "a", tool: "run_tool_plan" }]
        })]),
        turn("recovered")
      ]),
      toolRegistry: registry([tool("lookup", effects, () => "ok")])
    });

    const result = await runtime.run(runInput("plan to chain things", ["lookup"]));

    expect(result.response.output).toBe("recovered"); // loop survived — no recursion/crash
    const planResult = cap.seen.find((e) => e.name === "run_tool_plan");
    expect(planResult?.status).toBe("blocked");
    expect(String(planResult?.output)).toContain("unknown tool 'run_tool_plan'");
    expect(effects).toEqual([]); // nothing executed
  });

  it("parse error ⇒ a clean BLOCKED tool result, the loop continues (no crash)", async () => {
    const effects: Effect[] = [];
    const cap = capture();
    const runtime = createAgentRuntime({
      hooks: [cap.hook as never],
      modelProvider: sequenceProvider([
        turn("planning", [planCall({ result: "$missing", steps: [{ args: {}, as: "a", tool: "lookup" }] })]),
        turn("recovered")
      ]),
      toolRegistry: registry([tool("lookup", effects, () => "ok")])
    });

    const result = await runtime.run(runInput("plan something", ["lookup"]));

    expect(result.response.output).toBe("recovered");
    const planResult = cap.seen.find((e) => e.name === "run_tool_plan");
    expect(planResult?.status).toBe("blocked");
    expect(String(planResult?.output)).toContain("invalid tool plan");
    expect(effects).toEqual([]); // a result-projection error means NO step ran (validated before execution)
  });

  it("blocked step ⇒ a clean BLOCKED tool result with NO partial downstream effect", async () => {
    const effects: Effect[] = [];
    const cap = capture();
    const runtime = createAgentRuntime({
      hooks: [cap.hook as never],
      modelProvider: sequenceProvider([
        turn("planning", [planCall({
          result: "$b",
          steps: [
            { args: { value: "x" }, as: "a", tool: "blocked_step" },
            { args: { value: "$a" }, as: "b", tool: "after_step" }
          ]
        })]),
        turn("recovered")
      ]),
      // Deny the FIRST step; the plan must abort before after_step runs.
      toolApprovalGate: ({ toolCall }) => (toolCall.name === "blocked_step" ? { allowed: false, reason: "denied" } : { allowed: true }),
      toolRegistry: registry([
        tool("blocked_step", effects, () => "should not run"),
        tool("after_step", effects, () => "should not run either")
      ])
    });

    const result = await runtime.run(runInput("plan to chain a denied step", ["blocked_step", "after_step"]));

    expect(result.response.output).toBe("recovered"); // no crash
    const planResult = cap.seen.find((e) => e.name === "run_tool_plan");
    expect(planResult?.status).toBe("blocked");
    expect(effects).toEqual([]); // denied step never executed AND after_step never ran (no partial effect)
  });
});
