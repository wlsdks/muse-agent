import type { AgentRunInput, AgentRunResult } from "@muse/agent-core";
import {
  InMemoryAgentMessageBus,
  MultiAgentOrchestrator,
  RuleBasedAgentWorker,
  createWorkerResult
} from "@muse/multi-agent";
import { describe, expect, it, vi } from "vitest";

import type { ModelProvider, ModelRequest, ModelResponse } from "@muse/model";

import { toMultiAgentSseStream } from "../src/multi-agent-routes.js";
import { createAnswerVerifier, createWorkerSummarizer } from "../src/multi-agent-workers.js";

function busWithClearSpy() {
  const bus = new InMemoryAgentMessageBus();
  const clearSpy = vi.fn();
  const origClear = bus.clear.bind(bus);
  bus.clear = () => {
    clearSpy();
    origClear();
  };
  return { bus, clearSpy };
}

const input: AgentRunInput = { messages: [{ content: "go", role: "user" }], model: "diagnostic" };

describe("toMultiAgentSseStream unsubscribe lifecycle", () => {
  it("clears the bus when the consumer disconnects at the start frame (no leak)", async () => {
    const { bus, clearSpy } = busWithClearSpy();
    const hanging = new RuleBasedAgentWorker(
      "w", "w", ["task"],
      () => new Promise<AgentRunResult>(() => undefined) // never resolves
    );
    const orchestrator = new MultiAgentOrchestrator({ messageBus: bus, workers: [hanging] });
    const gen = toMultiAgentSseStream({
      input, messageBus: bus, mode: "sequential", options: { mode: "sequential" }, orchestrator
    }) as AsyncGenerator<string, void, unknown>;

    const first = await gen.next();
    expect(String(first.value)).toContain("event: start");
    // Consumer / Readable destroyed while suspended at the start
    // frame — pre-fix this yield was outside the try so finally
    // (messageBus.clear) never ran and the subscription leaked.
    await gen.return(undefined);
    expect(clearSpy).toHaveBeenCalledTimes(1);
  });

  it("clears the bus on normal completion too (no regression)", async () => {
    const { bus, clearSpy } = busWithClearSpy();
    const worker = new RuleBasedAgentWorker(
      "w", "w", ["task"],
      async (i: AgentRunInput) => createWorkerResult("w", "done", i)
    );
    const orchestrator = new MultiAgentOrchestrator({ messageBus: bus, workers: [worker] });
    const gen = toMultiAgentSseStream({
      input, messageBus: bus, mode: "sequential", options: { mode: "sequential" }, orchestrator
    });

    const frames: string[] = [];
    for await (const frame of gen) {
      frames.push(frame);
    }
    expect(frames.join("")).toContain("event: done");
    expect(clearSpy).toHaveBeenCalledTimes(1);
  });
});

describe("createWorkerSummarizer timer hygiene", () => {
  function stubProvider(output: string): ModelProvider {
    return {
      id: "stub",
      listModels: async () => [],
      generate: async (_request: ModelRequest): Promise<ModelResponse> => ({ id: "x", model: "x", output }),
      stream: async function* () { /* not used */ }
    };
  }

  it("clears the 15s summarizer timeout when the model response wins the race so no setTimeout dangles in the event loop after each summarizer call — pre-fix the timer handle wasn't stored, so no clearTimeout could fire and every successful summarize leaked a 15s timer", async () => {
    vi.useFakeTimers();
    try {
      const summarizer = createWorkerSummarizer(stubProvider("brief summary"), "model")!;
      const result = await summarizer("worker-1", "the worker's verbose output");
      expect(result).toBe("brief summary");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns undefined when no modelProvider is wired (legacy contract — no summarizer means no timer)", () => {
    expect(createWorkerSummarizer(undefined, "model")).toBeUndefined();
  });

  it("createAnswerVerifier parses the strict verdict: SATISFIED → ok, MISSING: X → flagged, garbage → ok (never falsely flag), no provider → undefined", async () => {
    function stub(output: string): ModelProvider {
      return { generate: async (): Promise<ModelResponse> => ({ id: "x", model: "x", output }), id: "stub", listModels: async () => [], stream: async function* () { /* unused */ } };
    }
    expect(createAnswerVerifier(undefined, "m")).toBeUndefined();
    expect(await createAnswerVerifier(stub("SATISFIED"), "m")!("req", "ans")).toEqual({ satisfied: true });
    expect(await createAnswerVerifier(stub("MISSING: the risk analysis"), "m")!("req", "ans")).toEqual({ missing: "the risk analysis", satisfied: false });
    // an unparseable verdict must NOT falsely flag a healthy answer
    expect(await createAnswerVerifier(stub("hmm, looks mostly fine I think"), "m")!("req", "ans")).toEqual({ satisfied: true });
  });

  it("falls back to the raw output when the model returns an empty string — and STILL clears the timer in the finally path", async () => {
    vi.useFakeTimers();
    try {
      const summarizer = createWorkerSummarizer(stubProvider("   "), "model")!;
      const result = await summarizer("worker-2", "raw output here");
      expect(result).toBe("raw output here");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
