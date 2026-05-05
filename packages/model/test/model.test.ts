import { describe, expect, it } from "vitest";
import { canUseNativeTools, type ModelInfo } from "../src/index.js";

const baseModel: ModelInfo = {
  providerId: "test",
  modelId: "test-model",
  capabilities: {
    cost: "unknown",
    latencyProfile: "unknown",
    local: false,
    maxInputTokens: 128000,
    maxOutputTokens: 4096,
    promptCaching: false,
    reasoning: false,
    streaming: true,
    structuredOutput: true,
    toolCalling: true,
    vision: false
  }
};

describe("canUseNativeTools", () => {
  it("requires native tool calling and structured output", () => {
    expect(canUseNativeTools(baseModel)).toBe(true);
    expect(
      canUseNativeTools({
        ...baseModel,
        capabilities: { ...baseModel.capabilities, structuredOutput: false }
      })
    ).toBe(false);
  });
});
