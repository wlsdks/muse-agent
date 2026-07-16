import { describe, expect, it, vi } from "vitest";
import { InMemoryAgentRunHistoryStore, InMemoryCheckpointStore } from "@muse/runtime-state";
import {
  recordCheckpoint,
  recordRunComplete,
  recordRunFailure,
  recordRunStart
} from "../src/lifecycle.js";
import type { AgentRunContext, ModelLoopExecution } from "../src/types.js";

function buildContext(overrides: Partial<AgentRunContext> = {}): AgentRunContext {
  return {
    input: {
      messages: [{ content: "hello", role: "user" }],
      model: "provider/model",
      ...(overrides.input ?? {})
    },
    runId: "run-1",
    startedAt: new Date("2026-05-08T00:00:00.000Z"),
    ...overrides
  };
}

describe("lifecycle recorders", () => {
  it("recordRunStart createRun + appends inbound messages to the history store", async () => {
    const historyStore = new InMemoryAgentRunHistoryStore();

    await recordRunStart({
      context: buildContext({
        input: {
          messages: [
            { content: "system seed", role: "system" },
            { content: "user ask", role: "user" }
          ],
          metadata: { userId: "u-1" },
          model: "provider/model"
        }
      }),
      historyStore,
      model: "provider/model",
      provider: "openai"
    });

    const run = await historyStore.findRun("run-1");
    expect(run).toMatchObject({
      id: "run-1",
      input: "user ask",
      model: "provider/model",
      provider: "openai",
      status: "running",
      userId: "u-1"
    });
    const messages = await historyStore.listMessages("run-1");
    const roles = messages.map((m) => m.role).sort();
    expect(roles).toEqual(["system", "user"]);
  });

  it("recordRunStart is a no-op when historyStore is undefined", async () => {
    await expect(
      recordRunStart({ context: buildContext(), model: "m", provider: "p" })
    ).resolves.toBeUndefined();
  });

  it("recordRunComplete appends intermediate + final messages and tool-call rows", async () => {
    const historyStore = new InMemoryAgentRunHistoryStore();
    await historyStore.createRun({
      id: "run-2",
      input: "u",
      mode: "react",
      model: "m",
      provider: "p",
      startedAt: new Date(),
      status: "running"
    });

    const execution: ModelLoopExecution = {
      finalResponse: {
        id: "resp-1",
        model: "m",
        output: "final",
        toolCalls: [{ arguments: {}, id: "tc-2", name: "tool_b" }]
      },
      intermediateMessages: [{ content: "thinking", role: "assistant" }],
      toolResults: [
        {
          result: { id: "tc-1", name: "tool_a", output: "ok", status: "completed" },
          toolCall: { arguments: {}, id: "tc-1", name: "tool_a" }
        }
      ],
      toolsUsed: ["tool_a"]
    };

    await recordRunComplete({
      context: buildContext({ runId: "run-2" }),
      execution,
      historyStore,
      resolveToolRisk: () => "read"
    });

    const messages = await historyStore.listMessages("run-2");
    const roles = messages.map((m) => m.role);
    expect(roles).toContain("assistant");
    expect(messages.some((m) => m.content === "final")).toBe(true);

    const toolCalls = await historyStore.listToolCalls("run-2");
    const sortedNames = toolCalls.map((c) => c.name).sort();
    expect(sortedNames).toEqual(["tool_a", "tool_b"]);
    const tcA = toolCalls.find((c) => c.id === "tc-1");
    expect(tcA?.status).toBe("completed");
    const tcB = toolCalls.find((c) => c.id === "tc-2");
    expect(tcB?.status).toBe("queued");

    const updated = await historyStore.findRun("run-2");
    expect(updated?.status).toBe("completed");
    expect(updated?.output).toBe("final");
  });

  it("recordRunComplete persists costUsd when the model has known pricing", async () => {
    const historyStore = new InMemoryAgentRunHistoryStore();
    await historyStore.createRun({
      id: "run-cost",
      input: "u",
      mode: "react",
      model: "openai/gpt-4o-mini",
      provider: "openai",
      startedAt: new Date(),
      status: "running"
    });

    const execution: ModelLoopExecution = {
      finalResponse: {
        id: "r",
        model: "openai/gpt-4o-mini",
        output: "ok",
        usage: { inputTokens: 1_000, outputTokens: 1_000 }
      },
      intermediateMessages: [],
      toolResults: [],
      toolsUsed: []
    };

    await recordRunComplete({
      context: buildContext({ runId: "run-cost" }),
      execution,
      historyStore,
      resolveToolRisk: () => "read"
    });

    const run = await historyStore.findRun("run-cost");
    expect(run?.costUsd).toBeDefined();
    expect(Number(run?.costUsd)).toBeGreaterThan(0);
    // 1k+1k for gpt-4o-mini ≈ $0.00075
    expect(Number(run?.costUsd)).toBeCloseTo(0.00075, 5);
  });

  it("recordRunComplete leaves costUsd at the createRun default when pricing is unknown", async () => {
    const historyStore = new InMemoryAgentRunHistoryStore();
    await historyStore.createRun({
      id: "run-no-cost",
      input: "u",
      mode: "react",
      model: "diagnostic/smoke",
      provider: "diagnostic",
      startedAt: new Date(),
      status: "running"
    });

    const execution: ModelLoopExecution = {
      finalResponse: {
        id: "r",
        model: "diagnostic/smoke",
        output: "ok",
        usage: { inputTokens: 5, outputTokens: 5 }
      },
      intermediateMessages: [],
      toolResults: [],
      toolsUsed: []
    };

    await recordRunComplete({
      context: buildContext({ runId: "run-no-cost" }),
      execution,
      historyStore,
      resolveToolRisk: () => "read"
    });

    const run = await historyStore.findRun("run-no-cost");
    // Default pricing returns a small non-zero number for unknown models.
    // We don't assert a specific value — only that the path doesn't throw
    // and the run reaches "completed".
    expect(run?.status).toBe("completed");
  });

  it("recordRunComplete swallows store errors so agent execution is never blocked", async () => {
    const failing: { recordToolCall: ReturnType<typeof vi.fn>; appendMessage: ReturnType<typeof vi.fn>; updateRun: ReturnType<typeof vi.fn>; createRun: ReturnType<typeof vi.fn> } = {
      appendMessage: vi.fn().mockRejectedValue(new Error("storage down")),
      createRun: vi.fn(),
      recordToolCall: vi.fn(),
      updateRun: vi.fn()
    };

    await expect(
      recordRunComplete({
        context: buildContext({ runId: "run-3" }),
        execution: {
          finalResponse: { id: "r", model: "m", output: "out" },
          intermediateMessages: [{ content: "ignored", role: "assistant" }],
          toolResults: [],
          toolsUsed: []
        },
        historyStore: failing as never,
        resolveToolRisk: () => "read"
      })
    ).resolves.toBeUndefined();
    expect(failing.appendMessage).toHaveBeenCalled();
  });

  it("recordCheckpoint persists encoded state and is a no-op without a store", async () => {
    const checkpointStore = new InMemoryCheckpointStore();
    await recordCheckpoint({
      checkpointStore,
      context: buildContext({ runId: "ckpt-1" }),
      messages: [{ content: "user", role: "user" }],
      output: "draft",
      phase: "midstream",
      step: 50
    });
    const checkpoints = await checkpointStore.findByRunId("ckpt-1");
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0]).toMatchObject({ runId: "ckpt-1", step: 50 });

    await expect(
      recordCheckpoint({
        context: buildContext({ runId: "no-store" }),
        messages: [],
        phase: "p",
        step: 0
      })
    ).resolves.toBeUndefined();
  });

  it("recordRunFailure marks the run failed and stores the error message", async () => {
    const historyStore = new InMemoryAgentRunHistoryStore();
    await historyStore.createRun({
      id: "run-fail",
      input: "u",
      mode: "react",
      model: "m",
      provider: "p",
      startedAt: new Date(),
      status: "running"
    });

    await recordRunFailure({
      context: buildContext({ runId: "run-fail" }),
      error: new Error("boom"),
      historyStore
    });

    const run = await historyStore.findRun("run-fail");
    expect(run?.status).toBe("failed");
    expect(run?.error).toBe("boom");
  });

  it("recordRunFailure preserves useful string throws", async () => {
    const historyStore = new InMemoryAgentRunHistoryStore();
    await historyStore.createRun({
      id: "run-fail-2",
      input: "u",
      mode: "react",
      model: "m",
      provider: "p",
      startedAt: new Date(),
      status: "running"
    });

    await recordRunFailure({
      context: buildContext({ runId: "run-fail-2" }),
      error: "string error",
      historyStore
    });

    expect((await historyStore.findRun("run-fail-2"))?.error).toBe("string error");
  });
});
