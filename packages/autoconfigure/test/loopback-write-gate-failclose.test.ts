import { createAgentRuntime, parseToolPlan, ToolPlanStepBlockedError } from "@muse/agent-core";
import type { AgentRunContext, AgentRunInput } from "@muse/agent-core";
import {
  TasksProviderRegistry,
  createTasksRegistryMcpServer,
  type Task,
  type TaskInput,
  type TasksProvider
} from "@muse/domain-tools";
import { createLoopbackMcpMuseTools } from "@muse/mcp";
import { createToolExposureAuthority } from "@muse/policy";
import { ToolRegistry, type MuseTool } from "@muse/tools";
import type { ModelMessage } from "@muse/model";
import { describe, expect, it } from "vitest";

/**
 * #34 regression: a COMPOUND loopback tool (`muse.tasks-multi`) exposes per-command
 * risk — `add`/`complete` are WRITE, `list`/`search`/`providers` are READ. The runtime
 * gate keys off each PROJECTED tool's own risk (`muse.tasks-multi.add` → write), NOT the
 * server's, so a write sub-command can never be laundered through as read-risk and skip
 * the approval gate. These drive the REAL projection + registry + runtime gate and grade
 * the TERMINAL STATE (the task store), the invariant that matters: a gated-out add mutates
 * NOTHING (agent-testing.md §no-partial-side-effects; outbound-safety "prove the gate").
 */

// A real TasksProviderRegistry over a fake in-memory backend whose add() records into a
// sink — the "world state". A gated-out add proves itself by an empty sink. The registry
// is the genuine class; only the provider backend is faked (contract-faithful).
function recordingTasksTools(): { readonly added: TaskInput[]; readonly tools: readonly MuseTool[] } {
  const added: TaskInput[] = [];
  const provider: TasksProvider = {
    id: "local",
    describe: () => ({ description: "test", displayName: "Local", id: "local", local: true }),
    list: async () => [],
    add: async (input) => {
      added.push(input);
      const task: Task = { createdAt: new Date(), id: "t1", providerId: "local", status: "open", title: input.title };
      return task;
    },
    complete: async () => undefined,
    search: async () => []
  };
  const registry = new TasksProviderRegistry([provider]);
  const tools = createLoopbackMcpMuseTools(createTasksRegistryMcpServer({ registry }));
  return { added, tools };
}

const runtimeWith = (tools: readonly MuseTool[], gate?: AgentRunInput["toolApprovalGate"]) =>
  createAgentRuntime({
    modelProvider: {
      id: "noop",
      async generate() { throw new Error("model must not be called on the gated path"); },
      async listModels() { return []; },
      // eslint-disable-next-line require-yield
      async *stream() { throw new Error("model must not be called on the gated path"); }
    },
    toolRegistry: new ToolRegistry(tools),
    ...(gate ? { toolApprovalGate: gate } : {})
  });

const contextFor = (messages: readonly ModelMessage[]): AgentRunContext => ({
  input: {
    messages,
    model: "provider/model",
    toolExposureAuthority: createToolExposureAuthority({ allowedToolNames: ["muse.tasks-multi.add"], localMode: true })
  },
  runId: "run-34",
  startedAt: new Date()
});

const addPlan = () => {
  const parsed = parseToolPlan({
    result: "$a",
    steps: [{ args: { title: "Buy milk" }, as: "a", tool: "muse.tasks-multi.add" }]
  });
  if ("error" in parsed) throw new Error(parsed.error);
  return parsed;
};

describe("#34 — compound loopback WRITE sub-command is gated fail-close (no bypass on a gateless path)", () => {
  it("NO gate wired (the chat act path) ⇒ the write add is BLOCKED and the task store is UNCHANGED", async () => {
    const { added, tools } = recordingTasksTools();
    const runtime = runtimeWith(tools); // gateless, exactly like the shared chat runtime

    await expect(
      runtime.executeToolPlanGated(addPlan(), contextFor([{ content: "add a task: Buy milk", role: "user" }]))
    ).rejects.toBeInstanceOf(ToolPlanStepBlockedError);

    expect(added).toEqual([]); // fail-close held: add() never ran, nothing persisted
  });

  it("DENY gate ⇒ the write add is blocked and the task store is UNCHANGED (no partial side-effect)", async () => {
    const { added, tools } = recordingTasksTools();
    const runtime = runtimeWith(tools, () => ({ allowed: false, reason: "adding a task needs confirmation" }));

    await expect(
      runtime.executeToolPlanGated(addPlan(), contextFor([{ content: "add a task: Buy milk", role: "user" }]))
    ).rejects.toBeInstanceOf(ToolPlanStepBlockedError);

    expect(added).toEqual([]);
  });

  it("ALLOW gate ⇒ the add executes once AND the gate was consulted with risk \"write\" (not defaulted to read)", async () => {
    const { added, tools } = recordingTasksTools();
    const seen: { readonly risk: string; readonly name: string }[] = [];
    const runtime = runtimeWith(tools, ({ risk, toolCall }) => {
      seen.push({ name: toolCall.name, risk });
      return { allowed: true };
    });

    await runtime.executeToolPlanGated(addPlan(), contextFor([{ content: "add a task: Buy milk", role: "user" }]));

    expect(added).toHaveLength(1);
    expect(added[0]!.title).toBe("Buy milk");
    // The compound tool's per-command risk survived projection: the gate saw WRITE.
    expect(seen).toEqual([{ name: "muse.tasks-multi.add", risk: "write" }]);
  });
});
