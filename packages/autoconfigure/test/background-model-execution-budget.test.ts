import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ModelEvent, ModelProvider, ModelRequest, ModelResponse } from "@muse/model";
import { describe, expect, it, vi } from "vitest";

import {
  BackgroundModelExecutionBudgetError,
  backgroundModelExecutionBudgetEnvironment,
  clampBackgroundBudgetDuration,
  createBackgroundModelExecutionBudgetProviders,
  resolveBackgroundModelExecutionBudgetOptions,
  saturatingBackgroundBudgetIncrement
} from "../src/background-model-execution-budget.js";
import { createMuseRuntimeAssembly } from "../src/runtime-assembly.js";
import { createUsageRecordingProvider } from "../src/usage-recording-provider.js";

const response = (output: string): ModelResponse => ({ id: output, model: "test", output });
const request = (model: string, overrides: Partial<ModelRequest> = {}): ModelRequest => ({
  messages: [{ content: "hello", role: "user" }],
  model,
  ...overrides
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, reject, resolve };
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function providerWithGenerate(generate: ModelProvider["generate"]): ModelProvider {
  return {
    generate,
    id: "test-provider",
    listModels: async () => [],
    stream: () => (async function* (): AsyncIterable<ModelEvent> {
      yield { response: response("stream"), type: "done" };
    })()
  };
}

describe("resolveBackgroundModelExecutionBudgetOptions", () => {
  it("uses exact defaults and accepts only in-range decimal integer owner overrides", () => {
    expect(resolveBackgroundModelExecutionBudgetOptions({})).toEqual({
      maxConcurrency: 1,
      maxInputBytes: 65_536,
      maxOutputTokens: 512,
      maxQueue: 2
    });
    expect(resolveBackgroundModelExecutionBudgetOptions({
      MUSE_BACKGROUND_MODEL_MAX_CONCURRENCY: "4",
      MUSE_BACKGROUND_MODEL_MAX_INPUT_BYTES: "1048576",
      MUSE_BACKGROUND_MODEL_MAX_OUTPUT_TOKENS: "4096",
      MUSE_BACKGROUND_MODEL_MAX_QUEUE: "0"
    })).toEqual({ maxConcurrency: 4, maxInputBytes: 1_048_576, maxOutputTokens: 4_096, maxQueue: 0 });
    expect(resolveBackgroundModelExecutionBudgetOptions({
      MUSE_BACKGROUND_MODEL_MAX_CONCURRENCY: "0",
      MUSE_BACKGROUND_MODEL_MAX_INPUT_BYTES: "1e6",
      MUSE_BACKGROUND_MODEL_MAX_OUTPUT_TOKENS: "4097",
      MUSE_BACKGROUND_MODEL_MAX_QUEUE: "-1"
    })).toEqual({ maxConcurrency: 1, maxInputBytes: 65_536, maxOutputTokens: 512, maxQueue: 2 });
  });

  it("persists only valid explicit overrides across the resident launchd boundary", () => {
    expect(backgroundModelExecutionBudgetEnvironment({
      MUSE_BACKGROUND_MODEL_MAX_CONCURRENCY: " 2 ",
      MUSE_BACKGROUND_MODEL_MAX_INPUT_BYTES: "32768",
      MUSE_BACKGROUND_MODEL_MAX_OUTPUT_TOKENS: "0",
      MUSE_BACKGROUND_MODEL_MAX_QUEUE: "0"
    })).toEqual({
      MUSE_BACKGROUND_MODEL_MAX_CONCURRENCY: "2",
      MUSE_BACKGROUND_MODEL_MAX_INPUT_BYTES: "32768",
      MUSE_BACKGROUND_MODEL_MAX_QUEUE: "0"
    });
    expect(backgroundModelExecutionBudgetEnvironment({
      MUSE_BACKGROUND_MODEL_MAX_CONCURRENCY: "bad",
      MUSE_BACKGROUND_MODEL_MAX_INPUT_BYTES: "9999999"
    })).toEqual({});
  });

  it("saturates counters and clamps negative, non-finite, and overflow clock durations", () => {
    expect(saturatingBackgroundBudgetIncrement(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
    expect(saturatingBackgroundBudgetIncrement(Number.MAX_SAFE_INTEGER - 1)).toBe(Number.MAX_SAFE_INTEGER);
    expect(clampBackgroundBudgetDuration(-1)).toBe(0);
    expect(clampBackgroundBudgetDuration(Number.NaN)).toBe(0);
    expect(clampBackgroundBudgetDuration(Number.POSITIVE_INFINITY)).toBe(Number.MAX_SAFE_INTEGER);
    expect(clampBackgroundBudgetDuration(Number.MAX_VALUE)).toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe("background model execution budget", () => {
  it("clamps output and rejects a UTF-8-byte oversized provider-bound request before calling the provider", async () => {
    const generate = vi.fn(async (input: ModelRequest) => response(String(input.maxOutputTokens)));
    const views = createBackgroundModelExecutionBudgetProviders(providerWithGenerate(generate), {
      maxInputBytes: 1_024,
      maxOutputTokens: 64
    });

    await expect(views.background.generate(request("small", { maxOutputTokens: 300 })))
      .resolves.toMatchObject({ output: "64" });
    await expect(views.background.generate(request("zero", { maxOutputTokens: 0 })))
      .resolves.toMatchObject({ output: "0" });
    await expect(views.background.generate(request("oversized", {
      messages: [{ content: "한".repeat(400), role: "user" }]
    }))).rejects.toMatchObject({ code: "INPUT_TOO_LARGE", retryable: false });
    expect(generate).toHaveBeenCalledTimes(2);
    expect(views.snapshot()).toMatchObject({ completed: 2, rejected: 1, started: 2 });
  });

  it("rejects an unserialisable provider-bound request with zero underlying calls", async () => {
    const generate = vi.fn(async () => response("unexpected"));
    const views = createBackgroundModelExecutionBudgetProviders(providerWithGenerate(generate));
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    await expect(views.background.generate(request("cyclic", {
      responseFormat: cyclic as ModelRequest["responseFormat"]
    }))).rejects.toMatchObject({ code: "INPUT_TOO_LARGE" });
    expect(generate).not.toHaveBeenCalled();
  });

  it("runs background work FIFO with bounded concurrency and rejects overflow without an underlying call", async () => {
    const pending = new Map<string, ReturnType<typeof deferred<ModelResponse>>>();
    const starts: string[] = [];
    const provider = providerWithGenerate(async (input) => {
      starts.push(input.model);
      const work = deferred<ModelResponse>();
      pending.set(input.model, work);
      return work.promise;
    });
    const views = createBackgroundModelExecutionBudgetProviders(provider, { maxConcurrency: 1, maxQueue: 2 });

    const one = views.background.generate(request("one"));
    const two = views.background.generate(request("two"));
    const three = views.background.generate(request("three"));
    const overflow = views.background.generate(request("overflow"));
    await expect(overflow).rejects.toMatchObject({ code: "QUEUE_FULL", retryable: false });
    expect(starts).toEqual(["one"]);
    expect(views.snapshot()).toMatchObject({ activeBackground: 1, queuedBackground: 2, rejected: 1 });

    pending.get("one")!.resolve(response("one"));
    await one;
    await flush();
    expect(starts).toEqual(["one", "two"]);
    pending.get("two")!.resolve(response("two"));
    await two;
    await flush();
    expect(starts).toEqual(["one", "two", "three"]);
    pending.get("three")!.resolve(response("three"));
    await three;
    expect(views.snapshot()).toMatchObject({ activeBackground: 0, completed: 3, queuedBackground: 0 });
  });

  it("starts foreground immediately, preempts background once, and holds its slot until an uncooperative provider settles", async () => {
    const background = deferred<ModelResponse>();
    let backgroundSignal: AbortSignal | undefined;
    const starts: string[] = [];
    const provider = providerWithGenerate(async (input) => {
      starts.push(input.model);
      if (input.model === "background") {
        backgroundSignal = input.signal;
        return background.promise;
      }
      return response(input.model);
    });
    let now = 10;
    const views = createBackgroundModelExecutionBudgetProviders(provider, { maxConcurrency: 1, now: () => now });

    const running = views.background.generate(request("background"));
    await flush();
    await expect(views.foreground.generate(request("foreground"))).resolves.toMatchObject({ output: "foreground" });
    expect(backgroundSignal?.aborted).toBe(true);
    expect(views.snapshot()).toMatchObject({
      activeBackground: 1,
      pendingBackgroundSettlements: 1,
      preemptions: 1
    });
    const queued = views.background.generate(request("next"));
    expect(starts).toEqual(["background", "foreground"]);

    now = 37;
    background.resolve(response("ignored-abort"));
    await expect(running).rejects.toMatchObject({ code: "REQUEST_ABORTED" });
    await flush();
    expect(starts).toEqual(["background", "foreground", "next"]);
    await queued;
    expect(views.snapshot()).toMatchObject({
      cancelled: 1,
      lastCancellationSettleMs: 27,
      pendingBackgroundSettlements: 0
    });
  });

  it("does not pump queued background until all overlapping foreground calls settle", async () => {
    const foregroundOne = deferred<ModelResponse>();
    const foregroundTwo = deferred<ModelResponse>();
    const starts: string[] = [];
    const provider = providerWithGenerate(async (input) => {
      starts.push(input.model);
      if (input.model === "fg-one") return foregroundOne.promise;
      if (input.model === "fg-two") return foregroundTwo.promise;
      return response(input.model);
    });
    const views = createBackgroundModelExecutionBudgetProviders(provider);
    const one = views.foreground.generate(request("fg-one"));
    const two = views.foreground.generate(request("fg-two"));
    const queued = views.background.generate(request("background"));
    expect(starts).toEqual(["fg-one", "fg-two"]);
    foregroundOne.resolve(response("fg-one"));
    await one;
    await flush();
    expect(starts).toEqual(["fg-one", "fg-two"]);
    foregroundTwo.resolve(response("fg-two"));
    await two;
    await queued;
    expect(starts).toEqual(["fg-one", "fg-two", "background"]);
  });

  it("removes a queued caller abort from FIFO and never calls the provider for it", async () => {
    const first = deferred<ModelResponse>();
    const starts: string[] = [];
    const provider = providerWithGenerate(async (input) => {
      starts.push(input.model);
      return input.model === "first" ? first.promise : response(input.model);
    });
    const views = createBackgroundModelExecutionBudgetProviders(provider);
    const running = views.background.generate(request("first"));
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const queued = views.background.generate(request("cancelled", { signal: controller.signal }));
    controller.abort();
    await expect(queued).rejects.toMatchObject({ code: "REQUEST_ABORTED" });
    expect(remove).toHaveBeenCalled();
    first.resolve(response("first"));
    await running;
    expect(starts).toEqual(["first"]);
    expect(views.snapshot()).toMatchObject({ queuedBackground: 0, rejected: 1 });
  });

  it("keeps a running caller cancellation pending until uncooperative settlement and removes its listener", async () => {
    const work = deferred<ModelResponse>();
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const views = createBackgroundModelExecutionBudgetProviders(
      providerWithGenerate(async () => work.promise),
      { now: () => 50 }
    );
    const running = views.background.generate(request("running", { signal: controller.signal }));
    await flush();
    controller.abort();
    expect(views.snapshot()).toMatchObject({ activeBackground: 1, pendingBackgroundSettlements: 1 });
    work.resolve(response("late"));
    await expect(running).rejects.toMatchObject({ code: "REQUEST_ABORTED" });
    expect(remove).toHaveBeenCalled();
    expect(views.snapshot()).toMatchObject({ activeBackground: 0, cancelled: 1, pendingBackgroundSettlements: 0 });
  });

  it("releases exactly once after a synchronous provider throw and pumps the next queued request", async () => {
    const starts: string[] = [];
    const views = createBackgroundModelExecutionBudgetProviders(providerWithGenerate((input) => {
      starts.push(input.model);
      if (input.model === "throws") throw new Error("sync failure");
      return Promise.resolve(response(input.model));
    }));
    const failed = views.background.generate(request("throws"));
    const next = views.background.generate(request("next"));
    await expect(failed).rejects.toThrow("sync failure");
    await expect(next).resolves.toMatchObject({ output: "next" });
    expect(starts).toEqual(["throws", "next"]);
    expect(views.snapshot()).toMatchObject({ activeBackground: 0, completed: 1, failed: 1 });
  });

  it("applies one shared concurrency slot across generate and stream and supports queue zero", async () => {
    const generateWork = deferred<ModelResponse>();
    let streamStarts = 0;
    const provider: ModelProvider = {
      generate: async () => generateWork.promise,
      id: "mixed-provider",
      listModels: async () => [],
      stream: () => (async function* (): AsyncIterable<ModelEvent> {
        streamStarts += 1;
        yield { response: response("stream"), type: "done" };
      })()
    };
    const views = createBackgroundModelExecutionBudgetProviders(provider, { maxConcurrency: 1, maxQueue: 1 });
    const generated = views.background.generate(request("generate"));
    const iterator = views.background.stream(request("stream"))[Symbol.asyncIterator]();
    const streamed = iterator.next();
    await flush();
    expect(streamStarts).toBe(0);
    expect(views.snapshot()).toMatchObject({ activeBackground: 1, queuedBackground: 1 });
    generateWork.resolve(response("generate"));
    await generated;
    await expect(streamed).resolves.toMatchObject({ value: { type: "done" } });
    expect(streamStarts).toBe(1);

    const blockedForeground = deferred<ModelResponse>();
    const zeroQueue = createBackgroundModelExecutionBudgetProviders(
      providerWithGenerate(async (input) => input.model === "foreground" ? blockedForeground.promise : response(input.model)),
      { maxQueue: 0 }
    );
    const foreground = zeroQueue.foreground.generate(request("foreground"));
    await expect(zeroQueue.background.generate(request("rejected"))).rejects.toMatchObject({ code: "QUEUE_FULL" });
    blockedForeground.resolve(response("foreground"));
    await foreground;
  });

  it("clamps stream output with the same absent/existing wire contract as generate", async () => {
    const observed: Array<number | undefined> = [];
    const provider: ModelProvider = {
      generate: async () => response("unused"),
      id: "stream-output-provider",
      listModels: async () => [],
      stream: (input) => (async function* (): AsyncIterable<ModelEvent> {
        observed.push(input.maxOutputTokens);
        yield { response: response("done"), type: "done" };
      })()
    };
    const views = createBackgroundModelExecutionBudgetProviders(provider, { maxOutputTokens: 64 });
    for await (const _event of views.background.stream(request("absent"))) { /* consume */ }
    for await (const _event of views.background.stream(request("zero", { maxOutputTokens: 0 }))) { /* consume */ }
    for await (const _event of views.background.stream(request("large", { maxOutputTokens: 300 }))) { /* consume */ }
    expect(observed).toEqual([64, 0, 64]);
  });

  it("keeps streams lazy and calls the underlying iterator return on early consumer return", async () => {
    let starts = 0;
    let returns = 0;
    const provider: ModelProvider = {
      generate: async () => response("unused"),
      id: "stream-provider",
      listModels: async () => [],
      stream: () => (async function* (): AsyncIterable<ModelEvent> {
        starts += 1;
        try {
          yield { text: "one", type: "text-delta" };
          yield { response: response("done"), type: "done" };
        } finally {
          returns += 1;
        }
      })()
    };
    const views = createBackgroundModelExecutionBudgetProviders(provider);
    const iterable = views.background.stream(request("stream"));
    expect(starts).toBe(0);
    expect(views.snapshot()).toMatchObject({ activeBackground: 0, queuedBackground: 0 });
    const iterator = iterable[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({ done: false, value: { type: "text-delta" } });
    expect(starts).toBe(1);
    expect(views.snapshot().activeBackground).toBe(1);
    await iterator.return?.();
    expect(returns).toBe(1);
    expect(views.snapshot()).toMatchObject({ activeBackground: 0, cancelled: 1, completed: 0, failed: 0 });
  });

  it("calls underlying return exactly once when provider next rejects, then releases the slot as failed", async () => {
    let returns = 0;
    const provider: ModelProvider = {
      generate: async () => response("unused"),
      id: "rejecting-stream-provider",
      listModels: async () => [],
      stream: () => ({
        [Symbol.asyncIterator]() { return this; },
        next: async () => { throw new Error("next rejected"); },
        return: async () => {
          returns += 1;
          return { done: true, value: undefined };
        }
      })
    };
    const views = createBackgroundModelExecutionBudgetProviders(provider);
    const iterator = views.background.stream(request("reject"))[Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toThrow("next rejected");
    expect(returns).toBe(1);
    expect(views.snapshot()).toMatchObject({ activeBackground: 0, failed: 1 });
  });

  it("releases a stream slot when provider stream construction throws synchronously", async () => {
    const provider: ModelProvider = {
      generate: async () => response("unused"),
      id: "throwing-stream-provider",
      listModels: async () => [],
      stream: () => { throw new Error("stream construction failed"); }
    };
    const views = createBackgroundModelExecutionBudgetProviders(provider);
    await expect(views.background.stream(request("throw"))[Symbol.asyncIterator]().next())
      .rejects.toThrow("stream construction failed");
    expect(views.snapshot()).toMatchObject({ activeBackground: 0, failed: 1 });
  });

  it("awaits uncooperative stream return before releasing a caller-cancelled slot", async () => {
    const next = deferred<IteratorResult<ModelEvent>>();
    const returned = deferred<IteratorResult<ModelEvent>>();
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    let returnCalls = 0;
    const provider: ModelProvider = {
      generate: async () => response("unused"),
      id: "uncooperative-stream-provider",
      listModels: async () => [],
      stream: () => ({
        [Symbol.asyncIterator]() { return this; },
        next: () => next.promise,
        return: () => {
          returnCalls += 1;
          return returned.promise;
        }
      })
    };
    const views = createBackgroundModelExecutionBudgetProviders(provider);
    const pending = views.background.stream(request("running", { signal: controller.signal }))[Symbol.asyncIterator]().next();
    await flush();
    controller.abort();
    next.resolve({ done: false, value: { text: "late", type: "text-delta" } });
    await flush();
    expect(returnCalls).toBe(1);
    expect(views.snapshot()).toMatchObject({ activeBackground: 1, pendingBackgroundSettlements: 1 });
    returned.resolve({ done: true, value: undefined });
    await expect(pending).rejects.toMatchObject({ code: "REQUEST_ABORTED" });
    expect(remove).toHaveBeenCalled();
    expect(views.snapshot()).toMatchObject({ activeBackground: 0, cancelled: 1, pendingBackgroundSettlements: 0 });
  });

  it("closes the provider iterator on for-await break and consumer throw", async () => {
    let returns = 0;
    const provider: ModelProvider = {
      generate: async () => response("unused"),
      id: "consumer-close-provider",
      listModels: async () => [],
      stream: () => (async function* (): AsyncIterable<ModelEvent> {
        try {
          yield { text: "one", type: "text-delta" };
          yield { text: "two", type: "text-delta" };
        } finally {
          returns += 1;
        }
      })()
    };
    const views = createBackgroundModelExecutionBudgetProviders(provider);
    for await (const _event of views.background.stream(request("break"))) break;
    await expect((async () => {
      for await (const _event of views.background.stream(request("throw"))) throw new Error("consumer failed");
    })()).rejects.toThrow("consumer failed");
    expect(returns).toBe(2);
    expect(views.snapshot()).toMatchObject({ activeBackground: 0, cancelled: 2 });
  });

  it("removes a queued stream abort listener without constructing the provider iterator", async () => {
    const blocker = deferred<ModelResponse>();
    let streamCalls = 0;
    const provider: ModelProvider = {
      generate: async () => blocker.promise,
      id: "queued-stream-provider",
      listModels: async () => [],
      stream: () => {
        streamCalls += 1;
        return (async function* (): AsyncIterable<ModelEvent> {
          yield { response: response("done"), type: "done" };
        })();
      }
    };
    const views = createBackgroundModelExecutionBudgetProviders(provider);
    const running = views.background.generate(request("blocker"));
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const queued = views.background.stream(request("queued", { signal: controller.signal }))[Symbol.asyncIterator]().next();
    await flush();
    controller.abort();
    await expect(queued).rejects.toMatchObject({ code: "REQUEST_ABORTED" });
    expect(streamCalls).toBe(0);
    expect(remove).toHaveBeenCalled();
    blocker.resolve(response("done"));
    await running;
  });

  it("preempts every active background exactly once on the first of multiple foreground entries", async () => {
    const works = [deferred<ModelResponse>(), deferred<ModelResponse>()];
    const signals: AbortSignal[] = [];
    let backgroundIndex = 0;
    const provider = providerWithGenerate(async (input) => {
      if (input.model.startsWith("background")) {
        signals.push(input.signal!);
        return works[backgroundIndex++]!.promise;
      }
      return response(input.model);
    });
    const views = createBackgroundModelExecutionBudgetProviders(provider, { maxConcurrency: 2 });
    const backgrounds = [
      views.background.generate(request("background-one")),
      views.background.generate(request("background-two"))
    ];
    await flush();
    await Promise.all([
      views.foreground.generate(request("foreground-one")),
      views.foreground.generate(request("foreground-two"))
    ]);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(views.snapshot()).toMatchObject({ pendingBackgroundSettlements: 2, preemptions: 2 });
    works.forEach((work, index) => work.resolve(response(`late-${index.toString()}`)));
    await Promise.all(backgrounds.map(async (background) => expect(background).rejects.toMatchObject({ code: "REQUEST_ABORTED" })));
    expect(views.snapshot()).toMatchObject({ activeBackground: 0, cancelled: 2, preemptions: 2 });
  });

  it("exposes an exact fixed-size privacy-safe snapshot shape", () => {
    const views = createBackgroundModelExecutionBudgetProviders(providerWithGenerate(async () => response("ok")));
    expect(Object.keys(views.snapshot()).sort()).toEqual([
      "activeBackground",
      "activeForeground",
      "cancelled",
      "completed",
      "failed",
      "lastCancellationSettleMs",
      "pendingBackgroundSettlements",
      "preemptions",
      "queuedBackground",
      "rejected",
      "started"
    ]);
    expect(JSON.stringify(views.snapshot())).not.toContain("hello");
  });

  it("marks an already-aborted request as a non-retryable zero-call rejection", async () => {
    const generate = vi.fn(async () => response("unexpected"));
    const views = createBackgroundModelExecutionBudgetProviders(providerWithGenerate(generate));
    const controller = new AbortController();
    controller.abort();
    const result = views.background.generate(request("aborted", { signal: controller.signal }));
    await expect(result).rejects.toBeInstanceOf(BackgroundModelExecutionBudgetError);
    await expect(result).rejects.toMatchObject({ code: "REQUEST_ABORTED", retryable: false });
    expect(generate).not.toHaveBeenCalled();
  });

  it("preserves exactly-once usage recording when the coordinator wraps the usage decorator", async () => {
    const records: unknown[] = [];
    const base = providerWithGenerate(async () => ({
      ...response("metered"),
      usage: { inputTokens: 7, outputTokens: 3 }
    }));
    const metered = createUsageRecordingProvider(base, { record: async (record) => { records.push(record); } });
    const views = createBackgroundModelExecutionBudgetProviders(metered);

    await views.background.generate(request("metered"));
    expect(records).toHaveLength(1);
  });
});

describe("runtime assembly background model budget wiring", () => {
  it("routes the fire-and-forget preference review through the observable background budget", async () => {
    const home = mkdtempSync(join(tmpdir(), "muse-background-model-budget-"));
    const assembly = createMuseRuntimeAssembly({
      env: {
        HOME: home,
        MUSE_ACTIVE_CONTEXT_ENABLED: "false",
        MUSE_BACKGROUND_REVIEW_ENABLED: "true",
        MUSE_BACKGROUND_REVIEW_MEMORY_TURNS: "1",
        MUSE_FOLLOWUP_CAPTURE_ENABLED: "false",
        MUSE_MODEL: "diagnostic/smoke",
        MUSE_MODEL_PROVIDER_ID: "diagnostic",
        MUSE_SCHEDULER_CRON_ENABLED: "false",
        MUSE_USER_MEMORY_AUTO_EXTRACT: "false"
      }
    });
    const snapshot = assembly.observability.modelExecutionBudgetSnapshot;
    expect(snapshot).toBeTypeOf("function");
    expect(snapshot!().started).toBe(0);

    await assembly.agentRuntime!.run({
      messages: [
        { content: "summarise the meeting", role: "user" },
        { content: "Here is a long prose summary.", role: "assistant" },
        { content: "No, use bullet points instead.", role: "user" }
      ],
      metadata: { userId: "owner" },
      model: "diagnostic/smoke"
    });
    await flush();
    await flush();

    expect(snapshot!()).toMatchObject({ activeBackground: 0, completed: 1, started: 1 });
  });

  it("keeps runtime, auto-extract, and awaited followup LLM calls off the background queue", async () => {
    const home = mkdtempSync(join(tmpdir(), "muse-foreground-model-budget-"));
    const assembly = createMuseRuntimeAssembly({
      env: {
        HOME: home,
        MUSE_ACTIVE_CONTEXT_ENABLED: "false",
        MUSE_BACKGROUND_REVIEW_ENABLED: "false",
        MUSE_FOLLOWUP_CAPTURE_ENABLED: "true",
        MUSE_FOLLOWUP_LLM_FALLBACK: "true",
        MUSE_MODEL: "diagnostic/smoke",
        MUSE_MODEL_PROVIDER_ID: "diagnostic",
        MUSE_SCHEDULER_CRON_ENABLED: "false",
        MUSE_USER_MEMORY_AUTO_EXTRACT: "true"
      }
    });
    await assembly.agentRuntime!.run({
      messages: [{ content: "Please answer and remember that I prefer concise replies.", role: "user" }],
      metadata: { userId: "owner" },
      model: "diagnostic/smoke"
    });
    const record = JSON.parse(
      readFileSync(join(home, ".muse", "followup-llm-budget.json"), "utf8")
    ) as { calls: number };
    expect(record.calls).toBe(1);
    expect(assembly.observability.modelExecutionBudgetSnapshot!()).toMatchObject({
      activeBackground: 0,
      queuedBackground: 0,
      started: 0
    });
  });
});
