import { describe, expect, it, vi } from "vitest";
import { InMemoryHookTraceStore } from "@muse/runtime-state";
import {
  hookInvocation,
  invokeHooks,
  mergedHooks,
  recordHookTrace
} from "../src/hook-orchestration.js";
import type { AgentRunContext, HookStage } from "../src/types.js";

function buildContext(overrides: Partial<AgentRunContext> = {}): AgentRunContext {
  return {
    input: {
      messages: [{ content: "hi", role: "user" }],
      model: "test/model",
      ...(overrides.input ?? {})
    },
    runId: "run-hook-1",
    startedAt: new Date(),
    ...overrides
  };
}

describe("hook orchestration", () => {
  it("invokeHooks fires every hook with the requested lifecycle and records completed traces", async () => {
    const beforeStartA = vi.fn();
    const beforeStartB = vi.fn();
    const afterToolUnused = vi.fn();
    const hookTraceStore = new InMemoryHookTraceStore();

    await invokeHooks("beforeStart", buildContext(), {
      hookTraceStore,
      hooks: [
        { afterTool: afterToolUnused, beforeStart: beforeStartA, id: "hook-a" },
        { beforeStart: beforeStartB, id: "hook-b" }
      ]
    });

    expect(beforeStartA).toHaveBeenCalledTimes(1);
    expect(beforeStartB).toHaveBeenCalledTimes(1);
    expect(afterToolUnused).not.toHaveBeenCalled();
    const traces = await hookTraceStore.listRecent();
    expect(traces.map((t) => `${t.hookId}:${t.lifecycle}:${t.status}`).sort()).toEqual([
      "hook-a:beforeStart:completed",
      "hook-b:beforeStart:completed"
    ]);
  });

  it("invokeHooks records 'failed' traces and continues with later hooks when one throws", async () => {
    const failing = vi.fn().mockRejectedValue(new Error("hook A boom"));
    const surviving = vi.fn();
    const hookTraceStore = new InMemoryHookTraceStore();

    await expect(invokeHooks("beforeStart", buildContext(), {
      hookTraceStore,
      hooks: [
        { beforeStart: failing, id: "hook-fail" },
        { beforeStart: surviving, id: "hook-after" }
      ]
    })).resolves.toBeUndefined();

    expect(surviving).toHaveBeenCalledTimes(1);
    const traces = await hookTraceStore.listRecent();
    const failed = traces.find((t) => t.hookId === "hook-fail");
    expect(failed?.status).toBe("failed");
    expect(failed?.error).toBe("hook A boom");
  });

  it("does NOT hang the loop on a hook that never resolves — times out, records 'failed', continues", async () => {
    const hanging = (): Promise<void> => Promise.withResolvers<void>().promise;
    const surviving = vi.fn();
    const hookTraceStore = new InMemoryHookTraceStore();

    await expect(invokeHooks("beforeStart", buildContext(), {
      hookTimeoutMs: 10,
      hookTraceStore,
      hooks: [
        { beforeStart: hanging, id: "hook-hang" },
        { beforeStart: surviving, id: "hook-after" }
      ]
    })).resolves.toBeUndefined();

    expect(surviving).toHaveBeenCalledTimes(1); // a hang no longer blocks later hooks / the loop
    const traces = await hookTraceStore.listRecent();
    const hung = traces.find((t) => t.hookId === "hook-hang");
    expect(hung?.status).toBe("failed");
    expect(hung?.error).toContain("timeout");
  });

  it("a fast hook completes normally under the timeout (no false cut-off)", async () => {
    const fast = vi.fn().mockResolvedValue(undefined);
    const hookTraceStore = new InMemoryHookTraceStore();
    await invokeHooks("beforeStart", buildContext(), { hookTimeoutMs: 1000, hookTraceStore, hooks: [{ beforeStart: fast, id: "fast" }] });
    expect(fast).toHaveBeenCalledTimes(1);
    expect((await hookTraceStore.listRecent()).find((t) => t.hookId === "fast")?.status).toBe("completed");
  });

  it("mergedHooks lets a HookRegistry entry override a static hook with the same id", () => {
    const staticHook: HookStage = { beforeStart: () => undefined, id: "shared" };
    const dynamicHook: HookStage = { beforeStart: () => undefined, id: "shared" };
    const merged = mergedHooks({
      hookRegistry: { list: () => [dynamicHook] },
      hooks: [staticHook]
    });
    expect(merged).toHaveLength(1);
    expect(merged[0]).toBe(dynamicHook);
  });

  it("hookInvocation returns undefined when the hook does not implement the requested lifecycle", () => {
    const hook: HookStage = { beforeStart: () => undefined, id: "static" };
    expect(hookInvocation(hook, "afterTool", buildContext(), { result: { id: "x", name: "tool", output: "", status: "completed" }, toolCall: { arguments: {}, id: "x", name: "tool" } })).toBeUndefined();
    expect(hookInvocation(hook, "beforeStart", buildContext(), undefined)).toBeDefined();
  });

  it("recordHookTrace is a no-op when no store is configured", async () => {
    await expect(
      recordHookTrace(undefined, buildContext(), "h", "beforeStart", "completed", new Date(), Date.now())
    ).resolves.toBeUndefined();
  });

  it("recordHookTrace swallows store errors so the agent loop is never blocked", async () => {
    const failing = { record: vi.fn().mockRejectedValue(new Error("store down")) };
    await expect(
      recordHookTrace(failing as never, buildContext(), "h", "beforeStart", "completed", new Date(), Date.now())
    ).resolves.toBeUndefined();
    expect(failing.record).toHaveBeenCalledTimes(1);
  });
});
