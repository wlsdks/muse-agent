import { beforeEach, describe, expect, it } from "vitest";

import { createMuseRuntimeAssembly, type MuseRuntimeAssembly } from "../src/index.js";

// End-to-end through the REAL production assembly (createMuseRuntimeAssembly),
// not a hand-wired runtime: provider routing → guards/context transforms →
// model loop (direct + plan-execute) → real tool execution → synthesis →
// history/tool-call/message persistence. The diagnostic provider makes the
// whole path deterministic (the in-process equivalent of smoke:broad).
const DIAGNOSTIC_ENV = { MUSE_MODEL: "diagnostic/smoke", MUSE_MODEL_PROVIDER_ID: "diagnostic" };

describe("createMuseRuntimeAssembly end-to-end (diagnostic provider)", () => {
  let assembly: MuseRuntimeAssembly;

  beforeEach(() => {
    // A fresh assembly (fresh in-memory stores) per test — no cross-test bleed.
    assembly = createMuseRuntimeAssembly({ env: DIAGNOSTIC_ENV });
  });

  it("assembles a runnable runtime wired to the diagnostic provider", () => {
    expect(assembly.agentRuntime).toBeTruthy();
    expect(assembly.defaultModel).toBe("diagnostic/smoke");
    expect(assembly.modelProvider?.id).toBe("diagnostic");
  });

  it("runs a direct-answer turn through the full stack", async () => {
    const result = await assembly.agentRuntime!.run({
      messages: [{ content: "hello there", role: "user" }],
      model: "diagnostic/smoke",
    });
    expect(result.response.output).toBe("Diagnostic response: hello there");
    expect(result.runId).toBeTruthy();
    expect(result.contextWindow).toBeDefined();
    expect(result.toolsUsed ?? []).toEqual([]); // a direct answer uses no tools

  });

  it("drives a plan-execute tool round-trip: plan → real tool execution → synthesis", async () => {
    const result = await assembly.agentRuntime!.run({
      messages: [{ content: "what time is it right now?", role: "user" }],
      model: "diagnostic/smoke",
      metadata: { agentMode: "plan_execute" },
    });
    // The diagnostic planner emits a one-step time_now plan; the assembled
    // tool registry executes the real time_now tool; the result is synthesised.
    expect(result.toolsUsed).toEqual(["time_now"]);
    expect(result.response.output).toContain("time_now");
    expect(result.runId).toBeTruthy();
  });

  it("persists the run, its tool calls, and its messages in the assembled history store", async () => {
    const result = await assembly.agentRuntime!.run({
      messages: [{ content: "what time is it now?", role: "user" }],
      model: "diagnostic/smoke",
      metadata: { agentMode: "plan_execute", userId: "jinan" },
    });

    const runs = await assembly.historyStore.listRuns();
    const record = runs.find((r) => r.id === result.runId);
    expect(record).toMatchObject({ status: "completed", model: "diagnostic/smoke" });

    expect((await assembly.historyStore.listRunsByUser("jinan")).map((r) => r.id)).toContain(result.runId);
    expect(await assembly.historyStore.listRunsByUser("someone-else")).toEqual([]);

    const toolCalls = await assembly.historyStore.listToolCalls(result.runId);
    expect(toolCalls.map((t) => ({ name: t.name, status: t.status }))).toEqual([
      { name: "time_now", status: "completed" },
    ]);

    const messages = await assembly.historyStore.listMessages(result.runId);
    expect([...new Set(messages.map((m) => m.role))]).toEqual(expect.arrayContaining(["user", "assistant", "tool"]));
  });
});
