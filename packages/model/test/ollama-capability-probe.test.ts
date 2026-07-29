import { describe, expect, it, vi } from "vitest";

import {
  MODEL_CAPABILITY_PROBE_SCHEMA_VERSION,
  ModelProviderRegistry,
  OllamaProvider,
  localCatalogModels,
  probeOllamaModelCapabilities,
  projectModelCapabilitiesFromProbe,
  type ModelCapabilityProbeResult,
  type ModelEvent,
  type ModelInfo,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse
} from "../src/index.js";

const NOW = new Date("2026-07-29T05:00:00.000Z");

function showFetch(payload: unknown): {
  readonly body: () => unknown;
  readonly fetchImpl: typeof fetch;
  readonly url: () => string;
} {
  let requestedUrl = "";
  let requestedBody: unknown;
  return {
    body: () => requestedBody,
    fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
      requestedUrl = String(url);
      requestedBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify(payload));
    }) as typeof fetch,
    url: () => requestedUrl
  };
}

describe("probeOllamaModelCapabilities", () => {
  it("projects /api/show completion, tools, vision, and context into the common contract", async () => {
    const fake = showFetch({
      capabilities: ["completion", "tools", "vision"],
      model_info: {
        "general.architecture": "gemma4",
        "gemma4.context_length": 131_072
      }
    });

    const result = await probeOllamaModelCapabilities(
      "http://127.0.0.1:11434/v1",
      "ollama",
      "ollama/gemma4:12b",
      fake.fetchImpl,
      { now: () => NOW }
    );

    expect(result).toEqual({
      adapterVersion: "ollama-native-api.v1",
      capabilities: {
        streaming: "supported",
        structuredOutput: "supported",
        toolCalling: "supported",
        vision: "supported"
      },
      limits: { maxInputTokens: 131_072 },
      modelId: "gemma4:12b",
      observedAt: "2026-07-29T05:00:00.000Z",
      providerId: "ollama",
      schemaVersion: MODEL_CAPABILITY_PROBE_SCHEMA_VERSION,
      source: "ollama-api-show",
      status: "available",
      validUntil: "2026-07-29T05:05:00.000Z"
    });
    expect(fake.url()).toBe("http://127.0.0.1:11434/api/show");
    expect(fake.body()).toEqual({ model: "gemma4:12b" });
  });

  it("distinguishes model-specific unsupported tools/vision from a failed unknown probe", async () => {
    const unsupported = await probeOllamaModelCapabilities(
      "http://127.0.0.1:11434",
      "ollama",
      "llama3.2",
      showFetch({ capabilities: ["completion"] }).fetchImpl,
      { now: () => NOW }
    );
    expect(unsupported).toMatchObject({
      capabilities: {
        streaming: "supported",
        structuredOutput: "supported",
        toolCalling: "unsupported",
        vision: "unsupported"
      },
      status: "available"
    });

    const failed = await probeOllamaModelCapabilities(
      "http://127.0.0.1:11434",
      "ollama",
      "llama3.2",
      (async () => {
        throw new Error("connection refused");
      }) as typeof fetch,
      { now: () => NOW }
    );
    expect(failed).toMatchObject({
      capabilities: {
        streaming: "unknown",
        structuredOutput: "unknown",
        toolCalling: "unknown",
        vision: "unknown"
      },
      failureReason: "transport-error",
      status: "failed"
    });
  });
});

describe("OllamaProvider capability projection", () => {
  it("uses the probe result, not the adapter name, for model capabilities", async () => {
    const withTools = new OllamaProvider({
      capabilityProbeNow: () => NOW,
      fetch: showFetch({ capabilities: ["completion", "tools"] }).fetchImpl,
      models: ["same-model"],
      probeModelCapabilities: true
    });
    const withoutTools = new OllamaProvider({
      capabilityProbeNow: () => NOW,
      fetch: showFetch({ capabilities: ["completion"] }).fetchImpl,
      models: ["same-model"],
      probeModelCapabilities: true
    });

    expect((await withTools.listModels())[0]?.capabilities.toolCalling).toBe(true);
    expect((await withoutTools.listModels())[0]?.capabilities.toolCalling).toBe(false);
    expect((await withoutTools.listModels())[0]?.capabilityProbe?.status).toBe("available");
  });

  it("keeps the static declaration and makes no probe call when opt-in is off", async () => {
    const fetchImpl = vi.fn();
    const provider = new OllamaProvider({
      fetch: fetchImpl as unknown as typeof fetch,
      models: ["same-model"]
    });

    const [model] = await provider.listModels();

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(model?.capabilityProbe).toBeUndefined();
    expect(model?.capabilities).toMatchObject({
      streaming: true,
      structuredOutput: true,
      toolCalling: true,
      vision: false
    });
  });
});

describe("ModelProviderRegistry probe admission", () => {
  it("rejects failed and stale probe evidence from routing", async () => {
    const declared = localCatalogModels()[0]!.capabilities;
    const fresh: ModelCapabilityProbeResult = {
      adapterVersion: "test.v1",
      capabilities: {
        streaming: "supported",
        structuredOutput: "supported",
        toolCalling: "supported",
        vision: "unsupported"
      },
      limits: {},
      modelId: "model",
      observedAt: new Date(Date.now() - 1_000).toISOString(),
      providerId: "fake",
      schemaVersion: 1,
      source: "test-probe",
      status: "available",
      validUntil: new Date(Date.now() + 60_000).toISOString()
    };
    const stale: ModelCapabilityProbeResult = {
      ...fresh,
      observedAt: "2026-01-01T00:00:00.000Z",
      validUntil: "2026-01-01T00:05:00.000Z"
    };
    const failed: ModelCapabilityProbeResult = {
      adapterVersion: "test.v1",
      capabilities: {
        streaming: "unknown",
        structuredOutput: "unknown",
        toolCalling: "unknown",
        vision: "unknown"
      },
      failureReason: "transport-error",
      modelId: "model",
      observedAt: new Date(Date.now() - 1_000).toISOString(),
      providerId: "fake",
      schemaVersion: 1,
      source: "test-probe",
      status: "failed",
      validUntil: new Date(Date.now() + 60_000).toISOString()
    };

    await expect(registryFor(modelInfo(declared, stale)).selectModel()).rejects.toThrow(
      "No compatible model found"
    );
    await expect(registryFor(modelInfo(declared, failed)).selectModel()).rejects.toThrow(
      "No compatible model found"
    );
    await expect(registryFor(modelInfo(declared, fresh)).selectModel({
      requires: { toolCalling: true }
    })).resolves.toMatchObject({ model: { modelId: "model" } });
  });

  it("uses fresh probed unsupported over a contradictory static declaration", async () => {
    const declared = {
      ...localCatalogModels()[0]!.capabilities,
      toolCalling: true
    };
    const probe: ModelCapabilityProbeResult = {
      adapterVersion: "test.v1",
      capabilities: {
        streaming: "supported",
        structuredOutput: "supported",
        toolCalling: "unsupported",
        vision: "unsupported"
      },
      limits: {},
      modelId: "model",
      observedAt: new Date(Date.now() - 1_000).toISOString(),
      providerId: "fake",
      schemaVersion: 1,
      source: "test-probe",
      status: "available",
      validUntil: new Date(Date.now() + 60_000).toISOString()
    };
    const registry = registryFor(modelInfo(declared, probe));

    await expect(registry.selectModel({
      requires: { toolCalling: true }
    })).rejects.toThrow("No compatible model found");
    await expect(registry.selectModel()).resolves.toMatchObject({
      model: { capabilities: { toolCalling: false } }
    });
  });

  it("does not project a stale result even when its booleans claim support", () => {
    const declared = localCatalogModels()[0]!.capabilities;
    const stale: ModelCapabilityProbeResult = {
      adapterVersion: "test.v1",
      capabilities: {
        streaming: "supported",
        structuredOutput: "supported",
        toolCalling: "supported",
        vision: "supported"
      },
      limits: {},
      modelId: "model",
      observedAt: "2026-07-29T05:00:00.000Z",
      providerId: "fake",
      schemaVersion: 1,
      source: "test-probe",
      status: "available",
      validUntil: "2026-07-29T05:05:00.000Z"
    };
    expect(projectModelCapabilitiesFromProbe(
      declared,
      stale,
      new Date("2026-07-29T05:05:00.000Z")
    )).toBeUndefined();
  });

  it("rejects non-canonical timestamps, empty source, and cross-model receipt reuse", async () => {
    const declared = localCatalogModels()[0]!.capabilities;
    const valid: ModelCapabilityProbeResult = {
      adapterVersion: "test.v1",
      capabilities: {
        streaming: "supported",
        structuredOutput: "supported",
        toolCalling: "supported",
        vision: "unsupported"
      },
      limits: {},
      modelId: "model",
      observedAt: new Date(Date.now() - 1_000).toISOString(),
      providerId: "fake",
      schemaVersion: 1,
      source: "test-probe",
      status: "available",
      validUntil: new Date(Date.now() + 60_000).toISOString()
    };

    expect(projectModelCapabilitiesFromProbe(declared, {
      ...valid,
      observedAt: new Date(Date.now() - 1_000).toUTCString()
    })).toBeUndefined();
    expect(projectModelCapabilitiesFromProbe(declared, {
      ...valid,
      source: ""
    })).toBeUndefined();
    await expect(registryFor(modelInfo(declared, {
      ...valid,
      modelId: "other-model",
      providerId: "other-provider"
    })).selectModel()).rejects.toThrow("No compatible model found");
  });

  it("is total and fail-closed for malformed runtime probe shapes", () => {
    const declared = localCatalogModels()[0]!.capabilities;
    const base = {
      adapterVersion: "test.v1",
      capabilities: {
        streaming: "supported",
        structuredOutput: "supported",
        toolCalling: "supported",
        vision: "unsupported"
      },
      limits: {},
      modelId: "model",
      observedAt: new Date(Date.now() - 1_000).toISOString(),
      providerId: "fake",
      schemaVersion: 1,
      source: "test-probe",
      status: "available",
      validUntil: new Date(Date.now() + 60_000).toISOString()
    } satisfies ModelCapabilityProbeResult;

    expect(() => projectModelCapabilitiesFromProbe(
      declared,
      { ...base, limits: undefined } as unknown as ModelCapabilityProbeResult
    )).not.toThrow();
    expect(projectModelCapabilitiesFromProbe(
      declared,
      { ...base, limits: undefined } as unknown as ModelCapabilityProbeResult
    )).toBeUndefined();
    expect(projectModelCapabilitiesFromProbe(
      declared,
      { ...base, capabilities: null } as unknown as ModelCapabilityProbeResult
    )).toBeUndefined();
  });
});

function modelInfo(
  capabilities: ModelInfo["capabilities"],
  capabilityProbe: ModelCapabilityProbeResult
): ModelInfo {
  return {
    capabilities,
    capabilityProbe,
    modelId: "model",
    providerId: "fake"
  };
}

function registryFor(model: ModelInfo): ModelProviderRegistry {
  const provider: ModelProvider = {
    generate: async (request: ModelRequest): Promise<ModelResponse> => ({
      id: "response",
      model: request.model,
      output: "ok"
    }),
    id: "fake",
    listModels: async () => [model],
    stream: async function* (): AsyncIterable<ModelEvent> {
      yield { response: { id: "response", model: "model", output: "ok" }, type: "done" };
    }
  };
  return new ModelProviderRegistry([provider], provider.id);
}
