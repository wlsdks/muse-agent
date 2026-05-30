import { describe, expect, it } from "vitest";

import type { CompatibilityRouteOptions } from "./compat-routes.js";
import { agentModeResponse, listSessionModels, parseAgentMode } from "./compat-models.js";

// Direct coverage for the compat model-registry helpers (untested module): the
// agent-mode normalizers (parseAgentMode / agentModeResponse) and the model
// dropdown source (listSessionModels) with its defaultModel fallback chain.

describe("parseAgentMode", () => {
  it("accepts the three valid modes case- and whitespace-insensitively, else undefined", () => {
    expect(parseAgentMode("standard")).toBe("standard");
    expect(parseAgentMode("PLAN_EXECUTE")).toBe("plan_execute");
    expect(parseAgentMode(" react ")).toBe("react");
    expect(parseAgentMode("bogus")).toBeUndefined();
    expect(parseAgentMode("")).toBeUndefined();
    expect(parseAgentMode(5)).toBeUndefined();
    expect(parseAgentMode(undefined)).toBeUndefined();
  });
});

describe("agentModeResponse", () => {
  it("maps plan_execute to PLAN_EXECUTE, upper-cases the rest, and defaults undefined to REACT", () => {
    expect(agentModeResponse("plan_execute")).toBe("PLAN_EXECUTE");
    expect(agentModeResponse("react")).toBe("REACT");
    expect(agentModeResponse("standard")).toBe("STANDARD");
    expect(agentModeResponse(undefined)).toBe("REACT");
  });
});

describe("listSessionModels", () => {
  const opts = (o: Partial<CompatibilityRouteOptions>): CompatibilityRouteOptions => o as CompatibilityRouteOptions;

  it("lists provider models as providerId/modelId with the default flagged", async () => {
    const result = await listSessionModels(opts({
      defaultModel: "ollama/qwen3:8b",
      modelProvider: { listModels: async () => [{ modelId: "qwen3:8b", providerId: "ollama" }, { modelId: "gpt", providerId: "openai" }] } as unknown as CompatibilityRouteOptions["modelProvider"]
    }));
    expect(result).toEqual({
      defaultModel: "ollama/qwen3:8b",
      models: [{ isDefault: true, name: "ollama/qwen3:8b" }, { isDefault: false, name: "openai/gpt" }]
    });
  });

  it("falls back to the configured defaultModel when no provider, and to the first model when no defaultModel", async () => {
    expect(await listSessionModels(opts({ defaultModel: "ollama/qwen3:8b" }))).toEqual({
      defaultModel: "ollama/qwen3:8b",
      models: [{ isDefault: true, name: "ollama/qwen3:8b" }]
    });
    const firstWins = await listSessionModels(opts({
      modelProvider: { listModels: async () => [{ modelId: "m1", providerId: "a" }, { modelId: "m2", providerId: "b" }] } as unknown as CompatibilityRouteOptions["modelProvider"]
    }));
    expect(firstWins.defaultModel).toBe("a/m1"); // names[0] when no configured default
    expect(firstWins.models[0]).toEqual({ isDefault: true, name: "a/m1" });
  });

  it("returns an empty list + empty default when nothing is configured", async () => {
    expect(await listSessionModels(opts({}))).toEqual({ defaultModel: "", models: [] });
  });
});
