import { estimateModelRequestTokens } from "@muse/memory";
import { ModelProviderError, type ModelEvent, type ModelProvider, type ModelRequest, type ModelResponse } from "@muse/model";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  createLocalModelContextAdmissionProviders,
  localModelContextAdmissionEnvironment,
  LocalModelContextAdmissionError
} from "../src/local-model-context-admission.js";
import { createBackgroundModelExecutionBudgetProviders } from "../src/background-model-execution-budget.js";
import { createCrossProcessModelExecutionLeaseProviders } from "../src/cross-process-model-execution-lease.js";
import { createMuseRuntimeAssembly } from "../src/runtime-assembly.js";
import { createUsageRecordingProvider } from "../src/usage-recording-provider.js";

const response: ModelResponse = { id: "r", model: "local/test", output: "ok" };
const request = (content: string, signal?: AbortSignal): ModelRequest => ({
  messages: [{ content, role: "user" }],
  model: "local/test",
  ...(signal ? { signal } : {})
});

function provider(window = 512): ModelProvider & { generate: ReturnType<typeof vi.fn> } {
  return {
    generate: vi.fn(async () => response),
    id: "local-test",
    listModels: async () => [],
    resolveContextWindow: async () => ({ providerWindowTokens: window, provenance: "configured" }),
    stream: () => (async function* (): AsyncIterable<ModelEvent> {
      yield { response, type: "done" };
    })()
  };
}

describe("local model context admission", () => {
  it("projects only bounded canonical resident settings", () => {
    expect(localModelContextAdmissionEnvironment({
      MUSE_LLM_MAX_CONTEXT_WINDOW_TOKENS: "32768",
      MUSE_LLM_MAX_OUTPUT_TOKENS: "2048",
      MUSE_LLM_WORKING_BUDGET_TOKENS: "0",
      MUSE_OLLAMA_NUM_CTX: "16384",
      MUSE_OLLAMA_PROBE_CONTEXT: " YES "
    })).toEqual({
      MUSE_LLM_MAX_CONTEXT_WINDOW_TOKENS: "32768",
      MUSE_LLM_MAX_OUTPUT_TOKENS: "2048",
      MUSE_LLM_WORKING_BUDGET_TOKENS: "0",
      MUSE_OLLAMA_NUM_CTX: "16384",
      MUSE_OLLAMA_PROBE_CONTEXT: "true"
    });
    expect(localModelContextAdmissionEnvironment({
      MUSE_LLM_MAX_CONTEXT_WINDOW_TOKENS: "999999999",
      MUSE_OLLAMA_NUM_CTX: "-1",
      MUSE_OLLAMA_PROBE_CONTEXT: "maybe"
    })).toEqual({});
  });

  it("forwards provider-window authority through every inner decorator", async () => {
    const base = provider(768);
    const usage = createUsageRecordingProvider(base, { record: async () => {} });
    const cross = createCrossProcessModelExecutionLeaseProviders(usage, {
      backgroundWaitMs: 100,
      enabled: true,
      foregroundWaitMs: 100,
      pollMs: 5,
      preemptPollMs: 25,
      root: join(mkdtempSync(join(tmpdir(), "muse-context-forwarding-")), "lease")
    });
    const budget = createBackgroundModelExecutionBudgetProviders(cross.foreground, {}, cross.background);
    const outer = createLocalModelContextAdmissionProviders(budget.foreground, budget.background, {
      maxContextWindowTokens: 4_096,
      outputReserveTokens: 256
    });
    await expect(outer.foreground.resolveContextWindow?.("local/test")).resolves.toEqual({
      providerWindowTokens: 768,
      provenance: "configured"
    });
    await expect(outer.background.resolveContextWindow?.("local/test")).resolves.toEqual({
      providerWindowTokens: 768,
      provenance: "configured"
    });
  });

  it("admits at the effective owner/provider window and shares role telemetry", async () => {
    const base = provider(512);
    const views = createLocalModelContextAdmissionProviders(base, base, {
      maxContextWindowTokens: 4_096,
      outputReserveTokens: 256
    });
    await expect(views.foreground.generate(request("small"))).resolves.toEqual(response);
    const iterator = views.background.stream(request("also small"))[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({ done: false, value: { type: "done" } });
    expect(views.snapshot()).toMatchObject({ admitted: 2, lastAdmissionWindowTokens: 512, lastProviderWindowTokens: 512 });
  });

  it("keeps the owner ceiling distinct from a larger provider wire window", async () => {
    const base = provider(8_192);
    const views = createLocalModelContextAdmissionProviders(base, base, {
      maxContextWindowTokens: 4_096,
      outputReserveTokens: 256
    });
    await views.foreground.generate(request("small"));
    expect(views.snapshot()).toMatchObject({
      lastAdmissionWindowTokens: 4_096,
      lastProviderWindowTokens: 8_192
    });
  });

  it("admits at limit minus one and limit, then rejects limit plus one", async () => {
    const base = provider(8_192);
    const views = createLocalModelContextAdmissionProviders(base, base, {
      maxContextWindowTokens: 4_096,
      outputReserveTokens: 256
    });
    const boundaryRequest = request("x".repeat(8_000));
    const inputTokens = estimateModelRequestTokens(boundaryRequest).estimatedInputTokens;
    const equalReserve = 4_096 - inputTokens;
    expect(equalReserve).toBeGreaterThan(1);

    await expect(views.foreground.generate({ ...boundaryRequest, maxOutputTokens: equalReserve - 1 })).resolves.toEqual(response);
    await expect(views.foreground.generate({ ...boundaryRequest, maxOutputTokens: equalReserve })).resolves.toEqual(response);
    await expect(views.foreground.generate({ ...boundaryRequest, maxOutputTokens: equalReserve + 1 })).rejects.toMatchObject({
      code: "CONTEXT_BUDGET_EXCEEDED",
      retryable: false
    });
    expect(base.generate).toHaveBeenCalledTimes(2);
  });

  it("does not double-wrap an existing foreground/background projection", async () => {
    const base = provider();
    const first = createLocalModelContextAdmissionProviders(base, base, {
      maxContextWindowTokens: 4_096,
      outputReserveTokens: 256
    });
    const second = createLocalModelContextAdmissionProviders(first.foreground, first.background, {
      maxContextWindowTokens: 4_096,
      outputReserveTokens: 256
    });
    expect(second.foreground).toBe(first.foreground);
    expect(second.background).toBe(first.background);
    expect(second.snapshot).toBe(first.snapshot);
    await second.foreground.generate(request("once"));
    expect(base.generate).toHaveBeenCalledTimes(1);
    expect(second.snapshot()).toMatchObject({ admitted: 1 });
  });

  it("rejects oversized generate and lazy stream before the raw provider", async () => {
    const base = provider(256);
    const stream = vi.fn(base.stream);
    base.stream = stream;
    const views = createLocalModelContextAdmissionProviders(base, base, {
      maxContextWindowTokens: 4_096,
      outputReserveTokens: 256
    });
    await expect(views.foreground.generate(request("too large"))).rejects.toMatchObject({
      code: "CONTEXT_BUDGET_EXCEEDED",
      retryable: false
    });
    expect(base.generate).not.toHaveBeenCalled();
    const iterable = views.background.stream(request("too large"));
    expect(stream).not.toHaveBeenCalled();
    await expect(iterable[Symbol.asyncIterator]().next()).rejects.toBeInstanceOf(LocalModelContextAdmissionError);
    expect(stream).not.toHaveBeenCalled();
    expect(views.snapshot()).toMatchObject({ rejected: 2 });
  });

  it("does not resolve a pre-aborted request", async () => {
    const base = provider();
    const resolveContextWindow = vi.fn(base.resolveContextWindow);
    base.resolveContextWindow = resolveContextWindow;
    const views = createLocalModelContextAdmissionProviders(base, base, {
      maxContextWindowTokens: 4_096,
      outputReserveTokens: 256
    });
    const controller = new AbortController();
    controller.abort("private");
    await expect(views.foreground.generate(request("ignored", controller.signal))).rejects.toMatchObject({ retryable: false });
    expect(resolveContextWindow).not.toHaveBeenCalled();
    expect(base.generate).not.toHaveBeenCalled();
    expect(views.snapshot()).toMatchObject({ admitted: 0, rejected: 0, stateFailures: 0 });
  });

  it("fails closed on invalid provider authority and unknown attachment size", async () => {
    const base = provider();
    base.resolveContextWindow = async () => ({ providerWindowTokens: Number.NaN, provenance: "configured" });
    const views = createLocalModelContextAdmissionProviders(base, base, {
      maxContextWindowTokens: 4_096,
      outputReserveTokens: 256
    });
    await expect(views.foreground.generate(request("small"))).rejects.toMatchObject({ code: "STATE_UNAVAILABLE" });
    const withoutCapability = provider();
    delete withoutCapability.resolveContextWindow;
    const direct = createLocalModelContextAdmissionProviders(withoutCapability, withoutCapability, {
      maxContextWindowTokens: 4_096,
      outputReserveTokens: 256
    });
    await expect(direct.foreground.generate({
      messages: [{ attachments: [{ mimeType: "image/png", url: "https://private.invalid/image" }], content: "", role: "user" }],
      model: "local/test"
    })).rejects.toMatchObject({ code: "STATE_UNAVAILABLE" });
    expect(withoutCapability.generate).not.toHaveBeenCalled();
  });

  it("normalizes resolver failures without leaking their message or retry policy", async () => {
    const base = provider();
    base.resolveContextWindow = async () => {
      throw new ModelProviderError("local-secret", "SECRET_PATH_/Users/private/model", true);
    };
    const views = createLocalModelContextAdmissionProviders(base, base, {
      maxContextWindowTokens: 4_096,
      outputReserveTokens: 256
    });
    const failure = await views.foreground.generate(request("private prompt")).catch((error: unknown) => error);
    expect(failure).toMatchObject({
      code: "STATE_UNAVAILABLE",
      message: "local model context admission state is unavailable",
      retryable: false
    });
    expect(String((failure as Error).message)).not.toContain("SECRET_PATH");
    expect(base.generate).not.toHaveBeenCalled();
    expect(views.snapshot()).toMatchObject({ admitted: 0, rejected: 0, stateFailures: 1 });
  });

  it("rejects outside both execution coordinators in the assembled local runtime", async () => {
    const home = mkdtempSync(join(tmpdir(), "muse-context-admission-"));
    const leaseRoot = join(home, "lease");
    const originalFetch = globalThis.fetch;
    const fetch = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: "unexpected" } }] })));
    globalThis.fetch = fetch as typeof globalThis.fetch;
    try {
      const assembly = createMuseRuntimeAssembly({
        env: {
          HOME: home,
          MUSE_ACTIVE_CONTEXT_ENABLED: "false",
          MUSE_CROSS_PROCESS_MODEL_LEASE_ROOT: leaseRoot,
          MUSE_FOLLOWUP_CAPTURE_ENABLED: "false",
          MUSE_LLM_MAX_CONTEXT_WINDOW_TOKENS: "4096",
          MUSE_LLM_MAX_OUTPUT_TOKENS: "4096",
          MUSE_LOCAL_ONLY: "true",
          MUSE_MODEL: "local/test",
          MUSE_MODEL_BASE_URL: "http://localhost:18000/v1",
          MUSE_SCHEDULER_CRON_ENABLED: "false",
          MUSE_USER_MEMORY_AUTO_EXTRACT: "false"
        }
      });
      await expect(assembly.modelProvider?.generate(request("blocked"))).rejects.toMatchObject({
        code: "CONTEXT_BUDGET_EXCEEDED"
      });
      expect(fetch).not.toHaveBeenCalled();
      expect(assembly.observability.localModelContextAdmissionSnapshot?.()).toMatchObject({ rejected: 1 });
      expect(assembly.observability.modelExecutionBudgetSnapshot?.()).toMatchObject({
        activeForeground: 0,
        maxObservedActiveForeground: 0,
        started: 0
      });
      expect(assembly.observability.crossProcessModelExecutionLeaseSnapshot?.()).toMatchObject({ acquired: 0 });
      expect(existsSync(leaseRoot)).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
