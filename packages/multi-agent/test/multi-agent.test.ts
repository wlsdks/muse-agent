import { describe, expect, it } from "vitest";
import {
  MultiAgentOrchestrator,
  NoAgentWorkerError,
  RuleBasedAgentWorker,
  SupervisorAgent,
  createWorkerResult
} from "../src/index.js";
import type { AgentMessageBus } from "../src/index.js";

const rejectingBus = (): AgentMessageBus => ({
  publish: async () => { throw new Error("bus down"); },
  subscribe: () => {},
  getMessages: () => [],
  getConversation: () => [],
  clear: () => {}
});

async function withHangGuard<T>(p: Promise<T>, label: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`hung: ${label}`)), 2_000);
  });
  try {
    return await Promise.race([p, guard]);
  } finally {
    clearTimeout(timer!);
  }
}

describe("SupervisorAgent", () => {
  it("selects the highest confidence worker", async () => {
    const research = new RuleBasedAgentWorker("research", "Research worker", ["research"], (input) =>
      createWorkerResult("research", "research answer", input)
    );
    const code = new RuleBasedAgentWorker("code", "Code worker", ["code"], (input) =>
      createWorkerResult("code", "code answer", input)
    );
    const supervisor = new SupervisorAgent({ workers: [research, code] });

    const result = await supervisor.run({
      messages: [{ content: "Please research this", role: "user" }],
      model: "model-1"
    });

    expect(result).toMatchObject({
      response: { output: "research answer" },
      selectedAgentId: "research"
    });
    expect(result.handoffs).toEqual([
      { confidence: 1, reason: "highest-confidence-worker", to: "research" }
    ]);
  });

  it("falls back after worker failure", async () => {
    const failing = new RuleBasedAgentWorker("primary", "Primary", ["task"], () => {
      throw new Error("primary down");
    });
    const fallback = new RuleBasedAgentWorker("fallback", "Fallback", [], (input) =>
      createWorkerResult("fallback", "fallback answer", input)
    );
    const supervisor = new SupervisorAgent({
      defaultWorkerId: "fallback",
      maxHandoffs: 2,
      minConfidence: 0.5,
      workers: [failing, fallback]
    });

    const result = await supervisor.run({
      messages: [{ content: "task", role: "user" }],
      model: "model-1"
    });

    expect(result.selectedAgentId).toBe("fallback");
    expect(result.handoffs.map((handoff) => handoff.to)).toEqual(["primary", "fallback"]);
  });

  it("requires at least one worker", () => {
    expect(() => new SupervisorAgent({ workers: [] })).toThrow(NoAgentWorkerError);
  });
});

describe("MultiAgentOrchestrator", () => {
  it("runs workers sequentially and passes prior worker output forward", async () => {
    const analyst = new RuleBasedAgentWorker("analyst", "Analyst", [], (input) =>
      createWorkerResult("analyst", "analysis complete", input)
    );
    const reviewer = new RuleBasedAgentWorker("reviewer", "Reviewer", [], (input) => {
      expect(input.messages[0]?.content).toContain("analysis complete");
      return createWorkerResult("reviewer", "review complete", input);
    });
    const orchestrator = new MultiAgentOrchestrator({
      idFactory: () => "orchestration-1",
      workers: [analyst, reviewer]
    });

    const result = await orchestrator.run({
      messages: [{ content: "plan project", role: "user" }],
      model: "model-1"
    });

    expect(result).toMatchObject({
      mode: "sequential",
      runId: "orchestration-1"
    });
    expect(result.results.map((step) => [step.workerId, step.status])).toEqual([
      ["analyst", "completed"],
      ["reviewer", "completed"]
    ]);
    expect(result.response.output).toContain("## analyst");
    expect(result.response.output).toContain("## reviewer");
  });

  it("runs workers in parallel and preserves failed worker results without failing the orchestration", async () => {
    const completed = new RuleBasedAgentWorker("completed", "Completed", [], (input) =>
      createWorkerResult("completed", "done", input)
    );
    const failed = new RuleBasedAgentWorker("failed", "Failed", [], () => {
      throw new Error("worker unavailable");
    });
    const orchestrator = new MultiAgentOrchestrator({
      idFactory: () => "orchestration-2",
      workers: [completed, failed]
    });

    const result = await orchestrator.run(
      {
        messages: [{ content: "compare paths", role: "user" }],
        model: "model-1"
      },
      { mode: "parallel" }
    );

    expect(result.results).toEqual([
      expect.objectContaining({ status: "completed", workerId: "completed" }),
      expect.objectContaining({ error: "worker unavailable", status: "failed", workerId: "failed" })
    ]);
    expect(result.response.output).toContain("done");
    expect(result.response.output).toContain("worker unavailable");
  });

  it("fails when every worker fails", async () => {
    const failed = new RuleBasedAgentWorker("failed", "Failed", [], () => {
      throw new Error("worker unavailable");
    });
    const orchestrator = new MultiAgentOrchestrator({ workers: [failed] });

    await expect(
      orchestrator.run({
        messages: [{ content: "compare paths", role: "user" }],
        model: "model-1"
      })
    ).rejects.toThrow(NoAgentWorkerError);
  });

  it("race mode resolves with the first successful worker (faster wins)", async () => {
    const fast = makeDelayedWorker("fast", "fast won", 10);
    const slow = makeDelayedWorker("slow", "slow won", 200);
    const orchestrator = new MultiAgentOrchestrator({
      idFactory: () => "orchestration-race-1",
      workers: [slow, fast]
    });

    const result = await orchestrator.run(
      { messages: [{ content: "race test", role: "user" }], model: "model-1" },
      { mode: "race" }
    );

    expect(result.mode).toBe("race");
    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({ status: "completed", workerId: "fast" });
    expect(result.response.output).toContain("fast won");
  });

  it("race mode skips a faster failure and resolves with the next successful worker", async () => {
    const fastFail = new RuleBasedAgentWorker("fast-fail", "Fast fail", [], async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      throw new Error("flaky");
    });
    const slow = makeDelayedWorker("slow-success", "slow won", 50);
    const orchestrator = new MultiAgentOrchestrator({
      idFactory: () => "orchestration-race-2",
      workers: [fastFail, slow]
    });

    const result = await orchestrator.run(
      { messages: [{ content: "race test 2", role: "user" }], model: "model-1" },
      { mode: "race" }
    );

    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({ status: "completed", workerId: "slow-success" });
  });

  it("race mode throws NoAgentWorkerError when every worker fails", async () => {
    const failA = new RuleBasedAgentWorker("a", "A", [], async () => {
      throw new Error("a-down");
    });
    const failB = new RuleBasedAgentWorker("b", "B", [], async () => {
      throw new Error("b-down");
    });
    const orchestrator = new MultiAgentOrchestrator({
      idFactory: () => "orchestration-race-3",
      workers: [failA, failB]
    });

    await expect(
      orchestrator.run(
        { messages: [{ content: "race fail", role: "user" }], model: "model-1" },
        { mode: "race" }
      )
    ).rejects.toThrow(NoAgentWorkerError);
  });

  it("race mode resolves with the winner even when the message bus publish rejects (no hang)", async () => {
    const winner = new RuleBasedAgentWorker("winner", "Winner", [], (input) =>
      createWorkerResult("winner", "won despite bus", input)
    );
    const orchestrator = new MultiAgentOrchestrator({
      idFactory: () => "orchestration-race-bus",
      messageBus: rejectingBus(),
      workers: [winner]
    });
    const result = await withHangGuard(
      orchestrator.run(
        { messages: [{ content: "race", role: "user" }], model: "model-1" },
        { mode: "race" }
      ),
      "race success + rejecting bus"
    );
    expect(result.mode).toBe("race");
    expect(result.results[0]).toMatchObject({ status: "completed", workerId: "winner" });
  });

  it("race mode still surfaces NoAgentWorkerError when all fail AND the bus rejects (no hang)", async () => {
    const failer = new RuleBasedAgentWorker("failer", "Failer", [], () => {
      throw new Error("worker down");
    });
    const orchestrator = new MultiAgentOrchestrator({
      messageBus: rejectingBus(),
      workers: [failer]
    });
    await expect(
      withHangGuard(
        orchestrator.run(
          { messages: [{ content: "x", role: "user" }], model: "model-1" },
          { mode: "race" }
        ),
        "race all-fail + rejecting bus"
      )
    ).rejects.toThrow(NoAgentWorkerError);
  });

  it("maxOutputCharsPerWorker caps each worker's output in the fan-in concat (CE 1.e)", async () => {
    const big = "x".repeat(2_000);
    const noisyA = new RuleBasedAgentWorker("noisy-a", "Noisy A", [], (input) =>
      createWorkerResult("noisy-a", big, input)
    );
    const noisyB = new RuleBasedAgentWorker("noisy-b", "Noisy B", [], (input) =>
      createWorkerResult("noisy-b", big, input)
    );
    const orchestrator = new MultiAgentOrchestrator({
      idFactory: () => "orchestration-fanin-1",
      workers: [noisyA, noisyB]
    });

    const result = await orchestrator.run(
      { messages: [{ content: "summarize both", role: "user" }], model: "model-1" },
      { maxOutputCharsPerWorker: 200, mode: "parallel" }
    );

    // Fan-in concat is bounded: 2 workers * 200 cap + framing slack, not 4_000+.
    expect(result.response.output.length).toBeLessThan(700);
    expect(result.response.output).toContain("agent noisy-a output trimmed by orchestrator fan-in");
    expect(result.response.output).toContain("agent noisy-b output trimmed by orchestrator fan-in");
    // Tracked results keep the FULL original output for trace fidelity.
    expect(result.results[0]?.result?.response.output).toBe(big);
    expect(result.results[1]?.result?.response.output).toBe(big);
  });

  it("maxOutputCharsPerWorker undefined / 0 keeps the legacy verbatim concat", async () => {
    const big = "y".repeat(800);
    const worker = new RuleBasedAgentWorker("verbose", "Verbose", [], (input) =>
      createWorkerResult("verbose", big, input)
    );
    const orchestrator = new MultiAgentOrchestrator({ workers: [worker] });

    const undefinedCap = await orchestrator.run(
      { messages: [{ content: "go", role: "user" }], model: "model-1" }
    );
    expect(undefinedCap.response.output).toContain(big);

    const zeroCap = await orchestrator.run(
      { messages: [{ content: "go", role: "user" }], model: "model-1" },
      { maxOutputCharsPerWorker: 0 }
    );
    expect(zeroCap.response.output).toContain(big);
  });

  it("summarizeWorkerOutput replaces each worker's output before the fan-in concat (CE 1.e LLM)", async () => {
    const big = "x".repeat(1_500);
    const verbose = new RuleBasedAgentWorker("verbose", "Verbose", [], (input) =>
      createWorkerResult("verbose", big, input)
    );
    const orchestrator = new MultiAgentOrchestrator({
      idFactory: () => "orch-summarizer-1",
      workers: [verbose]
    });

    const calls: Array<{ workerId: string; length: number }> = [];
    const result = await orchestrator.run(
      { messages: [{ content: "summarize", role: "user" }], model: "model-1" },
      {
        summarizeWorkerOutput: async (workerId, output) => {
          calls.push({ length: output.length, workerId });
          return `[summary of ${workerId}: ${output.length} chars]`;
        }
      }
    );

    expect(calls).toEqual([{ length: 1_500, workerId: "verbose" }]);
    expect(result.response.output).toContain("[summary of verbose: 1500 chars]");
    expect(result.response.output).not.toContain(big);
    expect(result.results[0]?.result?.response.output).toBe(big);
  });

  it("summarizeWorkerOutput failures fall back to raw output without blocking the orchestration", async () => {
    const original = "fallback target output";
    const worker = new RuleBasedAgentWorker("flaky", "Flaky", [], (input) =>
      createWorkerResult("flaky", original, input)
    );
    const orchestrator = new MultiAgentOrchestrator({ workers: [worker] });

    const result = await orchestrator.run(
      { messages: [{ content: "go", role: "user" }], model: "model-1" },
      {
        summarizeWorkerOutput: async () => {
          throw new Error("LLM unavailable");
        }
      }
    );

    expect(result.response.output).toContain(original);
  });

  it("summarizeWorkerOutput composes with maxOutputCharsPerWorker (summary still capped)", async () => {
    const worker = new RuleBasedAgentWorker("verbose", "Verbose", [], (input) =>
      createWorkerResult("verbose", "anything", input)
    );
    const orchestrator = new MultiAgentOrchestrator({ workers: [worker] });
    const longSummary = "S".repeat(2_000);

    const result = await orchestrator.run(
      { messages: [{ content: "go", role: "user" }], model: "model-1" },
      {
        maxOutputCharsPerWorker: 200,
        summarizeWorkerOutput: async () => longSummary
      }
    );

    expect(result.response.output.length).toBeLessThan(500);
    expect(result.response.output).toContain("agent verbose output trimmed by orchestrator fan-in");
  });
});

function makeDelayedWorker(id: string, output: string, delayMs: number): RuleBasedAgentWorker {
  return new RuleBasedAgentWorker(id, id, [], async (input) => {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return createWorkerResult(id, output, input);
  });
}
