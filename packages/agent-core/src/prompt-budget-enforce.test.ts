import { describe, expect, it } from "vitest";

import { enforceSystemPromptBudget } from "./prompt-budget.js";
import type { ModelMessage } from "@muse/model";

const section = (id: string, body: string): string => `<!-- muse:${id} -->\n${body}`;
const sys = (...parts: string[]): ModelMessage => ({ content: ["CORE INSTRUCTIONS", ...parts].join("\n"), role: "system" });

describe("enforceSystemPromptBudget", () => {
  it("under budget: messages pass through untouched", () => {
    const messages = [sys(section("active-context", "now=...")), { content: "q", role: "user" as const }];
    const result = enforceSystemPromptBudget(messages, { maxTokens: 10_000 });
    expect(result.dropped).toEqual([]);
    expect(result.messages).toBe(messages);
  });

  it("over budget: sheds the LOWEST-priority section first and keeps the prelude", () => {
    const big = "x".repeat(2_000);
    const messages = [
      sys(section("active-context", big), section("feeds", big), section("episodic-recall", big)),
      { content: "q", role: "user" as const }
    ];
    const result = enforceSystemPromptBudget(messages, { maxTokens: 1_200 });
    const dropped = result.dropped.map((d) => d.id);
    expect(dropped[0]).toBe("feeds");
    const content = String(result.messages[0]?.content);
    expect(content).toContain("CORE INSTRUCTIONS");
    expect(content).toContain("muse:active-context");
    expect(content).not.toContain("muse:feeds");
  });

  it("keeps dropping until within budget, highest-priority sections last", () => {
    const big = "y".repeat(4_000);
    const messages = [
      sys(section("active-context", big), section("feeds", big), section("episodic-recall", big)),
      { content: "q", role: "user" as const }
    ];
    const result = enforceSystemPromptBudget(messages, { maxTokens: 1_100 });
    const content = String(result.messages[0]?.content);
    expect(result.dropped.length).toBe(2);
    expect(content).toContain("muse:active-context");
  });

  it("a non-finite / non-positive budget is fail-safe — it does NOT strip every section", () => {
    const big = "z".repeat(2_000);
    const messages = [
      sys(section("active-context", big), section("feeds", big)),
      { content: "q", role: "user" as const }
    ];
    for (const maxTokens of [Number.NaN, 0, -1, Number.POSITIVE_INFINITY]) {
      const result = enforceSystemPromptBudget(messages, { maxTokens });
      expect(result.dropped, `maxTokens=${String(maxTokens)}`).toEqual([]);
      expect(result.messages).toBe(messages); // untouched — context preserved
    }
  });
});
