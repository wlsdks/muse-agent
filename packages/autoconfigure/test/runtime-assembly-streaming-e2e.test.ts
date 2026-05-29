import { beforeEach, describe, expect, it } from "vitest";

import { createMuseRuntimeAssembly, type MuseRuntimeAssembly } from "../src/index.js";

// Streaming counterpart to runtime-assembly-e2e: drive the assembled
// runtime's stream() surface through the diagnostic provider and assert
// the event sequence + final response + real tool execution end-to-end.
const DIAGNOSTIC_ENV = { MUSE_MODEL: "diagnostic/smoke", MUSE_MODEL_PROVIDER_ID: "diagnostic" };

interface DoneEvent {
  readonly type: "done";
  readonly runId: string;
  readonly response: { readonly output: string };
}

async function drain(stream: AsyncIterable<{ readonly type: string }>) {
  const types: string[] = [];
  let done: DoneEvent | undefined;
  for await (const event of stream) {
    types.push(event.type);
    if (event.type === "done") done = event as unknown as DoneEvent;
  }
  return { types, done };
}

describe("createMuseRuntimeAssembly streaming end-to-end (diagnostic provider)", () => {
  let assembly: MuseRuntimeAssembly;

  beforeEach(() => {
    assembly = createMuseRuntimeAssembly({ env: DIAGNOSTIC_ENV });
  });

  it("streams a direct answer as text-delta then done", async () => {
    const { types, done } = await drain(
      assembly.agentRuntime!.stream({ messages: [{ content: "hello", role: "user" }], model: "diagnostic/smoke" }),
    );
    expect(types).toEqual(["text-delta", "done"]);
    expect(done?.response.output).toBe("Diagnostic response: hello");
    expect(done?.runId).toBeTruthy();
  });

  it("streams the full plan-execute event sequence and a synthesised final response", async () => {
    const { types, done } = await drain(
      assembly.agentRuntime!.stream({
        messages: [{ content: "what time is it now?", role: "user" }],
        model: "diagnostic/smoke",
        metadata: { agentMode: "plan_execute" },
      }),
    );
    expect(types).toEqual([
      "plan-generated",
      "plan-step-executing",
      "plan-step-result",
      "synthesis-started",
      "text-delta",
      "done",
    ]);
    expect(done?.response.output).toContain("time_now");
  });

  it("executes the real time_now tool during the streamed plan-execute run", async () => {
    const { done } = await drain(
      assembly.agentRuntime!.stream({
        messages: [{ content: "what time is it now?", role: "user" }],
        model: "diagnostic/smoke",
        metadata: { agentMode: "plan_execute", userId: "u2" },
      }),
    );
    const toolCalls = await assembly.historyStore.listToolCalls(done!.runId);
    expect(toolCalls.map((t) => ({ name: t.name, status: t.status }))).toEqual([{ name: "time_now", status: "completed" }]);
  });
});
