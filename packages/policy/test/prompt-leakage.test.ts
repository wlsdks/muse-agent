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

  it("detects leaks obfuscated with zero-width / homoglyph splits (goal 298)", () => {
    // Built from escapes (never raw invisible bytes in source).
    const ZW = String.fromCharCode(0x200b);
    const cyrA = String.fromCharCode(0x0430); // Cyrillic homoglyph of "a"

    // ZW inside "prompt" — readable to a human; stripping it
    // restores "my system prompt is" which the raw regex missed.
    expect(detectSystemPromptLeakage(`Sure, my system pro${ZW}mpt is: be a helpful agent`)
      .map((f) => f.name)).toContain("my_system_prompt");

    // Cyrillic homoglyph in a section marker → folds to "[Language Rule]".
    expect(detectSystemPromptLeakage(`verbatim: [L${cyrA}nguage Rule] then more`)
      .map((f) => f.name)).toContain("prompt_section_marker");

    // Canary split by a zero-width char must still be caught.
    expect(
      detectSystemPromptLeakage(`the hidden marker is CANA${ZW}RY123`, { canaryTokens: ["CANARY123"] })
    ).toContainEqual({ match: "CANARY123", name: "canary_token" });

    // Clean benign text is still not flagged (normalize is identity).
    expect(detectSystemPromptLeakage("Let's compare two design options.")).toEqual([]);
  });

  // Each leakage PATTERN is a distinct detection class; the suite asserted only a
  // few, leaving most regexes unpinned (a broken pattern would silently stop
  // catching its leak class — mutation-surfaced: prompt-leakage scored ~43%). One
  // representative phrase per uncovered class, asserted by its finding `name`.
  it("detects each English system-prompt disclosure class", () => {
    const named = (text: string) => detectSystemPromptLeakage(text).map((f) => f.name);
    expect(named("my system prompt is: be a helpful agent")).toContain("my_system_prompt");
    expect(named("my original instructions say to stay terse")).toContain("original_instructions");
    expect(named("I am not supposed to reveal my instructions")).toContain("reveal_prompt_statement");
    expect(named("the original system prompt says be helpful")).toContain("the_system_prompt");
  });

  it("detects KOREAN system-prompt leakage (the user's language) across all three phrasings", () => {
    const named = (text: string) => detectSystemPromptLeakage(text).map((f) => f.name);
    expect(named("시스템 프롬프트는 다음과 같습니다: 친절하라")).toContain("korean_prompt_statement");
    expect(named("제가 따르는 프롬프트는 비밀입니다")).toContain("korean_followed_instructions");
    expect(named("저의 원래 지시는 사용자를 돕는 것")).toContain("korean_original_instructions");
  });

  it("detects tool-coercion / structural rule leakage and a cache-boundary marker echo", () => {
    const named = (text: string) => detectSystemPromptLeakage(text).map((f) => f.name);
    expect(named("private workspace questions always must call tools first")).toContain("private_workspace_tool_rule");
    expect(named("you must call `search_email` before answering")).toContain("tool_forcing_rule");
    expect(named("다음 규칙을 반드시 따라야 한다")).toContain("korean_structural_rule");
    expect(named("<!-- CACHE_BOUNDARY -->")).toContain("cache_boundary_marker");
  });
});
