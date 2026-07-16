import { describe, expect, it } from "vitest";
import { setTimeout as sleep } from "node:timers/promises";

import {
  MultiAgentOrchestrator,
  NoAgentWorkerError,
  RuleBasedAgentWorker,
  SupervisorAgent,
  createWorkerResult
} from "../src/index.js";
import type { AgentMessageBus, AgentWorker } from "../src/index.js";

const rejectingBus = (): AgentMessageBus => ({
  publish: async () => { throw new Error("bus down"); },
  subscribe: () => {},
  getMessages: () => [],
  getConversation: () => [],
  clear: () => {}
});

async function withHangGuard<T>(p: Promise<T>, label: string): Promise<T> {
  const guard = Promise.withResolvers<never>();
  const timer: NodeJS.Timeout = setTimeout(() => guard.reject(new Error(`hung: ${label}`)), 2_000);
  try {
    return await Promise.race([p, guard.promise]);
  } finally {
    clearTimeout(timer);
  }
}

describe("SupervisorAgent", () => {
  it("RuleBasedAgentWorker filters empty / whitespace-only keywords at construction — a stray blank no longer hijacks every dispatch with spurious confidence 1.0 (pre-fix `text.includes('')` was universally true so any blank in the keyword list scored full match against any input)", () => {
    // Construct with a deliberately blank slip in the keyword list.
    // Pre-fix: `text.includes("")` returns true universally, so
    // every keyword would "match" → confidence = 4/4 = 1.0 against
    // text with no real overlap. The supervisor would then route
    // unrelated requests to this worker, hijacking dispatch.
    const worker = new RuleBasedAgentWorker(
      "calendar",
      "Calendar worker",
      ["calendar", "", "  ", "schedule"],
      async (input) => createWorkerResult("calendar", "scheduled", input)
    );

    // Input has NO overlap with the real keywords ("calendar" /
    // "schedule"). Confidence must be 0 — the blank slips must
    // have been filtered out at construction.
    const unrelated = worker.canHandle({
      messages: [{ content: "tell me a joke about programming", role: "user" }],
      model: "test"
    });
    expect(unrelated, "blank keywords must NOT hijack unrelated inputs with confidence 1.0").toBe(0);

    // Real-keyword overlap still scores correctly: post-filter the
    // keyword list is ["calendar", "schedule"], so an input
    // containing "calendar" scores 1/2 = 0.5.
    const partial = worker.canHandle({
      messages: [{ content: "what's on my calendar today?", role: "user" }],
      model: "test"
    });
    expect(partial).toBe(0.5);

    // Both keywords matched → confidence 1.0 — pinning the
    // happy path stays unchanged.
    const full = worker.canHandle({
      messages: [{ content: "schedule a meeting on my calendar", role: "user" }],
      model: "test"
    });
    expect(full).toBe(1);
  });

  it("RuleBasedAgentWorker dedupes keywords at construction — a duplicate keyword can't double-count in both numerator and denominator and inflate dispatch confidence beyond the operator's intent (e.g. pre-fix ['foo','foo','bar'] vs. text 'foo' scored 2/3 ≈ 0.67 instead of 1/2 = 0.5)", () => {
    const worker = new RuleBasedAgentWorker(
      "deduper",
      "Dedup worker",
      // Mix: duplicates, blanks, mixed case — all should collapse to ["foo", "bar"].
      ["foo", "FOO", "foo", "  foo  ", "", "bar", "Bar"],
      async (input) => createWorkerResult("deduper", "ok", input)
    );

    // Input contains "foo" only — should be 1 of 2 unique keywords.
    const onlyFoo = worker.canHandle({
      messages: [{ content: "let's talk about foo", role: "user" }],
      model: "test"
    });
    expect(onlyFoo, "pre-fix would have been 4/5 or similar due to duplicates").toBe(0.5);

    // Input contains both — confidence 1.0 with the deduped denominator of 2.
    const both = worker.canHandle({
      messages: [{ content: "foo and bar together", role: "user" }],
      model: "test"
    });
    expect(both).toBe(1);

    // Input matches neither — confidence 0.
    const neither = worker.canHandle({
      messages: [{ content: "completely unrelated text", role: "user" }],
      model: "test"
    });
    expect(neither).toBe(0);
  });

  it("RuleBasedAgentWorker uses word-boundary matching on ASCII keywords so a short keyword like 'ai' / 'go' / 'rag' doesn't fire inside unrelated words ('email' / 'ago' / 'fragment') — pre-fix `text.includes('ai')` was true for any input containing 'email', silently inflating dispatch confidence", () => {
    const worker = new RuleBasedAgentWorker(
      "tech",
      "Tech worker",
      ["ai", "rag", "go"],
      async (input) => createWorkerResult("tech", "ok", input)
    );

    // Substring traps that pre-fix scored false-positives:
    // "ai" in "email" / "afraid", "rag" in "fragment", "go" in
    // "ago". Post-fix all three must be 0.
    const trap = worker.canHandle({
      messages: [{ content: "the email arrived and i'm afraid the fragment broke long ago", role: "user" }],
      model: "test"
    });
    expect(trap, "substring traps must NOT match — would have been 1.0 pre-fix").toBe(0);

    // Real word matches still score correctly.
    const realWords = worker.canHandle({
      messages: [{ content: "let's go for ai with rag pipelines", role: "user" }],
      model: "test"
    });
    expect(realWords).toBe(1);

    // Punctuation around the keyword still counts (commas, dots).
    const punct = worker.canHandle({
      messages: [{ content: "ai, then rag.", role: "user" }],
      model: "test"
    });
    expect(punct).toBe(2 / 3);
  });

  it("RuleBasedAgentWorker keeps substring matching for CJK keywords — Korean agglutinates particles without spaces (`우선순위` inside `우선순위를`), where word-boundary would wrongly miss the stem", () => {
    const worker = new RuleBasedAgentWorker(
      "korean",
      "Korean priority worker",
      ["우선순위"],
      async (input) => createWorkerResult("korean", "ok", input)
    );

    // The keyword is followed by a particle "를"; word-boundary
    // would reject this, but CJK substring matching catches it.
    const result = worker.canHandle({
      messages: [{ content: "이 일의 우선순위를 정해줘", role: "user" }],
      model: "test"
    });
    expect(result).toBe(1);
  });

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

  it("rejects ambiguous worker identities and invalid routing configuration at construction", () => {
    const worker = new RuleBasedAgentWorker("worker", "Worker", [], (input) =>
      createWorkerResult("worker", "ok", input)
    );
    const blankIdWorker = new RuleBasedAgentWorker("   ", "Blank", [], (input) =>
      createWorkerResult("blank", "ok", input)
    );

    expect(() => new SupervisorAgent({ workers: [worker, worker] })).toThrow(NoAgentWorkerError);
    expect(() => new MultiAgentOrchestrator({ workers: [worker, worker] })).toThrow(NoAgentWorkerError);
    expect(() => new SupervisorAgent({ workers: [blankIdWorker] })).toThrow(NoAgentWorkerError);
    expect(() => new SupervisorAgent({ defaultWorkerId: "missing", workers: [worker] })).toThrow(NoAgentWorkerError);

    for (const minConfidence of [Number.NaN, Number.POSITIVE_INFINITY, -0.1, 1.1]) {
      expect(() => new SupervisorAgent({ minConfidence, workers: [worker] })).toThrow(RangeError);
    }
    for (const maxHandoffs of [Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5]) {
      expect(() => new SupervisorAgent({ maxHandoffs, workers: [worker] })).toThrow(RangeError);
    }
  });

  it("owns the validated worker membership after construction", async () => {
    const original = new RuleBasedAgentWorker("original", "Original", ["task"], (input) =>
      createWorkerResult("original", "original", input)
    );
    const addedLater = new RuleBasedAgentWorker("added", "Added", ["task"], (input) =>
      createWorkerResult("added", "added", input)
    );
    const workers = [original];
    const supervisor = new SupervisorAgent({ workers });
    const orchestrator = new MultiAgentOrchestrator({ workers });

    workers.push(addedLater);
    const input = { messages: [{ content: "task", role: "user" as const }], model: "m" };

    expect(supervisor.selectWorker(input).to).toBe("original");
    const result = await orchestrator.run(input, { mode: "parallel" });
    expect(result.results).toEqual([expect.objectContaining({ status: "completed", workerId: "original" })]);
  });

  it("breaks a confidence tie by worker id ASC so dispatch is deterministic regardless of the workers[] order — two equally-confident workers must route to the same one every run", () => {
    const zebra = new RuleBasedAgentWorker("zebra", "Zebra", ["task"], (input) =>
      createWorkerResult("zebra", "z", input)
    );
    const alpha = new RuleBasedAgentWorker("alpha", "Alpha", ["task"], (input) =>
      createWorkerResult("alpha", "a", input)
    );
    const input = { messages: [{ content: "task", role: "user" as const }], model: "m" };
    // Both match the single keyword "task" → identical confidence.
    // The tie must resolve to "alpha" (id ASC) for BOTH orderings.
    expect(new SupervisorAgent({ workers: [zebra, alpha] }).selectWorker(input).to).toBe("alpha");
    expect(new SupervisorAgent({ workers: [alpha, zebra] }).selectWorker(input).to).toBe("alpha");
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

  it("race mode is PARKED — accepted on the wire, runs sequentially (single-GPU reality)", async () => {
    const order: string[] = [];
    const orchestrator = new MultiAgentOrchestrator({
      workers: [
        new RuleBasedAgentWorker("slow", "slow worker", ["task"], async (input) => {
          await sleep(30);
          order.push("slow");
          return createWorkerResult("slow", "slow answer", input);
        }),
        new RuleBasedAgentWorker("fast", "fast worker", ["task"], async (input) => {
          order.push("fast");
          return createWorkerResult("fast", "fast answer", input);
        })
      ]
    });
    const result = await orchestrator.run(
      { messages: [{ content: "task", role: "user" }], model: "diagnostic" },
      { mode: "race" }
    );
    expect(result.mode).toBe("race");
    // sequential under the hood: BOTH workers ran, in registration order.
    expect(order).toEqual(["slow", "fast"]);
    expect(result.results).toHaveLength(2);
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

  it("dispatches each worker on its own model override and runs an override-less worker on the run default — workers execute on different local models in one run (P10 s1)", async () => {
    const tieredWorker = (id: string, model?: string): AgentWorker => ({
      id,
      description: id,
      ...(model ? { model } : {}),
      canHandle: () => 1,
      run: async (input) => createWorkerResult(id, `ran on ${input.model}`, input)
    });

    const orchestrator = new MultiAgentOrchestrator({
      idFactory: () => "orch-tiered-1",
      workers: [
        tieredWorker("fast", "ollama/qwen3:1.7b"),
        tieredWorker("heavy", "ollama/qwen3:8b"),
        tieredWorker("plain")
      ]
    });

    const result = await orchestrator.run(
      { messages: [{ content: "split work", role: "user" }], model: "ollama/qwen3:4b" },
      { mode: "parallel" }
    );

    const modelById = Object.fromEntries(
      result.results.map((step) => [step.workerId, step.result?.response.model])
    );
    // Each override-carrying worker executed on its declared local model.
    expect(modelById.fast).toBe("ollama/qwen3:1.7b");
    expect(modelById.heavy).toBe("ollama/qwen3:8b");
    // The two tiers are genuinely distinct models within the one run.
    expect(modelById.fast).not.toBe(modelById.heavy);
    // A worker WITHOUT an override runs on the run-default model — single-model behaviour unchanged.
    expect(modelById.plain).toBe("ollama/qwen3:4b");
    // The overridden model reached the worker body, not just the result envelope.
    expect(result.results.find((step) => step.workerId === "fast")?.result?.response.output)
      .toBe("ran on ollama/qwen3:1.7b");
  });
});
