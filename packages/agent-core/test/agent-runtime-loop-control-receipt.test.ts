import { InMemoryResponseCache } from "@muse/cache";
import type { ModelProvider, ModelRequest, ModelResponse } from "@muse/model";
import { createToolExposureAuthority } from "@muse/policy";
import { InMemoryAgentRunHistoryStore, InMemoryCheckpointStore } from "@muse/runtime-state";
import { ToolRegistry } from "@muse/tools";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createAgentRuntime, parseLoopControlReceipt } from "../src/index.js";

function sequenceProvider(responses: readonly ModelResponse[]): ModelProvider {
  let index = 0;
  return {
    id: "loop-receipt-test",
    async generate(_request: ModelRequest) {
      const response = responses[Math.min(index, responses.length - 1)]!;
      index += 1;
      return response;
    },
    async listModels() {
      return [];
    },
    async *stream() {}
  };
}

const input = {
  messages: [{ content: "help me", role: "user" as const }],
  metadata: {},
  model: "test/model",
  runId: "run-loop-receipt"
};

describe("AgentRuntime loop control receipt wiring", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("surfaces a content-bound pending receipt for a normal ReAct candidate", async () => {
    const runtime = createAgentRuntime({
      modelProvider: sequenceProvider([{ id: "answer", model: "test/model", output: "done" }])
    });

    const result = await runtime.run(input);
    const receipt = parseLoopControlReceipt(result.loopControlReceipt);

    expect(receipt.loopKind).toBe("react");
    expect(receipt.terminal).toEqual({ reason: "verification-pending", status: "held" });
    expect(receipt.verification).toEqual({ status: "pending" });
  });

  it("promotes to completed only when the explicit outcome verifier passes with evidence", async () => {
    const runtime = createAgentRuntime({
      loopOutcomeVerifier: (verificationInput) => {
        expect(Object.isFrozen(verificationInput)).toBe(true);
        expect(Object.isFrozen(verificationInput.toolsUsed)).toBe(true);
        expect(verificationInput.output).toBe("done");
        return { evidenceId: "terminal-eval:pass", status: "passed" };
      },
      modelProvider: sequenceProvider([{ id: "answer", model: "test/model", output: "done" }])
    });

    const result = await runtime.run({ ...input, runId: "verified-pass-run" });
    const receipt = parseLoopControlReceipt(result.loopControlReceipt);

    expect(receipt.terminal).toEqual({ reason: "goal-verified", status: "completed" });
    expect(receipt.verification).toEqual({ evidenceId: "terminal-eval:pass", status: "passed" });
  });

  it("records an explicit verifier failure and keeps verifier errors pending", async () => {
    const failedCache = new InMemoryResponseCache();
    const checkpointStore = new InMemoryCheckpointStore();
    const historyStore = new InMemoryAgentRunHistoryStore();
    const failedRuntime = createAgentRuntime({
      checkpointStore,
      historyStore,
      loopOutcomeVerifier: () => ({ evidenceId: "terminal-eval:fail", status: "failed" }),
      modelProvider: sequenceProvider([{ id: "answer", model: "test/model", output: "wrong" }]),
      responseCache: failedCache
    });
    const failedResult = await failedRuntime.run({ ...input, runId: "verified-fail-run" });
    const failed = parseLoopControlReceipt(failedResult.loopControlReceipt);
    const failedRepeat = await failedRuntime.run({ ...input, runId: "verified-fail-repeat" });

    expect(failed.terminal).toEqual({ reason: "verification-failed", status: "failed" });
    expect(failedRepeat.fromCache).not.toBe(true);
    expect(await historyStore.findRun("verified-fail-run")).toMatchObject({ status: "failed" });
    expect((await checkpointStore.findLatestByRunId("verified-fail-run"))?.state.phase).toBe("failed");

    const brokenRuntime = createAgentRuntime({
      loopOutcomeVerifier: () => {
        throw new Error("verifier unavailable");
      },
      modelProvider: sequenceProvider([{ id: "answer", model: "test/model", output: "unverified" }])
    });
    const pending = parseLoopControlReceipt(
      (await brokenRuntime.run({ ...input, runId: "broken-verifier-run" })).loopControlReceipt
    );

    expect(pending.terminal).toEqual({ reason: "verification-pending", status: "held" });
  });

  it("bounds a hung verifier and leaves completion pending", async () => {
    vi.useFakeTimers();
    let aborted = false;
    const runtime = createAgentRuntime({
      loopOutcomeVerifier: ({ signal }) => new Promise((_resolve) => {
        signal.addEventListener("abort", () => {
          aborted = true;
        }, { once: true });
      }),
      loopOutcomeVerifierTimeoutMs: 5,
      modelProvider: sequenceProvider([{ id: "answer", model: "test/model", output: "unverified" }])
    });

    const resultPromise = runtime.run({ ...input, runId: "hung-verifier-run" });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(5);
    const receipt = parseLoopControlReceipt((await resultPromise).loopControlReceipt);

    expect(aborted).toBe(true);
    expect(receipt.terminal).toEqual({ reason: "verification-pending", status: "held" });
  });

  it("omits a loop receipt on a cache hit because no loop executed", async () => {
    const responseCache = new InMemoryResponseCache();
    const runtime = createAgentRuntime({
      modelProvider: sequenceProvider([{ id: "answer", model: "test/model", output: "cached answer" }]),
      responseCache
    });

    const first = await runtime.run({ ...input, runId: "cache-source-run" });
    const second = await runtime.run({ ...input, runId: "cache-hit-run" });

    expect(first.loopControlReceipt).toBeDefined();
    expect(second.fromCache).toBe(true);
    expect(second.loopControlReceipt).toBeUndefined();
  });

  it("observes each finalized non-cache receipt once and ignores observer failures", async () => {
    const observed: unknown[] = [];
    const responseCache = new InMemoryResponseCache();
    const runtime = createAgentRuntime({
      loopControlReceiptObserver: (receipt) => {
        observed.push(receipt);
        expect(Object.isFrozen(receipt)).toBe(true);
        throw new Error("observer unavailable");
      },
      modelProvider: sequenceProvider([{ id: "answer", model: "test/model", output: "cached answer" }]),
      responseCache
    });

    const first = await runtime.run({ ...input, runId: "observer-source-run" });
    const second = await runtime.run({ ...input, runId: "observer-cache-hit-run" });

    expect(first.loopControlReceipt).toEqual(observed[0]);
    expect(second.fromCache).toBe(true);
    expect(observed).toHaveLength(1);
  });

  it("distinguishes plan-execute and never promotes its raw answer to completed", async () => {
    const runtime = createAgentRuntime({
      modelProvider: sequenceProvider([
        { id: "plan", model: "test/model", output: "[]" },
        { id: "answer", model: "test/model", output: "direct answer" }
      ])
    });

    const result = await runtime.run({
      ...input,
      metadata: { agentMode: "plan_execute" },
      runId: "run-plan-receipt"
    });
    const receipt = parseLoopControlReceipt(result.loopControlReceipt);

    expect(receipt.loopKind).toBe("plan-execute");
    expect(receipt.terminal.status).toBe("held");
  });

  it("emits the same terminal receipt contract on a streamed plan-execute run", async () => {
    const observed: unknown[] = [];
    const runtime = createAgentRuntime({
      loopControlReceiptObserver: (receipt) => observed.push(receipt),
      modelProvider: sequenceProvider([
        { id: "plan", model: "test/model", output: "[]" },
        { id: "answer", model: "test/model", output: "direct answer" }
      ])
    });
    const events = [];
    for await (const event of runtime.stream({
      ...input,
      metadata: { agentMode: "plan_execute" },
      runId: "stream-plan-receipt"
    })) {
      events.push(event);
    }
    const done = events.find((event) => event.type === "done");
    if (!done || done.type !== "done") throw new Error("missing done event");
    const receipt = parseLoopControlReceipt(done.loopControlReceipt);

    expect(receipt.loopKind).toBe("plan-execute");
    expect(receipt.terminal).toEqual({ reason: "verification-pending", status: "held" });
    expect(observed).toEqual([receipt]);
  });

  it("settles the streamed receipt through the same explicit verifier", async () => {
    const runtime = createAgentRuntime({
      loopOutcomeVerifier: () => ({ evidenceId: "stream-eval:pass", status: "passed" }),
      modelProvider: sequenceProvider([
        { id: "plan", model: "test/model", output: "[]" },
        { id: "answer", model: "test/model", output: "direct answer" }
      ])
    });
    const events = [];
    for await (const event of runtime.stream({
      ...input,
      metadata: { agentMode: "plan_execute" },
      runId: "verified-stream-plan"
    })) {
      events.push(event);
    }
    const done = events.find((event) => event.type === "done");
    if (!done || done.type !== "done") throw new Error("missing done event");
    const receipt = parseLoopControlReceipt(done.loopControlReceipt);

    expect(receipt.terminal).toEqual({ reason: "goal-verified", status: "completed" });
    expect(receipt.verification).toEqual({ evidenceId: "stream-eval:pass", status: "passed" });
  });

  it("reports a consumed tool cap as budget-exhausted instead of completed", async () => {
    const toolRegistry = new ToolRegistry([
      {
        definition: {
          description: "Read a note",
          inputSchema: { type: "object" },
          name: "read_note",
          risk: "read"
        },
        execute: async () => "note"
      }
    ]);
    const runtime = createAgentRuntime({
      maxToolCalls: 1,
      modelProvider: sequenceProvider([
        {
          id: "call",
          model: "test/model",
          output: "",
          toolCalls: [{ arguments: {}, id: "call-1", name: "read_note" }]
        },
        { id: "answer", model: "test/model", output: "done" }
      ]),
      toolRegistry
    });

    const result = await runtime.run({ ...input, runId: "run-budget-receipt" });
    const receipt = parseLoopControlReceipt(result.loopControlReceipt);

    expect(receipt.terminal).toEqual({ reason: "budget-exhausted", status: "failed" });
    expect(receipt.budget.tools).toEqual({ exhausted: true, limit: 1, used: 1 });
  });

  it("records repeated-read no-progress as failed and never asks the outcome verifier to promote it", async () => {
    const afterComplete = vi.fn();
    const checkpointStore = new InMemoryCheckpointStore();
    const historyStore = new InMemoryAgentRunHistoryStore();
    const responseCache = new InMemoryResponseCache();
    const verify = vi.fn(() => ({ evidenceId: "must-not-run", status: "passed" as const }));
    const toolRegistry = new ToolRegistry([
      {
        definition: {
          description: "Read a note",
          inputSchema: { type: "object" },
          name: "read_note",
          risk: "read"
        },
        execute: async () => "results: alpha beta gamma delta"
      }
    ]);
    const runtime = createAgentRuntime({
      checkpointStore,
      historyStore,
      hooks: [{ afterComplete, id: "no-progress-completion-observer" }],
      loopOutcomeVerifier: verify,
      maxToolCalls: 10,
      modelProvider: sequenceProvider([
        {
          id: "call-1",
          model: "test/model",
          output: "",
          toolCalls: [{ arguments: { page: 1 }, id: "tool-1", name: "read_note" }]
        },
        {
          id: "call-2",
          model: "test/model",
          output: "",
          toolCalls: [{ arguments: { page: 2 }, id: "tool-2", name: "read_note" }]
        },
        {
          id: "call-3",
          model: "test/model",
          output: "",
          toolCalls: [{ arguments: { page: 3 }, id: "tool-3", name: "read_note" }]
        },
        { id: "answer", model: "test/model", output: "synthesised final answer" }
      ]),
      responseCache,
      toolRegistry
    });

    const result = await runtime.run({ ...input, runId: "run-no-progress-receipt" });
    const receipt = parseLoopControlReceipt(result.loopControlReceipt);

    expect(receipt.terminal).toEqual({ reason: "no-progress", status: "failed" });
    expect(receipt.verification).toEqual({ status: "not-required" });
    expect(verify).not.toHaveBeenCalled();
    expect(await historyStore.findRun("run-no-progress-receipt")).toMatchObject({ status: "failed" });
    expect((await checkpointStore.findLatestByRunId("run-no-progress-receipt"))?.state.phase).toBe("failed");
    expect(responseCache.size()).toBe(0);
    expect(afterComplete).not.toHaveBeenCalled();
  });

  it("does not consume tool budget for a middleware-blocked synthetic result", async () => {
    const toolRegistry = new ToolRegistry([
      {
        definition: { description: "Read", inputSchema: { type: "object" }, name: "read_note", risk: "read" },
        execute: async () => "must not run"
      }
    ]);
    const runtime = createAgentRuntime({
      maxToolCalls: 1,
      modelProvider: sequenceProvider([
        {
          id: "call",
          model: "test/model",
          output: "",
          toolCalls: [{ arguments: {}, id: "call-1", name: "read_note" }]
        },
        { id: "answer", model: "test/model", output: "blocked acknowledged" }
      ]),
      toolCallMiddleware: [() => ({ action: "block", reason: "policy" })],
      toolRegistry
    });

    const result = await runtime.run({ ...input, runId: "run-blocked-receipt" });
    const receipt = parseLoopControlReceipt(result.loopControlReceipt);

    expect(receipt.terminal).toEqual({ reason: "verification-pending", status: "held" });
    expect(receipt.budget.tools).toEqual({ exhausted: false, limit: 1, used: 0 });
  });

  it("settles an already-cancelled plan-execute run without calling the provider", async () => {
    let calls = 0;
    const provider: ModelProvider = {
      id: "never-plan",
      async generate() {
        calls += 1;
        return { id: "unexpected", model: "test/model", output: "[]" };
      },
      async listModels() {
        return [];
      },
      async *stream() {}
    };
    const controller = new AbortController();
    controller.abort();
    const runtime = createAgentRuntime({ modelProvider: provider });

    const result = await runtime.run({
      ...input,
      metadata: { agentMode: "plan_execute" },
      runId: "run-plan-cancel-receipt",
      signal: controller.signal
    });
    const receipt = parseLoopControlReceipt(result.loopControlReceipt);

    expect(calls).toBe(0);
    expect(receipt.loopKind).toBe("plan-execute");
    expect(receipt.terminal).toEqual({ reason: "caller-cancelled", status: "cancelled" });
  });

  it("settles an in-flight tool cancellation and forwards the exact signal to child work", async () => {
    const controller = new AbortController();
    let childActive = false;
    let providerCalls = 0;
    let seenSignal: AbortSignal | undefined;
    let notifyStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    const toolRegistry = new ToolRegistry([{
      definition: {
        description: "Run abortable child work",
        inputSchema: { type: "object" },
        name: "abortable_child",
        risk: "read"
      },
      execute: async (_args, context) => {
        seenSignal = context.signal;
        childActive = true;
        notifyStarted?.();
        await new Promise<never>((_resolve, reject) => {
          const abort = (): void => {
            childActive = false;
            reject(context.signal?.reason ?? new DOMException("aborted", "AbortError"));
          };
          if (context.signal?.aborted) {
            abort();
            return;
          }
          context.signal?.addEventListener("abort", abort, { once: true });
        });
      }
    }]);
    const provider: ModelProvider = {
      id: "cancel-tool-provider",
      async generate() {
        providerCalls += 1;
        return providerCalls === 1
          ? {
              id: "tool",
              model: "test/model",
              output: "",
              toolCalls: [{ arguments: {}, id: "child-1", name: "abortable_child" }]
            }
          : { id: "unexpected", model: "test/model", output: "must not continue" };
      },
      async listModels() {
        return [];
      },
      async *stream() {}
    };
    const runtime = createAgentRuntime({
      maxToolCalls: 2,
      modelProvider: provider,
      toolRegistry
    });

    const pending = runtime.run({
      ...input,
      runId: "run-inflight-tool-cancel",
      signal: controller.signal
    });
    await started;
    controller.abort(new Error("owner cancelled"));
    const result = await pending;
    const receipt = parseLoopControlReceipt(result.loopControlReceipt);

    expect(seenSignal).toBe(controller.signal);
    expect(childActive).toBe(false);
    expect(providerCalls).toBe(1);
    expect(result.response.output).toBe("(run interrupted)");
    expect(receipt.terminal).toEqual({ reason: "caller-cancelled", status: "cancelled" });
    expect(receipt.budget.tools).toEqual({ exhausted: false, limit: 2, used: 1 });
    expect(receipt.budget.wallclock).toMatchObject({ exhausted: false, limitMs: 300_000 });
  });

  it("cancels a pending approval without executing the tool or leaving approval work active", async () => {
    const controller = new AbortController();
    let pendingApprovals = 0;
    let seenGateSignal: AbortSignal | undefined;
    let notifyApprovalStarted: (() => void) | undefined;
    const approvalStarted = new Promise<void>((resolve) => {
      notifyApprovalStarted = resolve;
    });
    const execute = vi.fn(() => "must not execute");
    const toolRegistry = new ToolRegistry([{
      definition: {
        description: "Execute only after approval",
        inputSchema: { type: "object" },
        name: "approval_child",
        risk: "execute"
      },
      execute
    }]);
    const runtime = createAgentRuntime({
      maxToolCalls: 2,
      modelProvider: sequenceProvider([{
        id: "approval-tool",
        model: "test/model",
        output: "",
        toolCalls: [{ arguments: {}, id: "approval-1", name: "approval_child" }]
      }]),
      toolApprovalGate: (gateInput) => new Promise((_resolve, reject) => {
        seenGateSignal = gateInput.signal;
        if (!gateInput.signal) {
          reject(new Error("approval gate did not receive the run signal"));
          return;
        }
        pendingApprovals += 1;
        notifyApprovalStarted?.();
        const abort = (): void => {
          pendingApprovals -= 1;
          reject(gateInput.signal?.reason ?? new DOMException("approval cancelled", "AbortError"));
        };
        gateInput.signal?.addEventListener("abort", abort, { once: true });
      }),
      toolRegistry
    });

    const pending = runtime.run({
      ...input,
      runId: "run-pending-approval-cancel",
      signal: controller.signal,
      toolExposureAuthority: createToolExposureAuthority({
        allowedToolNames: ["approval_child"],
        localMode: true
      })
    });
    await approvalStarted;
    controller.abort(new Error("owner cancelled approval"));
    const result = await pending;
    const receipt = parseLoopControlReceipt(result.loopControlReceipt);

    expect(seenGateSignal).toBe(controller.signal);
    expect(pendingApprovals).toBe(0);
    expect(execute).not.toHaveBeenCalled();
    expect(result.response.output).toBe("(run interrupted)");
    expect(receipt.terminal).toEqual({ reason: "caller-cancelled", status: "cancelled" });
    expect(receipt.budget.tools).toEqual({ exhausted: false, limit: 2, used: 1 });
  });

  it("fails Plan-Execute at the exact wallclock boundary instead of synthesizing", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-30T00:00:00.000Z"));
    let calls = 0;
    const provider: ModelProvider = {
      id: "deadline-plan",
      async generate() {
        calls += 1;
        vi.setSystemTime(new Date("2026-07-30T00:00:00.010Z"));
        return { id: "plan", model: "test/model", output: "[]" };
      },
      async listModels() {
        return [];
      },
      async *stream() {}
    };
    const runtime = createAgentRuntime({ maxRunWallclockMs: 10, modelProvider: provider });

    const result = await runtime.run({
      ...input,
      metadata: { agentMode: "plan_execute" },
      runId: "run-plan-deadline-receipt"
    });
    const receipt = parseLoopControlReceipt(result.loopControlReceipt);

    expect(calls).toBe(1);
    expect(result.response.id).toBe("plan-deadline-exceeded");
    expect(receipt.terminal).toEqual({ reason: "deadline-exceeded", status: "failed" });
    expect(receipt.budget.wallclock).toEqual({ elapsedMs: 10, exhausted: true, limitMs: 10 });
  });

  it("reports an already-cancelled run as cancelled without calling the provider", async () => {
    let calls = 0;
    const provider: ModelProvider = {
      id: "never",
      async generate() {
        calls += 1;
        return { id: "unexpected", model: "test/model", output: "unexpected" };
      },
      async listModels() {
        return [];
      },
      async *stream() {}
    };
    const controller = new AbortController();
    controller.abort();
    const runtime = createAgentRuntime({ modelProvider: provider });

    const result = await runtime.run({ ...input, runId: "run-cancel-receipt", signal: controller.signal });
    const receipt = parseLoopControlReceipt(result.loopControlReceipt);

    expect(calls).toBe(0);
    expect(receipt.terminal).toEqual({ reason: "caller-cancelled", status: "cancelled" });
  });
});
