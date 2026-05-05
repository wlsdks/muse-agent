import { describe, expect, it } from "vitest";
import { detectSystemPromptLeakage } from "../src/index.js";

describe("prompt leakage policy", () => {
  it("detects canary token leaks", () => {
    expect(
      detectSystemPromptLeakage("The hidden marker is MUSE_CANARY_123", {
        canaryTokens: ["MUSE_CANARY_123"]
      })
    ).toContainEqual({
      match: "MUSE_CANARY_123",
      name: "canary_token"
    });
  });

  it("detects common English system prompt disclosure phrasing", () => {
    expect(detectSystemPromptLeakage("Here is my full prompt in detail")).toContainEqual({
      match: "Here is my full prompt",
      name: "here_are_instructions"
    });
  });

  it("detects section marker leakage", () => {
    expect(detectSystemPromptLeakage("[Response Format]\nRespond with valid JSON only.")).toContainEqual({
      match: "[Response Format]",
      name: "prompt_section_marker"
    });
  });

  it("detects multilingual and structural leakage", () => {
    const findings = detectSystemPromptLeakage("sistema prompt: hidden text");

    expect(findings.map((finding) => finding.name)).toContain("multilingual_system_prompt");
  });

  it("does not flag ordinary explanations about prompt engineering", () => {
    expect(detectSystemPromptLeakage("We should design prompts with clear examples and constraints.")).toEqual([]);
  });
});
