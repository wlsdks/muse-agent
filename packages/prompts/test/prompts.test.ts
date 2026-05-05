import { describe, expect, it } from "vitest";
import {
  MUSE_CACHE_BOUNDARY_MARKER,
  buildPromptContextPacket,
  buildSystemPrompt,
  mergePromptContext,
  renderJsonInstruction,
  renderRetrievedContext,
  renderToolResults,
  renderYamlInstruction,
  splitPromptCacheBoundary,
  stripPromptCacheBoundary
} from "../src/index.js";

describe("prompt instruction rendering", () => {
  it("renders response format instructions with optional schemas", () => {
    const json = renderJsonInstruction('{"type":"object"}');
    const yaml = renderYamlInstruction();

    expect(json).toContain("[Response Format]");
    expect(json).toContain("valid JSON only");
    expect(json).toContain("Expected JSON schema:");
    expect(yaml).toContain("valid YAML only");
    expect(yaml).not.toContain("Expected YAML structure:");
  });

  it("keeps retrieved context distinct from tool results", () => {
    const retrieved = renderRetrievedContext("Source A: product fact");
    const toolResults = renderToolResults("Tool A: live fact");

    expect(retrieved).toContain("[Retrieved Context]");
    expect(retrieved).toContain("knowledge source");
    expect(retrieved).toContain("Source A: product fact");
    expect(toolResults).toContain("[Tool Results]");
    expect(toolResults).toContain("executed tools");
    expect(toolResults).toContain("Tool A: live fact");
  });

  it("merges context blocks without blank placeholders", () => {
    expect(mergePromptContext(" primary ", " secondary ")).toBe("primary\n\nsecondary");
    expect(mergePromptContext(undefined, " ")).toBeUndefined();
  });
});

describe("system prompt building", () => {
  it("places stable sections above the cache boundary and dynamic sections below it", () => {
    const prompt = buildSystemPrompt({
      includeCacheBoundary: true,
      providerDynamicSuffix: "provider dynamic",
      providerStablePrefix: "provider stable",
      retrievedContext: "retrieved fact",
      responseFormat: "json"
    });
    const split = splitPromptCacheBoundary(prompt);

    expect(prompt).toContain(MUSE_CACHE_BOUNDARY_MARKER);
    expect(split?.stablePrefix).toContain("provider stable");
    expect(split?.stablePrefix).toContain("[Response Format]");
    expect(split?.dynamicSuffix).toContain("[Retrieved Context]");
    expect(split?.dynamicSuffix).toContain("provider dynamic");
  });

  it("strips cache boundary markers without deleting prompt content", () => {
    const prompt = `stable\n${MUSE_CACHE_BOUNDARY_MARKER}\ndynamic`;

    expect(stripPromptCacheBoundary(prompt)).toBe("stable\ndynamic");
  });

  it("builds sanitized context packet values for audit metadata", () => {
    expect(
      buildPromptContextPacket({
        requesterContext: " requester ",
        retrievedContext: " ",
        toolResults: " tool "
      })
    ).toEqual({
      delegatedAgent: undefined,
      requesterContext: "requester",
      retrievedContext: undefined,
      sessionMemoryContext: undefined,
      taskMemoryContext: undefined,
      toolResults: "tool",
      userMemoryContext: undefined
    });
  });
});
